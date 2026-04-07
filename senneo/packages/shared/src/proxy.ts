import crypto from 'crypto';

export type ProxyRotationMode = 'round-robin' | 'weighted' | 'least-connections';
export type ProxyProtocol = 'socks' | 'http' | 'https';

export interface ProxyConfig {
  id?: string;
  label?: string;
  url: string;
  region?: string;
  maxConns: number;
  weight: number;
  enabled: boolean;
}

export interface ProxyPoolConfig {
  enabled?: boolean;
  strictMode?: boolean;
  proxies: ProxyConfig[];
  rotationMode?: ProxyRotationMode;
  rotation?: ProxyRotationMode;
  healthCheckMs?: number;
  failThreshold?: number;
  cooldownMs?: number;
}

export interface NormalizedProxyConfig {
  proxyId: string;
  label: string;
  url: string;
  maskedUrl: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  region: string | null;
  maxConns: number;
  weight: number;
  enabled: boolean;
  originalIndex: number;
}

export interface NormalizedProxyPoolConfig {
  enabled: boolean;
  strictMode: boolean;
  rotationMode: ProxyRotationMode;
  healthCheckMs: number;
  failThreshold: number;
  cooldownMs: number;
  proxies: NormalizedProxyConfig[];
}

export interface ProxyAccountIdentity {
  accountKey?: string;
  accountIdx?: number | null;
  accountId?: string | null;
  username?: string | null;
}

export interface ProxyAssignment {
  accountKey: string;
  accountIdx: number | null;
  accountId: string | null;
  username: string | null;
  proxy: NormalizedProxyConfig | null;
  direct: boolean;
  reason: 'assigned' | 'over_capacity' | 'pool_disabled' | 'no_enabled_proxy' | 'missing_account_key';
}

function toPositiveInt(value: unknown, fallback: number, min = 1): number {
  const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

function isRotationMode(value: unknown): value is ProxyRotationMode {
  return value === 'round-robin' || value === 'weighted' || value === 'least-connections';
}

function normalizeProtocol(protocol: string): ProxyProtocol {
  const clean = protocol.replace(/:$/, '').toLowerCase();
  if (clean === 'http') return 'http';
  if (clean === 'https') return 'https';
  if (clean === 'socks' || clean === 'socks4' || clean === 'socks4a' || clean === 'socks5' || clean === 'socks5h') return 'socks';
  throw new Error(`Unsupported proxy protocol: ${protocol}`);
}

function safeUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function hashValue(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function loadScoreWeighted(currentLoad: number, proxy: NormalizedProxyConfig): number {
  return currentLoad / Math.max(proxy.weight, 1);
}

function loadScoreLeastConnections(currentLoad: number, proxy: NormalizedProxyConfig): number {
  return currentLoad / Math.max(proxy.maxConns, 1);
}

function fallbackScore(currentLoad: number, proxy: NormalizedProxyConfig): number {
  return Math.max(0, currentLoad - proxy.maxConns + 1) + loadScoreLeastConnections(currentLoad, proxy);
}

function chooseProxy(
  proxies: NormalizedProxyConfig[],
  loadByProxyId: Map<string, number>,
  rotationMode: ProxyRotationMode,
  roundRobinIndex: number,
): { proxy: NormalizedProxyConfig | null; nextRoundRobinIndex: number; overCapacity: boolean } {
  if (proxies.length === 0) return { proxy: null, nextRoundRobinIndex: roundRobinIndex, overCapacity: false };

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
    if (
      score < bestScore
      || (score === bestScore && proxyLoad < bestLoad)
      || (score === bestScore && proxyLoad === bestLoad && proxy.originalIndex < best.originalIndex)
    ) {
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

export function maskProxyUrl(url: string): string {
  const parsed = safeUrl(url);
  if (!parsed) return url;
  if (parsed.username) parsed.username = '***';
  if (parsed.password) parsed.password = '***';
  return parsed.toString();
}

export function parseProxyProtocol(url: string): ProxyProtocol {
  const parsed = safeUrl(url);
  if (!parsed) throw new Error(`Invalid proxy URL: ${url}`);
  return normalizeProtocol(parsed.protocol);
}

export function buildProxyId(url: string, index = 0): string {
  return hashValue(`${index}:${url.trim()}`).slice(0, 12);
}

export function buildProxyPoolConfigHash(pool: NormalizedProxyPoolConfig): string {
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

export function buildAccountProxyKey(identity: ProxyAccountIdentity): string {
  if (identity.accountKey?.trim()) return identity.accountKey.trim();
  if (identity.accountIdx != null && identity.accountIdx >= 0) return `idx:${identity.accountIdx}`;
  if (identity.accountId?.trim()) return `account:${identity.accountId.trim()}`;
  if (identity.username?.trim()) return `user:${identity.username.trim().toLowerCase()}`;
  return '';
}

export function normalizeProxyPoolConfig(raw: unknown): NormalizedProxyPoolConfig {
  const input = (typeof raw === 'object' && raw != null) ? raw as Record<string, unknown> : {};
  const rotationCandidate = input.rotationMode ?? input.rotation;
  const rotationMode: ProxyRotationMode = isRotationMode(rotationCandidate) ? rotationCandidate : 'weighted';
  const proxiesInput = Array.isArray(input.proxies) ? input.proxies : [];
  const proxies: NormalizedProxyConfig[] = proxiesInput.flatMap((entry, index) => {
    if (typeof entry !== 'object' || entry == null) return [];
    const row = entry as Record<string, unknown>;
    const url = typeof row.url === 'string' ? row.url.trim() : '';
    if (!url) return [];
    const parsed = safeUrl(url);
    if (!parsed) return [];
    let protocol: ProxyProtocol;
    try {
      protocol = normalizeProtocol(parsed.protocol);
    } catch {
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
    } satisfies NormalizedProxyConfig];
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

export function planProxyAssignments(accounts: ProxyAccountIdentity[], pool: NormalizedProxyPoolConfig): ProxyAssignment[] {
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

  const loadByProxyId = new Map<string, number>();
  let roundRobinIndex = 0;

  return normalizedAccounts.map(account => {
    if (!account.accountKey) return { ...account, proxy: null, direct: true, reason: 'missing_account_key' };
    const choice = chooseProxy(activeProxies, loadByProxyId, pool.rotationMode, roundRobinIndex);
    roundRobinIndex = choice.nextRoundRobinIndex;
    if (!choice.proxy) return { ...account, proxy: null, direct: true, reason: 'no_enabled_proxy' };
    loadByProxyId.set(choice.proxy.proxyId, (loadByProxyId.get(choice.proxy.proxyId) ?? 0) + 1);
    return {
      ...account,
      proxy: choice.proxy,
      direct: false,
      reason: choice.overCapacity ? 'over_capacity' : 'assigned',
    } satisfies ProxyAssignment;
  });
}
