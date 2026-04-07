import { Router, Request, Response } from 'express';
import { Client as CassandraClient, types as CassandraTypes } from 'cassandra-driver';
import { ClickHouseClient } from '@clickhouse/client';

const CH_DB    = process.env.CLICKHOUSE_DB   ?? 'senneo';
const KEYSPACE = process.env.SCYLLA_KEYSPACE ?? 'senneo';

// Async dedup state — dedup runs in background, frontend polls /status
let _dedupRunning   = false;
let _dedupStartedAt = 0;
let _dedupError: string | null = null;
let _dedupResult: { total_rows: number; unique_ids: number; elapsedMs: number } | null = null;
// FIX #3: Whitelist approach — only SELECT queries allowed on the raw CQL endpoint.
// A blacklist (DROP/TRUNCATE/DELETE) is easily bypassed; whitelist is not.
const CQL_SELECT_ONLY = /^\s*select\s/i;
const DESTRUCTIVE = /^\s*(drop|truncate|delete|insert|update|alter|rename|create|grant|revoke|batch)\s/i;

// P1-2: Safety limits for CH queries to prevent OOM/timeout at scale
const CH_QUERY_SAFETY = {
  max_execution_time:  10,              // 10 seconds max per query
  max_rows_to_read:    '0',             // unlimited (table exceeds 100M; timeout guards instead)
};

/**
 * Merge per-author stats from messages: counts, first/last seen, and best non-empty avatar.
 * `ids` must be validated numeric snowflakes only — interpolated into IN (...) as literals.
 */
async function enrichUserRowsFromMessages(
  ch: ClickHouseClient,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return rows;
  const ids = [...new Set(rows.map(r => String(r.author_id ?? '')).filter(id => /^\d{17,20}$/.test(id)))];
  if (ids.length === 0) return rows;
  const inSql = ids.join(',');
  try {
    const r = await ch.query({
      query: `
        SELECT
          author_id,
          count()         AS _msg_count,
          min(ts)         AS _first_seen,
          max(ts)         AS _last_seen,
          argMaxIf(author_avatar, ts, author_avatar != '') AS _best_avatar,
          groupBitOr(badge_mask) AS _badge_mask_agg
        FROM ${CH_DB}.messages
        WHERE author_id IN (${inSql})
        GROUP BY author_id
      `,
      format: 'JSONEachRow',
      clickhouse_settings: CH_QUERY_SAFETY,
    });
    const stats = await r.json<Record<string, unknown>[]>();
    const map = new Map(stats.map(s => [String(s.author_id), s]));
    return rows.map(row => {
      const id = String(row.author_id ?? '');
      const m = map.get(id);
      if (!m) return row;
      const out = { ...row };
      if (m._msg_count != null) out.msg_count = m._msg_count;
      if (m._first_seen != null) out.first_seen = m._first_seen;
      if (m._last_seen != null) out.last_seen = m._last_seen;
      const av = String(row.author_avatar ?? '').trim();
      const isValidAv = av && av !== '0' && av !== 'null' && av !== 'undefined';
      const best = String(m._best_avatar ?? '').trim();
      if (!isValidAv && best && best !== '0') out.author_avatar = best;
      // Merge badge_mask: OR existing (from users_latest) with aggregated from messages
      const existingMask = Number(row.badge_mask ?? 0);
      const aggMask = Number(m._badge_mask_agg ?? 0);
      if (aggMask > 0) out.badge_mask = String(existingMask | aggMask);
      return out;
    });
  } catch {
    return rows;
  }
}

function rowToJson(row: CassandraTypes.Row): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row)) {
    if (val instanceof CassandraTypes.Long) obj[key] = val.toString();
    else if (val instanceof Date)           obj[key] = val.toISOString();
    else                                    obj[key] = val;
  }
  return obj;
}

export function dbRouter(scylla: CassandraClient, ch: ClickHouseClient): Router {
  const router = Router();

  //  ClickHouse: list tables 
  router.get('/ch/tables', async (_req: Request, res: Response) => {
    try {
      const r = await ch.query({
        query: `SELECT name, engine, total_rows FROM system.tables WHERE database = {db:String} ORDER BY total_rows DESC`,
        query_params: { db: CH_DB },
        format: 'JSONEachRow',
      });
      return res.json(await r.json());
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  //  ClickHouse: table rows 
  router.get('/ch/tables/:table/rows', async (req: Request, res: Response) => {
    const limit  = Math.min(parseInt(req.query['limit'] as string ?? '50'), 500);
    const offset = parseInt(req.query['offset'] as string ?? '0', 10);
    try {
      const r = await ch.query({
        query: `SELECT * FROM ${CH_DB}.${req.params.table} LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: { limit, offset },
        format: 'JSONEachRow',
      });
      return res.json(await r.json());
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  //  ClickHouse: run SQL 
  router.post('/ch/query', async (req: Request, res: Response) => {
    const { sql } = req.body as { sql?: string };
    if (!sql?.trim()) return res.status(400).json({ error: 'sql is required' });
    if (DESTRUCTIVE.test(sql) && req.headers['x-confirm-destructive'] !== 'yes')
      return res.status(400).json({ error: 'Destructive query  add X-Confirm-Destructive: yes' });
    const start = Date.now();
    try {
      const r    = await ch.query({ query: sql, format: 'JSONEachRow', clickhouse_settings: CH_QUERY_SAFETY });
      const rows = await r.json<Record<string, unknown>[]>();
      return res.json({ rows, count: rows.length, elapsedMs: Date.now() - start });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message, elapsedMs: Date.now() - start });
    }
  });

  //  ClickHouse: analytics endpoints 
  router.get('/ch/analytics/topusers', async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query['limit'] as string ?? '20'), 100);
    const humansOnly = req.query['humansOnly'] === '1';
    const botsOnly   = req.query['botsOnly'] === '1';
    const botFilter  = humansOnly ? 'AND is_bot = 0' : botsOnly ? 'AND is_bot = 1' : '';
    try {
      const r = await ch.query({
        query: `SELECT author_id, author_name, count() AS msg_count, max(ts) AS last_seen,
                       argMax(is_bot, ts) AS is_bot, groupBitOr(badge_mask) AS badge_mask,
                       argMaxIf(author_avatar, ts, author_avatar != '' AND author_avatar != '0') AS author_avatar, argMax(display_name, ts) AS display_name,
                       min(ts) AS first_seen
                FROM ${CH_DB}.messages
                WHERE ts >= now() - INTERVAL 90 DAY ${botFilter}
                GROUP BY author_id, author_name
                ORDER BY msg_count DESC LIMIT {limit:UInt32}`,
        query_params: { limit }, format: 'JSONEachRow',
        clickhouse_settings: CH_QUERY_SAFETY,
      });
      const raw = await r.json<Record<string, unknown>[]>();
      const enriched = await enrichUserRowsFromMessages(ch, raw);
      return res.json(enriched);
    } catch (err: any) { return res.status(500).json({ error: err?.message }); }
  });

  router.get('/ch/analytics/topchannels', async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query['limit'] as string ?? '10'), 50);
    try {
      const r = await ch.query({
        query: `SELECT channel_id, count() AS msg_count, uniq(author_id) AS unique_users,
                       min(ts) AS first_msg, max(ts) AS last_msg
                FROM ${CH_DB}.messages
                WHERE ts >= now() - INTERVAL 90 DAY
                GROUP BY channel_id
                ORDER BY msg_count DESC LIMIT {limit:UInt32}`,
        query_params: { limit }, format: 'JSONEachRow',
        clickhouse_settings: CH_QUERY_SAFETY,
      });
      return res.json(await r.json());
    } catch (err: any) { return res.status(500).json({ error: err?.message }); }
  });

  router.get('/ch/analytics/activity', async (req: Request, res: Response) => {
    const days = Math.min(parseInt(req.query['days'] as string ?? '30'), 90);
    try {
      const r = await ch.query({
        query: `SELECT toDate(ts) AS date, count() AS messages, uniq(author_id) AS users
                FROM ${CH_DB}.messages
                WHERE ts >= now() - INTERVAL {days:UInt32} DAY
                GROUP BY date ORDER BY date ASC`,
        query_params: { days }, format: 'JSONEachRow',
        clickhouse_settings: CH_QUERY_SAFETY,
      });
      return res.json(await r.json());
    } catch (err: any) { return res.status(500).json({ error: err?.message }); }
  });

  router.get('/ch/analytics/hourly', async (_req: Request, res: Response) => {
    try {
      const r = await ch.query({
        query: `SELECT toHour(ts) AS hour, count() AS messages
                FROM ${CH_DB}.messages
                WHERE ts >= now() - INTERVAL 90 DAY
                GROUP BY hour ORDER BY hour ASC`,
        format: 'JSONEachRow',
        clickhouse_settings: CH_QUERY_SAFETY,
      });
      return res.json(await r.json());
    } catch (err: any) { return res.status(500).json({ error: err?.message }); }
  });

  router.get('/ch/analytics/search', async (req: Request, res: Response) => {
    const q     = (req.query['q'] as string ?? '').trim();
    const limit = Math.min(parseInt(req.query['limit'] as string ?? '50'), 200);
    if (!q) return res.status(400).json({ error: 'q is required' });
    try {
      const r = await ch.query({
        query: `SELECT message_id, channel_id, author_id, author_name, content, ts
                FROM ${CH_DB}.messages
                WHERE positionCaseInsensitive(content, {q:String}) > 0
                ORDER BY ts DESC LIMIT {limit:UInt32}`,
        query_params: { q, limit }, format: 'JSONEachRow',
        clickhouse_settings: CH_QUERY_SAFETY,
      });
      const rows = await r.json<Record<string, unknown>[]>();
      return res.json({ rows, count: rows.length });
    } catch (err: any) { return res.status(500).json({ error: err?.message }); }
  });

  // ── ClickHouse: content type distribution (last N days) ──
  router.get('/ch/analytics/content-types', async (req: Request, res: Response) => {
    const days = Math.min(parseInt(req.query['days'] as string ?? '30'), 90);
    try {
      const r = await ch.query({
        query: `SELECT
                  countIf(has_attachment = 0 AND embed_count = 0 AND length(sticker_names) = 0) AS text_only,
                  countIf(has_attachment = 1) AS with_attachment,
                  countIf(embed_count > 0) AS with_embed,
                  countIf(length(sticker_names) > 0) AS with_sticker,
                  count() AS total
                FROM ${CH_DB}.messages
                WHERE ts >= now() - INTERVAL {days:UInt32} DAY`,
        query_params: { days }, format: 'JSONEachRow',
        clickhouse_settings: CH_QUERY_SAFETY,
      });
      const rows = await r.json<Record<string, unknown>[]>();
      return res.json(rows[0] ?? {});
    } catch (err: any) { return res.status(500).json({ error: err?.message }); }
  });

  // ── ClickHouse: media type breakdown (last N days) ──
  router.get('/ch/analytics/media-types', async (req: Request, res: Response) => {
    const days = Math.min(parseInt(req.query['days'] as string ?? '30'), 90);
    try {
      const r = await ch.query({
        query: `SELECT media_type, count() AS cnt
                FROM ${CH_DB}.messages
                WHERE ts >= now() - INTERVAL {days:UInt32} DAY
                GROUP BY media_type
                ORDER BY cnt DESC`,
        query_params: { days }, format: 'JSONEachRow',
        clickhouse_settings: CH_QUERY_SAFETY,
      });
      return res.json(await r.json());
    } catch (err: any) { return res.status(500).json({ error: err?.message }); }
  });

  // ── ClickHouse: message size stats (avg, percentiles — last N days) ──
  router.get('/ch/analytics/msg-size', async (req: Request, res: Response) => {
    const days = Math.min(parseInt(req.query['days'] as string ?? '30'), 90);
    try {
      const r = await ch.query({
        query: `SELECT
                  round(avg(length(content))) AS avg_chars,
                  round(quantile(0.5)(length(content))) AS median_chars,
                  round(quantile(0.95)(length(content))) AS p95_chars,
                  max(length(content)) AS max_chars,
                  countIf(length(content) = 0) AS empty_count,
                  count() AS total
                FROM ${CH_DB}.messages
                WHERE ts >= now() - INTERVAL {days:UInt32} DAY`,
        query_params: { days }, format: 'JSONEachRow',
        clickhouse_settings: CH_QUERY_SAFETY,
      });
      const rows = await r.json<Record<string, unknown>[]>();
      return res.json(rows[0] ?? {});
    } catch (err: any) { return res.status(500).json({ error: err?.message }); }
  });

  // ── ClickHouse: user lookup by ID or name (global, uses PK where possible) ──
  router.get('/ch/analytics/user', async (req: Request, res: Response) => {
    const authorId = (req.query['authorId'] as string ?? '').trim();
    const name     = (req.query['name'] as string ?? '').trim();
    const limit    = Math.min(parseInt(req.query['limit'] as string ?? '20'), 100);

    if (!authorId && !name) return res.status(400).json({ error: 'authorId or name is required' });

    try {
      if (authorId && /^\d{17,20}$/.test(authorId)) {
        // Primary key lookup on users_latest — O(1), no scan
        const r = await ch.query({
          query: `SELECT author_id, author_name, badge_mask, last_seen_ts, sample_guild,
                         author_avatar, is_bot, display_name
                  FROM ${CH_DB}.users_latest FINAL
                  WHERE author_id = {authorId:UInt64}`,
          query_params: { authorId },
          format: 'JSONEachRow',
          clickhouse_settings: CH_QUERY_SAFETY,
        });
        const rows = await r.json<Record<string, unknown>[]>();

        // Also get message count + first/last seen from messages
        const countR = await ch.query({
          query: `SELECT count() AS msg_count, min(ts) AS first_seen, max(ts) AS last_seen,
                         argMaxIf(author_avatar, ts, author_avatar != '') AS best_avatar_from_msgs,
                         groupBitOr(badge_mask) AS badge_mask_agg
                  FROM ${CH_DB}.messages WHERE author_id = {authorId:UInt64}`,
          query_params: { authorId },
          format: 'JSONEachRow',
          clickhouse_settings: CH_QUERY_SAFETY,
        });
        const [countsRaw] = await countR.json<Record<string, unknown>[]>();
        let user = rows[0] ?? null;
        if (user && countsRaw) {
          const { best_avatar_from_msgs, badge_mask_agg, ...counts } = countsRaw as Record<string, unknown> & { best_avatar_from_msgs?: unknown; badge_mask_agg?: unknown };
          const av = String(user.author_avatar ?? '').trim();
          const best = String(best_avatar_from_msgs ?? '').trim();
          // Merge badge_mask: OR the users_latest value with aggregated from messages
          const existingMask = Number(user.badge_mask ?? 0);
          const aggMask = Number(badge_mask_agg ?? 0);
          user = { ...user, ...counts, author_avatar: av || best || user.author_avatar, badge_mask: String(existingMask | aggMask) };
        }
        return res.json({ user, found: !!user });
      }

      // Name search — uses positionCaseInsensitive (scan, but limited)
      if (name) {
        const r = await ch.query({
          query: `SELECT author_id, author_name, badge_mask, last_seen_ts, sample_guild,
                         author_avatar, is_bot, display_name
                  FROM ${CH_DB}.users_latest FINAL
                  WHERE positionCaseInsensitive(author_name, {name:String}) > 0
                  ORDER BY last_seen_ts DESC LIMIT {limit:UInt32}`,
          query_params: { name, limit },
          format: 'JSONEachRow',
          clickhouse_settings: CH_QUERY_SAFETY,
        });
        let rows = await r.json<Record<string, unknown>[]>();
        rows = await enrichUserRowsFromMessages(ch, rows);
        return res.json({ users: rows, count: rows.length });
      }
      return res.status(400).json({ error: 'Invalid query' });
    } catch (err: any) { return res.status(500).json({ error: err?.message }); }
  });

  // ── User identity history (ReplacingMergeTree — FINAL for guaranteed dedup) ──
  // observed_ts = ingestion time (when change was detected), NOT message creation time.
  router.get('/ch/analytics/user-history', async (req: Request, res: Response) => {
    const authorId = (req.query['authorId'] as string ?? '').trim();
    if (!authorId || !/^\d{17,20}$/.test(authorId))
      return res.status(400).json({ error: 'Valid authorId required' });
    const field = req.query['field'] as string | undefined;
    const limit = Math.min(parseInt(req.query['limit'] as string ?? '100'), 500);

    try {
      const fieldFilter = field ? 'AND field = {field:String}' : '';
      const r = await ch.query({
        query: `SELECT author_id, field, value, observed_ts, guild_id, source_msg_ts
                FROM ${CH_DB}.user_identity_log FINAL
                WHERE author_id = {authorId:UInt64} ${fieldFilter}
                ORDER BY field, observed_ts DESC
                LIMIT {limit:UInt32}`,
        query_params: { authorId, ...(field ? { field } : {}), limit },
        format: 'JSONEachRow',
        clickhouse_settings: CH_QUERY_SAFETY,
      });
      const rows = await r.json<Record<string, unknown>[]>();
      return res.json({ history: rows, count: rows.length });
    } catch (err: any) { return res.status(500).json({ error: err?.message }); }
  });

  // ── F10: Heatmap — messages per hour × day-of-week (last N days) ──
  router.get('/ch/analytics/heatmap', async (req: Request, res: Response) => {
    const days = Math.min(parseInt(req.query['days'] as string ?? '30'), 90);
    try {
      const r = await ch.query({
        query: `SELECT toDayOfWeek(ts) AS dow, toHour(ts) AS hour, count() AS cnt
                FROM ${CH_DB}.messages
                WHERE ts >= now() - INTERVAL {days:UInt32} DAY
                GROUP BY dow, hour ORDER BY dow, hour`,
        query_params: { days }, format: 'JSONEachRow',
        clickhouse_settings: CH_QUERY_SAFETY,
      });
      return res.json(await r.json());
    } catch (err: any) { return res.status(500).json({ error: err?.message }); }
  });

  // ── F10: Weekly growth trend (messages + unique authors per week) ──
  router.get('/ch/analytics/weekly-growth', async (req: Request, res: Response) => {
    const weeks = Math.min(parseInt(req.query['weeks'] as string ?? '12'), 52);
    try {
      const r = await ch.query({
        query: `SELECT toMonday(ts) AS week, count() AS messages, uniq(author_id) AS authors
                FROM ${CH_DB}.messages
                WHERE ts >= now() - INTERVAL {weeks:UInt32} WEEK
                GROUP BY week ORDER BY week ASC`,
        query_params: { weeks }, format: 'JSONEachRow',
        clickhouse_settings: CH_QUERY_SAFETY,
      });
      return res.json(await r.json());
    } catch (err: any) { return res.status(500).json({ error: err?.message }); }
  });

  // ── F10: Per-channel hourly activity (specific channel, last N days) ──
  router.get('/ch/analytics/channel-hourly', async (req: Request, res: Response) => {
    const channelId = (req.query['channelId'] as string ?? '').trim();
    const days = Math.min(parseInt(req.query['days'] as string ?? '30'), 90);
    if (!channelId || !/^\d{17,20}$/.test(channelId))
      return res.status(400).json({ error: 'Valid channelId required' });
    try {
      const r = await ch.query({
        query: `SELECT toHour(ts) AS hour, count() AS messages, uniq(author_id) AS authors
                FROM ${CH_DB}.messages
                WHERE channel_id = {cid:UInt64} AND ts >= now() - INTERVAL {days:UInt32} DAY
                GROUP BY hour ORDER BY hour`,
        query_params: { cid: channelId, days }, format: 'JSONEachRow',
        clickhouse_settings: CH_QUERY_SAFETY,
      });
      return res.json(await r.json());
    } catch (err: any) { return res.status(500).json({ error: err?.message }); }
  });

  // ── F10: Combined overview (single round-trip for dashboard) ──
  router.get('/ch/analytics/overview', async (req: Request, res: Response) => {
    const days = Math.min(parseInt(req.query['days'] as string ?? '30'), 90);
    try {
      const [totals, daily, hourly, contentTypes] = await Promise.all([
        ch.query({
          query: `SELECT count() AS total_messages, uniq(author_id) AS unique_authors,
                         uniq(channel_id) AS unique_channels, uniq(guild_id) AS unique_guilds,
                         min(ts) AS oldest, max(ts) AS newest
                  FROM ${CH_DB}.messages WHERE ts >= now() - INTERVAL {days:UInt32} DAY`,
          query_params: { days }, format: 'JSONEachRow', clickhouse_settings: CH_QUERY_SAFETY,
        }),
        ch.query({
          query: `SELECT toDate(ts) AS date, count() AS messages, uniq(author_id) AS authors
                  FROM ${CH_DB}.messages WHERE ts >= now() - INTERVAL {days:UInt32} DAY
                  GROUP BY date ORDER BY date ASC`,
          query_params: { days }, format: 'JSONEachRow', clickhouse_settings: CH_QUERY_SAFETY,
        }),
        ch.query({
          query: `SELECT toHour(ts) AS hour, count() AS messages
                  FROM ${CH_DB}.messages WHERE ts >= now() - INTERVAL {days:UInt32} DAY
                  GROUP BY hour ORDER BY hour ASC`,
          query_params: { days }, format: 'JSONEachRow', clickhouse_settings: CH_QUERY_SAFETY,
        }),
        ch.query({
          query: `SELECT
                    countIf(has_attachment = 0 AND embed_count = 0) AS text_only,
                    countIf(has_attachment = 1) AS with_attachment,
                    countIf(embed_count > 0) AS with_embed,
                    count() AS total
                  FROM ${CH_DB}.messages WHERE ts >= now() - INTERVAL {days:UInt32} DAY`,
          query_params: { days }, format: 'JSONEachRow', clickhouse_settings: CH_QUERY_SAFETY,
        }),
      ]);

      const [t] = await totals.json<Record<string, unknown>[]>();
      const d = await daily.json();
      const h = await hourly.json();
      const [ct] = await contentTypes.json<Record<string, unknown>[]>();

      return res.json({ totals: t ?? {}, daily: d, hourly: h, contentTypes: ct ?? {}, days });
    } catch (err: any) { return res.status(500).json({ error: err?.message }); }
  });

  // ── ClickHouse: duplicate message detection ──
  router.get('/ch/dedup/status', async (_req: Request, res: Response) => {
    try {
      const r = await ch.query({
        query: `
          SELECT
            count()                                       AS total_rows,
            countDistinct(message_id)                     AS unique_ids,
            count() - countDistinct(message_id)           AS duplicate_rows,
            round((count() - countDistinct(message_id)) * 100.0 / greatest(count(), 1), 4) AS duplicate_pct
          FROM ${CH_DB}.messages
        `,
        format: 'JSONEachRow',
        clickhouse_settings: { max_execution_time: 60 },
      });
      const rows = await r.json<any[]>();
      const row = rows[0] ?? {};
      return res.json({
        total_rows:     Number(row.total_rows     ?? 0),
        unique_ids:     Number(row.unique_ids     ?? 0),
        duplicate_rows: Number(row.duplicate_rows ?? 0),
        duplicate_pct:  parseFloat(row.duplicate_pct ?? '0'),
        // Async dedup state fields
        running:        _dedupRunning,
        dedupError:     _dedupError,
        dedupResult:    _dedupResult,
        dedupStartedAt: _dedupStartedAt || undefined,
      });
    } catch (err: any) { return res.status(500).json({ error: err?.message }); }
  });

  // ── ClickHouse: run deduplication (ASYNC — returns immediately, runs in background) ──
  router.post('/ch/dedup/run', async (_req: Request, res: Response) => {
    // If already running, don't start a second OPTIMIZE
    if (_dedupRunning) {
      return res.json({ ok: true, running: true, startedAt: _dedupStartedAt, message: 'Zaten çalışıyor' });
    }

    _dedupRunning   = true;
    _dedupStartedAt = Date.now();
    _dedupError     = null;
    _dedupResult    = null;

    // Fire-and-forget — respond immediately, OPTIMIZE runs in background
    res.json({ ok: true, running: true, startedAt: _dedupStartedAt, message: 'Dedup başlatıldı — arkaplanda çalışıyor. Status endpoint’inden takip edin.' });

    // Background execution
    (async () => {
      const start = _dedupStartedAt;
      try {
        // Step 1: Per-partition OPTIMIZE DEDUPLICATE (memory-safe)
        // OPTIMIZE TABLE FINAL loads ALL partitions into RAM simultaneously → OOM kill on 110M rows.
        // Per-partition approach processes one month at a time — predictable, low memory usage.
        const partResult = await ch.query({
          query: `SELECT DISTINCT partition FROM system.parts WHERE database='${CH_DB}' AND table='messages' AND active=1 ORDER BY partition`,
          format: 'JSONEachRow',
          clickhouse_settings: { max_execution_time: 30 },
        });
        const partRows = await partResult.json<{ partition: string }[]>();
        for (const { partition } of partRows) {
          await ch.command({
            query: `OPTIMIZE TABLE ${CH_DB}.messages PARTITION '${partition}' DEDUPLICATE BY guild_id, channel_id, ts, message_id`,
            clickhouse_settings: { max_execution_time: 300 },
          }).catch((e: unknown) => console.warn(`[dedup] partition ${partition} skip:`, (e as Error)?.message?.slice(0, 80)));
        }

        // Step 2: Lightweight DELETE for same message_id with different ts/guild_id
        await ch.command({
          query: `
            ALTER TABLE ${CH_DB}.messages
            DELETE WHERE (message_id, inserted_at) NOT IN (
              SELECT message_id, max(inserted_at)
              FROM ${CH_DB}.messages
              GROUP BY message_id
              HAVING count() > 1
            )
            AND message_id IN (
              SELECT message_id FROM ${CH_DB}.messages
              GROUP BY message_id HAVING count() > 1
            )
          `,
          clickhouse_settings: {
            max_execution_time:                    600,
            allow_experimental_lightweight_delete: 1,
          } as any,
        }).catch(() => {});

        const r = await ch.query({
          query: `SELECT count() AS total_rows, countDistinct(message_id) AS unique_ids FROM ${CH_DB}.messages`,
          format: 'JSONEachRow',
          clickhouse_settings: { max_execution_time: 60 },
        });
        const rows = await r.json<any[]>();
        const row = rows[0] ?? {};
        _dedupResult = {
          total_rows: Number(row.total_rows ?? 0),
          unique_ids: Number(row.unique_ids ?? 0),
          elapsedMs:  Date.now() - start,
        };
        console.log(`[dedup] Tamamlandı ${_dedupResult.elapsedMs}ms — ${_dedupResult.total_rows - _dedupResult.unique_ids} duplicate kaldı`);
      } catch (err: any) {
        _dedupError = err?.message ?? 'Bilinmeyen hata';
        console.error('[dedup] Hata:', _dedupError);
      } finally {
        _dedupRunning = false;
      }
    })();
  });

  //  ScyllaDB: list tables 
  router.get('/scylla/tables', async (_req: Request, res: Response) => {
    try {
      const r = await scylla.execute(
        `SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?`,
        [KEYSPACE], { prepare: true },
      );
      return res.json(r.rows.map(row => ({ name: row['table_name'] })));
    } catch (err: any) { return res.status(500).json({ error: err?.message }); }
  });

  //  ScyllaDB: run CQL (SELECT only) 
  router.post('/scylla/query', async (req: Request, res: Response) => {
    const { cql } = req.body as { cql?: string };
    if (!cql?.trim()) return res.status(400).json({ error: 'cql is required' });
    // FIX #3: Whitelist — only SELECT is permitted. All write/DDL operations are blocked.
    if (!CQL_SELECT_ONLY.test(cql))
      return res.status(400).json({ error: 'Sadece SELECT sorgularina izin verilir.' });
    if (DESTRUCTIVE.test(cql))
      return res.status(400).json({ error: 'Bu sorgu tipi desteklenmiyor.' });
    const start = Date.now();
    try {
      const r = await scylla.execute(cql, [], { prepare: false });
      return res.json({ rows: r.rows.map(rowToJson), count: r.rowLength, elapsedMs: Date.now() - start });
    } catch (err: any) { return res.status(500).json({ error: err?.message, elapsedMs: Date.now() - start }); }
  });

  return router;
}