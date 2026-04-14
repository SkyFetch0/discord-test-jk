"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.messagesRouter = messagesRouter;
const express_1 = require("express");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const cassandra_driver_1 = require("cassandra-driver");
const name_resolve_1 = require("./name-resolve");
const discord_proxy_1 = require("../discord-proxy");
const KEYSPACE = process.env.SCYLLA_KEYSPACE ?? 'senneo';
const CH_DB = process.env.CLICKHOUSE_DB ?? 'senneo';
const BUCKET_MS = 86_400_000;
// P1-2: Safety limits for CH queries to prevent OOM/timeout at scale
const CH_QUERY_SAFETY = {
    max_execution_time: 10,
    max_rows_to_read: '0',
};
// ── Input validation helpers ──────────────────────────────────────────────────
function isValidSnowflake(s) {
    return /^\d{17,20}$/.test(s);
}
function parseLimit(raw, defaultVal = 50, max = 1000) {
    const n = parseInt(String(raw ?? defaultVal), 10);
    return isNaN(n) ? defaultVal : Math.max(1, Math.min(n, max));
}
function isValidIso(s) {
    return !isNaN(Date.parse(s));
}
// ── Row serialiser (Long → string, Date → ISO) ───────────────────────────────
function rowToJson(row) {
    const obj = {};
    for (const [key, val] of Object.entries(row)) {
        if (val instanceof cassandra_driver_1.types.Long)
            obj[key] = val.toString();
        else if (val instanceof Date)
            obj[key] = val.toISOString();
        else
            obj[key] = val;
    }
    return obj;
}
function messagesRouter(scylla, ch) {
    const router = (0, express_1.Router)();
    // ── GET /messages/count ───────────────────────────────────────────────────
    router.get('/count', async (_req, res) => {
        try {
            const result = await ch.query({
                query: `
          SELECT
            count()          AS total_messages,
            uniq(author_id)  AS unique_users,
            uniq(channel_id) AS unique_channels,
            uniq(guild_id)   AS unique_guilds,
            min(ts)          AS oldest_message,
            max(ts)          AS newest_message
          FROM ${CH_DB}.messages
        `,
                format: 'JSONEachRow',
                clickhouse_settings: CH_QUERY_SAFETY,
            });
            const rows = await result.json();
            return res.json(rows[0] ?? {});
        }
        catch (err) {
            console.error('[api] count error:', err);
            return res.status(500).json({ error: 'Internal error' });
        }
    });
    // ── GET /messages/search ──────────────────────────────────────────────────
    // Query params: q, limit, sort (newest|oldest), match (substring|whole),
    //               guildId, channelId, authorId, from, to
    // match=whole uses ClickHouse match() with word-boundary regex (\\b).
    // match=substring (default) uses positionCaseInsensitive (faster, index-friendly).
    router.get('/search', async (req, res) => {
        const { guildId, channelId, authorId, from, to, q } = req.query;
        const limit = parseLimit(req.query['limit'], 100, 1000);
        const sortDir = req.query['sort'] === 'oldest' ? 'ASC' : 'DESC';
        const matchMode = req.query['match'] === 'whole' ? 'whole' : 'substring';
        // Validate snowflake IDs
        for (const [name, val] of [['guildId', guildId], ['channelId', channelId], ['authorId', authorId]]) {
            if (val && !isValidSnowflake(val)) {
                return res.status(400).json({ error: `Invalid ${name} — must be a Discord snowflake` });
            }
        }
        // Validate dates
        for (const [name, val] of [['from', from], ['to', to]]) {
            if (val && !isValidIso(val)) {
                return res.status(400).json({ error: `Invalid ${name} — must be an ISO 8601 date` });
            }
        }
        const conditions = [];
        const params = {};
        if (guildId) {
            conditions.push('guild_id = {guildId:UInt64}');
            params['guildId'] = guildId;
        }
        if (channelId) {
            conditions.push('channel_id = {channelId:UInt64}');
            params['channelId'] = channelId;
        }
        if (authorId) {
            conditions.push('author_id = {authorId:UInt64}');
            params['authorId'] = authorId;
        }
        if (from) {
            conditions.push("ts >= {from:DateTime64(3,'UTC')}");
            params['from'] = from;
        }
        if (to) {
            conditions.push("ts <= {to:DateTime64(3,'UTC')}");
            params['to'] = to;
        }
        if (q) {
            if (matchMode === 'whole') {
                // Word-boundary match: \\b ensures the query appears as a distinct word.
                // ClickHouse match() uses re2 regex; (?i) = case-insensitive.
                // We escape regex metacharacters in user input to prevent injection.
                const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                conditions.push(`match(content, {qRegex:String})`);
                params['qRegex'] = `(?i)\\b${escaped}\\b`;
            }
            else {
                // Substring match (default) — faster, uses positionCaseInsensitive
                conditions.push('positionCaseInsensitive(content, {q:String}) > 0');
                params['q'] = q;
            }
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        try {
            const result = await ch.query({
                query: `
          SELECT message_id, channel_id, guild_id, author_id, author_name,
                 nick, content, ts, badge_mask, has_attachment, embed_count,
                 author_avatar, ref_msg_id, is_bot, display_name
          FROM ${CH_DB}.messages ${where}
          ORDER BY ts ${sortDir}
          LIMIT {limit:UInt32}
        `,
                query_params: { ...params, limit },
                format: 'JSONEachRow',
                clickhouse_settings: CH_QUERY_SAFETY,
            });
            const rows = await result.json();
            // Enrich with names (Scylla) + avatar/display_name/is_bot backfill (CH users_latest)
            await (0, name_resolve_1.enrichMessagesWithNames)(scylla, rows, ch);
            return res.json({ messages: rows, count: rows.length });
        }
        catch (err) {
            console.error('[api] search error:', err);
            return res.status(500).json({ error: 'Internal error' });
        }
    });
    // ── GET /messages/badges/counts — count users per badge bit ──────────────
    router.get('/badges/counts', async (_req, res) => {
        // Known badge bits to check
        const bits = [0, 1, 2, 3, 6, 7, 8, 9, 14, 17, 18, 22, 24, 25];
        try {
            const cases = bits.map(b => `countIf(bitAnd(badge_mask, bitShiftLeft(toUInt64(1), ${b})) != 0) AS b${b}`).join(',\n        ');
            const result = await ch.query({
                query: `SELECT ${cases} FROM ${CH_DB}.users_latest FINAL WHERE badge_mask != 0`,
                format: 'JSONEachRow',
                clickhouse_settings: CH_QUERY_SAFETY,
            });
            const rows = await result.json();
            const row = (rows[0] ?? {});
            const counts = {};
            for (const b of bits)
                counts[b] = Number(row[`b${b}`] ?? 0);
            return res.json({ counts, totalUsersWithBadges: Object.values(counts).reduce((a, b) => a + b, 0) });
        }
        catch (err) {
            console.error('[api] badge counts error:', err);
            return res.status(500).json({ error: 'Internal error' });
        }
    });
    // ── GET /messages/badges — users by badge mask ─────────────────────────────
    router.get('/badges', async (req, res) => {
        const { badgeMask } = req.query;
        if (!badgeMask)
            return res.status(400).json({ error: 'badgeMask is required' });
        if (!/^\d+$/.test(badgeMask))
            return res.status(400).json({ error: 'badgeMask must be a number' });
        const limit = parseLimit(req.query['limit'], 100, 5000);
        const mode = req.query['mode'] ?? 'all'; // 'all' = AND match, 'any' = OR match
        try {
            const whereClause = mode === 'any'
                ? `bitAnd(badge_mask, {mask:UInt64}) != 0`
                : `bitAnd(badge_mask, {mask:UInt64}) = {mask:UInt64}`;
            const result = await ch.query({
                query: `
          SELECT author_id, author_name, display_name, author_avatar, badge_mask, last_seen_ts, sample_guild, is_bot
          FROM ${CH_DB}.users_latest FINAL
          WHERE ${whereClause}
          ORDER BY last_seen_ts DESC
          LIMIT {limit:UInt32}
        `,
                query_params: { mask: badgeMask, limit },
                format: 'JSONEachRow',
                clickhouse_settings: CH_QUERY_SAFETY,
            });
            const rows = await result.json();
            return res.json({ users: rows, count: rows.length });
        }
        catch (err) {
            console.error('[api] badges error:', err);
            return res.status(500).json({ error: 'Internal error' });
        }
    });
    // ── POST /messages/badges/enrich — fetch Discord profiles to get full public_flags ──
    const ACCOUNTS_FILE = path_1.default.resolve(__dirname, '../../../../accounts.json');
    let _enrichJob = null;
    function discordGetUser(token, userId) {
        return (0, discord_proxy_1.discordApiGet)(`/users/${userId}`, { token, timeoutMs: 10_000 }).catch(() => null);
    }
    router.post('/badges/enrich', async (req, res) => {
        if (_enrichJob?.running)
            return res.json({ ok: false, message: 'Already running', ..._enrichJob });
        const limit = Math.min(parseInt(req.body?.limit ?? '5000', 10) || 5000, 50000);
        let tokens = [];
        try {
            tokens = JSON.parse(fs_1.default.readFileSync(ACCOUNTS_FILE, 'utf-8'))?.accounts?.map((a) => a.token) ?? [];
        }
        catch {
            return res.status(500).json({ error: 'Cannot read accounts.json' });
        }
        if (tokens.length === 0)
            return res.status(400).json({ error: 'No tokens available' });
        _enrichJob = { running: true, processed: 0, updated: 0, total: 0, errors: 0 };
        res.json({ ok: true, message: 'Enrichment started', limit });
        // Run in background
        (async () => {
            try {
                // Get users to enrich (most active first)
                const usersResult = await ch.query({
                    query: `SELECT author_id, badge_mask FROM ${CH_DB}.users_latest FINAL ORDER BY last_seen_ts DESC LIMIT {lim:UInt32}`,
                    query_params: { lim: limit },
                    format: 'JSONEachRow',
                });
                const users = await usersResult.json();
                _enrichJob.total = users.length;
                let tokenIdx = 0;
                const OFFICIAL_BITS_MASK = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 6) | (1 << 7) | (1 << 8) | (1 << 9) | (1 << 14) | (1 << 17) | (1 << 18) | (1 << 22);
                for (const user of users) {
                    if (!_enrichJob.running)
                        break;
                    const token = tokens[tokenIdx % tokens.length];
                    tokenIdx++;
                    try {
                        const profile = await discordGetUser(token, user.author_id);
                        if (profile?.public_flags != null) {
                            const oldMask = Number(user.badge_mask);
                            const customBits = oldMask & ~OFFICIAL_BITS_MASK; // preserve custom bits (24, 25)
                            const newOfficialBits = profile.public_flags & OFFICIAL_BITS_MASK;
                            const newMask = newOfficialBits | customBits;
                            if (newMask !== oldMask) {
                                await ch.command({
                                    query: `ALTER TABLE ${CH_DB}.users_latest UPDATE badge_mask = ${newMask} WHERE author_id = '${user.author_id}'`,
                                });
                                _enrichJob.updated++;
                            }
                        }
                    }
                    catch {
                        _enrichJob.errors++;
                    }
                    _enrichJob.processed++;
                    // Rate limit: ~2 requests per second per token, rotate tokens
                    await new Promise(r => setTimeout(r, 500));
                }
            }
            catch (err) {
                console.error('[badge-enrich] Fatal:', err);
            }
            finally {
                _enrichJob.running = false;
                console.log(`[badge-enrich] Done: ${_enrichJob.processed} processed, ${_enrichJob.updated} updated, ${_enrichJob.errors} errors`);
            }
        })();
    });
    router.get('/badges/enrich/status', async (_req, res) => {
        res.json(_enrichJob ?? { running: false, processed: 0, updated: 0, total: 0, errors: 0 });
    });
    // ── GET /messages/stats/:channelId ────────────────────────────────────────
    router.get('/stats/:channelId', async (req, res) => {
        const { channelId } = req.params;
        if (!isValidSnowflake(channelId))
            return res.status(400).json({ error: 'Invalid channelId' });
        try {
            const result = await ch.query({
                query: `
          SELECT
            date,
            message_count,
            unique_authors
          FROM ${CH_DB}.channel_daily_mv
          WHERE channel_id = {channelId:UInt64}
          ORDER BY date ASC
        `,
                query_params: { channelId },
                format: 'JSONEachRow',
            });
            const rows = await result.json();
            return res.json({ channelId, stats: rows });
        }
        catch (err) {
            // Fallback to raw table if MV isn't ready
            console.warn('[api] channel_daily_mv not ready, falling back to raw query');
            try {
                const result = await ch.query({
                    query: `
            SELECT toDate(ts) AS date, count() AS message_count, uniq(author_id) AS unique_authors
            FROM ${CH_DB}.messages
            WHERE channel_id = {channelId:UInt64}
            GROUP BY date ORDER BY date ASC
          `,
                    query_params: { channelId },
                    format: 'JSONEachRow',
                });
                const rows = await result.json();
                return res.json({ channelId, stats: rows });
            }
            catch (err2) {
                console.error('[api] stats error:', err2);
                return res.status(500).json({ error: 'Internal error' });
            }
        }
    });
    // ── GET /messages/author/:authorId ────────────────────────────────────────
    // NEW: find all messages by a specific author (uses Scylla messages_by_author)
    router.get('/author/:authorId', async (req, res) => {
        const { authorId } = req.params;
        if (!isValidSnowflake(authorId))
            return res.status(400).json({ error: 'Invalid authorId' });
        const limit = parseLimit(req.query['limit'], 50, 200);
        const beforeTs = req.query['before'] ? new Date(req.query['before']) : new Date();
        let bucket = Math.floor(beforeTs.getTime() / BUCKET_MS);
        try {
            const rows = [];
            while (rows.length < limit && bucket >= 0) {
                const result = await scylla.execute(`SELECT * FROM ${KEYSPACE}.messages_by_author
           WHERE author_id = ? AND bucket = ? AND ts < ?
           ORDER BY ts DESC, message_id DESC LIMIT ?`, [cassandra_driver_1.types.Long.fromString(authorId), bucket, beforeTs, limit - rows.length], { prepare: true });
                rows.push(...result.rows);
                bucket--;
                beforeTs.setTime(bucket * BUCKET_MS + BUCKET_MS);
            }
            return res.json({ messages: rows.map(rowToJson), count: rows.length });
        }
        catch (err) {
            console.error('[api] author lookup error:', err);
            return res.status(500).json({ error: 'Internal error' });
        }
    });
    // ── GET /messages/channel/:channelId  (cursor scroll via Scylla) ──────────
    router.get('/channel/:channelId', async (req, res) => {
        const { channelId } = req.params;
        if (!isValidSnowflake(channelId))
            return res.status(400).json({ error: 'Invalid channelId' });
        const limit = parseLimit(req.query['limit'], 50, 100);
        const beforeTs = req.query['before'] ? new Date(req.query['before']) : new Date();
        let bucket = Math.floor(beforeTs.getTime() / BUCKET_MS);
        try {
            const rows = [];
            let currentTs = new Date(beforeTs);
            while (rows.length < limit && bucket >= 0) {
                const result = await scylla.execute(`SELECT * FROM ${KEYSPACE}.messages_by_channel_bucket
           WHERE channel_id = ? AND bucket = ? AND ts < ?
           ORDER BY ts DESC, message_id DESC LIMIT ?`, [cassandra_driver_1.types.Long.fromString(channelId), bucket, currentTs, limit - rows.length], { prepare: true });
                rows.push(...result.rows);
                bucket--;
                currentTs = new Date(bucket * BUCKET_MS + BUCKET_MS);
            }
            const serialised = rows.map(rowToJson);
            const nextBefore = serialised.length > 0
                ? serialised[serialised.length - 1]['ts']
                : null;
            return res.json({
                messages: serialised,
                count: serialised.length,
                nextBefore, // Pagination cursor for the client
            });
        }
        catch (err) {
            console.error('[api] scroll error:', err);
            return res.status(500).json({ error: 'Internal error' });
        }
    });
    // ── GET /messages/context — reply chain resolution (F7) ──────────────────
    // Walks ref_msg_id chain upward. ?messageId=&depth= (default depth=5, max 10)
    router.get('/context', async (req, res) => {
        const messageId = (req.query['messageId'] ?? '').trim();
        if (!isValidSnowflake(messageId))
            return res.status(400).json({ error: 'Invalid messageId' });
        const depth = Math.min(Math.max(parseInt(req.query['depth'] ?? '5', 10) || 5, 1), 10);
        try {
            const chain = [];
            let currentId = messageId;
            for (let i = 0; i < depth; i++) {
                const result = await ch.query({
                    query: `
            SELECT message_id, channel_id, guild_id, author_id, author_name,
                   nick, content, ts, badge_mask, author_avatar, ref_msg_id
            FROM ${CH_DB}.messages
            WHERE message_id = {mid:UInt64}
            LIMIT 1
          `,
                    query_params: { mid: currentId },
                    format: 'JSONEachRow',
                    clickhouse_settings: CH_QUERY_SAFETY,
                });
                const rows = await result.json();
                if (rows.length === 0) {
                    // Message not found — add tombstone and stop
                    chain.push({ message_id: currentId, deleted: true });
                    break;
                }
                const msg = rows[0];
                chain.push(msg);
                // Follow ref_msg_id chain
                const refId = String(msg.ref_msg_id ?? '0');
                if (refId === '0' || refId === '' || refId === currentId)
                    break;
                currentId = refId;
            }
            // Enrich with names
            const enrichable = chain.filter(m => !m.deleted);
            await (0, name_resolve_1.enrichMessagesWithNames)(scylla, enrichable, ch);
            return res.json({ chain, depth: chain.length });
        }
        catch (err) {
            console.error('[api] context error:', err);
            return res.status(500).json({ error: 'Internal error' });
        }
    });
    // ── GET /messages/:messageId  (point lookup — must be last) ──────────────
    router.get('/:messageId', async (req, res) => {
        const { messageId } = req.params;
        if (!isValidSnowflake(messageId))
            return res.status(400).json({ error: 'Invalid messageId' });
        try {
            const result = await scylla.execute(`SELECT * FROM ${KEYSPACE}.messages_by_id WHERE message_id = ?`, [cassandra_driver_1.types.Long.fromString(messageId)], { prepare: true });
            if (result.rowLength === 0)
                return res.status(404).json({ error: 'Message not found' });
            return res.json(rowToJson(result.first()));
        }
        catch (err) {
            console.error('[api] point lookup error:', err);
            return res.status(500).json({ error: 'Internal error' });
        }
    });
    return router;
}
//# sourceMappingURL=messages.js.map