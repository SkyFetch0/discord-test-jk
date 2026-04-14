"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.combinePauseSource = combinePauseSource;
exports.buildPauseIntentView = buildPauseIntentView;
exports.isPauseAcknowledged = isPauseAcknowledged;
exports.emptyRuntimeStateCounts = emptyRuntimeStateCounts;
exports.addRuntimeStateCount = addRuntimeStateCount;
exports.countedRuntimeTotal = countedRuntimeTotal;
exports.readPausedAccounts = readPausedAccounts;
exports.readPausedChannels = readPausedChannels;
exports.readAllRuntimeStates = readAllRuntimeStates;
exports.readRuntimeStatesByChannelIds = readRuntimeStatesByChannelIds;
const KEYSPACE = process.env.SCYLLA_KEYSPACE ?? 'senneo';
const RUNTIME_STATE_SELECT = `SELECT channel_id, scheduler_state, pause_source, state_updated_at, state_reason, worker_id, lease_expires_at, last_error_class, last_error_code, last_error_at FROM ${KEYSPACE}.scrape_stats`;
function toIso(value) {
    if (value == null)
        return null;
    if (value instanceof Date)
        return value.toISOString();
    if (typeof value === 'string') {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
    }
    return null;
}
function mapRuntimeRow(row) {
    return {
        channelId: row['channel_id'] ?? '',
        schedulerState: row['scheduler_state'] ?? null,
        pauseSource: row['pause_source'] ?? null,
        stateUpdatedAt: toIso(row['state_updated_at']),
        stateReason: row['state_reason'] ?? null,
        workerId: row['worker_id'] ?? null,
        leaseExpiresAt: toIso(row['lease_expires_at']),
        lastErrorClass: row['last_error_class'] ?? null,
        lastErrorCode: row['last_error_code'] ?? null,
        lastErrorAt: toIso(row['last_error_at']),
    };
}
function combinePauseSource(accountPaused, channelPaused) {
    if (accountPaused && channelPaused)
        return 'both';
    if (channelPaused)
        return 'channel';
    if (accountPaused)
        return 'account';
    return 'none';
}
function buildPauseIntentView(ownerAccountId, channelId, pausedAccounts, pausedChannels) {
    const accountPause = ownerAccountId ? pausedAccounts.get(ownerAccountId) : undefined;
    const channelPause = pausedChannels.get(channelId);
    const accountPaused = !!accountPause;
    const channelPaused = !!channelPause;
    return {
        pauseRequested: accountPaused || channelPaused,
        accountPauseRequested: accountPaused,
        channelPauseRequested: channelPaused,
        requestedPauseSource: combinePauseSource(accountPaused, channelPaused),
        pauseReason: channelPause?.reason ?? accountPause?.reason ?? null,
        pauseRequestedBy: channelPause?.requestedBy ?? accountPause?.requestedBy ?? null,
        pauseRequestedAt: channelPause?.requestedAt ?? accountPause?.requestedAt ?? null,
        pauseRequestId: channelPause?.requestId ?? accountPause?.requestId ?? null,
    };
}
function isPauseAcknowledged(runtimeState, complete, pauseRequested) {
    if (!pauseRequested)
        return false;
    if (complete)
        return true;
    return runtimeState === 'paused';
}
function emptyRuntimeStateCounts() {
    return {
        queued: 0,
        running: 0,
        paused: 0,
        completed: 0,
        error_retryable: 0,
        error_terminal: 0,
    };
}
function addRuntimeStateCount(counts, state) {
    if (!state)
        return;
    counts[state] = (counts[state] ?? 0) + 1;
}
function countedRuntimeTotal(counts) {
    return counts.queued + counts.running + counts.paused + counts.completed + counts.error_retryable + counts.error_terminal;
}
async function readPausedAccounts(db) {
    const result = await db.execute(`SELECT account_id, reason, requested_by, request_id, requested_at FROM ${KEYSPACE}.scrape_paused_accounts`).catch(() => null);
    if (!result)
        return new Map();
    const entries = result.rows.map(row => {
        const accountId = row['account_id'] ?? '';
        return [accountId, {
                accountId,
                reason: row['reason'] ?? null,
                requestedBy: row['requested_by'] ?? null,
                requestId: row['request_id'] ?? null,
                requestedAt: toIso(row['requested_at']),
            }];
    }).filter(([accountId]) => !!accountId);
    return new Map(entries);
}
async function readPausedChannels(db) {
    const result = await db.execute(`SELECT channel_id, guild_id, account_id, reason, requested_by, request_id, requested_at FROM ${KEYSPACE}.scrape_paused_channels`).catch(() => null);
    if (!result)
        return new Map();
    const entries = result.rows.map(row => {
        const channelId = row['channel_id'] ?? '';
        return [channelId, {
                channelId,
                guildId: row['guild_id'] ?? '',
                accountId: row['account_id'] ?? '',
                reason: row['reason'] ?? null,
                requestedBy: row['requested_by'] ?? null,
                requestId: row['request_id'] ?? null,
                requestedAt: toIso(row['requested_at']),
            }];
    }).filter(([channelId]) => !!channelId);
    return new Map(entries);
}
async function readAllRuntimeStates(db) {
    const result = await db.execute(RUNTIME_STATE_SELECT).catch(() => null);
    if (!result)
        return new Map();
    const entries = result.rows.map(row => {
        const runtime = mapRuntimeRow(row);
        return [runtime.channelId, runtime];
    }).filter(([channelId]) => !!channelId);
    return new Map(entries);
}
async function readRuntimeStatesByChannelIds(db, channelIds) {
    const ids = [...new Set(channelIds.map(id => id.trim()).filter(Boolean))];
    if (ids.length === 0)
        return new Map();
    if (ids.length > 150) {
        const all = await readAllRuntimeStates(db);
        const filtered = ids
            .map(id => {
            const runtime = all.get(id);
            return runtime ? [id, runtime] : null;
        })
            .filter((entry) => entry != null);
        return new Map(filtered);
    }
    const out = new Map();
    const chunkSize = 50;
    for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const rows = await Promise.all(chunk.map(async (channelId) => {
            const result = await db.execute(`${RUNTIME_STATE_SELECT} WHERE channel_id = ?`, [channelId]).catch(() => null);
            const row = result?.rows[0];
            if (!row)
                return null;
            const runtime = mapRuntimeRow(row);
            return [channelId, runtime];
        }));
        rows.filter((entry) => entry != null).forEach(([channelId, runtime]) => {
            out.set(channelId, runtime);
        });
    }
    return out;
}
//# sourceMappingURL=scrape-control.js.map