"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureChannel = ensureChannel;
exports.initChannel = initChannel;
exports.setRuntimeState = setRuntimeState;
exports.getRuntimeState = getRuntimeState;
exports.flushStats = flushStats;
exports.recordBatch = recordBatch;
exports.recordRateLimit = recordRateLimit;
exports.recordError = recordError;
exports.recordComplete = recordComplete;
exports.removeChannel = removeChannel;
exports.activeChannelCount = activeChannelCount;
exports.readAllStats = readAllStats;
const db_1 = require("./db");
const KEYSPACE = process.env.SCYLLA_KEYSPACE ?? 'senneo';
const ROLLING_WIN = 10;
const TRANSIENT_LEASE_MS = parseInt(process.env.SCRAPER_RUNTIME_LEASE_MS ?? '45000', 10);
const LEASE_RENEW_MS = Math.max(5_000, Math.floor(TRANSIENT_LEASE_MS / 3));
function envFlag(name, defaultValue) {
    const raw = process.env[name];
    if (raw == null)
        return defaultValue;
    return ['true', '1', 'yes', 'on'].includes(raw.toLowerCase());
}
function envPositiveInt(name, defaultValue) {
    const parsed = parseInt(process.env[name] ?? `${defaultValue}`, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}
const _totals = {};
const _rl = {};
const _errors = {};
const _complete = {};
const _guildId = {};
const _accountId = {};
const _rolling = {};
const _schedulerState = {};
const _pauseSource = {};
const _stateUpdatedAt = {};
const _stateReason = {};
const _workerId = {};
const _leaseExpiresAt = {};
const _lastErrorClass = {};
const _lastErrorCode = {};
const _lastErrorAt = {};
const _transient = new Set();
let _dirty = new Set();
let _timer = null;
let _leaseTimer = null;
let _flushing = false;
const BOUNDED_FLUSH_ENABLED = envFlag('SCRAPER_BOUNDED_STATS_FLUSH_ENABLED', true);
const FLUSH_CONCURRENCY = envPositiveInt('SCRAPER_STATS_FLUSH_CONCURRENCY', 16);
function toDateOrNull(value) {
    if (!value)
        return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}
async function runWithConcurrency(ids, concurrency, worker) {
    let index = 0;
    const width = Math.max(1, Math.min(concurrency, ids.length || 1));
    await Promise.all(Array.from({ length: width }, async () => {
        while (true) {
            const id = ids[index++];
            if (id == null)
                return;
            await worker(id);
        }
    }));
}
function renewLease(channelId) {
    const state = _schedulerState[channelId];
    if (state !== 'queued' && state !== 'running')
        return;
    _leaseExpiresAt[channelId] = new Date(Date.now() + TRANSIENT_LEASE_MS).toISOString();
    _dirty.add(channelId);
}
async function flushDirty() {
    if (_dirty.size === 0)
        return;
    if (_flushing)
        return;
    _flushing = true;
    try {
        while (_dirty.size > 0) {
            const ids = [..._dirty];
            _dirty = new Set();
            const failed = [];
            try {
                const db = await (0, db_1.getDb)();
                const concurrency = BOUNDED_FLUSH_ENABLED
                    ? Math.min(FLUSH_CONCURRENCY, Math.max(ids.length, 1))
                    : Math.max(ids.length, 1);
                await runWithConcurrency(ids, concurrency, async (id) => {
                    const now = Date.now();
                    const win = _rolling[id] ?? [];
                    const dur = win.length > 1 ? (now - win[0].ts) / 1000 : 1;
                    const mps = _complete[id] ? 0 : Math.round(win.reduce((s, w) => s + w.count, 0) / dur);
                    try {
                        await db.execute(`INSERT INTO ${KEYSPACE}.scrape_stats
               (channel_id,guild_id,total_scraped,msgs_per_sec,rate_limit_hits,errors,last_updated,complete,account_id,scheduler_state,pause_source,state_updated_at,state_reason,worker_id,lease_expires_at,last_error_class,last_error_code,last_error_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, _guildId[id] ?? '', _totals[id] ?? 0, mps,
                            _rl[id] ?? 0, (_errors[id] ?? []).slice(-20), new Date(), _complete[id] ?? false,
                            _accountId[id] ?? null,
                            _schedulerState[id] ?? null,
                            _pauseSource[id] ?? 'none',
                            toDateOrNull(_stateUpdatedAt[id]),
                            _stateReason[id] ?? null,
                            _workerId[id] ?? null,
                            toDateOrNull(_leaseExpiresAt[id]),
                            _lastErrorClass[id] ?? null,
                            _lastErrorCode[id] ?? null,
                            toDateOrNull(_lastErrorAt[id])]);
                    }
                    catch {
                        failed.push(id);
                    }
                });
            }
            catch (err) {
                failed.push(...ids.filter(id => !failed.includes(id)));
                console.error('[stats] flush hatasi:', err);
            }
            failed.forEach(id => _dirty.add(id));
        }
    }
    finally {
        _flushing = false;
    }
}
function startTimer() {
    if (!_timer)
        _timer = setInterval(() => { flushDirty().catch(() => { }); }, 5_000);
    if (!_leaseTimer)
        _leaseTimer = setInterval(() => {
            for (const id of _transient)
                renewLease(id);
        }, LEASE_RENEW_MS);
}
function ensureChannel(channelId, guildId, accountId) {
    if (!_guildId[channelId])
        _guildId[channelId] = guildId;
    if (_rl[channelId] == null)
        _rl[channelId] = 0;
    if (!_errors[channelId])
        _errors[channelId] = [];
    if (_complete[channelId] == null)
        _complete[channelId] = false;
    if (!_rolling[channelId])
        _rolling[channelId] = [];
    if (accountId != null)
        _accountId[channelId] = accountId;
    if (!_pauseSource[channelId])
        _pauseSource[channelId] = 'none';
    if (!(_totals[channelId] >= 0))
        _totals[channelId] = 0;
    startTimer();
}
function initChannel(channelId, guildId, accountId) {
    ensureChannel(channelId, guildId, accountId);
    _guildId[channelId] = guildId;
    _rl[channelId] = 0;
    _errors[channelId] = [];
    _complete[channelId] = false;
    _rolling[channelId] = [];
    if (accountId != null)
        _accountId[channelId] = accountId;
    if (!_pauseSource[channelId])
        _pauseSource[channelId] = 'none';
    if (!(_totals[channelId] >= 0))
        _totals[channelId] = 0;
    _dirty.add(channelId);
    startTimer();
}
function setRuntimeState(channelId, state) {
    _schedulerState[channelId] = state.schedulerState;
    _pauseSource[channelId] = state.pauseSource;
    _stateUpdatedAt[channelId] = state.stateUpdatedAt ?? new Date().toISOString();
    _stateReason[channelId] = state.stateReason ?? null;
    _workerId[channelId] = state.workerId ?? null;
    _leaseExpiresAt[channelId] = state.leaseExpiresAt ?? null;
    _lastErrorClass[channelId] = state.lastErrorClass ?? null;
    _lastErrorCode[channelId] = state.lastErrorCode ?? null;
    _lastErrorAt[channelId] = state.lastErrorAt ?? null;
    if (state.schedulerState === 'queued' || state.schedulerState === 'running') {
        _transient.add(channelId);
        renewLease(channelId);
    }
    else {
        _transient.delete(channelId);
    }
    _dirty.add(channelId);
    startTimer();
}
function getRuntimeState(channelId) {
    if (!_schedulerState[channelId])
        return null;
    return {
        channelId,
        schedulerState: _schedulerState[channelId],
        pauseSource: _pauseSource[channelId] ?? 'none',
        stateUpdatedAt: _stateUpdatedAt[channelId] ?? null,
        stateReason: _stateReason[channelId] ?? null,
        workerId: _workerId[channelId] ?? null,
        leaseExpiresAt: _leaseExpiresAt[channelId] ?? null,
        lastErrorClass: _lastErrorClass[channelId] ?? null,
        lastErrorCode: _lastErrorCode[channelId] ?? null,
        lastErrorAt: _lastErrorAt[channelId] ?? null,
    };
}
function flushStats() {
    return flushDirty();
}
function recordBatch(channelId, batchSize, absoluteTotal) {
    _totals[channelId] = Math.max(_totals[channelId] ?? 0, absoluteTotal);
    const now = Date.now();
    const win = _rolling[channelId] ?? [];
    win.push({ ts: now, count: batchSize });
    if (win.length > ROLLING_WIN)
        win.shift();
    _rolling[channelId] = win;
    _dirty.add(channelId);
}
function recordRateLimit(channelId, waitMs) {
    _rl[channelId] = (_rl[channelId] ?? 0) + 1;
    console.warn(`[rate-limit] channel=${channelId} wait=${waitMs}ms`);
    _dirty.add(channelId);
}
function recordError(channelId, msg) {
    if (!_errors[channelId])
        _errors[channelId] = [];
    _errors[channelId].push(`${new Date().toISOString()} ${msg}`);
    if (_errors[channelId].length > 20)
        _errors[channelId].shift();
    _dirty.add(channelId);
}
function recordComplete(channelId) {
    _complete[channelId] = true;
    _transient.delete(channelId);
    _schedulerState[channelId] = 'completed';
    _pauseSource[channelId] = _pauseSource[channelId] ?? 'none';
    _stateUpdatedAt[channelId] = new Date().toISOString();
    _stateReason[channelId] = 'complete';
    _leaseExpiresAt[channelId] = null;
    _dirty.add(channelId);
    // Tamamlanma aninda hemen yaz  gecikmesiz
    flushDirty().catch(() => { });
}
function removeChannel(channelId) {
    delete _totals[channelId];
    delete _rl[channelId];
    delete _errors[channelId];
    delete _complete[channelId];
    delete _guildId[channelId];
    delete _accountId[channelId];
    delete _rolling[channelId];
    delete _schedulerState[channelId];
    delete _pauseSource[channelId];
    delete _stateUpdatedAt[channelId];
    delete _stateReason[channelId];
    delete _workerId[channelId];
    delete _leaseExpiresAt[channelId];
    delete _lastErrorClass[channelId];
    delete _lastErrorCode[channelId];
    delete _lastErrorAt[channelId];
    _transient.delete(channelId);
    (0, db_1.getDb)().then(db => db.execute(`DELETE FROM ${KEYSPACE}.scrape_stats WHERE channel_id = ?`, [channelId])).catch(() => { });
}
function activeChannelCount() {
    return Object.values(_complete).filter(v => !v).length;
}
async function readAllStats() {
    try {
        const db = await (0, db_1.getDb)();
        const result = await db.execute(`SELECT * FROM ${KEYSPACE}.scrape_stats`);
        const channels = {};
        let totalScraped = 0, msgsPerSec = 0;
        for (const row of result.rows) {
            const id = row['channel_id'];
            const ts = Number(row['total_scraped'] ?? 0);
            const mps = Number(row['msgs_per_sec'] ?? 0);
            channels[id] = {
                channelId: id, guildId: row['guild_id'] ?? '',
                totalScraped: ts, lastBatchSize: 100, msgsPerSec: mps,
                rateLimitHits: Number(row['rate_limit_hits'] ?? 0),
                errors: row['errors'] ?? [],
                lastUpdated: row['last_updated']?.toISOString() ?? '',
                complete: row['complete'] ?? false,
                accountId: row['account_id'] ?? undefined,
                schedulerState: row['scheduler_state'] ?? undefined,
                pauseSource: row['pause_source'] ?? undefined,
                stateUpdatedAt: row['state_updated_at']?.toISOString() ?? undefined,
                stateReason: row['state_reason'] ?? null,
                workerId: row['worker_id'] ?? null,
                leaseExpiresAt: row['lease_expires_at']?.toISOString() ?? null,
                lastErrorClass: row['last_error_class'] ?? null,
                lastErrorCode: row['last_error_code'] ?? null,
                lastErrorAt: row['last_error_at']?.toISOString() ?? null,
            };
            totalScraped += ts;
            msgsPerSec += mps;
        }
        return { updatedAt: new Date().toISOString(), totalScraped, msgsPerSec, channels, rateLimitLog: [] };
    }
    catch {
        return { channels: {}, totalScraped: 0, msgsPerSec: 0, rateLimitLog: [] };
    }
}
process.on('SIGINT', () => { flushDirty().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { flushDirty().finally(() => process.exit(0)); });
//# sourceMappingURL=stats.js.map