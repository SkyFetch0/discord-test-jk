"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initProxyPool = initProxyPool;
exports.stopProxyPool = stopProxyPool;
exports.getProxyPoolConfig = getProxyPoolConfig;
exports.getProxyConfigHash = getProxyConfigHash;
exports.isProxyPoolEnabled = isProxyPoolEnabled;
exports.isProxyStrictMode = isProxyStrictMode;
exports.syncPlannedProxyAssignments = syncPlannedProxyAssignments;
exports.updateRuntimeProxyAssignment = updateRuntimeProxyAssignment;
exports.removeRuntimeProxyAssignment = removeRuntimeProxyAssignment;
exports.createProxyAgent = createProxyAgent;
exports.createProxyAgentBundle = createProxyAgentBundle;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const shared_1 = require("@senneo/shared");
const PROXIES_FILE = path_1.default.resolve(__dirname, '../../../proxies.json');
const PROXY_RUNTIME_FILE = path_1.default.resolve(__dirname, '../../../proxy_runtime_state.json');
const dynamicImport = new Function('modulePath', 'return import(modulePath);');
let _poolConfig = (0, shared_1.normalizeProxyPoolConfig)({ proxies: [] });
let _configHash = (0, shared_1.buildProxyPoolConfigHash)(_poolConfig);
let _watching = false;
let _runtimeAssignments = new Map();
function parseOptionalEnvFlag(name) {
    const raw = process.env[name];
    if (raw == null || raw.trim() === '')
        return undefined;
    const normalized = raw.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized))
        return true;
    if (['false', '0', 'no', 'off'].includes(normalized))
        return false;
    return undefined;
}
function withEnvOverrides(config) {
    const enabledOverride = parseOptionalEnvFlag('PROXY_ENABLED');
    const strictOverride = parseOptionalEnvFlag('PROXY_STRICT_MODE');
    return {
        ...config,
        enabled: enabledOverride ?? config.enabled,
        strictMode: strictOverride ?? config.strictMode,
    };
}
function readProxyConfig() {
    if (!fs_1.default.existsSync(PROXIES_FILE))
        return withEnvOverrides((0, shared_1.normalizeProxyPoolConfig)({ proxies: [] }));
    try {
        const raw = JSON.parse(fs_1.default.readFileSync(PROXIES_FILE, 'utf-8'));
        return withEnvOverrides((0, shared_1.normalizeProxyPoolConfig)(raw));
    }
    catch (err) {
        console.warn('[proxy] proxies.json parse hatası (non-fatal):', err);
        return withEnvOverrides((0, shared_1.normalizeProxyPoolConfig)({ proxies: [] }));
    }
}
function sortRuntimeAssignments(values) {
    return [...values].sort((a, b) => {
        const leftIdx = a.accountIdx ?? Number.MAX_SAFE_INTEGER;
        const rightIdx = b.accountIdx ?? Number.MAX_SAFE_INTEGER;
        if (leftIdx !== rightIdx)
            return leftIdx - rightIdx;
        return a.accountKey.localeCompare(b.accountKey);
    });
}
function writeRuntimeSnapshot() {
    try {
        fs_1.default.writeFileSync(PROXY_RUNTIME_FILE, JSON.stringify({
            updatedAt: new Date().toISOString(),
            configPath: PROXIES_FILE,
            configHash: _configHash,
            enabled: _poolConfig.enabled,
            strictMode: _poolConfig.strictMode,
            rotationMode: _poolConfig.rotationMode,
            healthCheckMs: _poolConfig.healthCheckMs,
            failThreshold: _poolConfig.failThreshold,
            cooldownMs: _poolConfig.cooldownMs,
            proxies: _poolConfig.proxies.map(proxy => ({
                proxyId: proxy.proxyId,
                label: proxy.label,
                maskedUrl: proxy.maskedUrl,
                protocol: proxy.protocol,
                host: proxy.host,
                port: proxy.port,
                region: proxy.region,
                maxConns: proxy.maxConns,
                weight: proxy.weight,
                enabled: proxy.enabled,
            })),
            accounts: sortRuntimeAssignments(_runtimeAssignments.values()),
        }, null, 2));
    }
    catch (err) {
        console.warn('[proxy] runtime snapshot yazılamadı:', err);
    }
}
function refreshPoolConfig() {
    _poolConfig = readProxyConfig();
    _configHash = (0, shared_1.buildProxyPoolConfigHash)(_poolConfig);
    const enabledCount = _poolConfig.proxies.filter(proxy => proxy.enabled).length;
    if (enabledCount > 0) {
        console.log(`[proxy] ${enabledCount}/${_poolConfig.proxies.length} proxy yüklendi (${PROXIES_FILE})`);
    }
    else if (_poolConfig.enabled) {
        console.warn('[proxy] Proxy sistemi aktif ama kullanılabilir proxy yok');
    }
    else {
        console.log('[proxy] Proxy kapalı — direct bağlantı kullanılacak');
    }
    writeRuntimeSnapshot();
}
function runtimeStateFromAssignment(assignment, previous) {
    const now = new Date().toISOString();
    const proxy = previous?.connected && previous.proxyId
        ? {
            proxyId: previous.proxyId,
            label: previous.proxyLabel ?? '',
            maskedUrl: previous.proxyMaskedUrl ?? '',
            protocol: previous.proxyProtocol,
            host: previous.proxyHost ?? '',
            port: previous.proxyPort ?? 0,
            region: previous.proxyRegion,
        }
        : assignment.proxy;
    const assignedAt = previous?.proxyId === proxy?.proxyId ? previous?.assignedAt ?? now : now;
    return {
        accountKey: assignment.accountKey,
        accountIdx: assignment.accountIdx,
        accountId: assignment.accountId ?? previous?.accountId ?? null,
        username: assignment.username ?? previous?.username ?? null,
        proxyId: proxy?.proxyId ?? null,
        proxyLabel: proxy?.label ?? null,
        proxyMaskedUrl: proxy?.maskedUrl ?? null,
        proxyProtocol: proxy?.protocol ?? null,
        proxyHost: proxy?.host ?? null,
        proxyPort: proxy?.port ?? null,
        proxyRegion: proxy?.region ?? null,
        direct: previous?.connected && previous.proxyId ? false : assignment.direct,
        connected: previous?.connected ?? false,
        assignmentReason: previous?.connected && previous.proxyId ? previous.assignmentReason : assignment.reason,
        lastError: previous?.lastError ?? null,
        assignedAt,
        connectedAt: previous?.connectedAt ?? null,
        updatedAt: now,
    };
}
function initProxyPool() {
    refreshPoolConfig();
    if (_watching)
        return;
    _watching = true;
    fs_1.default.watchFile(PROXIES_FILE, { interval: 5_000 }, () => {
        const before = _configHash;
        refreshPoolConfig();
        if (before !== _configHash)
            console.log('[proxy] proxies.json yeniden yüklendi');
    });
}
function stopProxyPool() {
    if (_watching) {
        fs_1.default.unwatchFile(PROXIES_FILE);
        _watching = false;
    }
}
function getProxyPoolConfig() {
    return _poolConfig;
}
function getProxyConfigHash() {
    return _configHash;
}
function isProxyPoolEnabled() {
    return _poolConfig.enabled;
}
function isProxyStrictMode() {
    return _poolConfig.enabled && _poolConfig.strictMode;
}
function syncPlannedProxyAssignments(accounts) {
    const assignments = (0, shared_1.planProxyAssignments)(accounts, _poolConfig);
    const next = new Map();
    for (const assignment of assignments) {
        next.set(assignment.accountKey, runtimeStateFromAssignment(assignment, _runtimeAssignments.get(assignment.accountKey)));
    }
    _runtimeAssignments = next;
    writeRuntimeSnapshot();
    return assignments;
}
function updateRuntimeProxyAssignment(accountKey, patch) {
    const existing = _runtimeAssignments.get(accountKey);
    if (!existing)
        return;
    _runtimeAssignments.set(accountKey, {
        ...existing,
        ...patch,
        updatedAt: new Date().toISOString(),
        connectedAt: patch.connected === true ? (patch.connectedAt ?? existing.connectedAt ?? new Date().toISOString()) : (patch.connected === false ? null : existing.connectedAt),
    });
    writeRuntimeSnapshot();
}
function removeRuntimeProxyAssignment(account) {
    const accountKey = (0, shared_1.buildAccountProxyKey)(account);
    if (!accountKey)
        return;
    _runtimeAssignments.delete(accountKey);
    writeRuntimeSnapshot();
}
async function createProxyAgent(proxy) {
    if (!proxy)
        return undefined;
    try {
        if (proxy.protocol === 'socks') {
            const mod = await dynamicImport('socks-proxy-agent');
            const Ctor = mod['SocksProxyAgent']
                ?? mod.default?.['SocksProxyAgent']
                ?? mod.default;
            if (typeof Ctor !== 'function')
                throw new Error('SocksProxyAgent constructor bulunamadı');
            return new Ctor(proxy.url);
        }
        const mod = await dynamicImport('https-proxy-agent');
        const Ctor = mod['HttpsProxyAgent']
            ?? mod.default?.['HttpsProxyAgent']
            ?? mod.default;
        if (typeof Ctor !== 'function')
            throw new Error('HttpsProxyAgent constructor bulunamadı');
        return new Ctor(proxy.url);
    }
    catch (err) {
        console.error('[proxy] proxy agent yüklenemedi:', err);
        throw new Error(`Proxy agent yüklenemedi (${proxy.protocol})`);
    }
}
/**
 * Creates both a Node http.Agent AND returns the raw proxy URL.
 * discord.js-selfbot-v13 needs:
 *   - ws.agent  = { httpAgent: Agent, httpsAgent: Agent }  (for WebSocket)
 *   - http.agent = proxyUrl string                         (for REST via undici)
 */
async function createProxyAgentBundle(proxy) {
    if (!proxy)
        return undefined;
    const agent = await createProxyAgent(proxy);
    if (!agent)
        return undefined;
    return { agent, proxyUrl: proxy.url };
}
//# sourceMappingURL=proxy.js.map