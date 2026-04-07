import { Router, Request, Response } from 'express';
import { ClickHouseClient } from '@clickhouse/client';

const CH_DB = process.env.CLICKHOUSE_DB ?? 'senneo';

const CH_QUERY_SAFETY = {
  max_rows_to_read: '5000000',
  max_execution_time: 10,
};

// ── POST /errors — write error log entries (used by all services) ────────
// Accepts a single entry or an array.  Truncates detail to 4KB to prevent
// accidental token / PII leakage from stack traces.
async function writeErrors(ch: ClickHouseClient, entries: Record<string, unknown>[]): Promise<void> {
  if (entries.length === 0) return;
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const rows = entries.map(e => ({
    ts:             String(e.ts ?? now).replace('T', ' ').replace('Z', ''),
    severity:       String(e.severity ?? 'error'),
    category:       String(e.category ?? 'unknown'),
    source:         String(e.source ?? 'other'),
    message:        String(e.message ?? '').slice(0, 2000),
    detail:         String(e.detail ?? '').slice(0, 4096),
    fingerprint:    String(e.fingerprint ?? ''),
    count:          Number(e.count) || 1,
    channel_id:     String(e.channel_id ?? ''),
    guild_id:       String(e.guild_id ?? ''),
    account_id:     String(e.account_id ?? ''),
    account_idx:    Number(e.account_idx) || -1,
    kafka_topic:    String(e.kafka_topic ?? ''),
    error_code:     String(e.error_code ?? ''),
    correlation_id: String(e.correlation_id ?? ''),
  }));
  await ch.insert({ table: `${CH_DB}.error_log`, values: rows, format: 'JSONEachRow' });
}

// ── Router ───────────────────────────────────────────────────────────────
export function errorsRouter(ch: ClickHouseClient): Router {
  const router = Router();

  // POST /errors — ingest error entries
  router.post('/', async (req: Request, res: Response) => {
    try {
      const body = req.body;
      const entries: Record<string, unknown>[] = Array.isArray(body) ? body : [body];
      if (entries.length === 0) return res.status(400).json({ error: 'Empty body' });
      await writeErrors(ch, entries);
      return res.json({ ok: true, count: entries.length });
    } catch (err: any) {
      console.error('[errors] Write failed:', err?.message);
      return res.status(500).json({ error: err?.message });
    }
  });

  // GET /errors — paginated list with filters
  router.get('/', async (req: Request, res: Response) => {
    const limit    = Math.min(parseInt(req.query['limit'] as string ?? '50', 10) || 50, 500);
    const offset   = Math.max(parseInt(req.query['offset'] as string ?? '0', 10) || 0, 0);
    const category = req.query['category'] as string | undefined;
    const source   = req.query['source']   as string | undefined;
    const severity = req.query['severity'] as string | undefined;
    const q        = req.query['q']        as string | undefined;
    const channelId  = req.query['channelId']  as string | undefined;
    const guildId    = req.query['guildId']    as string | undefined;
    const accountId  = req.query['accountId']  as string | undefined;
    const accountIdx = req.query['accountIdx'] as string | undefined;
    const since      = req.query['since']      as string | undefined; // ISO or "1h", "24h", "7d"
    const until      = req.query['until']      as string | undefined;

    const conditions: string[] = [];
    const params: Record<string, unknown> = { limit, offset };

    // Time filter
    if (since) {
      const interval = parseInterval(since);
      if (interval) {
        conditions.push(`ts >= now() - INTERVAL ${interval}`);
      } else {
        conditions.push(`ts >= {since:String}`);
        params.since = since;
      }
    }
    if (until) {
      conditions.push(`ts <= {until:String}`);
      params.until = until;
    }

    if (category) { conditions.push(`category = {category:String}`); params.category = category; }
    if (source)   { conditions.push(`source = {source:String}`);     params.source   = source; }
    if (severity) { conditions.push(`severity = {severity:String}`); params.severity = severity; }
    if (channelId)  { conditions.push(`channel_id = {chId:String}`);   params.chId = channelId; }
    if (guildId)    { conditions.push(`guild_id = {gId:String}`);      params.gId  = guildId; }
    if (accountId)  { conditions.push(`account_id = {aId:String}`);    params.aId  = accountId; }
    if (accountIdx) { conditions.push(`account_idx = {aIdx:Int32}`);   params.aIdx = parseInt(accountIdx, 10); }
    if (q)          { conditions.push(`positionCaseInsensitive(message, {q:String}) > 0`); params.q = q; }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
      const [countResult, dataResult] = await Promise.all([
        ch.query({
          query: `SELECT count() AS total FROM ${CH_DB}.error_log ${where}`,
          query_params: params,
          format: 'JSONEachRow',
          clickhouse_settings: CH_QUERY_SAFETY,
        }),
        ch.query({
          query: `SELECT * FROM ${CH_DB}.error_log ${where} ORDER BY ts DESC LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
          query_params: params,
          format: 'JSONEachRow',
          clickhouse_settings: CH_QUERY_SAFETY,
        }),
      ]);
      const [{ total }] = await countResult.json<{ total: string }[]>();
      const rows = await dataResult.json<Record<string, unknown>[]>();
      return res.json({ errors: rows, total: Number(total), limit, offset });
    } catch (err: any) {
      console.error('[errors] Query failed:', err?.message);
      return res.status(500).json({ error: err?.message });
    }
  });

  // GET /errors/summary — category + severity counts for last N minutes/hours
  router.get('/summary', async (req: Request, res: Response) => {
    const since = req.query['since'] as string ?? '24h';
    const interval = parseInterval(since) ?? '24 HOUR';

    try {
      const [byCat, bySev, bySource, recentR] = await Promise.all([
        ch.query({
          query: `SELECT category, count() AS cnt FROM ${CH_DB}.error_log WHERE ts >= now() - INTERVAL ${interval} GROUP BY category ORDER BY cnt DESC`,
          format: 'JSONEachRow', clickhouse_settings: CH_QUERY_SAFETY,
        }),
        ch.query({
          query: `SELECT severity, count() AS cnt FROM ${CH_DB}.error_log WHERE ts >= now() - INTERVAL ${interval} GROUP BY severity ORDER BY cnt DESC`,
          format: 'JSONEachRow', clickhouse_settings: CH_QUERY_SAFETY,
        }),
        ch.query({
          query: `SELECT source, count() AS cnt FROM ${CH_DB}.error_log WHERE ts >= now() - INTERVAL ${interval} GROUP BY source ORDER BY cnt DESC`,
          format: 'JSONEachRow', clickhouse_settings: CH_QUERY_SAFETY,
        }),
        ch.query({
          query: `SELECT count() AS total, min(ts) AS oldest, max(ts) AS newest FROM ${CH_DB}.error_log WHERE ts >= now() - INTERVAL ${interval}`,
          format: 'JSONEachRow', clickhouse_settings: CH_QUERY_SAFETY,
        }),
      ]);

      const byCategory = await byCat.json();
      const bySeverity = await bySev.json();
      const bySourceData = await bySource.json();
      const [recent] = await recentR.json<Record<string, unknown>[]>();

      return res.json({ byCategory, bySeverity, bySource: bySourceData, ...recent, interval: since });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message });
    }
  });

  return router;
}

// Parse shorthand intervals: "1h" → "1 HOUR", "24h" → "24 HOUR", "7d" → "7 DAY", "30m" → "30 MINUTE"
function parseInterval(s: string): string | null {
  const m = s.match(/^(\d+)(m|h|d)$/i);
  if (!m) return null;
  const n = m[1];
  const unit = m[2].toLowerCase();
  if (unit === 'm') return `${n} MINUTE`;
  if (unit === 'h') return `${n} HOUR`;
  if (unit === 'd') return `${n} DAY`;
  return null;
}
