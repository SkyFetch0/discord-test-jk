"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
[
    path_1.default.resolve(__dirname, '../../../.env'),
    path_1.default.resolve(__dirname, '../../../../.env'),
    path_1.default.resolve(process.cwd(), '.env'),
].forEach(p => require('dotenv').config({ path: p }));
const fs_1 = __importDefault(require("fs"));
const https_1 = __importDefault(require("https"));
const p_queue_1 = __importDefault(require("p-queue"));
const checkpoint_1 = require("./checkpoint");
const scraper_1 = require("./scraper");
const producer_1 = require("./producer");
const stats_1 = require("./stats");
const db_1 = require("./db");
const scrape_event_log_1 = require("./scrape-event-log");
const proxy_1 = require("./proxy");
const guild_sync_1 = require("./guild-sync");
const ACCOUNTS_FILE = path_1.default.resolve(__dirname, '../../../accounts.json');
const KAFKA_BROKERS = process.env.KAFKA_BROKERS ?? 'localhost:9092';
const KAFKA_TOPIC = process.env.KAFKA_TOPIC ?? 'messages';
const CONCURRENT_CHNL = parseInt(process.env.CONCURRENT_GUILDS ?? '15', 10);
const KEYSPACE = process.env.SCYLLA_KEYSPACE ?? 'senneo';
// SCALE FIX: max concurrent logins — 400 simultaneous ws connections = Discord rate-limit/ban
const LOGIN_CONCURRENCY = parseInt(process.env.LOGIN_CONCURRENCY ?? '10', 10);
const LOGIN_DELAY_MS = parseInt(process.env.LOGIN_DELAY_MS ?? '1500', 10);
// Multi-instance: ACCOUNTS_RANGE_START/END slice accounts.json but preserve
// global indices so scrape_targets.account_idx is consistent across instances.
// Unset = load all accounts (backward compatible single-instance mode).
const RANGE_START = process.env.ACCOUNTS_RANGE_START != null
    ? parseInt(process.env.ACCOUNTS_RANGE_START, 10) : undefined;
const RANGE_END = process.env.ACCOUNTS_RANGE_END != null
    ? parseInt(process.env.ACCOUNTS_RANGE_END, 10) : undefined;
const WORKER_ID = process.env.SCRAPER_WORKER_ID?.trim() || `accounts-${process.pid}`;
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
const SCRAPER_FLAGS = {
    runtimeStateEnabled: envFlag('SCRAPER_RUNTIME_STATE_ENABLED', true),
    pauseControlEnabled: envFlag('SCRAPER_PAUSE_CONTROL_ENABLED', true),
    accountPauseEnabled: envFlag('SCRAPER_ACCOUNT_PAUSE_ENABLED', true),
};
const SCOPED_THROTTLE_ENABLED = envFlag('SCRAPER_SCOPED_THROTTLE_ENABLED', false);
const RL_RETRY_BUDGET = envPositiveInt('SCRAPER_RL_RETRY_BUDGET', 6);
const RL_COOLDOWN_WINDOW_MS = envPositiveInt('SCRAPER_RL_COOLDOWN_WINDOW_MS', 60_000);
const RL_MAX_SCOPE_COOLDOWN_MS = envPositiveInt('SCRAPER_RL_MAX_SCOPE_COOLDOWN_MS', 120_000);
const RL_QUIET_WINDOW_MS = envPositiveInt('SCRAPER_RL_QUIET_WINDOW_MS', 45_000);
const RL_ACCOUNT_CONCURRENCY_MIN = Math.max(1, Math.min(CONCURRENT_CHNL, envPositiveInt('SCRAPER_ACCOUNT_CONCURRENCY_MIN', 1)));
async function readTargets(db) {
    const result = await db.execute(`SELECT channel_id, guild_id, label, account_id, account_idx, pinned_account_id, pinned_account_idx FROM ${KEYSPACE}.scrape_targets`);
    return result.rows.map(row => ({
        channelId: row['channel_id'],
        guildId: row['guild_id'],
        label: row['label'],
        accountId: row['account_id'] ?? undefined,
        accountIdx: row['account_idx'] != null ? Number(row['account_idx']) : undefined,
        pinnedAccountId: row['pinned_account_id'] ?? undefined,
        pinnedAccountIdx: row['pinned_account_idx'] != null ? Number(row['pinned_account_idx']) : undefined,
    }));
}
async function readPausedAccounts(db) {
    if (!SCRAPER_FLAGS.pauseControlEnabled || !SCRAPER_FLAGS.accountPauseEnabled)
        return new Map();
    const result = await db.execute(`SELECT account_id, reason, requested_by, request_id, requested_at FROM ${KEYSPACE}.scrape_paused_accounts`);
    const entries = result.rows.map(row => {
        const accountId = row['account_id'] ?? '';
        return [accountId, {
                accountId,
                reason: row['reason'] ?? null,
                requestedBy: row['requested_by'] ?? null,
                requestId: row['request_id'] ?? null,
                requestedAt: row['requested_at']?.toISOString?.() ?? new Date(0).toISOString(),
            }];
    }).filter(([accountId]) => !!accountId);
    return new Map(entries);
}
async function readPausedChannels(db) {
    if (!SCRAPER_FLAGS.pauseControlEnabled)
        return new Map();
    const result = await db.execute(`SELECT channel_id, guild_id, account_id, reason, requested_by, request_id, requested_at FROM ${KEYSPACE}.scrape_paused_channels`);
    const entries = result.rows.map(row => {
        const channelId = row['channel_id'] ?? '';
        return [channelId, {
                channelId,
                guildId: row['guild_id'] ?? '',
                accountId: row['account_id'] ?? '',
                reason: row['reason'] ?? null,
                requestedBy: row['requested_by'] ?? null,
                requestId: row['request_id'] ?? null,
                requestedAt: row['requested_at']?.toISOString?.() ?? new Date(0).toISOString(),
            }];
    }).filter(([channelId]) => !!channelId);
    return new Map(entries);
}
function buildControlOverlayHash(pausedAccounts, pausedChannels) {
    const accountPart = [...pausedAccounts.values()]
        .sort((a, b) => a.accountId.localeCompare(b.accountId))
        .map(a => `${a.accountId}|${a.reason ?? ''}|${a.requestId ?? ''}|${a.requestedAt}`)
        .join(',');
    const channelPart = [...pausedChannels.values()]
        .sort((a, b) => a.channelId.localeCompare(b.channelId))
        .map(c => `${c.channelId}|${c.accountId}|${c.reason ?? ''}|${c.requestId ?? ''}|${c.requestedAt}`)
        .join(',');
    return `${accountPart}::${channelPart}`;
}
async function readControlOverlay(db) {
    const [pausedAccounts, pausedChannels] = await Promise.all([
        readPausedAccounts(db),
        readPausedChannels(db),
    ]);
    return {
        pausedAccounts,
        pausedChannels,
        hash: buildControlOverlayHash(pausedAccounts, pausedChannels),
    };
}
// Returns [globalIndex, config][] — globalIndex is the position in the full
// accounts.json file, NOT a 0-based local index.  This global index is what
// gets written to scrape_targets.account_idx and shown in dashboard/logs.
function loadAccounts() {
    if (!fs_1.default.existsSync(ACCOUNTS_FILE))
        throw new Error(`accounts.json bulunamadı`);
    const raw = JSON.parse(fs_1.default.readFileSync(ACCOUNTS_FILE, 'utf-8'));
    if (!raw.accounts?.length)
        throw new Error('accounts.json boş');
    const all = raw.accounts;
    const start = RANGE_START ?? 0;
    const end = RANGE_END ?? all.length;
    const slice = all.slice(start, end).map((acc, i) => [start + i, acc]);
    if (slice.length === 0)
        throw new Error(`accounts.json aralığı boş [${start}, ${end}) — endExclusive`);
    if (RANGE_START != null || RANGE_END != null)
        console.log(`[accounts] Aralık [${start}, ${end}) → global indeks ${start}–${end - 1} (${slice.length}/${all.length} hesap)`);
    return slice;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createClient(token, proxyBundle) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require('discord.js-selfbot-v13');
    // discord.js-selfbot-v13 proxy plumbing:
    //   ws.agent  → passed to `ws` library.  ws requires `instanceof http.Agent`.
    //               BUT discord.js verifyProxyAgent() also checks agent.httpAgent/httpsAgent.
    //               Solution: attach httpAgent/httpsAgent props onto the Agent itself.
    //   http.agent → proxy URL string for undici ProxyAgent (REST calls).
    const opts = { checkUpdate: false };
    if (proxyBundle) {
        const wsAgent = proxyBundle.agent;
        wsAgent.httpAgent = proxyBundle.agent;
        wsAgent.httpsAgent = proxyBundle.agent;
        opts.ws = { agent: wsAgent };
        opts.http = { agent: proxyBundle.proxyUrl };
    }
    return new Promise((resolve, reject) => {
        const client = new Client(opts);
        const timeout = setTimeout(() => reject(new Error('Login timeout')), 30_000);
        client.once('ready', () => { clearTimeout(timeout); console.log(`[accounts] ✓ ${client.user?.username}`); resolve(client); });
        client.once('error', (err) => { clearTimeout(timeout); reject(err); });
        client.login(token).catch((err) => { clearTimeout(timeout); reject(err); });
    });
}
async function fetchGuildIds(token, agent) {
    return new Promise(resolve => {
        const req = https_1.default.request({
            hostname: 'discord.com', path: '/api/v10/users/@me/guilds', method: 'GET',
            headers: { 'Authorization': token, 'User-Agent': 'Mozilla/5.0' },
            ...(agent ? { agent } : {}),
        }, (res) => {
            let data = '';
            res.on('data', (c) => data += c.toString());
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(new Set(Array.isArray(parsed) ? parsed.map((g) => g.id) : []));
                }
                catch {
                    resolve(new Set());
                }
            });
        });
        req.on('error', () => resolve(new Set()));
        req.setTimeout(8000, () => { req.destroy(); resolve(new Set()); });
        req.end();
    });
}
function failedTokenHint(token) {
    return token.length > 20 ? token.slice(0, 8) + '...' + token.slice(-4) : '***';
}
async function fetchDiscordMe(token, agent) {
    return new Promise(resolve => {
        const req = https_1.default.request({ hostname: 'discord.com', path: '/api/v10/users/@me', method: 'GET',
            headers: { Authorization: token, 'User-Agent': 'Mozilla/5.0' },
            ...(agent ? { agent } : {}),
        }, (res) => {
            let d = '';
            res.on('data', (c) => d += c.toString());
            res.on('end', () => { try {
                resolve(JSON.parse(d));
            }
            catch {
                resolve(null);
            } });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(8000, () => { req.destroy(); resolve(null); });
        req.end();
    });
}
async function deleteFailedRowsByTokenHint(db, tokenHint) {
    if (!tokenHint || tokenHint === '***')
        return;
    const failedRows = await db.execute(`SELECT account_id FROM ${KEYSPACE}.failed_accounts WHERE token_hint = ? ALLOW FILTERING`, [tokenHint]).catch(() => null);
    await Promise.all((failedRows?.rows ?? []).map(row => {
        const accountId = row['account_id'] ?? '';
        if (!accountId)
            return Promise.resolve();
        return db.execute(`DELETE FROM ${KEYSPACE}.failed_accounts WHERE account_id = ?`, [accountId]).catch(() => { });
    }));
}
async function resolveFailedAccountIdentity(db, token, fallbackAccountId, agent) {
    const tokenKey = token.slice(-16);
    const mapped = await db.execute(`SELECT account_id, username FROM ${KEYSPACE}.token_account_map WHERE token_key = ?`, [tokenKey]).catch(() => null);
    const mappedAccountId = mapped?.rows[0]?.['account_id'] ?? '';
    if (mappedAccountId) {
        return {
            accountId: mappedAccountId,
            username: mapped?.rows[0]?.['username'] ?? '',
        };
    }
    const userData = await fetchDiscordMe(token, agent).catch(() => null);
    if (userData?.id) {
        return { accountId: userData.id, username: userData.username ?? '' };
    }
    return { accountId: fallbackAccountId, username: '' };
}
async function recordFailedAccount(db, token, fallbackAccountId, reason, errorMsg, agent) {
    const tokenHint = failedTokenHint(token);
    const { accountId, username } = await resolveFailedAccountIdentity(db, token, fallbackAccountId, agent);
    if (!accountId.startsWith('unknown_')) {
        const staleRows = await db.execute(`SELECT account_id FROM ${KEYSPACE}.failed_accounts WHERE token_hint = ? ALLOW FILTERING`, [tokenHint]).catch(() => null);
        await Promise.all((staleRows?.rows ?? []).map(row => {
            const staleId = row['account_id'] ?? '';
            if (!staleId || !staleId.startsWith('unknown_'))
                return Promise.resolve();
            return db.execute(`DELETE FROM ${KEYSPACE}.failed_accounts WHERE account_id = ?`, [staleId]).catch(() => { });
        }));
    }
    // Skip writing placeholder unknown_* entries — invalid tokens should not pollute the dashboard
    if (!accountId.startsWith('unknown_')) {
        await db.execute(`INSERT INTO ${KEYSPACE}.failed_accounts (account_id, username, token_hint, reason, error_msg, detected_at) VALUES (?,?,?,?,?,?)`, [accountId, username, tokenHint, reason, errorMsg, new Date()]);
    }
    return { accountId, username, tokenHint };
}
async function main() {
    const db = await (0, db_1.getDb)();
    await (0, checkpoint_1.loadCheckpoints)();
    const accountPairs = loadAccounts(); // [globalIdx, config][]
    let liveAccountPairs = accountPairs.slice();
    (0, proxy_1.initProxyPool)();
    const { send: sendToKafka, disconnect: disconnectKafka } = await (0, producer_1.createProducer)(KAFKA_BROKERS.split(','), KAFKA_TOPIC);
    const queues = new Map(); // key = discord user ID
    const clients = new Map(); // key = discord user ID
    const enqueued = new Set();
    const throttleStates = new Map();
    const accountRecoveryTimers = new Map();
    const accountBaseConcurrency = new Map();
    const accountAgents = new Map();
    const accountKeyById = new Map();
    let proxyAssignmentsByKey = new Map();
    function refreshProxyAssignmentPlan(pairs) {
        const assignments = (0, proxy_1.syncPlannedProxyAssignments)(pairs.map(([gIdx]) => ({ accountIdx: gIdx })));
        proxyAssignmentsByKey = new Map(assignments.map(assignment => [assignment.accountKey, assignment]));
    }
    function proxyAssignmentForIdx(gIdx) {
        return proxyAssignmentsByKey.get(`idx:${gIdx}`) ?? null;
    }
    function destroyBundle(bundle) {
        try {
            bundle?.agent?.destroy?.();
        }
        catch { }
    }
    refreshProxyAssignmentPlan(liveAccountPairs);
    if ((0, proxy_1.isProxyPoolEnabled)()) {
        console.log(`[accounts] Proxy AÇIK — managed pool aktif${(0, proxy_1.isProxyStrictMode)() ? ' (strict mode)' : ''}`);
    }
    else {
        console.log('[accounts] Proxy KAPALI — doğrudan bağlantı (VDS IP)');
    }
    // Map from globalIdx to Discord user ID (resolved after login)
    const idxToDiscordId = new Map();
    // SCALE FIX: Chunked login — not all 400 accounts simultaneously.
    // 400 concurrent ws logins triggers Discord rate-limits and potential IP ban.
    for (let i = 0; i < accountPairs.length; i += LOGIN_CONCURRENCY) {
        const chunk = accountPairs.slice(i, i + LOGIN_CONCURRENCY);
        await Promise.all(chunk.map(async ([gIdx, acc]) => {
            const accountKey = `idx:${gIdx}`;
            const proxyAssignment = proxyAssignmentForIdx(gIdx);
            let bundle;
            try {
                if ((0, proxy_1.isProxyPoolEnabled)()) {
                    if (!proxyAssignment?.proxy) {
                        const noProxyMsg = 'Proxy sistemi aktif ama hesaba atanmış proxy yok';
                        (0, proxy_1.updateRuntimeProxyAssignment)(accountKey, { connected: false, lastError: noProxyMsg, direct: true });
                        if ((0, proxy_1.isProxyStrictMode)())
                            throw new Error(noProxyMsg);
                    }
                    else {
                        bundle = await (0, proxy_1.createProxyAgentBundle)(proxyAssignment.proxy);
                        console.log(`[accounts] Hesap (idx ${gIdx}) → proxy ${proxyAssignment.proxy.maskedUrl}`);
                    }
                }
                const client = await createClient(acc.token, bundle);
                const discordId = client.user?.id ?? String(gIdx);
                const clientUsername = client.user?.username ?? '';
                const tokenHint = failedTokenHint(acc.token);
                idxToDiscordId.set(gIdx, discordId);
                accountKeyById.set(discordId, accountKey);
                clients.set(discordId, client);
                accountAgents.set(discordId, bundle);
                queues.set(discordId, new p_queue_1.default({ concurrency: CONCURRENT_CHNL }));
                accountBaseConcurrency.set(discordId, CONCURRENT_CHNL);
                (0, proxy_1.updateRuntimeProxyAssignment)(accountKey, { accountId: discordId, username: clientUsername, connected: true, lastError: null, direct: !proxyAssignment?.proxy });
                // Clear from failed_accounts if previously failed
                db.execute(`DELETE FROM ${KEYSPACE}.failed_accounts WHERE account_id = ?`, [discordId]).catch(() => { });
                deleteFailedRowsByTokenHint(db, tokenHint).catch(() => { });
                // Ensure account_info is populated (used by guild inventory categories)
                db.execute(`INSERT INTO ${KEYSPACE}.account_info (account_id, discord_id, username, avatar, last_fetched) VALUES (?,?,?,?,?)`, [discordId, discordId, clientUsername, client.user?.avatar ?? '', new Date()]).catch(() => { });
                db.execute(`INSERT INTO ${KEYSPACE}.token_account_map (token_key, account_id, username, updated_at) VALUES (?,?,?,?)`, [acc.token.slice(-16), discordId, clientUsername, new Date()]).catch(() => { });
                // Monitor: detect disconnect/error at runtime (token invalidated, ban, etc.)
                client.on('error', (err) => {
                    console.error(`[accounts] ${clientUsername} (${discordId}) client error:`, err.message);
                    (0, proxy_1.updateRuntimeProxyAssignment)(accountKey, { accountId: discordId, username: clientUsername, connected: false, lastError: err.message });
                });
                client.on('disconnect', () => {
                    console.warn(`[accounts] ${clientUsername} (${discordId}) disconnected — marking as failed`);
                    (0, proxy_1.updateRuntimeProxyAssignment)(accountKey, { accountId: discordId, username: clientUsername, connected: false, lastError: 'WebSocket disconnected' });
                    db.execute(`INSERT INTO ${KEYSPACE}.failed_accounts (account_id, username, token_hint, reason, error_msg, detected_at) VALUES (?,?,?,?,?,?)`, [discordId, clientUsername, '', 'disconnected', 'WebSocket disconnected', new Date()]).catch(() => { });
                    (0, scrape_event_log_1.emit)('scrape_error', `${clientUsername || discordId} baglanti kesildi`, { accountId: discordId, accountName: clientUsername || discordId });
                });
                client.on('invalidated', () => {
                    console.warn(`[accounts] ${clientUsername} (${discordId}) session invalidated — marking as failed`);
                    (0, proxy_1.updateRuntimeProxyAssignment)(accountKey, { accountId: discordId, username: clientUsername, connected: false, lastError: 'Session invalidated by Discord' });
                    db.execute(`INSERT INTO ${KEYSPACE}.failed_accounts (account_id, username, token_hint, reason, error_msg, detected_at) VALUES (?,?,?,?,?,?)`, [discordId, clientUsername, '', 'token_invalidated', 'Session invalidated by Discord', new Date()]).catch(() => { });
                    (0, scrape_event_log_1.emit)('scrape_error', `${clientUsername || discordId} oturum gecersiz`, { accountId: discordId, accountName: clientUsername || discordId });
                });
            }
            catch (err) {
                console.error(`[accounts] Hesap (idx ${gIdx}) giriş başarısız:`, err);
                try {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    const { accountId: discordId, username, tokenHint } = await recordFailedAccount(db, acc.token, `unknown_idx_${gIdx}`, 'login_failed', errMsg, bundle?.agent);
                    (0, proxy_1.updateRuntimeProxyAssignment)(accountKey, { accountId: discordId, username, connected: false, lastError: errMsg });
                    (0, scrape_event_log_1.emit)('scrape_error', `${username || discordId} login başarısız`, { accountId: discordId, accountName: username || discordId });
                    console.log(`[accounts] Failed account detected: ${username || discordId} (token: ${tokenHint})`);
                }
                catch { /* ignore */ }
                destroyBundle(bundle);
            }
        }));
        if (i + LOGIN_CONCURRENCY < accountPairs.length) {
            console.log(`[accounts] ${Math.min(i + LOGIN_CONCURRENCY, accountPairs.length)}/${accountPairs.length} hesap giriş yaptı — ${LOGIN_DELAY_MS}ms bekleniyor...`);
            await new Promise(r => setTimeout(r, LOGIN_DELAY_MS));
        }
    }
    const activeIds = [...clients.keys()];
    if (!activeIds.length)
        throw new Error('Hiçbir hesap giriş yapamadı');
    console.log(`[accounts] ${activeIds.length} hesap hazır | concurrency=${CONCURRENT_CHNL}`);
    (0, scrape_event_log_1.startEventLog)();
    // Build [discordId, config] pairs for guild-sync
    const syncPairs = accountPairs
        .filter(([gIdx]) => idxToDiscordId.has(gIdx))
        .map(([gIdx, acc]) => ({ accountId: idxToDiscordId.get(gIdx), accountIdx: gIdx, config: acc, agent: accountAgents.get(idxToDiscordId.get(gIdx))?.agent }));
    (0, guild_sync_1.startGuildSync)(db, syncPairs);
    // Build a quick lookup from discordId → token for guild fetching
    const tokenById = new Map();
    for (const [gIdx, acc] of accountPairs) {
        const did = idxToDiscordId.get(gIdx);
        if (did)
            tokenById.set(did, acc.token);
    }
    const globalIdxByAccountId = new Map();
    for (const [gIdx, did] of idxToDiscordId)
        globalIdxByAccountId.set(did, gIdx);
    const accountGuilds = new Map();
    await Promise.all(activeIds.map(async (accId) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const client = clients.get(accId);
        let guildIds = new Set([...(client.guilds?.cache?.keys?.() ?? [])]);
        const token = tokenById.get(accId);
        if (guildIds.size < 2 && token)
            guildIds = await fetchGuildIds(token, accountAgents.get(accId)?.agent);
        accountGuilds.set(accId, guildIds);
        console.log(`[accounts] ${client.user?.username} (${accId}) — ${guildIds.size} guild`);
    }));
    const guildToAccounts = new Map();
    function rebuildGuildToAccounts() {
        guildToAccounts.clear();
        for (const [accId, guilds] of accountGuilds) {
            for (const gid of guilds) {
                if (!guildToAccounts.has(gid))
                    guildToAccounts.set(gid, []);
                guildToAccounts.get(gid).push(accId);
            }
        }
    }
    rebuildGuildToAccounts();
    const guildRR = new Map();
    const trackedTargetState = new Map();
    const assignedAccountByChannel = new Map();
    const ownerAccountByChannel = new Map();
    const currentTargetsByChannel = new Map();
    const queuedChannelsByAccount = new Map();
    const runningChannelsByAccount = new Map();
    const channelRunToken = new Map();
    const abortHandles = new Map();
    const stopReasonByChannel = new Map();
    let controlOverlay = { pausedAccounts: new Map(), pausedChannels: new Map(), hash: '' };
    let lastControlHash = controlOverlay.hash;
    let schedulerChain = Promise.resolve();
    function withSchedulerLock(fn) {
        const next = schedulerChain.catch(() => { }).then(fn);
        schedulerChain = next.then(() => undefined, () => undefined);
        return next;
    }
    function accountNameFor(accountId) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return clients.get(accountId)?.user?.username ?? accountId;
    }
    function throttleScopeKey(kind, accountId, guildId, channelId) {
        if (!accountId)
            return null;
        if (kind === 'account')
            return `account:${accountId}`;
        if (kind === 'guild')
            return guildId ? `guild:${accountId}:${guildId}` : null;
        return channelId ? `channel:${accountId}:${channelId}` : null;
    }
    function clearRecoveryTimer(accountId) {
        const timer = accountRecoveryTimers.get(accountId);
        if (timer)
            clearTimeout(timer);
        accountRecoveryTimers.delete(accountId);
    }
    function clearThrottleStateForAccount(accountId) {
        clearRecoveryTimer(accountId);
        for (const key of [...throttleStates.keys()]) {
            if (key === `account:${accountId}` || key.startsWith(`guild:${accountId}:`) || key.startsWith(`channel:${accountId}:`)) {
                throttleStates.delete(key);
            }
        }
        accountBaseConcurrency.delete(accountId);
    }
    function registerScopeCooldown(scopeKey, baseWaitMs) {
        const now = Date.now();
        const prev = throttleStates.get(scopeKey);
        const withinWindow = !!prev && (now - prev.windowStartedAt) <= RL_COOLDOWN_WINDOW_MS;
        const hitsInWindow = withinWindow ? (prev.hitsInWindow + 1) : 1;
        const budgetedHits = Math.min(hitsInWindow, RL_RETRY_BUDGET);
        const cap = Math.min(Math.max(baseWaitMs, 1_000) * (2 ** Math.max(0, budgetedHits - 1)), RL_MAX_SCOPE_COOLDOWN_MS);
        const jitterMs = Math.floor(Math.random() * cap);
        const waitMs = Math.max(baseWaitMs, jitterMs);
        const cooldownUntil = Math.max(prev?.cooldownUntil ?? 0, now + waitMs);
        throttleStates.set(scopeKey, {
            cooldownUntil,
            hitsInWindow,
            windowStartedAt: withinWindow ? prev.windowStartedAt : now,
            lastHitAt: now,
        });
        return { waitMs, cooldownUntil, hitsInWindow };
    }
    function computeThrottleWait(accountId, guildId, channelId) {
        if (!SCOPED_THROTTLE_ENABLED || !accountId)
            return 0;
        const now = Date.now();
        const keys = [
            throttleScopeKey('account', accountId, guildId, channelId),
            throttleScopeKey('guild', accountId, guildId, channelId),
            throttleScopeKey('channel', accountId, guildId, channelId),
        ].filter((key) => !!key);
        let waitMs = 0;
        for (const key of keys) {
            const state = throttleStates.get(key);
            if (!state || state.cooldownUntil <= now)
                continue;
            waitMs = Math.max(waitMs, state.cooldownUntil - now);
        }
        return waitMs;
    }
    function scheduleAccountRecovery(accountId) {
        if (!SCOPED_THROTTLE_ENABLED)
            return;
        clearRecoveryTimer(accountId);
        const queue = queues.get(accountId);
        if (!queue)
            return;
        const baseConcurrency = accountBaseConcurrency.get(accountId) ?? CONCURRENT_CHNL;
        if (queue.concurrency >= baseConcurrency)
            return;
        const waitMs = computeThrottleWait(accountId) + RL_QUIET_WINDOW_MS;
        const timer = setTimeout(() => {
            const nextQueue = queues.get(accountId);
            if (!nextQueue) {
                accountRecoveryTimers.delete(accountId);
                return;
            }
            const blockedForMs = computeThrottleWait(accountId);
            if (blockedForMs > 0) {
                scheduleAccountRecovery(accountId);
                return;
            }
            const base = accountBaseConcurrency.get(accountId) ?? CONCURRENT_CHNL;
            const prev = nextQueue.concurrency;
            const next = Math.min(base, prev + 1);
            if (next > prev) {
                nextQueue.concurrency = next;
                const detail = `event=resume_window accountId=${accountId} restoredConcurrency=${next} quietMs=${RL_QUIET_WINDOW_MS}`;
                console.warn(`[scraper] ${detail}`);
                (0, scrape_event_log_1.emit)('info', 'resume window', { accountId, accountName: accountNameFor(accountId), detail });
            }
            if (next < base)
                scheduleAccountRecovery(accountId);
            else
                accountRecoveryTimers.delete(accountId);
        }, Math.max(1_000, waitMs));
        accountRecoveryTimers.set(accountId, timer);
    }
    function reduceAccountConcurrency(accountId, guildId, channelId) {
        const queue = queues.get(accountId);
        if (!queue)
            return;
        const prev = queue.concurrency;
        const next = Math.max(RL_ACCOUNT_CONCURRENCY_MIN, prev - 1);
        if (next < prev) {
            queue.concurrency = next;
            const detail = `event=concurrency_reduced accountId=${accountId} channelId=${channelId} guildId=${guildId} previousConcurrency=${prev} newConcurrency=${next}`;
            console.warn(`[scraper] ${detail}`);
            (0, scrape_event_log_1.emit)('info', 'concurrency reduced', { accountId, accountName: accountNameFor(accountId), channelId, guildId, detail });
        }
        scheduleAccountRecovery(accountId);
    }
    const throttleHooks = SCOPED_THROTTLE_ENABLED ? {
        beforeFetch: ({ accountId, guildId, channelId }) => computeThrottleWait(accountId, guildId, channelId),
        onRateLimit: async (event) => {
            if (!event.accountId)
                return { waitMs: event.waitMs };
            const accountKey = throttleScopeKey('account', event.accountId, event.guildId, event.channelId);
            const guildKey = throttleScopeKey('guild', event.accountId, event.guildId, event.channelId);
            const channelKey = throttleScopeKey('channel', event.accountId, event.guildId, event.channelId);
            const accountState = accountKey ? registerScopeCooldown(accountKey, event.waitMs) : null;
            const guildState = guildKey ? registerScopeCooldown(guildKey, event.waitMs) : null;
            const channelState = channelKey ? registerScopeCooldown(channelKey, event.waitMs) : null;
            reduceAccountConcurrency(event.accountId, event.guildId, event.channelId);
            const appliedWaitMs = Math.max(event.waitMs, accountState?.waitMs ?? 0, guildState?.waitMs ?? 0, channelState?.waitMs ?? 0);
            const cooldownUntil = Math.max(accountState?.cooldownUntil ?? 0, guildState?.cooldownUntil ?? 0, channelState?.cooldownUntil ?? 0);
            const detail = `event=throttle_applied accountId=${event.accountId} channelId=${event.channelId} guildId=${event.guildId} accountWaitMs=${accountState?.waitMs ?? 0} guildWaitMs=${guildState?.waitMs ?? 0} channelWaitMs=${channelState?.waitMs ?? 0} waitMs=${appliedWaitMs} cooldownUntil=${new Date(cooldownUntil || (Date.now() + appliedWaitMs)).toISOString()} retryBudget=${RL_RETRY_BUDGET}`;
            console.warn(`[scraper] ${detail}`);
            (0, scrape_event_log_1.emit)('info', 'throttle applied', { accountId: event.accountId, accountName: accountNameFor(event.accountId), channelId: event.channelId, guildId: event.guildId, detail });
            return { waitMs: appliedWaitMs };
        },
    } : undefined;
    function addChannel(map, accountId, channelId) {
        if (!map.has(accountId))
            map.set(accountId, new Set());
        map.get(accountId).add(channelId);
    }
    function removeChannelFromAccount(map, accountId, channelId) {
        const set = map.get(accountId);
        if (!set)
            return;
        set.delete(channelId);
        if (set.size === 0)
            map.delete(accountId);
    }
    function ownerAccountFor(target) {
        if (target.pinnedAccountId)
            return target.pinnedAccountId;
        if (target.accountId)
            return target.accountId;
        if (target.pinnedAccountIdx != null)
            return idxToDiscordId.get(target.pinnedAccountIdx) ?? null;
        if (target.accountIdx != null)
            return idxToDiscordId.get(target.accountIdx) ?? null;
        return null;
    }
    function pauseSourceFor(target, overlay) {
        if (!SCRAPER_FLAGS.pauseControlEnabled)
            return 'none';
        const channelPaused = overlay.pausedChannels.has(target.channelId);
        const ownerAccountId = ownerAccountFor(target);
        const accountPaused = !!(SCRAPER_FLAGS.accountPauseEnabled && ownerAccountId && overlay.pausedAccounts.has(ownerAccountId));
        if (channelPaused && accountPaused)
            return 'both';
        if (channelPaused)
            return 'channel';
        if (accountPaused)
            return 'account';
        return 'none';
    }
    function pauseReasonFor(target, overlay, pauseSource) {
        if (pauseSource === 'channel' || pauseSource === 'both') {
            const reason = overlay.pausedChannels.get(target.channelId)?.reason?.trim();
            if (reason)
                return reason;
        }
        if (pauseSource === 'account' || pauseSource === 'both') {
            const ownerAccountId = ownerAccountFor(target);
            const reason = ownerAccountId ? overlay.pausedAccounts.get(ownerAccountId)?.reason?.trim() : '';
            if (reason)
                return reason;
        }
        if (pauseSource === 'channel')
            return 'paused by channel control';
        if (pauseSource === 'account')
            return 'paused by account control';
        if (pauseSource === 'both')
            return 'paused by account and channel control';
        return null;
    }
    function writeRuntimeState(target, schedulerState, opts) {
        if (!SCRAPER_FLAGS.runtimeStateEnabled)
            return;
        (0, stats_1.ensureChannel)(target.channelId, target.guildId, opts?.accountId ?? target.accountId);
        (0, stats_1.setRuntimeState)(target.channelId, {
            schedulerState,
            pauseSource: opts?.pauseSource ?? 'none',
            stateReason: opts?.stateReason ?? null,
            workerId: WORKER_ID,
            lastErrorClass: opts?.lastErrorClass ?? null,
            lastErrorCode: opts?.lastErrorCode ?? null,
            lastErrorAt: opts?.lastErrorAt ?? null,
        });
    }
    function pinnedAccountFor(target) {
        const pinned = target.pinnedAccountId ?? (target.pinnedAccountIdx != null ? idxToDiscordId.get(target.pinnedAccountIdx) ?? null : null);
        if (!pinned)
            return null;
        if (!activeIds.includes(pinned))
            return null;
        const pool = guildToAccounts.get(target.guildId);
        if (!pool || pool.includes(pinned))
            return pinned;
        console.warn(`[accounts] Pinned hesap guild dışı görünüyor, fallback: ${target.channelId} → ${pinned}`);
        return null;
    }
    function pickAccount(target, overlay = controlOverlay) {
        const pinned = pinnedAccountFor(target);
        if (pinned)
            return pinned;
        const basePool = guildToAccounts.get(target.guildId) ?? activeIds;
        const eligiblePool = SCRAPER_FLAGS.accountPauseEnabled
            ? basePool.filter(accId => !overlay.pausedAccounts.has(accId))
            : basePool;
        const pool = eligiblePool.length > 0 ? eligiblePool : basePool;
        if (!guildToAccounts.has(target.guildId))
            console.warn(`[accounts] Guild ${target.guildId} için uygun hesap yok, fallback`);
        const rr = guildRR.get(target.guildId) ?? 0;
        guildRR.set(target.guildId, (rr + 1) % pool.length);
        return pool[rr % pool.length];
    }
    function targetStateKey(target) {
        return [
            target.guildId,
            target.pinnedAccountId ?? '',
            target.pinnedAccountIdx != null ? String(target.pinnedAccountIdx) : '',
        ].join('|');
    }
    async function upsertTargetMirror(target, activeAccountId) {
        const ownerAccountId = target.pinnedAccountId ?? activeAccountId;
        const previousOwnerId = ownerAccountByChannel.get(target.channelId) ?? target.pinnedAccountId ?? target.accountId ?? assignedAccountByChannel.get(target.channelId);
        if (previousOwnerId && previousOwnerId !== ownerAccountId) {
            await db.execute(`DELETE FROM ${KEYSPACE}.account_targets_by_account WHERE account_id = ? AND channel_id = ?`, [previousOwnerId, target.channelId]).catch(() => { });
        }
        const ownerAccountIdx = globalIdxByAccountId.get(ownerAccountId);
        const activeAccountIdx = globalIdxByAccountId.get(activeAccountId);
        await db.execute(`INSERT INTO ${KEYSPACE}.account_targets_by_account (account_id, channel_id, guild_id, label, account_idx, active_account_id, active_account_idx, pinned_account_id, pinned_account_idx, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, [ownerAccountId, target.channelId, target.guildId, target.label ?? '', ownerAccountIdx ?? null, activeAccountId, activeAccountIdx ?? null, target.pinnedAccountId ?? null, target.pinnedAccountIdx ?? null, new Date()]).catch(() => { });
        assignedAccountByChannel.set(target.channelId, activeAccountId);
        ownerAccountByChannel.set(target.channelId, ownerAccountId);
    }
    async function deleteTargetMirror(channelId) {
        const ownerAccountId = ownerAccountByChannel.get(channelId) ?? assignedAccountByChannel.get(channelId);
        if (ownerAccountId) {
            await db.execute(`DELETE FROM ${KEYSPACE}.account_targets_by_account WHERE account_id = ? AND channel_id = ?`, [ownerAccountId, channelId]).catch(() => { });
        }
        assignedAccountByChannel.delete(channelId);
        ownerAccountByChannel.delete(channelId);
    }
    async function seedTargetMirrors(targets) {
        const withAccount = targets.filter(t => t.accountId || t.pinnedAccountId);
        for (let i = 0; i < withAccount.length; i += 100) {
            await Promise.all(withAccount.slice(i, i + 100).map(t => upsertTargetMirror(t, t.accountId ?? t.pinnedAccountId)));
        }
    }
    function clearQueuedForAccount(accountId, overlay) {
        const waiting = [...(queuedChannelsByAccount.get(accountId) ?? [])];
        if (waiting.length === 0)
            return;
        queues.get(accountId)?.clear();
        for (const channelId of waiting) {
            const target = currentTargetsByChannel.get(channelId);
            const pauseSource = target ? pauseSourceFor(target, overlay) : 'none';
            abortHandles.get(channelId)?.controller.abort();
            abortHandles.delete(channelId);
            removeChannelFromAccount(queuedChannelsByAccount, accountId, channelId);
            enqueued.delete(channelId);
            trackedTargetState.delete(channelId);
            channelRunToken.delete(channelId);
            stopReasonByChannel.delete(channelId);
            if (target && pauseSource !== 'none') {
                const reason = pauseReasonFor(target, overlay, pauseSource);
                writeRuntimeState(target, 'paused', { accountId, pauseSource, stateReason: reason });
                (0, scrape_event_log_1.emit)('dequeue', `${channelId} duraklatildi`, { accountId, channelId, guildId: target.guildId, detail: reason ?? undefined });
            }
        }
    }
    async function finalizeScrapeExit(target, accId, runToken, result) {
        if (channelRunToken.get(target.channelId) !== runToken)
            return;
        const stop = stopReasonByChannel.get(target.channelId);
        const stopMatches = stop?.runToken === runToken;
        const nowIso = new Date().toISOString();
        if (result.kind === 'completed') {
            writeRuntimeState(target, 'completed', { accountId: accId, stateReason: result.reason ?? 'complete' });
            await (0, stats_1.flushStats)().catch(() => { });
        }
        else if (result.kind === 'error_retryable') {
            writeRuntimeState(target, 'error_retryable', {
                accountId: accId,
                stateReason: result.reason ?? 'retryable scrape error',
                lastErrorClass: 'retryable',
                lastErrorCode: result.code ?? 'retryable_error',
                lastErrorAt: nowIso,
            });
            await (0, stats_1.flushStats)().catch(() => { });
        }
        else if (result.kind === 'error_terminal') {
            writeRuntimeState(target, 'error_terminal', {
                accountId: accId,
                stateReason: result.reason ?? 'terminal scrape error',
                lastErrorClass: 'terminal',
                lastErrorCode: result.code ?? 'terminal_error',
                lastErrorAt: nowIso,
            });
            await (0, stats_1.flushStats)().catch(() => { });
        }
        else if (result.kind === 'aborted' && stopMatches && (stop.reason === 'pause_account' || stop.reason === 'pause_channel')) {
            const flushed = await (0, checkpoint_1.flushCheckpoint)(target.channelId);
            enqueued.delete(target.channelId);
            trackedTargetState.delete(target.channelId);
            if (flushed) {
                const reason = pauseReasonFor(target, controlOverlay, stop.pauseSource);
                writeRuntimeState(target, 'paused', {
                    accountId: accId,
                    pauseSource: stop.pauseSource,
                    stateReason: reason,
                });
                (0, scrape_event_log_1.emit)('info', `${target.channelId} duraklatildi`, { accountId: accId, channelId: target.channelId, guildId: target.guildId, detail: reason ?? undefined });
            }
            else {
                writeRuntimeState(target, 'error_retryable', {
                    accountId: accId,
                    pauseSource: stop.pauseSource,
                    stateReason: 'pause checkpoint flush failed',
                    lastErrorClass: 'retryable',
                    lastErrorCode: 'pause_checkpoint_flush_failed',
                    lastErrorAt: nowIso,
                });
            }
            await (0, stats_1.flushStats)().catch(() => { });
        }
        else if (result.kind === 'aborted') {
            enqueued.delete(target.channelId);
            trackedTargetState.delete(target.channelId);
            if (!stopMatches || stop.reason === 'shutdown') {
                writeRuntimeState(target, 'error_retryable', {
                    accountId: accId,
                    stateReason: result.reason ?? 'aborted',
                    lastErrorClass: 'retryable',
                    lastErrorCode: result.code ?? 'abort_signal',
                    lastErrorAt: nowIso,
                });
                await (0, stats_1.flushStats)().catch(() => { });
            }
            if (stopMatches && (stop.reason === 'target_reassigned' || stop.reason === 'account_pool_changed')) {
                setImmediate(() => {
                    withSchedulerLock(() => syncTargets(undefined, controlOverlay)).catch(() => { });
                });
            }
        }
        else if (result.kind === 'noop' && result.code === 'empty_channel') {
            writeRuntimeState(target, 'completed', { accountId: accId, stateReason: result.reason ?? 'channel is empty' });
            await (0, stats_1.flushStats)().catch(() => { });
        }
        else if (result.kind === 'noop') {
            writeRuntimeState(target, 'error_retryable', {
                accountId: accId,
                stateReason: result.reason ?? 'scrape exited without progress',
                lastErrorClass: 'retryable',
                lastErrorCode: result.code ?? 'noop',
                lastErrorAt: nowIso,
            });
            await (0, stats_1.flushStats)().catch(() => { });
        }
        if (stopMatches)
            stopReasonByChannel.delete(target.channelId);
        channelRunToken.delete(target.channelId);
    }
    function enqueueChannel(target, accId, overlay = controlOverlay) {
        if (enqueued.has(target.channelId))
            return;
        const cp = (0, checkpoint_1.getAllCheckpoints)()[target.channelId];
        if (cp?.complete) {
            console.log(`[accounts] ${target.channelId} zaten tamamlanmış`);
            writeRuntimeState(target, 'completed', { accountId: target.accountId ?? accId, stateReason: 'checkpoint complete' });
            return;
        }
        const pauseSource = pauseSourceFor(target, overlay);
        if (pauseSource !== 'none') {
            writeRuntimeState(target, 'paused', {
                accountId: ownerAccountFor(target) ?? target.accountId ?? accId,
                pauseSource,
                stateReason: pauseReasonFor(target, overlay, pauseSource),
            });
            return;
        }
        const queue = queues.get(accId);
        const client = clients.get(accId);
        if (!queue || !client)
            return;
        const abort = new AbortController();
        const runToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        enqueued.add(target.channelId);
        channelRunToken.set(target.channelId, runToken);
        abortHandles.set(target.channelId, { controller: abort, runToken, accountId: accId });
        addChannel(queuedChannelsByAccount, accId, target.channelId);
        writeRuntimeState(target, 'queued', { accountId: accId, stateReason: 'queued for scrape' });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const accName = client.user?.username ?? accId;
        console.log(`[accounts] ▶ ${target.channelId} → ${accName} (${accId}) kuyruğuna eklendi`);
        (0, scrape_event_log_1.emit)('enqueue', `${target.channelId} → ${accName}`, { accountId: accId, accountName: accName, channelId: target.channelId, guildId: target.guildId });
        const accountIdx = globalIdxByAccountId.get(accId);
        db.execute(`UPDATE ${KEYSPACE}.scrape_targets SET account_id = ?, account_idx = ? WHERE channel_id = ?`, [accId, accountIdx ?? null, target.channelId]).catch(() => { });
        upsertTargetMirror(target, accId).catch(() => { });
        queue.add(async () => {
            const handle = abortHandles.get(target.channelId);
            if (!handle || handle.runToken !== runToken)
                return;
            removeChannelFromAccount(queuedChannelsByAccount, accId, target.channelId);
            let result;
            if (abort.signal.aborted) {
                result = { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received before run start' };
            }
            else {
                addChannel(runningChannelsByAccount, accId, target.channelId);
                writeRuntimeState(target, 'running', { accountId: accId, stateReason: 'scrape in progress' });
                try {
                    result = await (0, scraper_1.scrapeChannel)(client, target.guildId, target.channelId, async (batch) => { if (!abort.signal.aborted)
                        await sendToKafka(batch); }, (total) => { if (total % 5_000 === 0)
                        console.log(`[accounts] ${accName} | ${target.channelId} | ${total.toLocaleString()} mesaj`); }, abort.signal, accId, throttleHooks);
                }
                catch (err) {
                    if (!abort.signal.aborted)
                        console.error(`[accounts] ${accName} ${target.channelId} hata:`, err);
                    result = {
                        kind: 'error_retryable',
                        code: 'worker_unhandled_error',
                        reason: err instanceof Error ? err.message : String(err),
                    };
                }
            }
            removeChannelFromAccount(runningChannelsByAccount, accId, target.channelId);
            const currentHandle = abortHandles.get(target.channelId);
            if (currentHandle?.runToken === runToken)
                abortHandles.delete(target.channelId);
            await finalizeScrapeExit(target, accId, runToken, result);
        }).catch(err => {
            console.error(`[accounts] Queue task failed for ${target.channelId}:`, err);
        });
    }
    async function syncTargets(targetsOverride, overlayOverride) {
        const targets = targetsOverride ?? await readTargets(db);
        const overlay = overlayOverride ?? controlOverlay;
        currentTargetsByChannel.clear();
        for (const target of targets)
            currentTargetsByChannel.set(target.channelId, target);
        const liveChannelIds = new Set(targets.map(t => t.channelId));
        const accountsToRebuild = new Set();
        for (const channelId of [...enqueued]) {
            if (!liveChannelIds.has(channelId)) {
                const handle = abortHandles.get(channelId);
                if (handle) {
                    stopReasonByChannel.set(channelId, { reason: 'target_removed', runToken: handle.runToken, pauseSource: 'none' });
                    accountsToRebuild.add(handle.accountId);
                    handle.controller.abort();
                }
                else {
                    enqueued.delete(channelId);
                }
                trackedTargetState.delete(channelId);
                deleteTargetMirror(channelId).catch(() => { });
                (0, stats_1.removeChannel)(channelId);
                console.log(`[accounts] ■ ${channelId} listeden çıkarıldı`);
                (0, scrape_event_log_1.emit)('dequeue', `${channelId} kaldirildi`, { channelId });
            }
        }
        for (const target of targets) {
            const pauseSource = pauseSourceFor(target, overlay);
            const stateKey = targetStateKey(target);
            const prevState = trackedTargetState.get(target.channelId);
            const handle = abortHandles.get(target.channelId);
            if (pauseSource !== 'none' && enqueued.has(target.channelId) && handle) {
                stopReasonByChannel.set(target.channelId, {
                    reason: pauseSource === 'channel' ? 'pause_channel' : 'pause_account',
                    runToken: handle.runToken,
                    pauseSource,
                });
                accountsToRebuild.add(handle.accountId);
                handle.controller.abort();
            }
            if (pauseSource === 'none' && enqueued.has(target.channelId) && prevState && prevState !== stateKey) {
                if (handle) {
                    stopReasonByChannel.set(target.channelId, { reason: 'target_reassigned', runToken: handle.runToken, pauseSource: 'none' });
                    accountsToRebuild.add(handle.accountId);
                    handle.controller.abort();
                }
                else {
                    enqueued.delete(target.channelId);
                    trackedTargetState.delete(target.channelId);
                }
                console.log(`[accounts] ↻ ${target.channelId} yeniden atanıyor`);
            }
        }
        for (const accountId of accountsToRebuild)
            clearQueuedForAccount(accountId, overlay);
        for (const target of targets) {
            const pauseSource = pauseSourceFor(target, overlay);
            const cp = (0, checkpoint_1.getAllCheckpoints)()[target.channelId];
            if (cp?.complete) {
                writeRuntimeState(target, 'completed', { accountId: target.accountId ?? ownerAccountFor(target), stateReason: 'checkpoint complete' });
                continue;
            }
            if (pauseSource !== 'none') {
                const assignedAccountId = assignedAccountByChannel.get(target.channelId) ?? ownerAccountFor(target) ?? target.accountId ?? null;
                const isRunning = assignedAccountId ? runningChannelsByAccount.get(assignedAccountId)?.has(target.channelId) === true : false;
                if (!isRunning) {
                    writeRuntimeState(target, 'paused', {
                        accountId: assignedAccountId,
                        pauseSource,
                        stateReason: pauseReasonFor(target, overlay, pauseSource),
                    });
                }
                continue;
            }
            if (!enqueued.has(target.channelId)) {
                enqueueChannel(target, pickAccount(target, overlay), overlay);
                trackedTargetState.set(target.channelId, targetStateKey(target));
            }
        }
    }
    function requestAbortForAccount(accountId, reason, overlay) {
        clearQueuedForAccount(accountId, overlay);
        const running = [...(runningChannelsByAccount.get(accountId) ?? [])];
        for (const channelId of running) {
            const handle = abortHandles.get(channelId);
            if (!handle)
                continue;
            stopReasonByChannel.set(channelId, { reason, runToken: handle.runToken, pauseSource: 'none' });
            handle.controller.abort();
        }
    }
    function abortAllEnqueued(reason, overlay) {
        const accounts = new Set([
            ...queuedChannelsByAccount.keys(),
            ...runningChannelsByAccount.keys(),
            ...[...abortHandles.values()].map(handle => handle.accountId),
        ]);
        for (const accountId of accounts)
            requestAbortForAccount(accountId, reason, overlay);
    }
    controlOverlay = await readControlOverlay(db);
    lastControlHash = controlOverlay.hash;
    const initialTargets = await readTargets(db);
    await seedTargetMirrors(initialTargets);
    await withSchedulerLock(() => syncTargets(initialTargets, controlOverlay));
    console.log(`[accounts] ${enqueued.size} kanal kuyruğa alındı`);
    // Name cache — runs in background, non-blocking
    setImmediate(async () => {
        try {
            const targets = await readTargets(db);
            const namesToSave = [];
            // Guild names come from discord.js cache (free, no API calls)
            for (const accId of activeIds) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const client = clients.get(accId);
                for (const [guildId, guild] of (client.guilds?.cache ?? new Map())) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    if (guild?.name)
                        namesToSave.push([guildId, guild.name, 'guild', guild.icon ?? null]);
                }
            }
            // SCALE FIX: Check which channel IDs are already in name_cache before
            // making Discord API calls. At 90K channels this avoids 90K API requests on restart.
            const existingResult = await db.execute(`SELECT id FROM ${KEYSPACE}.name_cache WHERE kind = 'channel' ALLOW FILTERING`);
            const alreadyCached = new Set(existingResult.rows.map(r => r['id']));
            const uncachedTargets = targets.filter(t => !alreadyCached.has(t.channelId));
            console.log(`[accounts] İsim cache: ${alreadyCached.size} mevcut, ${uncachedTargets.length} yeni kanal bulunacak`);
            // Fetch names only for uncached channels — in small batches with delay
            // to avoid Discord rate limits (1 batch of 5 every 2s)
            const NAME_FETCH_CONCURRENCY = parseInt(process.env.NAME_FETCH_CONCURRENCY ?? '5', 10);
            const NAME_FETCH_DELAY_MS = parseInt(process.env.NAME_FETCH_DELAY_MS ?? '2000', 10);
            const chunks = [];
            for (let i = 0; i < uncachedTargets.length; i += NAME_FETCH_CONCURRENCY)
                chunks.push(uncachedTargets.slice(i, i + NAME_FETCH_CONCURRENCY));
            for (const chunk of chunks) {
                await Promise.all(chunk.map(async (t) => {
                    // Pick account that is in this guild for the fetch
                    const accId = pickAccount(t) || activeIds[0];
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const client = clients.get(accId);
                    if (!client)
                        return;
                    try {
                        const ch = await client.channels.fetch(t.channelId);
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        if (ch?.name)
                            namesToSave.push([t.channelId, ch.name, 'channel', null]);
                    }
                    catch { /* erişim yoksa atla */ }
                }));
                if (chunks.indexOf(chunk) < chunks.length - 1)
                    await new Promise(r => setTimeout(r, NAME_FETCH_DELAY_MS));
            }
            // Write to DB in batches of 50 (not one giant Promise.all)
            const WRITE_CHUNK = 50;
            for (let i = 0; i < namesToSave.length; i += WRITE_CHUNK) {
                const slice = namesToSave.slice(i, i + WRITE_CHUNK);
                await Promise.all(slice.map(([id, name, kind, icon]) => db.execute(`INSERT INTO ${KEYSPACE}.name_cache (id, name, kind, icon) VALUES (?,?,?,?)`, [id, name, kind, icon ?? null])));
            }
            if (namesToSave.length > 0)
                console.log(`[accounts] ✓ ${namesToSave.length} isim kaydedildi`);
        }
        catch (err) {
            console.warn('[accounts] İsim yükleme hatası (non-fatal):', err);
        }
    });
    let pollTimer;
    let lastTargetCount = initialTargets.length;
    let lastTargetHash = [...initialTargets]
        .sort((a, b) => a.channelId.localeCompare(b.channelId))
        .map(t => `${t.channelId}|${targetStateKey(t)}`)
        .join(',');
    pollTimer = setInterval(async () => {
        try {
            const [targets, overlay] = await Promise.all([
                readTargets(db),
                readControlOverlay(db),
            ]);
            const hash = [...targets]
                .sort((a, b) => a.channelId.localeCompare(b.channelId))
                .map(t => `${t.channelId}|${targetStateKey(t)}`)
                .join(',');
            const overlayChanged = overlay.hash !== lastControlHash;
            if (targets.length !== lastTargetCount || hash !== lastTargetHash || overlayChanged) {
                console.log(`[accounts] Hedef değişikliği algılandı (${lastTargetCount} → ${targets.length})`);
                await withSchedulerLock(async () => {
                    controlOverlay = overlay;
                    const before = enqueued.size;
                    await seedTargetMirrors(targets);
                    await syncTargets(targets, controlOverlay);
                    const added = enqueued.size - before;
                    if (added > 0)
                        console.log(`[accounts] +${added} yeni kanal kuyruğa eklendi`);
                    lastTargetCount = targets.length;
                    lastTargetHash = hash;
                    lastControlHash = controlOverlay.hash;
                });
            }
        }
        catch { /* ignore */ }
    }, 2_000);
    // accounts.json hot-reload — compares tokens to detect changes
    let accWatchDebounce = null;
    // Track which tokens are currently loaded (to detect additions/removals)
    const activeTokens = new Set(accountPairs.filter(([gIdx]) => idxToDiscordId.has(gIdx)).map(([_, acc]) => acc.token));
    fs_1.default.watchFile(ACCOUNTS_FILE, { interval: 2_000 }, () => {
        if (accWatchDebounce)
            clearTimeout(accWatchDebounce);
        accWatchDebounce = setTimeout(async () => {
            await withSchedulerLock(async () => {
                let newPairs;
                try {
                    newPairs = loadAccounts();
                }
                catch {
                    return;
                }
                liveAccountPairs = newPairs;
                refreshProxyAssignmentPlan(liveAccountPairs);
                const newTokens = new Set(newPairs.map(([_, acc]) => acc.token));
                let accountPoolChanged = false;
                for (const [gIdx, acc] of newPairs) {
                    if (activeTokens.has(acc.token))
                        continue;
                    console.log(`[accounts] Yeni hesap — login olunuyor…`);
                    const accountKey = `idx:${gIdx}`;
                    const proxyAssignment = proxyAssignmentForIdx(gIdx);
                    let bundle;
                    try {
                        if ((0, proxy_1.isProxyPoolEnabled)()) {
                            if (!proxyAssignment?.proxy) {
                                const noProxyMsg = 'Proxy sistemi aktif ama hesaba atanmış proxy yok';
                                (0, proxy_1.updateRuntimeProxyAssignment)(accountKey, { connected: false, lastError: noProxyMsg, direct: true });
                                if ((0, proxy_1.isProxyStrictMode)())
                                    throw new Error(noProxyMsg);
                            }
                            else {
                                bundle = await (0, proxy_1.createProxyAgentBundle)(proxyAssignment.proxy);
                                console.log(`[accounts] Yeni hesap (idx ${gIdx}) → proxy ${proxyAssignment.proxy.maskedUrl}`);
                            }
                        }
                        const client = await createClient(acc.token, bundle);
                        const discordId = client.user?.id ?? `unknown-${Date.now()}`;
                        const tokenHint = failedTokenHint(acc.token);
                        idxToDiscordId.set(gIdx, discordId);
                        globalIdxByAccountId.set(discordId, gIdx);
                        accountKeyById.set(discordId, accountKey);
                        clients.set(discordId, client);
                        accountAgents.set(discordId, bundle);
                        queues.set(discordId, new p_queue_1.default({ concurrency: CONCURRENT_CHNL }));
                        accountBaseConcurrency.set(discordId, CONCURRENT_CHNL);
                        activeIds.push(discordId);
                        tokenById.set(discordId, acc.token);
                        activeTokens.add(acc.token);
                        (0, proxy_1.updateRuntimeProxyAssignment)(accountKey, { accountId: discordId, username: client.user?.username ?? '', connected: true, lastError: null, direct: !proxyAssignment?.proxy });
                        db.execute(`DELETE FROM ${KEYSPACE}.failed_accounts WHERE account_id = ?`, [discordId]).catch(() => { });
                        deleteFailedRowsByTokenHint(db, tokenHint).catch(() => { });
                        db.execute(`INSERT INTO ${KEYSPACE}.token_account_map (token_key, account_id, username, updated_at) VALUES (?,?,?,?)`, [acc.token.slice(-16), discordId, client.user?.username ?? '', new Date()]).catch(() => { });
                        const guildIds = await fetchGuildIds(acc.token, bundle?.agent);
                        accountGuilds.set(discordId, guildIds);
                        rebuildGuildToAccounts();
                        accountPoolChanged = true;
                        console.log(`[accounts] ✓ ${client.user?.username} (${discordId}) sisteme katıldı (${guildIds.size} guild)`);
                    }
                    catch (err) {
                        console.error(`[accounts] Yeni hesap hata:`, err);
                        try {
                            const errMsg = err instanceof Error ? err.message : String(err);
                            const { accountId: discordId, username: uname } = await recordFailedAccount(db, acc.token, `unknown_hotreload_${Date.now()}`, 'login_failed', errMsg, bundle?.agent);
                            (0, proxy_1.updateRuntimeProxyAssignment)(accountKey, { accountId: discordId, username: uname || null, connected: false, lastError: errMsg });
                            (0, scrape_event_log_1.emit)('scrape_error', `${uname || discordId} login basarisiz (hot-reload)`, { accountId: discordId, accountName: uname || discordId });
                            console.log(`[accounts] Failed account detected (hot-reload): ${uname || discordId}`);
                        }
                        catch { /* ignore */ }
                        destroyBundle(bundle);
                    }
                }
                for (const [accId] of [...clients]) {
                    const token = tokenById.get(accId);
                    if (token && newTokens.has(token))
                        continue;
                    const removedIdx = globalIdxByAccountId.get(accId);
                    requestAbortForAccount(accId, 'account_pool_changed', controlOverlay);
                    queues.get(accId)?.clear();
                    clearThrottleStateForAccount(accId);
                    clients.delete(accId);
                    queues.delete(accId);
                    destroyBundle(accountAgents.get(accId));
                    accountAgents.delete(accId);
                    accountGuilds.delete(accId);
                    globalIdxByAccountId.delete(accId);
                    accountKeyById.delete(accId);
                    queuedChannelsByAccount.delete(accId);
                    runningChannelsByAccount.delete(accId);
                    for (const [gIdx, discordId] of [...idxToDiscordId.entries()]) {
                        if (discordId === accId)
                            idxToDiscordId.delete(gIdx);
                    }
                    if (token) {
                        tokenById.delete(accId);
                        activeTokens.delete(token);
                    }
                    const ai = activeIds.indexOf(accId);
                    if (ai !== -1)
                        activeIds.splice(ai, 1);
                    if (removedIdx != null)
                        (0, proxy_1.removeRuntimeProxyAssignment)({ accountIdx: removedIdx });
                    rebuildGuildToAccounts();
                    accountPoolChanged = true;
                    console.log(`[accounts] ${accId} kaldırıldı`);
                }
                if (accountPoolChanged && activeIds.length > 0) {
                    abortAllEnqueued('account_pool_changed', controlOverlay);
                    await syncTargets(undefined, controlOverlay);
                }
                (0, guild_sync_1.updateGuildSyncAccounts)(liveAccountPairs
                    .filter(([gIdx]) => idxToDiscordId.has(gIdx))
                    .map(([gIdx, acc]) => ({ accountId: idxToDiscordId.get(gIdx), accountIdx: gIdx, config: acc, agent: accountAgents.get(idxToDiscordId.get(gIdx))?.agent })));
            });
        }, 1_000);
    });
    await new Promise(resolve => {
        const shutdown = async () => {
            clearInterval(pollTimer);
            if (accWatchDebounce)
                clearTimeout(accWatchDebounce);
            fs_1.default.unwatchFile(ACCOUNTS_FILE);
            for (const accountId of accountRecoveryTimers.keys())
                clearRecoveryTimer(accountId);
            for (const [accountId, accountKey] of accountKeyById)
                (0, proxy_1.updateRuntimeProxyAssignment)(accountKey, { accountId, connected: false, lastError: 'worker_shutdown' });
            abortAllEnqueued('shutdown', controlOverlay);
            await Promise.all([...queues.values()].map(queue => queue.onIdle().catch(() => { })));
            await (0, checkpoint_1.flush)();
            await (0, stats_1.flushStats)().catch(() => { });
            (0, guild_sync_1.stopGuildSync)();
            await (0, scrape_event_log_1.stopEventLog)();
            (0, proxy_1.stopProxyPool)();
            await disconnectKafka();
            for (const [accId, client] of clients) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await client.destroy?.().catch(() => { });
                destroyBundle(accountAgents.get(accId));
                console.log(`[accounts] ${accId} kapatıldı`);
            }
            console.log(`[accounts] Durduruldu. Aktif: ${(0, stats_1.activeChannelCount)()}`);
            resolve();
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
    });
}
main().catch(err => { console.error('[accounts] Fatal:', err); process.exit(1); });
//# sourceMappingURL=index.js.map