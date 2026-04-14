"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.liveRouter = liveRouter;
const express_1 = require("express");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const scrape_control_1 = require("../scrape-control");
const name_resolve_1 = require("./name-resolve");
const CH_DB = process.env.CLICKHOUSE_DB ?? 'senneo';
const KEYSPACE = process.env.SCYLLA_KEYSPACE ?? 'senneo';
// P1-2: Safety limits for CH queries to prevent OOM/timeout at scale
const CH_QUERY_SAFETY = {
    max_execution_time: 10,
    max_rows_to_read: '0',
};
// P1 FIX #11+12: Single shared cache, refreshed by background timer
// SSE clients just read from cache  no more N3 queries/s
let _cache = null;
let _cacheTs = 0;
let _refreshTimer = null;
// SCALE FIX: At 90K channels, 3 full ScyllaDB table scans per second is too aggressive.
// 3s interval cuts ScyllaDB load 3x with no visible UX difference (SSE stream stays fast).
const REFRESH_INTERVAL = parseInt(process.env.LIVE_REFRESH_MS ?? '3000', 10);
// SCALE FIX: Name+icon enrichment TTL cache.
// Without this: 900+ ScyllaDB IN-clause queries per second at 90K channels.
// With this: queries run at most every NAME_CACHE_TTL ms.
let _nameMap = null;
let _iconMap = null;
let _nameCacheTs = 0;
const NAME_CACHE_TTL = parseInt(process.env.NAME_CACHE_TTL_MS ?? '30000', 10); // 30s
/** scrape_stats is only rewritten when the channel is "dirty"; if scraping stops, msgs_per_sec stays stale forever. */
function effectiveMsgsPerSec(mergedComplete, rawMps, lastUpdated) {
    if (mergedComplete)
        return 0;
    if (rawMps <= 0)
        return 0;
    if (!lastUpdated)
        return rawMps;
    const ageMs = Date.now() - lastUpdated.getTime();
    return ageMs > 45_000 ? 0 : rawMps;
}
function computeScrapePhase(c) {
    if (c.schedulerState === 'completed')
        return 'done';
    if (c.schedulerState === 'running')
        return 'active';
    if (c.schedulerState === 'queued')
        return 'queued';
    if (c.schedulerState === 'error_retryable' || c.schedulerState === 'error_terminal')
        return 'error';
    if (c.schedulerState === 'paused')
        return 'idle';
    if (c.complete)
        return 'done';
    if (c.msgsPerSec > 0)
        return 'active';
    if (c.errors?.length > 0)
        return 'error';
    if (c.totalScraped === 0 && (c.progress ?? 0) === 0)
        return 'queued';
    return 'idle';
}
async function buildStats(scylla) {
    try {
        const [statsResult, targetsResult, checkpointsResult, pausedAccounts, pausedChannels] = await Promise.all([
            scylla.execute(`SELECT * FROM ${KEYSPACE}.scrape_stats`),
            scylla.execute(`SELECT channel_id, guild_id, label, account_id, pinned_account_id FROM ${KEYSPACE}.scrape_targets`),
            scylla.execute(`SELECT channel_id, total_scraped, complete, newest_message_id, cursor_id FROM ${KEYSPACE}.scrape_checkpoints`),
            (0, scrape_control_1.readPausedAccounts)(scylla),
            (0, scrape_control_1.readPausedChannels)(scylla),
        ]);
        const channels = {};
        let totalScraped = 0, msgsPerSec = 0;
        const rateLimitLog = [];
        // Build target lookup for active runtime account_id + owner account_id
        const targetAccId = {};
        const targetOwnerAccId = {};
        const targetGuild = {};
        const targetLabel = {};
        for (const row of targetsResult.rows) {
            const cid = row['channel_id'];
            if (row['account_id'] != null)
                targetAccId[cid] = row['account_id'];
            if (row['pinned_account_id'] != null)
                targetOwnerAccId[cid] = row['pinned_account_id'];
            targetGuild[cid] = row['guild_id'] ?? '';
            targetLabel[cid] = row['label'] ?? '';
        }
        const cpMap = {};
        for (const row of checkpointsResult.rows) {
            cpMap[row['channel_id']] = {
                totalScraped: Number(row['total_scraped'] ?? 0),
                complete: row['complete'] ?? false,
                newestId: row['newest_message_id'] ?? undefined,
                cursorId: row['cursor_id'] ?? undefined,
            };
        }
        const calcProgress = (channelId, cp) => {
            if (!cp)
                return 0;
            if (cp.complete)
                return 100;
            // If no cursor yet = just started or not started  0%
            if (!cp.newestId || !cp.cursorId)
                return 0;
            // If cursor === newest  we haven't moved yet  0%
            if (cp.cursorId === cp.newestId)
                return 0;
            try {
                const newestMs = Number(BigInt(cp.newestId) >> 22n) + 1420070400000;
                const cursorMs = Number(BigInt(cp.cursorId) >> 22n) + 1420070400000;
                const channelMs = Number(BigInt(channelId) >> 22n) + 1420070400000;
                // Sanity checks
                if (newestMs <= channelMs)
                    return 0;
                if (cursorMs >= newestMs)
                    return 0; // cursor ahead of newest = bug
                if (cursorMs <= channelMs)
                    return 99; // cursor before channel creation = nearly done
                // Progress = how far back we've gone from newest toward channel creation
                const totalRange = newestMs - channelMs;
                const scraped = newestMs - cursorMs;
                if (scraped <= 0 || totalRange <= 0)
                    return 0;
                const pct = Math.round((scraped / totalRange) * 100);
                return Math.max(0, Math.min(99, pct)); // cap at 99  only complete=true gives 100
            }
            catch {
                return 0;
            }
        };
        const statsIds = new Set();
        for (const row of statsResult.rows) {
            const id = row['channel_id'];
            const ts = Number(row['total_scraped'] ?? 0);
            const rawMps = Number(row['msgs_per_sec'] ?? 0);
            const rl = Number(row['rate_limit_hits'] ?? 0);
            statsIds.add(id);
            const cp = cpMap[id];
            const mergedComplete = Boolean(row['complete']) || Boolean(cp?.complete);
            const lu = row['last_updated'];
            const mps = effectiveMsgsPerSec(mergedComplete, rawMps, lu);
            const prog = mergedComplete ? 100 : calcProgress(id, cp);
            const totalSc = Math.max(ts, cp?.totalScraped ?? 0);
            const errs = row['errors'] ?? [];
            const ownerAccountId = targetOwnerAccId[id] ?? targetAccId[id] ?? undefined;
            const pauseIntent = (0, scrape_control_1.buildPauseIntentView)(ownerAccountId, id, pausedAccounts, pausedChannels);
            const schedulerState = row['scheduler_state'] ?? null;
            channels[id] = {
                channelId: id, guildId: row['guild_id'] ?? '',
                totalScraped: totalSc, lastBatchSize: 100, msgsPerSec: mps,
                rateLimitHits: rl, errors: errs,
                lastUpdated: lu?.toISOString() ?? '',
                complete: mergedComplete,
                accountId: row['account_id'] ?? targetAccId[id] ?? undefined,
                ownerAccountId,
                channelLabel: targetLabel[id] ?? '',
                progress: prog,
                schedulerState,
                pauseSource: row['pause_source'] ?? 'none',
                stateUpdatedAt: row['state_updated_at']?.toISOString?.() ?? null,
                stateReason: row['state_reason'] ?? null,
                workerId: row['worker_id'] ?? null,
                leaseExpiresAt: row['lease_expires_at']?.toISOString?.() ?? null,
                lastErrorClass: row['last_error_class'] ?? null,
                lastErrorCode: row['last_error_code'] ?? null,
                lastErrorAt: row['last_error_at']?.toISOString?.() ?? null,
                pauseRequested: pauseIntent.pauseRequested,
                accountPauseRequested: pauseIntent.accountPauseRequested,
                channelPauseRequested: pauseIntent.channelPauseRequested,
                requestedPauseSource: pauseIntent.requestedPauseSource,
                pauseReason: pauseIntent.pauseReason,
                pauseRequestedBy: pauseIntent.pauseRequestedBy,
                pauseRequestedAt: pauseIntent.pauseRequestedAt,
                pauseRequestId: pauseIntent.pauseRequestId,
                pauseAcknowledged: (0, scrape_control_1.isPauseAcknowledged)(schedulerState, mergedComplete, pauseIntent.pauseRequested),
                scrapePhase: computeScrapePhase({ complete: mergedComplete, msgsPerSec: mps, errors: errs, totalScraped: totalSc, progress: prog, schedulerState }),
            };
            totalScraped += totalSc;
            msgsPerSec += mps;
            if (rl > 0)
                rateLimitLog.push({ ts: row['last_updated']?.toISOString(), channelId: id, waitMs: 0 });
        }
        for (const row of targetsResult.rows) {
            const id = row['channel_id'];
            if (statsIds.has(id))
                continue;
            const cp = cpMap[id];
            const cpTotal = cp?.totalScraped ?? 0;
            const mergedComplete2 = Boolean(cp?.complete);
            const prog2 = mergedComplete2 ? 100 : calcProgress(id, cp);
            const ownerAccountId = (row['pinned_account_id'] ?? row['account_id'] ?? targetOwnerAccId[id] ?? targetAccId[id] ?? undefined);
            const pauseIntent = (0, scrape_control_1.buildPauseIntentView)(ownerAccountId, id, pausedAccounts, pausedChannels);
            channels[id] = {
                channelId: id, guildId: row['guild_id'] ?? '',
                totalScraped: cpTotal,
                lastBatchSize: 0,
                msgsPerSec: 0,
                rateLimitHits: 0,
                errors: [],
                lastUpdated: new Date().toISOString(),
                complete: mergedComplete2,
                accountId: row['account_id'] ?? undefined,
                ownerAccountId,
                channelLabel: targetLabel[id] ?? '',
                progress: prog2,
                schedulerState: null,
                pauseSource: 'none',
                stateUpdatedAt: null,
                stateReason: null,
                workerId: null,
                leaseExpiresAt: null,
                lastErrorClass: null,
                lastErrorCode: null,
                lastErrorAt: null,
                pauseRequested: pauseIntent.pauseRequested,
                accountPauseRequested: pauseIntent.accountPauseRequested,
                channelPauseRequested: pauseIntent.channelPauseRequested,
                requestedPauseSource: pauseIntent.requestedPauseSource,
                pauseReason: pauseIntent.pauseReason,
                pauseRequestedBy: pauseIntent.pauseRequestedBy,
                pauseRequestedAt: pauseIntent.pauseRequestedAt,
                pauseRequestId: pauseIntent.pauseRequestId,
                pauseAcknowledged: (0, scrape_control_1.isPauseAcknowledged)(null, mergedComplete2, pauseIntent.pauseRequested),
                scrapePhase: computeScrapePhase({ complete: mergedComplete2, msgsPerSec: 0, errors: [], totalScraped: cpTotal, progress: prog2, schedulerState: null }),
            };
            totalScraped += cpTotal;
        }
        // Enrich with channel/guild names and guild icons from name_cache
        // SCALE FIX: cache the name/icon maps with TTL — avoid 900+ Scylla queries/s at 90K channels
        const now = Date.now();
        if (!_nameMap || !_iconMap || now - _nameCacheTs > NAME_CACHE_TTL) {
            const nameIds = [];
            const guildIds = new Set();
            for (const ch of Object.values(channels)) {
                const gid = String(ch['guildId'] ?? '');
                const cid = String(ch['channelId'] ?? '');
                if (gid) {
                    nameIds.push(gid);
                    guildIds.add(gid);
                }
                if (cid)
                    nameIds.push(cid);
            }
            const [freshNames, freshIcons] = await Promise.all([
                (0, name_resolve_1.fetchNamesByIds)(scylla, nameIds),
                (0, name_resolve_1.fetchIconsByIds)(scylla, [...guildIds]),
            ]);
            _nameMap = freshNames;
            _iconMap = freshIcons;
            _nameCacheTs = now;
        }
        const nameMap = _nameMap;
        const iconMap = _iconMap;
        for (const [id, ch] of Object.entries(channels)) {
            ch['channelName'] = nameMap.get(id) || id;
            const gid = String(ch['guildId'] ?? '');
            ch['guildName'] = nameMap.get(gid) || '';
            ch['guildIcon'] = iconMap.get(gid) ?? null;
        }
        return { startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), totalScraped, msgsPerSec, channels, rateLimitLog };
    }
    catch {
        return _cache ?? { status: 'scraper_not_running', channels: {}, rateLimitLog: [] };
    }
}
function startRefresh(scylla) {
    if (_refreshTimer)
        return;
    // Initial fetch
    buildStats(scylla).then(s => { _cache = s; _cacheTs = Date.now(); }).catch(() => { });
    _refreshTimer = setInterval(async () => {
        try {
            _cache = await buildStats(scylla);
            _cacheTs = Date.now();
        }
        catch { /* keep stale cache */ }
    }, REFRESH_INTERVAL);
}
function getCachedChannels() {
    if (!_cache)
        return [];
    const ch = _cache['channels'];
    return ch ? Object.values(ch) : [];
}
function buildSummaryFromCache() {
    const all = getCachedChannels();
    const phaseCounts = { done: 0, active: 0, idle: 0, queued: 0, error: 0 };
    const schedulerCounts = { queued: 0, running: 0, paused: 0, completed: 0, error_retryable: 0, error_terminal: 0 };
    let totalScraped = 0, msgsPerSec = 0;
    const guildSet = new Set();
    let pauseRequestedCount = 0;
    let pauseAcknowledgedCount = 0;
    for (const ch of all) {
        const phase = String(ch['scrapePhase'] ?? 'queued');
        phaseCounts[phase] = (phaseCounts[phase] ?? 0) + 1;
        const schedulerState = String(ch['schedulerState'] ?? '');
        if (schedulerState)
            schedulerCounts[schedulerState] = (schedulerCounts[schedulerState] ?? 0) + 1;
        totalScraped += Number(ch['totalScraped'] ?? 0);
        msgsPerSec += Number(ch['msgsPerSec'] ?? 0);
        const gid = String(ch['guildId'] ?? '');
        if (gid)
            guildSet.add(gid);
        if (Boolean(ch['pauseRequested']))
            pauseRequestedCount++;
        if (Boolean(ch['pauseAcknowledged']))
            pauseAcknowledgedCount++;
    }
    return {
        totalScraped,
        msgsPerSec,
        totalChannels: all.length,
        totalGuilds: guildSet.size,
        phaseCounts,
        schedulerCounts,
        pauseRequestedCount,
        pauseAcknowledgedCount,
        updatedAt: _cache?.['updatedAt'] ?? new Date().toISOString(),
        startedAt: _cache?.['startedAt'] ?? new Date().toISOString(),
    };
}
function filterChannels(all, opts) {
    let filtered = all;
    // Phase filter
    if (opts.phase && opts.phase !== 'all') {
        filtered = filtered.filter(c => String(c['scrapePhase'] ?? '') === opts.phase);
    }
    // Guild filter
    if (opts.guildId) {
        filtered = filtered.filter(c => String(c['guildId'] ?? '') === opts.guildId);
    }
    // Account filter
    if (opts.accountId) {
        filtered = filtered.filter(c => String(c['accountId'] ?? '') === opts.accountId);
    }
    if (opts.schedulerState && opts.schedulerState !== 'all') {
        filtered = filtered.filter(c => String(c['schedulerState'] ?? '') === opts.schedulerState);
    }
    if (opts.pauseSource && opts.pauseSource !== 'all') {
        filtered = filtered.filter(c => String(c['pauseSource'] ?? '') === opts.pauseSource);
    }
    if (opts.requestedPauseSource && opts.requestedPauseSource !== 'all') {
        filtered = filtered.filter(c => String(c['requestedPauseSource'] ?? '') === opts.requestedPauseSource);
    }
    if (opts.pauseRequested != null && opts.pauseRequested !== '' && opts.pauseRequested !== 'all') {
        const desired = ['1', 'true', 'yes'].includes(opts.pauseRequested.toLowerCase());
        filtered = filtered.filter(c => Boolean(c['pauseRequested']) === desired);
    }
    // Search (channel name, guild name, channel ID, guild ID)
    if (opts.q) {
        const q = opts.q.toLowerCase();
        filtered = filtered.filter(c => String(c['channelName'] ?? '').toLowerCase().includes(q) ||
            String(c['guildName'] ?? '').toLowerCase().includes(q) ||
            String(c['channelId'] ?? '').toLowerCase().includes(q) ||
            String(c['guildId'] ?? '').toLowerCase().includes(q) ||
            String(c['channelLabel'] ?? '').toLowerCase().includes(q));
    }
    const totalFiltered = filtered.length;
    // Sort with stable tie-breaking (guildId → channelId) to prevent row jumps on refresh
    const sortKey = opts.sort ?? 'msgsPerSec';
    const desc = !opts.sort?.startsWith('+');
    const key = sortKey.replace(/^[+-]/, '');
    filtered.sort((a, b) => {
        const av = a[key], bv = b[key];
        let cmp;
        if (typeof av === 'number' && typeof bv === 'number')
            cmp = desc ? bv - av : av - bv;
        else
            cmp = desc ? String(bv ?? '').localeCompare(String(av ?? '')) : String(av ?? '').localeCompare(String(bv ?? ''));
        if (cmp !== 0)
            return cmp;
        // Stable tie-break: guildId asc, then channelId asc
        const ga = String(a['guildId'] ?? ''), gb = String(b['guildId'] ?? '');
        if (ga !== gb)
            return ga.localeCompare(gb);
        return String(a['channelId'] ?? '').localeCompare(String(b['channelId'] ?? ''));
    });
    // Paginate
    const page = filtered.slice(opts.offset, opts.offset + opts.limit);
    return { channels: page, total: all.length, filtered: totalFiltered };
}
// ── Scraper event log file reader (written by accounts process) ──────────────
const SCRAPER_LOG_FILE = path_1.default.resolve(process.cwd(), 'scraper_events.json');
let _logCache = null;
let _logCacheMtime = 0;
async function readScraperLog() {
    try {
        const stat = await fs_1.default.promises.stat(SCRAPER_LOG_FILE);
        if (stat.mtimeMs === _logCacheMtime && _logCache)
            return _logCache;
        const raw = await fs_1.default.promises.readFile(SCRAPER_LOG_FILE, 'utf-8');
        _logCache = JSON.parse(raw);
        _logCacheMtime = stat.mtimeMs;
        return _logCache;
    }
    catch {
        return null;
    }
}
// ── Router ───────────────────────────────────────────────────────────────────
function liveRouter(ch, scylla) {
    startRefresh(scylla);
    const router = (0, express_1.Router)();
    // Full cache (backwards compat) — avoid at 100K+ channels
    router.get('/', async (_req, res) => {
        if (!_cache)
            _cache = await buildStats(scylla);
        return res.json(_cache);
    });
    // ── GET /live/channels — server-side filter/search/pagination ────────────
    // Scales to 100K+ channels: dashboard fetches pages, not the full blob.
    router.get('/channels', (_req, res) => {
        const limit = Math.min(Math.max(parseInt(_req.query['limit'] ?? '50', 10) || 50, 1), 200);
        const offset = Math.max(parseInt(_req.query['offset'] ?? '0', 10) || 0, 0);
        const phase = _req.query['phase'];
        const guildId = _req.query['guildId'];
        const accountId = _req.query['accountId'];
        const schedulerState = _req.query['schedulerState'];
        const pauseRequested = _req.query['pauseRequested'];
        const pauseSource = _req.query['pauseSource'];
        const requestedPauseSource = _req.query['requestedPauseSource'];
        const q = _req.query['q'];
        const sort = _req.query['sort'];
        const all = getCachedChannels();
        const result = filterChannels(all, { phase, guildId, accountId: accountId || undefined, schedulerState, pauseRequested, pauseSource, requestedPauseSource, q, sort, limit, offset });
        return res.json(result);
    });
    // ── GET /live/guilds — unique guilds with channel counts ─────────────────
    router.get('/guilds', (_req, res) => {
        const all = getCachedChannels();
        const guildMap = new Map();
        for (const ch of all) {
            const gid = String(ch['guildId'] ?? '');
            if (!gid)
                continue;
            const existing = guildMap.get(gid);
            if (!existing) {
                guildMap.set(gid, {
                    guildId: gid,
                    guildName: String(ch['guildName'] ?? ''),
                    channelCount: 1,
                    activeCount: ch['scrapePhase'] === 'active' ? 1 : 0,
                    totalScraped: Number(ch['totalScraped'] ?? 0),
                });
            }
            else {
                existing.channelCount++;
                if (ch['scrapePhase'] === 'active')
                    existing.activeCount++;
                existing.totalScraped += Number(ch['totalScraped'] ?? 0);
                if (!existing.guildName)
                    existing.guildName = String(ch['guildName'] ?? '');
            }
        }
        const guilds = [...guildMap.values()].sort((a, b) => b.totalScraped - a.totalScraped);
        return res.json({ guilds, total: guilds.length });
    });
    router.get('/ratelimits', (_req, res) => {
        return res.json(_cache?.['rateLimitLog'] ?? []);
    });
    // ── GET /live/scraper-log — structured event log from accounts process ─────
    // Reads shared file written by accounts ring buffer (async, mtime-cached).
    router.get('/scraper-log', async (req, res) => {
        const since = parseInt(req.query['since'] ?? '0', 10) || 0;
        const limit = Math.min(parseInt(req.query['limit'] ?? '100', 10) || 100, 500);
        const typeFilter = req.query['type'];
        const log = await readScraperLog();
        if (!log)
            return res.json({ events: [], cursor: 0, stats: null });
        let events = log.events;
        if (since > 0)
            events = events.filter(e => e.id > since);
        if (typeFilter)
            events = events.filter(e => e.type === typeFilter);
        const page = events.slice(-limit);
        const cursor = page.length > 0 ? page[page.length - 1].id : since;
        return res.json({ events: page, cursor, stats: log.stats });
    });
    router.get('/recent', async (req, res) => {
        const limit = Math.min(parseInt(req.query['limit'] ?? '20'), 100);
        const channelId = req.query['channelId'];
        const where = channelId ? 'WHERE channel_id = {channelId:UInt64}' : '';
        try {
            const result = await ch.query({
                query: `SELECT message_id, channel_id, guild_id, author_id, author_name,
                       nick, content, ts, badge_mask, author_avatar, ref_msg_id
                FROM ${CH_DB}.messages ${where}
                ORDER BY inserted_at DESC LIMIT {limit:UInt32}`,
                query_params: { ...(channelId ? { channelId } : {}), limit },
                format: 'JSONEachRow',
            });
            const rows = await result.json();
            return res.json({ messages: rows, count: rows.length });
        }
        catch (err) {
            console.error('[api] recent error:', err);
            return res.status(500).json({ error: 'Internal error' });
        }
    });
    // ── SSE: lightweight summary only (phase counts + totals) ───────────────
    // At 100K+ channels, streaming full channel list = 50MB+/s bandwidth.
    // Dashboard uses /live/channels REST for paginated channel data.
    router.get('/stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        const sendSummary = () => {
            const summary = buildSummaryFromCache();
            res.write(`data: ${JSON.stringify(summary)}\n\n`);
        };
        // Send immediately
        sendSummary();
        // Then push whenever cache updates
        let lastSent = _cacheTs;
        const interval = setInterval(() => {
            if (_cacheTs > lastSent) {
                sendSummary();
                lastSent = _cacheTs;
            }
        }, 500);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000);
        req.on('close', () => { clearInterval(interval); clearInterval(heartbeat); });
    });
    // ── GET /live/messages/stream — F2: SSE real-time message feed ───────────
    // Pushes new messages as they appear in ClickHouse (via inserted_at cursor).
    // Client sends ?since=<message_id> to resume from last known position.
    // Rate limited: max 1 poll/s server-side; client should use visibilitychange to pause.
    router.get('/messages/stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        let lastSeenId = req.query['since'] ?? '0';
        let closed = false;
        const poll = async () => {
            if (closed)
                return;
            try {
                const result = await ch.query({
                    query: `SELECT message_id, channel_id, guild_id, author_id, author_name,
                         nick, content, ts, badge_mask, author_avatar, ref_msg_id
                  FROM ${CH_DB}.messages
                  WHERE message_id > {since:UInt64}
                  ORDER BY inserted_at DESC
                  LIMIT 50`,
                    query_params: { since: lastSeenId },
                    format: 'JSONEachRow',
                });
                const rows = await result.json();
                if (rows.length > 0) {
                    await (0, name_resolve_1.enrichMessagesWithNames)(scylla, rows);
                    // Update cursor to newest message_id
                    const maxId = rows.reduce((max, r) => {
                        const mid = String(r.message_id ?? '0');
                        return BigInt(mid) > BigInt(max) ? mid : max;
                    }, lastSeenId);
                    lastSeenId = maxId;
                    res.write(`data: ${JSON.stringify({ messages: rows, cursor: lastSeenId })}\n\n`);
                }
            }
            catch {
                // Non-fatal — just skip this poll cycle
            }
        };
        // Initial fetch
        poll();
        const interval = setInterval(poll, 1000);
        const heartbeat = setInterval(() => { if (!closed)
            res.write(': heartbeat\n\n'); }, 25_000);
        req.on('close', () => {
            closed = true;
            clearInterval(interval);
            clearInterval(heartbeat);
        });
    });
    // ── GET /live/stream/full — legacy full SSE (opt-in, not default) ────────
    router.get('/stream/full', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        res.write(`data: ${JSON.stringify(_cache ?? { status: 'loading' })}\n\n`);
        let lastSent = _cacheTs;
        const interval = setInterval(() => {
            if (_cacheTs > lastSent) {
                res.write(`data: ${JSON.stringify(_cache)}\n\n`);
                lastSent = _cacheTs;
            }
        }, 500);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000);
        req.on('close', () => { clearInterval(interval); clearInterval(heartbeat); });
    });
    router.get('/summary', async (_req, res) => {
        try {
            const result = await ch.query({
                query: `SELECT count() AS db_total_messages, uniq(guild_id) AS db_total_guilds,
                       uniq(channel_id) AS db_total_channels, uniq(author_id) AS db_total_authors,
                       uniqIf(author_id, is_bot = 0) AS db_human_authors,
                       countIf(is_bot = 1) AS db_bot_messages,
                       min(ts) AS oldest_ts, max(ts) AS newest_ts, max(inserted_at) AS last_insert_ts
                FROM ${CH_DB}.messages`,
                format: 'JSONEachRow',
                clickhouse_settings: CH_QUERY_SAFETY,
            });
            const [dbStats] = await result.json();
            return res.json({ database: dbStats ?? {}, scraper: buildSummaryFromCache() });
        }
        catch (err) {
            console.error('[api] summary error:', err);
            return res.status(500).json({ error: 'Internal error' });
        }
    });
    return router;
}
//# sourceMappingURL=live.js.map