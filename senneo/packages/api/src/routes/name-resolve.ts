import { Client as CassandraClient } from 'cassandra-driver';
import { ClickHouseClient } from '@clickhouse/client';

const KEYSPACE = process.env.SCYLLA_KEYSPACE ?? 'senneo';
const CH_DB    = process.env.CLICKHOUSE_DB   ?? 'senneo';
const NAME_IN_CHUNK = 200;

/**
 * Batch lookup channel/guild names from Scylla name_cache.
 * Returns Map<id, name>. Scales to large ID lists via chunked IN queries.
 */
export async function fetchNamesByIds(
  scylla: CassandraClient,
  ids: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const uniq = [...new Set(ids)].filter(Boolean);
  for (let i = 0; i < uniq.length; i += NAME_IN_CHUNK) {
    const slice = uniq.slice(i, i + NAME_IN_CHUNK);
    const q = `SELECT id, name FROM ${KEYSPACE}.name_cache WHERE id IN (${slice.map(() => '?').join(',')})`;
    const result = await scylla.execute(q, slice);
    for (const row of result.rows) map.set(row['id'] as string, String(row['name'] ?? ''));
  }
  return map;
}

/**
 * Batch lookup guild icon hashes from Scylla name_cache.
 * Returns Map<guildId, iconHash>. Only returns rows where icon is set.
 */
export async function fetchIconsByIds(
  scylla: CassandraClient,
  ids: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const uniq = [...new Set(ids)].filter(Boolean);
  for (let i = 0; i < uniq.length; i += NAME_IN_CHUNK) {
    const slice = uniq.slice(i, i + NAME_IN_CHUNK);
    const q = `SELECT id, icon FROM ${KEYSPACE}.name_cache WHERE id IN (${slice.map(() => '?').join(',')})`;
    const result = await scylla.execute(q, slice);
    for (const row of result.rows) {
      const icon = row['icon'] as string | null | undefined;
      if (icon && icon !== '0' && icon !== 'null') map.set(row['id'] as string, icon);
    }
  }
  return map;
}

/**
 * Batch lookup user profile data (avatar, display_name, is_bot) from ClickHouse users_latest.
 * Used to backfill message rows where author_avatar is empty (old data before avatar collection).
 * Single query with IN clause — no N+1.
 */
interface UserProfile { author_avatar: string; display_name: string; is_bot: number }

async function fetchUserProfiles(
  ch: ClickHouseClient,
  authorIds: string[],
): Promise<Map<string, UserProfile>> {
  const map = new Map<string, UserProfile>();
  const uniq = [...new Set(authorIds)].filter(Boolean);
  if (uniq.length === 0) return map;

  // Chunk to avoid oversized IN clauses
  for (let i = 0; i < uniq.length; i += NAME_IN_CHUNK) {
    const slice = uniq.slice(i, i + NAME_IN_CHUNK);
    const placeholders = slice.map((_, idx) => `{a${idx}:UInt64}`).join(',');
    const params: Record<string, string> = {};
    slice.forEach((id, idx) => { params[`a${idx}`] = id; });

    try {
      const result = await ch.query({
        query: `SELECT author_id, author_avatar, display_name, is_bot
                FROM ${CH_DB}.users_latest FINAL
                WHERE author_id IN (${placeholders})`,
        query_params: params,
        format: 'JSONEachRow',
      });
      const rows = await result.json<Record<string, unknown>[]>();
      for (const row of rows) {
        map.set(String(row.author_id), {
          author_avatar: String(row.author_avatar ?? ''),
          display_name:  String(row.display_name ?? ''),
          is_bot:        Number(row.is_bot ?? 0),
        });
      }
    } catch {
      // Non-fatal: avatar enrichment failure shouldn't break the response
    }
  }

  // Second pass: for users with empty avatar in users_latest, try messages table
  const needsMsgFallback = uniq.filter(id => {
    const p = map.get(id);
    return !p || !p.author_avatar || p.author_avatar === '0';
  });
  if (needsMsgFallback.length > 0) {
    for (let i = 0; i < needsMsgFallback.length; i += NAME_IN_CHUNK) {
      const slice = needsMsgFallback.slice(i, i + NAME_IN_CHUNK);
      const placeholders = slice.map((_, idx) => `{b${idx}:UInt64}`).join(',');
      const params: Record<string, string> = {};
      slice.forEach((id, idx) => { params[`b${idx}`] = id; });
      try {
        const result = await ch.query({
          query: `SELECT author_id,
                         argMaxIf(author_avatar, ts, author_avatar != '' AND author_avatar != '0') AS best_avatar,
                         argMax(display_name, ts) AS best_display_name
                  FROM ${CH_DB}.messages
                  WHERE author_id IN (${placeholders})
                  GROUP BY author_id`,
          query_params: params,
          format: 'JSONEachRow',
        });
        const rows = await result.json<Record<string, unknown>[]>();
        for (const row of rows) {
          const aid = String(row.author_id);
          const bestAvatar = String(row.best_avatar ?? '');
          if (bestAvatar && bestAvatar !== '0') {
            const existing = map.get(aid);
            if (existing) {
              existing.author_avatar = bestAvatar;
              if (!existing.display_name && row.best_display_name) existing.display_name = String(row.best_display_name);
            } else {
              map.set(aid, { author_avatar: bestAvatar, display_name: String(row.best_display_name ?? ''), is_bot: 0 });
            }
          }
        }
      } catch { /* non-fatal */ }
    }
  }

  return map;
}

/**
 * Enrich an array of message rows (from ClickHouse) with:
 *   1. channel_name / guild_name from Scylla name_cache
 *   2. author_avatar / display_name / is_bot from CH users_latest (when ch provided)
 *
 * Avatar priority: message row hash (non-empty) > users_latest hash > empty (frontend fallback).
 * Mutates rows in-place and returns them.
 */
export async function enrichMessagesWithNames<T extends Record<string, unknown>>(
  scylla: CassandraClient,
  rows: T[],
  ch?: ClickHouseClient,
): Promise<T[]> {
  if (rows.length === 0) return rows;

  // 1. Channel/guild name enrichment (Scylla)
  const channelIds = rows.map(r => String(r.channel_id ?? '')).filter(Boolean);
  const guildIds   = rows.map(r => String(r.guild_id ?? '')).filter(Boolean);
  const allIds     = [...new Set([...channelIds, ...guildIds])];
  const names = await fetchNamesByIds(scylla, allIds);

  // 2. Avatar/profile enrichment (ClickHouse users_latest) — only if ch provided
  //    Collect author_ids that need backfill (empty author_avatar in message row)
  let profiles: Map<string, UserProfile> | null = null;
  if (ch) {
    const needsBackfill = [...new Set(
      rows
        .filter(r => !r.author_avatar || String(r.author_avatar) === '' || String(r.author_avatar) === '0')
        .map(r => String(r.author_id ?? ''))
        .filter(Boolean)
    )];
    if (needsBackfill.length > 0) {
      profiles = await fetchUserProfiles(ch, needsBackfill);
    }
  }

  // 3. Apply enrichment to each row
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const cid = String(r.channel_id ?? '');
    const gid = String(r.guild_id ?? '');
    const aid = String(r.author_id ?? '');

    r['channel_name'] = names.get(cid) ?? null;
    r['guild_name']   = names.get(gid) ?? null;

    // Avatar backfill: only if message row's author_avatar is empty
    if (profiles && (!r['author_avatar'] || String(r['author_avatar']) === '' || String(r['author_avatar']) === '0')) {
      const profile = profiles.get(aid);
      if (profile) {
        if (profile.author_avatar) r['author_avatar'] = profile.author_avatar;
        if (profile.display_name)  r['display_name']  = profile.display_name;
        // is_bot backfill: only if row doesn't already have it set to non-zero
        if (!r['is_bot'] || Number(r['is_bot']) === 0) {
          r['is_bot'] = profile.is_bot;
        }
      }
    }
  }

  return rows;
}
