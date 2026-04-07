import fs from 'fs';
import path from 'path';
import type { Agent } from 'http';
import { buildAccountProxyKey, buildProxyPoolConfigHash, normalizeProxyPoolConfig, planProxyAssignments, type NormalizedProxyConfig, type NormalizedProxyPoolConfig, type ProxyAccountIdentity, type ProxyAssignment, type ProxyProtocol } from '@senneo/shared';

const PROXIES_FILE = path.resolve(__dirname, '../../../proxies.json');
const PROXY_RUNTIME_FILE = path.resolve(__dirname, '../../../proxy_runtime_state.json');
const dynamicImport = new Function('modulePath', 'return import(modulePath);') as (modulePath: string) => Promise<Record<string, unknown>>;

export interface ProxyRuntimeAccountState {
  accountKey: string;
  accountIdx: number | null;
  accountId: string | null;
  username: string | null;
  proxyId: string | null;
  proxyLabel: string | null;
  proxyMaskedUrl: string | null;
  proxyProtocol: ProxyProtocol | null;
  proxyHost: string | null;
  proxyPort: number | null;
  proxyRegion: string | null;
  direct: boolean;
  connected: boolean;
  assignmentReason: ProxyAssignment['reason'];
  lastError: string | null;
  assignedAt: string | null;
  connectedAt: string | null;
  updatedAt: string;
}

let _poolConfig: NormalizedProxyPoolConfig = normalizeProxyPoolConfig({ proxies: [] });
let _configHash = buildProxyPoolConfigHash(_poolConfig);
let _watching = false;
let _runtimeAssignments = new Map<string, ProxyRuntimeAccountState>();

function parseOptionalEnvFlag(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function withEnvOverrides(config: NormalizedProxyPoolConfig): NormalizedProxyPoolConfig {
  const enabledOverride = parseOptionalEnvFlag('PROXY_ENABLED');
  const strictOverride = parseOptionalEnvFlag('PROXY_STRICT_MODE');
  return {
    ...config,
    enabled: enabledOverride ?? config.enabled,
    strictMode: strictOverride ?? config.strictMode,
  };
}

function readProxyConfig(): NormalizedProxyPoolConfig {
  if (!fs.existsSync(PROXIES_FILE)) return withEnvOverrides(normalizeProxyPoolConfig({ proxies: [] }));
  try {
    const raw = JSON.parse(fs.readFileSync(PROXIES_FILE, 'utf-8'));
    return withEnvOverrides(normalizeProxyPoolConfig(raw));
  } catch (err) {
    console.warn('[proxy] proxies.json parse hatası (non-fatal):', err);
    return withEnvOverrides(normalizeProxyPoolConfig({ proxies: [] }));
  }
}

function sortRuntimeAssignments(values: Iterable<ProxyRuntimeAccountState>): ProxyRuntimeAccountState[] {
  return [...values].sort((a, b) => {
    const leftIdx = a.accountIdx ?? Number.MAX_SAFE_INTEGER;
    const rightIdx = b.accountIdx ?? Number.MAX_SAFE_INTEGER;
    if (leftIdx !== rightIdx) return leftIdx - rightIdx;
    return a.accountKey.localeCompare(b.accountKey);
  });
}

function writeRuntimeSnapshot(): void {
  try {
    fs.writeFileSync(PROXY_RUNTIME_FILE, JSON.stringify({
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
  } catch (err) {
    console.warn('[proxy] runtime snapshot yazılamadı:', err);
  }
}

function refreshPoolConfig(): void {
  _poolConfig = readProxyConfig();
  _configHash = buildProxyPoolConfigHash(_poolConfig);
  const enabledCount = _poolConfig.proxies.filter(proxy => proxy.enabled).length;
  if (enabledCount > 0) {
    console.log(`[proxy] ${enabledCount}/${_poolConfig.proxies.length} proxy yüklendi (${PROXIES_FILE})`);
  } else if (_poolConfig.enabled) {
    console.warn('[proxy] Proxy sistemi aktif ama kullanılabilir proxy yok');
  } else {
    console.log('[proxy] Proxy kapalı — direct bağlantı kullanılacak');
  }
  writeRuntimeSnapshot();
}

function runtimeStateFromAssignment(assignment: ProxyAssignment, previous?: ProxyRuntimeAccountState): ProxyRuntimeAccountState {
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

export function initProxyPool(): void {
  refreshPoolConfig();
  if (_watching) return;
  _watching = true;
  fs.watchFile(PROXIES_FILE, { interval: 5_000 }, () => {
    const before = _configHash;
    refreshPoolConfig();
    if (before !== _configHash) console.log('[proxy] proxies.json yeniden yüklendi');
  });
}

export function stopProxyPool(): void {
  if (_watching) {
    fs.unwatchFile(PROXIES_FILE);
    _watching = false;
  }
}

export function getProxyPoolConfig(): NormalizedProxyPoolConfig {
  return _poolConfig;
}

export function getProxyConfigHash(): string {
  return _configHash;
}

export function isProxyPoolEnabled(): boolean {
  return _poolConfig.enabled;
}

export function isProxyStrictMode(): boolean {
  return _poolConfig.enabled && _poolConfig.strictMode;
}

export function syncPlannedProxyAssignments(accounts: ProxyAccountIdentity[]): ProxyAssignment[] {
  const assignments = planProxyAssignments(accounts, _poolConfig);
  const next = new Map<string, ProxyRuntimeAccountState>();
  for (const assignment of assignments) {
    next.set(assignment.accountKey, runtimeStateFromAssignment(assignment, _runtimeAssignments.get(assignment.accountKey)));
  }
  _runtimeAssignments = next;
  writeRuntimeSnapshot();
  return assignments;
}

export function updateRuntimeProxyAssignment(accountKey: string, patch: Partial<ProxyRuntimeAccountState>): void {
  const existing = _runtimeAssignments.get(accountKey);
  if (!existing) return;
  _runtimeAssignments.set(accountKey, {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
    connectedAt: patch.connected === true ? (patch.connectedAt ?? existing.connectedAt ?? new Date().toISOString()) : (patch.connected === false ? null : existing.connectedAt),
  });
  writeRuntimeSnapshot();
}

export function removeRuntimeProxyAssignment(account: ProxyAccountIdentity): void {
  const accountKey = buildAccountProxyKey(account);
  if (!accountKey) return;
  _runtimeAssignments.delete(accountKey);
  writeRuntimeSnapshot();
}

/**
 * Bundle returned by createProxyAgentBundle.
 * - `agent`    → Node http.Agent for native https.request (fetchGuildIds, guild-sync etc.)
 * - `proxyUrl` → raw proxy URL string, used by discord.js-selfbot-v13's undici ProxyAgent
 */
export interface ProxyAgentBundle {
  agent: Agent;
  proxyUrl: string;
}

export async function createProxyAgent(proxy: NormalizedProxyConfig | null): Promise<Agent | undefined> {
  if (!proxy) return undefined;
  try {
    if (proxy.protocol === 'socks') {
      const mod = await dynamicImport('socks-proxy-agent');
      const Ctor = mod['SocksProxyAgent']
        ?? (mod.default as Record<string, unknown> | undefined)?.['SocksProxyAgent']
        ?? mod.default;
      if (typeof Ctor !== 'function') throw new Error('SocksProxyAgent constructor bulunamadı');
      return new (Ctor as new (url: string) => Agent)(proxy.url);
    }
    const mod = await dynamicImport('https-proxy-agent');
    const Ctor = mod['HttpsProxyAgent']
      ?? (mod.default as Record<string, unknown> | undefined)?.['HttpsProxyAgent']
      ?? mod.default;
    if (typeof Ctor !== 'function') throw new Error('HttpsProxyAgent constructor bulunamadı');
    return new (Ctor as new (url: string) => Agent)(proxy.url);
  } catch (err) {
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
export async function createProxyAgentBundle(proxy: NormalizedProxyConfig | null): Promise<ProxyAgentBundle | undefined> {
  if (!proxy) return undefined;
  const agent = await createProxyAgent(proxy);
  if (!agent) return undefined;
  return { agent, proxyUrl: proxy.url };
}
