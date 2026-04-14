"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.maskProxyUrl = maskProxyUrl;
exports.parseProxyProtocol = parseProxyProtocol;
exports.buildProxyId = buildProxyId;
exports.buildProxyPoolConfigHash = buildProxyPoolConfigHash;
exports.buildAccountProxyKey = buildAccountProxyKey;
exports.normalizeProxyPoolConfig = normalizeProxyPoolConfig;
exports.planProxyAssignments = planProxyAssignments;
const crypto_1 = __importDefault(require("crypto"));
function toPositiveInt(value, fallback, min = 1) {
    const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed < min)
        return fallback;
    return parsed;
}
function isRotationMode(value) {
    return value === 'round-robin' || value === 'weighted' || value === 'least-connections';
}
function normalizeProtocol(protocol) {
    const clean = protocol.replace(/:$/, '').toLowerCase();
    if (clean === 'http')
        return 'http';
    if (clean === 'https')
        return 'https';
    if (clean === 'socks' || clean === 'socks4' || clean === 'socks4a' || clean === 'socks5' || clean === 'socks5h')
        return 'socks';
    throw new Error(`Unsupported proxy protocol: ${protocol}`);
}
function safeUrl(input) {
    try {
        return new URL(input);
    }
    catch {
        return null;
    }
}
function hashValue(value) {
    return crypto_1.default.createHash('sha1').update(value).digest('hex');
}
function loadScoreWeighted(currentLoad, proxy) {
    return currentLoad / Math.max(proxy.weight, 1);
}
function loadScoreLeastConnections(currentLoad, proxy) {
    return currentLoad / Math.max(proxy.maxConns, 1);
}
function fallbackScore(currentLoad, proxy) {
    return Math.max(0, currentLoad - proxy.maxConns + 1) + loadScoreLeastConnections(currentLoad, proxy);
}
function chooseProxy(proxies, loadByProxyId, rotationMode, roundRobinIndex) {
    if (proxies.length === 0)
        return { proxy: null, nextRoundRobinIndex: roundRobinIndex, overCapacity: false };
    if (rotationMode === 'round-robin') {
        for (let i = 0; i < proxies.length; i++) {
            const idx = (roundRobinIndex + i) % proxies.length;
            const proxy = proxies[idx];
            const load = loadByProxyId.get(proxy.proxyId) ?? 0;
            if (load < proxy.maxConns) {
                return { proxy, nextRoundRobinIndex: idx + 1, overCapacity: false };
            }
        }
        let best = proxies[0];
        let bestScore = fallbackScore(loadByProxyId.get(best.proxyId) ?? 0, best);
        for (const proxy of proxies.slice(1)) {
            const score = fallbackScore(loadByProxyId.get(proxy.proxyId) ?? 0, proxy);
            if (score < bestScore || (score === bestScore && proxy.originalIndex < best.originalIndex)) {
                best = proxy;
                bestScore = score;
            }
        }
        return { proxy: best, nextRoundRobinIndex: roundRobinIndex, overCapacity: true };
    }
    const underCapacity = proxies.filter(proxy => (loadByProxyId.get(proxy.proxyId) ?? 0) < proxy.maxConns);
    const candidates = underCapacity.length > 0 ? underCapacity : proxies;
    let best = candidates[0];
    let bestScore = rotationMode === 'least-connections'
        ? loadScoreLeastConnections(loadByProxyId.get(best.proxyId) ?? 0, best)
        : loadScoreWeighted(loadByProxyId.get(best.proxyId) ?? 0, best);
    for (const proxy of candidates.slice(1)) {
        const score = rotationMode === 'least-connections'
            ? loadScoreLeastConnections(loadByProxyId.get(proxy.proxyId) ?? 0, proxy)
            : loadScoreWeighted(loadByProxyId.get(proxy.proxyId) ?? 0, proxy);
        const bestLoad = loadByProxyId.get(best.proxyId) ?? 0;
        const proxyLoad = loadByProxyId.get(proxy.proxyId) ?? 0;
        if (score < bestScore
            || (score === bestScore && proxyLoad < bestLoad)
            || (score === bestScore && proxyLoad === bestLoad && proxy.originalIndex < best.originalIndex)) {
            best = proxy;
            bestScore = score;
        }
    }
    return {
        proxy: best,
        nextRoundRobinIndex: roundRobinIndex,
        overCapacity: underCapacity.length === 0 && (loadByProxyId.get(best.proxyId) ?? 0) >= best.maxConns,
    };
}
function maskProxyUrl(url) {
    const parsed = safeUrl(url);
    if (!parsed)
        return url;
    if (parsed.username)
        parsed.username = '***';
    if (parsed.password)
        parsed.password = '***';
    return parsed.toString();
}
function parseProxyProtocol(url) {
    const parsed = safeUrl(url);
    if (!parsed)
        throw new Error(`Invalid proxy URL: ${url}`);
    return normalizeProtocol(parsed.protocol);
}
function buildProxyId(url, index = 0) {
    return hashValue(`${index}:${url.trim()}`).slice(0, 12);
}
function buildProxyPoolConfigHash(pool) {
    return hashValue(JSON.stringify({
        enabled: pool.enabled,
        strictMode: pool.strictMode,
        rotationMode: pool.rotationMode,
        healthCheckMs: pool.healthCheckMs,
        failThreshold: pool.failThreshold,
        cooldownMs: pool.cooldownMs,
        proxies: pool.proxies.map(proxy => ({
            proxyId: proxy.proxyId,
            url: proxy.url,
            enabled: proxy.enabled,
            weight: proxy.weight,
            maxConns: proxy.maxConns,
            region: proxy.region,
            label: proxy.label,
        })),
    })).slice(0, 12);
}
function buildAccountProxyKey(identity) {
    if (identity.accountKey?.trim())
        return identity.accountKey.trim();
    if (identity.accountIdx != null && identity.accountIdx >= 0)
        return `idx:${identity.accountIdx}`;
    if (identity.accountId?.trim())
        return `account:${identity.accountId.trim()}`;
    if (identity.username?.trim())
        return `user:${identity.username.trim().toLowerCase()}`;
    return '';
}
function normalizeProxyPoolConfig(raw) {
    const input = (typeof raw === 'object' && raw != null) ? raw : {};
    const rotationCandidate = input.rotationMode ?? input.rotation;
    const rotationMode = isRotationMode(rotationCandidate) ? rotationCandidate : 'weighted';
    const proxiesInput = Array.isArray(input.proxies) ? input.proxies : [];
    const proxies = proxiesInput.flatMap((entry, index) => {
        if (typeof entry !== 'object' || entry == null)
            return [];
        const row = entry;
        const url = typeof row.url === 'string' ? row.url.trim() : '';
        if (!url)
            return [];
        const parsed = safeUrl(url);
        if (!parsed)
            return [];
        let protocol;
        try {
            protocol = normalizeProtocol(parsed.protocol);
        }
        catch {
            return [];
        }
        const proxyId = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : buildProxyId(url, index);
        const port = parsed.port ? parseInt(parsed.port, 10) : protocol === 'http' ? 80 : protocol === 'https' ? 443 : 1080;
        const label = typeof row.label === 'string' && row.label.trim() ? row.label.trim() : `Proxy ${index + 1}`;
        return [{
                proxyId,
                label,
                url,
                maskedUrl: maskProxyUrl(url),
                protocol,
                host: parsed.hostname,
                port: Number.isFinite(port) ? port : (protocol === 'socks' ? 1080 : 443),
                region: typeof row.region === 'string' && row.region.trim() ? row.region.trim() : null,
                maxConns: toPositiveInt(row.maxConns, 50),
                weight: toPositiveInt(row.weight, 1),
                enabled: row.enabled !== false,
                originalIndex: index,
            }];
    });
    return {
        enabled: input.enabled === true,
        strictMode: input.strictMode === true,
        rotationMode,
        healthCheckMs: toPositiveInt(input.healthCheckMs, 30_000),
        failThreshold: toPositiveInt(input.failThreshold, 3),
        cooldownMs: toPositiveInt(input.cooldownMs, 60_000),
        proxies,
    };
}
function planProxyAssignments(accounts, pool) {
    const normalizedAccounts = accounts
        .map(account => ({
        accountKey: buildAccountProxyKey(account),
        accountIdx: account.accountIdx ?? null,
        accountId: account.accountId ?? null,
        username: account.username ?? null,
    }))
        .sort((a, b) => a.accountKey.localeCompare(b.accountKey) || (a.accountIdx ?? Number.MAX_SAFE_INTEGER) - (b.accountIdx ?? Number.MAX_SAFE_INTEGER));
    if (!pool.enabled) {
        return normalizedAccounts.map(account => ({ ...account, proxy: null, direct: true, reason: account.accountKey ? 'pool_disabled' : 'missing_account_key' }));
    }
    const activeProxies = pool.proxies.filter(proxy => proxy.enabled).sort((a, b) => a.originalIndex - b.originalIndex || a.proxyId.localeCompare(b.proxyId));
    if (activeProxies.length === 0) {
        return normalizedAccounts.map(account => ({ ...account, proxy: null, direct: true, reason: account.accountKey ? 'no_enabled_proxy' : 'missing_account_key' }));
    }
    const loadByProxyId = new Map();
    let roundRobinIndex = 0;
    return normalizedAccounts.map(account => {
        if (!account.accountKey)
            return { ...account, proxy: null, direct: true, reason: 'missing_account_key' };
        const choice = chooseProxy(activeProxies, loadByProxyId, pool.rotationMode, roundRobinIndex);
        roundRobinIndex = choice.nextRoundRobinIndex;
        if (!choice.proxy)
            return { ...account, proxy: null, direct: true, reason: 'no_enabled_proxy' };
        loadByProxyId.set(choice.proxy.proxyId, (loadByProxyId.get(choice.proxy.proxyId) ?? 0) + 1);
        return {
            ...account,
            proxy: choice.proxy,
            direct: false,
            reason: choice.overCapacity ? 'over_capacity' : 'assigned',
        };
    });
}
//# sourceMappingURL=proxy.js.map