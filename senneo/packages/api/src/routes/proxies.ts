import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { buildProxyPoolConfigHash, normalizeProxyPoolConfig, parseProxyProtocol, planProxyAssignments, type NormalizedProxyConfig, type NormalizedProxyPoolConfig, type ProxyProtocol } from '@senneo/shared';

const ACCOUNTS_FILE = path.resolve(process.cwd(), 'accounts.json');
const PROXIES_FILE = path.resolve(process.cwd(), 'proxies.json');
const PROXY_RUNTIME_FILE = path.resolve(process.cwd(), 'proxy_runtime_state.json');

type ProxyHealthStatus = 'healthy' | 'degraded' | 'down' | 'cooldown' | 'disabled' | 'unknown' | 'removed';

interface RuntimeProxyAccountRow {
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
  assignmentReason: 'assigned' | 'over_capacity' | 'pool_disabled' | 'no_enabled_proxy' | 'missing_account_key';
  lastError: string | null;
  assignedAt: string | null;
  connectedAt: string | null;
  updatedAt: string;
}

interface RuntimeSnapshotFile {
  updatedAt?: string;
  configHash?: string;
  enabled?: boolean;
  strictMode?: boolean;
  rotationMode?: string;
  accounts?: RuntimeProxyAccountRow[];
}

interface ProxyHealthCacheEntry {
  proxyId: string;
  status: ProxyHealthStatus;
  latencyMs: number | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFails: number;
  cooldownUntil: string | null;
  checkedAtMs: number;
}

const healthCache = new Map<string, ProxyHealthCacheEntry>();

function readAccounts(): { token: string }[] {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'))?.accounts ?? [];
  } catch {
    return [];
  }
}

function readProxyPoolFile(): { exists: boolean; pool: NormalizedProxyPoolConfig } {
  if (!fs.existsSync(PROXIES_FILE)) return { exists: false, pool: normalizeProxyPoolConfig({ proxies: [] }) };
  try {
    const raw = JSON.parse(fs.readFileSync(PROXIES_FILE, 'utf-8'));
    return { exists: true, pool: normalizeProxyPoolConfig(raw) };
  } catch {
    return { exists: true, pool: normalizeProxyPoolConfig({ proxies: [] }) };
  }
}

function readRuntimeSnapshot(): RuntimeSnapshotFile | null {
  try {
    if (!fs.existsSync(PROXY_RUNTIME_FILE)) return null;
    return JSON.parse(fs.readFileSync(PROXY_RUNTIME_FILE, 'utf-8')) as RuntimeSnapshotFile;
  } catch {
    return null;
  }
}

function serializeProxyConfig(pool: NormalizedProxyPoolConfig): Record<string, unknown> {
  return {
    enabled: pool.enabled,
    strictMode: pool.strictMode,
    rotationMode: pool.rotationMode,
    healthCheckMs: pool.healthCheckMs,
    failThreshold: pool.failThreshold,
    cooldownMs: pool.cooldownMs,
    proxies: pool.proxies.map(proxy => ({
      id: proxy.proxyId,
      label: proxy.label,
      url: proxy.url,
      region: proxy.region ?? undefined,
      maxConns: proxy.maxConns,
      weight: proxy.weight,
      enabled: proxy.enabled,
    })),
  };
}

function validateProxyPayload(body: unknown): { normalized?: NormalizedProxyPoolConfig; error?: string } {
  if (typeof body !== 'object' || body == null) return { error: 'Geçersiz body' };
  const input = body as Record<string, unknown>;
  if (!Array.isArray(input.proxies)) return { error: 'proxies[] gerekli' };
  for (let i = 0; i < input.proxies.length; i++) {
    const row = input.proxies[i];
    if (typeof row !== 'object' || row == null) return { error: `Proxy #${i + 1} geçersiz` };
    const item = row as Record<string, unknown>;
    if (typeof item.url !== 'string' || !item.url.trim()) return { error: `Proxy #${i + 1} URL gerekli` };
    try {
      new URL(item.url.trim());
      parseProxyProtocol(item.url.trim());
    } catch (err) {
      return { error: `Proxy #${i + 1} URL hatalı: ${err instanceof Error ? err.message : 'invalid'}` };
    }
    if (item.maxConns != null) {
      const maxConns = Number(item.maxConns);
      if (!Number.isFinite(maxConns) || maxConns < 1) return { error: `Proxy #${i + 1} maxConns pozitif olmalı` };
    }
    if (item.weight != null) {
      const weight = Number(item.weight);
      if (!Number.isFinite(weight) || weight < 1) return { error: `Proxy #${i + 1} weight pozitif olmalı` };
    }
  }
  const normalized = normalizeProxyPoolConfig(input);
  if (normalized.proxies.length !== input.proxies.length) return { error: 'Bazı proxy kayıtları çözümlenemedi' };
  return { normalized };
}

async function checkProxyHealth(proxy: NormalizedProxyConfig, pool: NormalizedProxyPoolConfig, force: boolean): Promise<ProxyHealthCacheEntry> {
  const now = Date.now();
  const cached = healthCache.get(proxy.proxyId);
  if (!proxy.enabled) {
    return {
      proxyId: proxy.proxyId,
      status: 'disabled',
      latencyMs: cached?.latencyMs ?? null,
      lastCheckedAt: cached?.lastCheckedAt ?? null,
      lastSuccessAt: cached?.lastSuccessAt ?? null,
      lastError: cached?.lastError ?? null,
      consecutiveFails: cached?.consecutiveFails ?? 0,
      cooldownUntil: cached?.cooldownUntil ?? null,
      checkedAtMs: cached?.checkedAtMs ?? 0,
    };
  }
  if (!force && cached) {
    if (cached.cooldownUntil) {
      const cooldownUntilMs = new Date(cached.cooldownUntil).getTime();
      if (Number.isFinite(cooldownUntilMs) && cooldownUntilMs > now) return { ...cached, status: 'cooldown' };
    }
    if (now - cached.checkedAtMs < pool.healthCheckMs) return cached;
  }

  const undici = await import('undici') as unknown as {
    request: (url: string, opts: Record<string, unknown>) => Promise<{ statusCode: number; body: { dump?: () => Promise<void> } }>;
    ProxyAgent: new (uri: string) => { close?: () => Promise<void> };
    Socks5ProxyAgent: new (uri: string) => { close?: () => Promise<void> };
  };
  let dispatcher: { close?: () => Promise<void> } | null = null;
  try {
    dispatcher = proxy.protocol === 'socks'
      ? new undici.Socks5ProxyAgent(proxy.url)
      : new undici.ProxyAgent(proxy.url);
    const startedAt = Date.now();
    const hardTimeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Health check timeout (10s)')), 10_000));
    const response = await Promise.race([
      undici.request('https://discord.com/api/v10/gateway', {
        method: 'GET',
        dispatcher,
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        headersTimeout: 8_000,
        bodyTimeout: 8_000,
      }),
      hardTimeout,
    ]);
    await response.body.dump?.();
    const latencyMs = Date.now() - startedAt;
    const next: ProxyHealthCacheEntry = {
      proxyId: proxy.proxyId,
      status: response.statusCode >= 200 && response.statusCode < 300
        ? (latencyMs > 2_000 ? 'degraded' : 'healthy')
        : 'down',
      latencyMs,
      lastCheckedAt: new Date().toISOString(),
      lastSuccessAt: response.statusCode >= 200 && response.statusCode < 300 ? new Date().toISOString() : cached?.lastSuccessAt ?? null,
      lastError: response.statusCode >= 200 && response.statusCode < 300 ? null : `HTTP ${response.statusCode}`,
      consecutiveFails: response.statusCode >= 200 && response.statusCode < 300 ? 0 : (cached?.consecutiveFails ?? 0) + 1,
      cooldownUntil: null,
      checkedAtMs: now,
    };
    if (next.consecutiveFails >= pool.failThreshold) {
      next.status = 'cooldown';
      next.cooldownUntil = new Date(now + pool.cooldownMs).toISOString();
    }
    healthCache.set(proxy.proxyId, next);
    return next;
  } catch (err) {
    const consecutiveFails = (cached?.consecutiveFails ?? 0) + 1;
    const next: ProxyHealthCacheEntry = {
      proxyId: proxy.proxyId,
      status: consecutiveFails >= pool.failThreshold ? 'cooldown' : 'down',
      latencyMs: null,
      lastCheckedAt: new Date().toISOString(),
      lastSuccessAt: cached?.lastSuccessAt ?? null,
      lastError: err instanceof Error ? err.message : 'Proxy health check failed',
      consecutiveFails,
      cooldownUntil: consecutiveFails >= pool.failThreshold ? new Date(now + pool.cooldownMs).toISOString() : null,
      checkedAtMs: now,
    };
    healthCache.set(proxy.proxyId, next);
    return next;
  } finally {
    await dispatcher?.close?.().catch(() => {});
  }
}

export function proxiesRouter(): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    const force = ['1', 'true', 'yes'].includes(String(req.query['force'] ?? '').toLowerCase());
    const liveAccounts = readAccounts();
    const { exists: configExists, pool } = readProxyPoolFile();
    const runtime = readRuntimeSnapshot();
    const configHash = buildProxyPoolConfigHash(pool);
    const plannedAssignments = planProxyAssignments(liveAccounts.map((_account, idx) => ({ accountIdx: idx })), pool);
    const runtimeByKey = new Map<string, RuntimeProxyAccountRow>(
      (runtime?.accounts ?? [])
        .filter((row): row is RuntimeProxyAccountRow => !!row && typeof row.accountKey === 'string')
        .map(row => [row.accountKey, row]),
    );

    const effectiveAssignments = plannedAssignments.map(assignment => {
      const runtimeRow = runtimeByKey.get(assignment.accountKey);
      return {
        accountKey: assignment.accountKey,
        accountIdx: assignment.accountIdx,
        accountId: runtimeRow?.accountId ?? assignment.accountId ?? null,
        username: runtimeRow?.username ?? `Hesap ${assignment.accountIdx != null ? assignment.accountIdx + 1 : assignment.accountKey}`,
        direct: runtimeRow?.direct ?? assignment.direct,
        connected: runtimeRow?.connected ?? false,
        assignmentReason: runtimeRow?.assignmentReason ?? assignment.reason,
        lastError: runtimeRow?.lastError ?? null,
        assignedAt: runtimeRow?.assignedAt ?? null,
        connectedAt: runtimeRow?.connectedAt ?? null,
        updatedAt: runtimeRow?.updatedAt ?? null,
        proxyId: runtimeRow?.proxyId ?? assignment.proxy?.proxyId ?? null,
        proxyLabel: runtimeRow?.proxyLabel ?? assignment.proxy?.label ?? null,
        proxyMaskedUrl: runtimeRow?.proxyMaskedUrl ?? assignment.proxy?.maskedUrl ?? null,
        proxyProtocol: runtimeRow?.proxyProtocol ?? assignment.proxy?.protocol ?? null,
        proxyHost: runtimeRow?.proxyHost ?? assignment.proxy?.host ?? null,
        proxyPort: runtimeRow?.proxyPort ?? assignment.proxy?.port ?? null,
        proxyRegion: runtimeRow?.proxyRegion ?? assignment.proxy?.region ?? null,
      };
    }).sort((a, b) => (a.accountIdx ?? Number.MAX_SAFE_INTEGER) - (b.accountIdx ?? Number.MAX_SAFE_INTEGER));

    const staleRuntimeAssignments = [...runtimeByKey.values()]
      .filter(row => !effectiveAssignments.some(assignment => assignment.accountKey === row.accountKey));

    const healthEntries = force
      ? await Promise.all(pool.proxies.map(proxy => checkProxyHealth(proxy, pool, true)))
      : pool.proxies.map(proxy => {
          const cached = healthCache.get(proxy.proxyId);
          if (cached) return cached;
          return { proxyId: proxy.proxyId, status: (proxy.enabled ? 'unknown' : 'disabled') as ProxyHealthStatus, latencyMs: null, lastCheckedAt: null, lastSuccessAt: null, lastError: null, consecutiveFails: 0, cooldownUntil: null, checkedAtMs: 0 };
        });
    const healthByProxyId = new Map(healthEntries.map(entry => [entry.proxyId, entry]));

    const staleProxyMap = new Map<string, { proxyId: string; label: string | null; maskedUrl: string | null; protocol: ProxyProtocol | null; host: string | null; port: number | null; region: string | null; assignedAccounts: typeof effectiveAssignments }>();
    for (const assignment of effectiveAssignments) {
      if (!assignment.proxyId) continue;
      if (pool.proxies.some(proxy => proxy.proxyId === assignment.proxyId)) continue;
      const bucket = staleProxyMap.get(assignment.proxyId) ?? {
        proxyId: assignment.proxyId,
        label: assignment.proxyLabel,
        maskedUrl: assignment.proxyMaskedUrl,
        protocol: assignment.proxyProtocol,
        host: assignment.proxyHost,
        port: assignment.proxyPort,
        region: assignment.proxyRegion,
        assignedAccounts: [],
      };
      bucket.assignedAccounts.push(assignment);
      staleProxyMap.set(assignment.proxyId, bucket);
    }

    const proxies = [
      ...pool.proxies.map(proxy => {
        const assignedAccounts = effectiveAssignments.filter(assignment => assignment.proxyId === proxy.proxyId);
        const health = healthByProxyId.get(proxy.proxyId);
        return {
          proxyId: proxy.proxyId,
          label: proxy.label,
          url: proxy.url,
          maskedUrl: proxy.maskedUrl,
          protocol: proxy.protocol,
          host: proxy.host,
          port: proxy.port,
          region: proxy.region,
          maxConns: proxy.maxConns,
          weight: proxy.weight,
          enabled: proxy.enabled,
          removed: false,
          assignmentCount: assignedAccounts.length,
          connectedAccountCount: assignedAccounts.filter(assignment => assignment.connected).length,
          directAccountCount: assignedAccounts.filter(assignment => assignment.direct).length,
          capacityLeft: Math.max(proxy.maxConns - assignedAccounts.length, 0),
          overCapacity: assignedAccounts.length > proxy.maxConns,
          health: {
            status: health?.status ?? (proxy.enabled ? 'unknown' : 'disabled'),
            latencyMs: health?.latencyMs ?? null,
            lastCheckedAt: health?.lastCheckedAt ?? null,
            lastSuccessAt: health?.lastSuccessAt ?? null,
            lastError: health?.lastError ?? null,
            consecutiveFails: health?.consecutiveFails ?? 0,
            cooldownUntil: health?.cooldownUntil ?? null,
          },
          assignedAccounts: assignedAccounts.map(assignment => ({
            accountKey: assignment.accountKey,
            accountIdx: assignment.accountIdx,
            accountId: assignment.accountId,
            username: assignment.username,
            connected: assignment.connected,
            direct: assignment.direct,
            lastError: assignment.lastError,
            assignmentReason: assignment.assignmentReason,
          })),
        };
      }),
      ...[...staleProxyMap.values()].map(proxy => ({
        proxyId: proxy.proxyId,
        label: proxy.label,
        url: null,
        maskedUrl: proxy.maskedUrl,
        protocol: proxy.protocol,
        host: proxy.host,
        port: proxy.port,
        region: proxy.region,
        maxConns: 0,
        weight: 0,
        enabled: false,
        removed: true,
        assignmentCount: proxy.assignedAccounts.length,
        connectedAccountCount: proxy.assignedAccounts.filter(assignment => assignment.connected).length,
        directAccountCount: 0,
        capacityLeft: 0,
        overCapacity: false,
        health: {
          status: 'removed' as ProxyHealthStatus,
          latencyMs: null,
          lastCheckedAt: null,
          lastSuccessAt: null,
          lastError: 'Bu proxy mevcut proxies.json içinde bulunmuyor',
          consecutiveFails: 0,
          cooldownUntil: null,
        },
        assignedAccounts: proxy.assignedAccounts.map(assignment => ({
          accountKey: assignment.accountKey,
          accountIdx: assignment.accountIdx,
          accountId: assignment.accountId,
          username: assignment.username,
          connected: assignment.connected,
          direct: assignment.direct,
          lastError: assignment.lastError,
          assignmentReason: assignment.assignmentReason,
        })),
      })),
    ].sort((a, b) => Number(b.connectedAccountCount) - Number(a.connectedAccountCount) || (a.label ?? '').localeCompare(b.label ?? ''));

    const assignments = effectiveAssignments.map(assignment => {
      const proxyHealth = assignment.proxyId ? (healthByProxyId.get(assignment.proxyId) ?? null) : null;
      return {
        ...assignment,
        proxyHealthStatus: assignment.proxyId ? (proxyHealth?.status ?? (assignment.proxyId && staleProxyMap.has(assignment.proxyId) ? 'removed' : 'unknown')) : 'unknown',
        proxyLatencyMs: proxyHealth?.latencyMs ?? null,
        proxyLastCheckedAt: proxyHealth?.lastCheckedAt ?? null,
        proxyLastError: proxyHealth?.lastError ?? null,
      };
    });

    const restartRequired = !!runtime?.configHash && runtime.configHash !== configHash;
    const diagnostics = {
      warnings: [
        !configExists ? 'proxies.json bulunamadı. Dosya kaydedildiğinde worker yeni havuzu okuyacak.' : null,
        pool.enabled && pool.proxies.filter(proxy => proxy.enabled).length === 0 ? 'Proxy sistemi aktif ama etkin proxy yok.' : null,
        !runtime ? 'proxy_runtime_state.json bulunamadı. Worker henüz proxy runtime snapshot yazmamış olabilir.' : null,
        restartRequired ? 'Canlı worker proxy konfigürasyonu güncel dosya ile farklı. Yeni atamaların tam uygulanması için accounts worker restart gerekebilir.' : null,
        pool.enabled && assignments.some(assignment => assignment.direct) ? 'Bazı hesaplar hâlâ direct fallback kullanıyor.' : null,
        staleRuntimeAssignments.length > 0 ? `${staleRuntimeAssignments.length} runtime kayıt artık accounts.json içinde görünmüyor.` : null,
      ].filter((warning): warning is string => !!warning),
      staleRuntimeAssignments: staleRuntimeAssignments.length,
      restartRequired,
    };

    return res.json({
      config: {
        ...serializeProxyConfig(pool),
        path: PROXIES_FILE,
        exists: configExists,
        configHash,
      },
      runtime: {
        path: PROXY_RUNTIME_FILE,
        exists: !!runtime,
        updatedAt: runtime?.updatedAt ?? null,
        configHash: runtime?.configHash ?? null,
        enabled: runtime?.enabled ?? null,
        strictMode: runtime?.strictMode ?? null,
        restartRequired,
      },
      summary: {
        totalAccounts: liveAccounts.length,
        assignedAccounts: assignments.filter(assignment => !assignment.direct && assignment.proxyId).length,
        connectedAccounts: assignments.filter(assignment => assignment.connected).length,
        directAccounts: assignments.filter(assignment => assignment.direct).length,
        totalProxies: proxies.length,
        enabledProxies: pool.proxies.filter(proxy => proxy.enabled).length,
        disabledProxies: pool.proxies.filter(proxy => !proxy.enabled).length,
        healthyProxies: proxies.filter(proxy => proxy.health.status === 'healthy').length,
        degradedProxies: proxies.filter(proxy => proxy.health.status === 'degraded').length,
        unhealthyProxies: proxies.filter(proxy => ['down', 'cooldown', 'removed'].includes(proxy.health.status)).length,
        overCapacityProxies: proxies.filter(proxy => proxy.overCapacity).length,
        unassignedProxies: proxies.filter(proxy => proxy.assignmentCount === 0).length,
      },
      proxies,
      assignments,
      diagnostics,
    });
  });

  router.put('/', async (req: Request, res: Response) => {
    const validation = validateProxyPayload(req.body);
    if (!validation.normalized) return res.status(400).json({ error: validation.error ?? 'Geçersiz proxy config' });
    const normalized = validation.normalized;
    const serializable = serializeProxyConfig(normalized);
    try {
      fs.writeFileSync(PROXIES_FILE, JSON.stringify(serializable, null, 2));
      healthCache.clear();
      return res.json({ ok: true, config: { ...serializable, path: PROXIES_FILE, configHash: buildProxyPoolConfigHash(normalized) } });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Proxy config kaydedilemedi' });
    }
  });

  return router;
}
