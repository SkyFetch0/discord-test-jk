import fs from 'fs';
import path from 'path';
import { normalizeProxyPoolConfig, planProxyAssignments, type NormalizedProxyConfig } from '@senneo/shared';

const ACCOUNTS_FILE = path.resolve(process.cwd(), 'accounts.json');
const PROXIES_FILE = path.resolve(process.cwd(), 'proxies.json');

let fallbackProxyCursor = 0;

function readAccounts(): Array<{ token: string }> {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'))?.accounts ?? [];
  } catch {
    return [];
  }
}

function readProxyPool() {
  try {
    if (!fs.existsSync(PROXIES_FILE)) return normalizeProxyPoolConfig({ proxies: [] });
    return normalizeProxyPoolConfig(JSON.parse(fs.readFileSync(PROXIES_FILE, 'utf-8')));
  } catch {
    return normalizeProxyPoolConfig({ proxies: [] });
  }
}

function resolveAccountIdx(token?: string, explicitIdx?: number | null): number | null {
  if (explicitIdx != null && explicitIdx >= 0) return explicitIdx;
  if (!token) return null;
  const accounts = readAccounts();
  const idx = accounts.findIndex(account => account.token === token);
  return idx >= 0 ? idx : null;
}

function pickProxy(token?: string, explicitIdx?: number | null): NormalizedProxyConfig | null {
  const pool = readProxyPool();
  if (!pool.enabled) return null;
  const accounts = readAccounts();
  const enabled = pool.proxies.filter(proxy => proxy.enabled);
  if (enabled.length === 0) return null;

  const resolvedIdx = resolveAccountIdx(token, explicitIdx);
  if (resolvedIdx != null) {
    const assignments = planProxyAssignments(accounts.map((_account, idx) => ({ accountIdx: idx })), pool);
    const assignment = assignments.find(item => item.accountIdx === resolvedIdx);
    return assignment?.proxy ?? null;
  }

  const proxy = enabled[fallbackProxyCursor % enabled.length] ?? null;
  fallbackProxyCursor += 1;
  return proxy;
}

export async function discordApiGet<T>(endpointOrUrl: string, opts: { token?: string; accountIdx?: number | null; timeoutMs?: number } = {}): Promise<T> {
  const url = endpointOrUrl.startsWith('http') ? endpointOrUrl : `https://discord.com/api/v10${endpointOrUrl}`;
  const proxy = pickProxy(opts.token, opts.accountIdx ?? null);
  const undici = await import('undici') as unknown as {
    request: (url: string, opts: Record<string, unknown>) => Promise<{ statusCode: number; body: { text: () => Promise<string> } }>;
    ProxyAgent: new (uri: string) => { close?: () => Promise<void> };
    Socks5ProxyAgent: new (uri: string) => { close?: () => Promise<void> };
  };
  const dispatcher = proxy
    ? (proxy.protocol === 'socks' ? new undici.Socks5ProxyAgent(proxy.url) : new undici.ProxyAgent(proxy.url))
    : null;
  try {
    const response = await undici.request(url, {
      method: 'GET',
      dispatcher: dispatcher ?? undefined,
      headers: {
        ...(opts.token ? { Authorization: opts.token } : {}),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Accept: 'application/json',
      },
      headersTimeout: opts.timeoutMs ?? 8_000,
      bodyTimeout: opts.timeoutMs ?? 8_000,
    });
    const body = await response.body.text();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`HTTP ${response.statusCode}${body ? `: ${body.slice(0, 240)}` : ''}`);
    }
    return JSON.parse(body) as T;
  } finally {
    await dispatcher?.close?.().catch(() => {});
  }
}
