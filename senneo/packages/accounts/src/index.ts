import path from 'path';
[
  path.resolve(__dirname, '../../../.env'),
  path.resolve(__dirname, '../../../../.env'),
  path.resolve(process.cwd(), '.env'),
].forEach(p => require('dotenv').config({ path: p }));

import fs   from 'fs';
import https from 'https';
import PQueue from 'p-queue';
import { Client as CassandraClient } from 'cassandra-driver';
import { AccountConfig, PauseSource, ProxyAssignment, ScrapeControlFlags, ScrapePausedAccount, ScrapePausedChannel, ScrapeTarget, StopReason } from '@senneo/shared';
import { loadCheckpoints, flush, flushCheckpoint, getAllCheckpoints } from './checkpoint';
import { scrapeChannel, ScrapeChannelResult, ScrapeRateLimitEvent, ScrapeThrottleHooks } from './scraper';
import { createProducer } from './producer';
import { activeChannelCount, ensureChannel, flushStats, removeChannel, setRuntimeState } from './stats';
import { getDb } from './db';
import { emit, startEventLog, stopEventLog } from './scrape-event-log';
import { createProxyAgentBundle, initProxyPool, isProxyPoolEnabled, isProxyStrictMode, removeRuntimeProxyAssignment, stopProxyPool, syncPlannedProxyAssignments, updateRuntimeProxyAssignment, type ProxyAgentBundle } from './proxy';
import { startGuildSync, stopGuildSync, updateGuildSyncAccounts } from './guild-sync';
import type { Agent } from 'http';

interface WorkerTarget extends ScrapeTarget {
  label?: string;
  accountId?: string;
  accountIdx?: number;
  pinnedAccountId?: string;
  pinnedAccountIdx?: number;
}

interface ControlOverlay {
  pausedAccounts: Map<string, ScrapePausedAccount>;
  pausedChannels: Map<string, ScrapePausedChannel>;
  hash: string;
}

interface ScopedThrottleState {
  cooldownUntil: number;
  hitsInWindow: number;
  windowStartedAt: number;
  lastHitAt: number;
}

const ACCOUNTS_FILE   = path.resolve(__dirname, '../../../accounts.json');
const KAFKA_BROKERS   = process.env.KAFKA_BROKERS ?? 'localhost:9092';
const KAFKA_TOPIC     = process.env.KAFKA_TOPIC   ?? 'messages';
const CONCURRENT_CHNL = parseInt(process.env.CONCURRENT_GUILDS ?? '15', 10);
const KEYSPACE        = process.env.SCYLLA_KEYSPACE ?? 'senneo';
// SCALE FIX: max concurrent logins — 400 simultaneous ws connections = Discord rate-limit/ban
const LOGIN_CONCURRENCY = parseInt(process.env.LOGIN_CONCURRENCY ?? '10', 10);
const LOGIN_DELAY_MS    = parseInt(process.env.LOGIN_DELAY_MS    ?? '1500', 10);

// Multi-instance: ACCOUNTS_RANGE_START/END slice accounts.json but preserve
// global indices so scrape_targets.account_idx is consistent across instances.
// Unset = load all accounts (backward compatible single-instance mode).
const RANGE_START = process.env.ACCOUNTS_RANGE_START != null
  ? parseInt(process.env.ACCOUNTS_RANGE_START, 10) : undefined;
const RANGE_END   = process.env.ACCOUNTS_RANGE_END != null
  ? parseInt(process.env.ACCOUNTS_RANGE_END, 10)   : undefined;
const WORKER_ID = process.env.SCRAPER_WORKER_ID?.trim() || `accounts-${process.pid}`;

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  return ['true', '1', 'yes', 'on'].includes(raw.toLowerCase());
}

function envPositiveInt(name: string, defaultValue: number): number {
  const parsed = parseInt(process.env[name] ?? `${defaultValue}`, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

const SCRAPER_FLAGS: ScrapeControlFlags = {
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

async function readTargets(db: CassandraClient): Promise<WorkerTarget[]> {
  const result = await db.execute(`SELECT channel_id, guild_id, label, account_id, account_idx, pinned_account_id, pinned_account_idx FROM ${KEYSPACE}.scrape_targets`);
  return result.rows.map(row => ({
    channelId:        row['channel_id'] as string,
    guildId:          row['guild_id']   as string,
    label:            row['label']      as string | undefined,
    accountId:        (row['account_id'] as string) ?? undefined,
    accountIdx:       row['account_idx'] != null ? Number(row['account_idx']) : undefined,
    pinnedAccountId:  (row['pinned_account_id'] as string) ?? undefined,
    pinnedAccountIdx: row['pinned_account_idx'] != null ? Number(row['pinned_account_idx']) : undefined,
  }));
}

async function readPausedAccounts(db: CassandraClient): Promise<Map<string, ScrapePausedAccount>> {
  if (!SCRAPER_FLAGS.pauseControlEnabled || !SCRAPER_FLAGS.accountPauseEnabled) return new Map();
  const result = await db.execute(`SELECT account_id, reason, requested_by, request_id, requested_at FROM ${KEYSPACE}.scrape_paused_accounts`);
  const entries: Array<[string, ScrapePausedAccount]> = result.rows.map(row => {
    const accountId = (row['account_id'] as string) ?? '';
    return [accountId, {
      accountId,
      reason: (row['reason'] as string) ?? null,
      requestedBy: (row['requested_by'] as string) ?? null,
      requestId: (row['request_id'] as string) ?? null,
      requestedAt: row['requested_at']?.toISOString?.() ?? new Date(0).toISOString(),
    } satisfies ScrapePausedAccount] as [string, ScrapePausedAccount];
  }).filter(([accountId]) => !!accountId);
  return new Map(entries);
}

async function readPausedChannels(db: CassandraClient): Promise<Map<string, ScrapePausedChannel>> {
  if (!SCRAPER_FLAGS.pauseControlEnabled) return new Map();
  const result = await db.execute(`SELECT channel_id, guild_id, account_id, reason, requested_by, request_id, requested_at FROM ${KEYSPACE}.scrape_paused_channels`);
  const entries: Array<[string, ScrapePausedChannel]> = result.rows.map(row => {
    const channelId = (row['channel_id'] as string) ?? '';
    return [channelId, {
      channelId,
      guildId: (row['guild_id'] as string) ?? '',
      accountId: (row['account_id'] as string) ?? '',
      reason: (row['reason'] as string) ?? null,
      requestedBy: (row['requested_by'] as string) ?? null,
      requestId: (row['request_id'] as string) ?? null,
      requestedAt: row['requested_at']?.toISOString?.() ?? new Date(0).toISOString(),
    } satisfies ScrapePausedChannel] as [string, ScrapePausedChannel];
  }).filter(([channelId]) => !!channelId);
  return new Map(entries);
}

function buildControlOverlayHash(pausedAccounts: Map<string, ScrapePausedAccount>, pausedChannels: Map<string, ScrapePausedChannel>): string {
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

async function readControlOverlay(db: CassandraClient): Promise<ControlOverlay> {
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
function loadAccounts(): Array<[number, AccountConfig]> {
  if (!fs.existsSync(ACCOUNTS_FILE)) throw new Error(`accounts.json bulunamadı`);
  const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8')) as { accounts: AccountConfig[] };
  if (!raw.accounts?.length) throw new Error('accounts.json boş');
  const all = raw.accounts;
  const start = RANGE_START ?? 0;
  const end   = RANGE_END   ?? all.length;
  const slice = all.slice(start, end).map((acc, i) => [start + i, acc] as [number, AccountConfig]);
  if (slice.length === 0) throw new Error(`accounts.json aralığı boş [${start}, ${end}) — endExclusive`);
  if (RANGE_START != null || RANGE_END != null)
    console.log(`[accounts] Aralık [${start}, ${end}) → global indeks ${start}–${end - 1} (${slice.length}/${all.length} hesap)`);
  return slice;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createClient(token: string, proxyBundle?: ProxyAgentBundle): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require('discord.js-selfbot-v13');
  const tokenHint = failedTokenHint(token);
  const proxyInfo = proxyBundle ? proxyBundle.proxyUrl.replace(/\/\/.*?@/, '//<creds>@') : 'DIRECT (proxy yok)';
  console.log(`[login] Token=${tokenHint} | Proxy=${proxyInfo} | agent=${proxyBundle?.agent?.constructor?.name ?? 'none'}`);

  // discord.js-selfbot-v13 proxy plumbing:
  //   ws.agent  → passed to `ws` library.  ws requires `instanceof http.Agent`.
  //               BUT discord.js verifyProxyAgent() also checks agent.httpAgent/httpsAgent.
  //               Solution: attach httpAgent/httpsAgent props onto the Agent itself.
  //   http.agent → proxy URL string for undici ProxyAgent (REST calls).
  const opts: Record<string, unknown> = { checkUpdate: false };
  if (proxyBundle) {
    const wsAgent = proxyBundle.agent as Agent & { httpAgent?: Agent; httpsAgent?: Agent };
    wsAgent.httpAgent = proxyBundle.agent;
    wsAgent.httpsAgent = proxyBundle.agent;
    opts.ws   = { agent: wsAgent };
    opts.http = { agent: proxyBundle.proxyUrl };
    console.log(`[login] WS agent set: httpAgent=${!!wsAgent.httpAgent} httpsAgent=${!!wsAgent.httpsAgent} | http.agent=${proxyBundle.proxyUrl.replace(/\/\/.*?@/, '//<creds>@')}`);
  } else {
    console.log(`[login] Proxy yok — doğrudan bağlantı`);
  }
  return new Promise((resolve, reject) => {
    const client = new Client(opts);
    const timeout = setTimeout(() => {
      console.error(`[login] TIMEOUT: Token=${tokenHint} proxy=${proxyInfo}`);
      reject(new Error('Login timeout'));
    }, 30_000);
    client.once('ready', () => {
      clearTimeout(timeout);
      console.log(`[accounts] ✓ ${client.user?.username} (${client.user?.id}) | proxy=${proxyInfo}`);
      resolve(client);
    });
    client.once('error', (err: Error) => {
      clearTimeout(timeout);
      console.error(`[login] WS error: Token=${tokenHint} proxy=${proxyInfo} → ${err.message}`);
      reject(err);
    });
    client.login(token).catch((err: Error) => {
      clearTimeout(timeout);
      console.error(`[login] login() rejected: Token=${tokenHint} proxy=${proxyInfo} → ${err.message}`);
      reject(err);
    });
  });
}

let _serverIp: string | null = null;
let _serverIpPromise: Promise<string | null> | null = null;
async function getServerIp(): Promise<string | null> {
  if (_serverIp) return _serverIp;
  if (_serverIpPromise) return _serverIpPromise;
  _serverIpPromise = new Promise(resolve => {
    const req = https.request(
      { hostname: 'api.ipify.org', path: '/', method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } },
      (res) => {
        let d = ''; res.on('data', (c: Buffer) => d += c.toString()); res.on('end', () => { _serverIp = d.trim(); resolve(_serverIp); });
      },
    );
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
  return _serverIpPromise;
}

async function verifyProxyIp(gIdx: number, proxyUrl: string, proxyLabel: string): Promise<{ ok: boolean; proxyIp: string | null; serverIp: string | null }> {
  const serverIp = await getServerIp();
  // HTTP proxy tüneli: proxy'ye bağlan, GET http://api.ipify.org/ iste (Proxy-Authorization header ile)
  const proxyIp: string | null = await new Promise(resolve => {
    try {
      const parsed = new URL(proxyUrl);
      const auth = parsed.username && parsed.password
        ? Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString('base64')
        : null;
      const headers: Record<string, string> = {
        'Host': 'api.ipify.org',
        'User-Agent': 'Mozilla/5.0',
        ...(auth ? { 'Proxy-Authorization': `Basic ${auth}` } : {}),
      };
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const httpMod = require('http') as typeof import('http');
      const req = httpMod.request(
        {
          hostname: parsed.hostname,
          port: Number(parsed.port) || 3128,
          path: 'http://api.ipify.org/',
          method: 'GET',
          headers,
        },
        (res) => {
          let d = ''; res.on('data', (c: Buffer) => d += c.toString()); res.on('end', () => resolve(d.trim() || null));
        },
      );
      req.on('error', (e: Error) => { console.warn(`[proxy-verify] idx=${gIdx} ${proxyLabel} IP check hatası: ${e.message}`); resolve(null); });
      req.setTimeout(8000, () => { req.destroy(); resolve(null); });
      req.end();
    } catch (e) {
      console.warn(`[proxy-verify] idx=${gIdx} ${proxyLabel} parse hatası: ${(e as Error).message}`);
      resolve(null);
    }
  });

  const ok = !!proxyIp && proxyIp !== serverIp;
  if (ok) {
    console.log(`[proxy-verify] ✓ idx=${gIdx} ${proxyLabel} — proxy IP: ${proxyIp} (sunucu: ${serverIp}) → farklı, güvenli`);
  } else if (proxyIp === serverIp) {
    console.warn(`[proxy-verify] ✗ idx=${gIdx} ${proxyLabel} — proxy IP sunucu IP ile AYNI (${proxyIp})! Proxy çalışmıyor olabilir`);
  } else {
    console.warn(`[proxy-verify] ✗ idx=${gIdx} ${proxyLabel} — proxy IP alınamadı (timeout/hata), sunucu: ${serverIp}`);
  }
  return { ok, proxyIp, serverIp };
}

async function fetchGuildIds(token: string, agent?: Agent): Promise<Set<string>> {
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'discord.com', path: '/api/v10/users/@me/guilds', method: 'GET',
      headers: { 'Authorization': token, 'User-Agent': 'Mozilla/5.0' },
      ...(agent ? { agent } : {}),
    }, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => data += c.toString());
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(new Set(Array.isArray(parsed) ? parsed.map((g: { id: string }) => g.id) : []));
        } catch { resolve(new Set()); }
      });
    });
    req.on('error', () => resolve(new Set()));
    req.setTimeout(8000, () => { req.destroy(); resolve(new Set()); });
    req.end();
  });
}

function failedTokenHint(token: string): string {
  return token.length > 20 ? token.slice(0, 8) + '...' + token.slice(-4) : '***';
}

async function fetchDiscordMe(token: string, agent?: Agent): Promise<{ id?: string; username?: string } | null> {
  return new Promise(resolve => {
    const req = https.request({ hostname: 'discord.com', path: '/api/v10/users/@me', method: 'GET',
      headers: { Authorization: token, 'User-Agent': 'Mozilla/5.0' },
      ...(agent ? { agent } : {}),
    }, (res: any) => {
      let d = ''; res.on('data', (c: Buffer) => d += c.toString());
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }); req.on('error', () => resolve(null)); req.setTimeout(8000, () => { req.destroy(); resolve(null); }); req.end();
  });
}

async function deleteFailedRowsByTokenHint(db: CassandraClient, tokenHint: string): Promise<void> {
  if (!tokenHint || tokenHint === '***') return;
  const failedRows = await db.execute(
    `SELECT account_id FROM ${KEYSPACE}.failed_accounts WHERE token_hint = ? ALLOW FILTERING`,
    [tokenHint],
  ).catch(() => null);
  await Promise.all((failedRows?.rows ?? []).map(row => {
    const accountId = (row['account_id'] as string) ?? '';
    if (!accountId) return Promise.resolve();
    return db.execute(`DELETE FROM ${KEYSPACE}.failed_accounts WHERE account_id = ?`, [accountId]).catch(() => {});
  }));
}

async function resolveFailedAccountIdentity(db: CassandraClient, token: string, fallbackAccountId: string, agent?: Agent): Promise<{ accountId: string; username: string }> {
  const tokenKey = token.slice(-16);
  const mapped = await db.execute(
    `SELECT account_id, username FROM ${KEYSPACE}.token_account_map WHERE token_key = ?`,
    [tokenKey],
  ).catch(() => null);
  const mappedAccountId = (mapped?.rows[0]?.['account_id'] as string) ?? '';
  if (mappedAccountId) {
    return {
      accountId: mappedAccountId,
      username: (mapped?.rows[0]?.['username'] as string) ?? '',
    };
  }

  const userData = await fetchDiscordMe(token, agent).catch(() => null);
  if (userData?.id) {
    return { accountId: userData.id, username: userData.username ?? '' };
  }

  return { accountId: fallbackAccountId, username: '' };
}

async function recordFailedAccount(db: CassandraClient, token: string, fallbackAccountId: string, reason: string, errorMsg: string, agent?: Agent): Promise<{ accountId: string; username: string; tokenHint: string }> {
  const tokenHint = failedTokenHint(token);
  const { accountId, username } = await resolveFailedAccountIdentity(db, token, fallbackAccountId, agent);

  if (!accountId.startsWith('unknown_')) {
    const staleRows = await db.execute(
      `SELECT account_id FROM ${KEYSPACE}.failed_accounts WHERE token_hint = ? ALLOW FILTERING`,
      [tokenHint],
    ).catch(() => null);
    await Promise.all((staleRows?.rows ?? []).map(row => {
      const staleId = (row['account_id'] as string) ?? '';
      if (!staleId || !staleId.startsWith('unknown_')) return Promise.resolve();
      return db.execute(`DELETE FROM ${KEYSPACE}.failed_accounts WHERE account_id = ?`, [staleId]).catch(() => {});
    }));
  }

  // Skip writing placeholder unknown_* entries — invalid tokens should not pollute the dashboard
  if (!accountId.startsWith('unknown_')) {
    await db.execute(
      `INSERT INTO ${KEYSPACE}.failed_accounts (account_id, username, token_hint, reason, error_msg, detected_at) VALUES (?,?,?,?,?,?)`,
      [accountId, username, tokenHint, reason, errorMsg, new Date()],
    );
  }
  return { accountId, username, tokenHint };
}

async function main(): Promise<void> {
  const db = await getDb();
  await loadCheckpoints();

  const accountPairs = loadAccounts(); // [globalIdx, config][]
  let liveAccountPairs = accountPairs.slice();
  initProxyPool();

  const { send: sendToKafka, disconnect: disconnectKafka } =
    await createProducer(KAFKA_BROKERS.split(','), KAFKA_TOPIC);

  const queues  = new Map<string, PQueue>();   // key = discord user ID
  const clients = new Map<string, unknown>();  // key = discord user ID
  const enqueued = new Set<string>();
  const throttleStates = new Map<string, ScopedThrottleState>();
  const accountRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const accountBaseConcurrency = new Map<string, number>();
  const accountAgents = new Map<string, ProxyAgentBundle | undefined>();
  const accountKeyById = new Map<string, string>();
  let proxyAssignmentsByKey = new Map<string, ProxyAssignment>();

  function refreshProxyAssignmentPlan(pairs: Array<[number, AccountConfig]>): void {
    const assignments = syncPlannedProxyAssignments(pairs.map(([gIdx]) => ({ accountIdx: gIdx })));
    proxyAssignmentsByKey = new Map(assignments.map(assignment => [assignment.accountKey, assignment]));
  }

  function proxyAssignmentForIdx(gIdx: number): ProxyAssignment | null {
    return proxyAssignmentsByKey.get(`idx:${gIdx}`) ?? null;
  }

  function destroyBundle(bundle: ProxyAgentBundle | undefined): void {
    try { bundle?.agent?.destroy?.(); } catch {}
  }

  refreshProxyAssignmentPlan(liveAccountPairs);
  if (isProxyPoolEnabled()) {
    console.log(`[accounts] Proxy AÇIK — managed pool aktif${isProxyStrictMode() ? ' (strict mode)' : ''}`);
  } else {
    console.log('[accounts] Proxy KAPALI — doğrudan bağlantı (VDS IP)');
  }

  // Map from globalIdx to Discord user ID (resolved after login)
  const idxToDiscordId = new Map<number, string>();

  // SCALE FIX: Chunked login — not all 400 accounts simultaneously.
  // 400 concurrent ws logins triggers Discord rate-limits and potential IP ban.
  for (let i = 0; i < accountPairs.length; i += LOGIN_CONCURRENCY) {
    const chunk = accountPairs.slice(i, i + LOGIN_CONCURRENCY);
    await Promise.all(chunk.map(async ([gIdx, acc]) => {
    const accountKey = `idx:${gIdx}`;
    const proxyAssignment = proxyAssignmentForIdx(gIdx);
    const tokenHint2 = failedTokenHint(acc.token);
    console.log(`[login-plan] idx=${gIdx} token=${tokenHint2} proxyEnabled=${isProxyPoolEnabled()} strictMode=${isProxyStrictMode()} proxyAssigned=${!!proxyAssignment?.proxy} proxyLabel=${proxyAssignment?.proxy?.label ?? 'none'}`);
    let bundle: ProxyAgentBundle | undefined;
    try {
      if (isProxyPoolEnabled()) {
        if (!proxyAssignment?.proxy) {
          const noProxyMsg = 'Proxy sistemi aktif ama hesaba atanmış proxy yok';
          console.warn(`[login-plan] idx=${gIdx} — proxy yok! strictMode=${isProxyStrictMode()}`);
          updateRuntimeProxyAssignment(accountKey, { connected: false, lastError: noProxyMsg, direct: true });
          if (isProxyStrictMode()) throw new Error(noProxyMsg);
        } else {
          console.log(`[login-plan] idx=${gIdx} — proxy bundle oluşturuluyor: ${proxyAssignment.proxy.maskedUrl}`);
          bundle = await createProxyAgentBundle(proxyAssignment.proxy);
          console.log(`[login-plan] idx=${gIdx} — bundle hazır: agent=${bundle?.agent?.constructor?.name ?? 'null'}`);
          console.log(`[accounts] Hesap (idx ${gIdx}) → proxy ${proxyAssignment.proxy.maskedUrl}`);
          // Proxy IP doğrulaması: discorda bağlanmadan önce proxy IP'nin sunucu IP'sinden farklı olduğunu doğrula
          const verify = await verifyProxyIp(gIdx, bundle!.proxyUrl, proxyAssignment.proxy.label ?? proxyAssignment.proxy.maskedUrl);
          if (!verify.ok && isProxyStrictMode()) {
            throw new Error(`Proxy IP doğrulaması başarısız: proxy=${verify.proxyIp ?? 'null'} sunucu=${verify.serverIp ?? 'null'} (${proxyAssignment.proxy.maskedUrl})`);
          }
        }
      } else {
        console.log(`[login-plan] idx=${gIdx} — proxy kapalı, direct bağlantı`);
        const serverIp = await getServerIp();
        console.log(`[proxy-verify] idx=${gIdx} — direct bağlantı, sunucu IP: ${serverIp}`);
      }
      const client = await createClient(acc.token, bundle) as any;
      const discordId: string = client.user?.id ?? String(gIdx);
      const clientUsername: string = client.user?.username ?? '';
      const tokenHint = failedTokenHint(acc.token);
      idxToDiscordId.set(gIdx, discordId);
      accountKeyById.set(discordId, accountKey);
      clients.set(discordId, client);
      accountAgents.set(discordId, bundle);
      queues.set(discordId, new PQueue({ concurrency: CONCURRENT_CHNL }));
      accountBaseConcurrency.set(discordId, CONCURRENT_CHNL);
      updateRuntimeProxyAssignment(accountKey, { accountId: discordId, username: clientUsername, connected: true, lastError: null, direct: !proxyAssignment?.proxy });
      // Clear from failed_accounts if previously failed
      db.execute(`DELETE FROM ${KEYSPACE}.failed_accounts WHERE account_id = ?`, [discordId]).catch(() => {});
      deleteFailedRowsByTokenHint(db, tokenHint).catch(() => {});
      // Ensure account_info is populated (used by guild inventory categories)
      db.execute(
        `INSERT INTO ${KEYSPACE}.account_info (account_id, discord_id, username, avatar, last_fetched) VALUES (?,?,?,?,?)`,
        [discordId, discordId, clientUsername, client.user?.avatar ?? '', new Date()],
      ).catch(() => {});
      db.execute(
        `INSERT INTO ${KEYSPACE}.token_account_map (token_key, account_id, username, updated_at) VALUES (?,?,?,?)`,
        [acc.token.slice(-16), discordId, clientUsername, new Date()],
      ).catch(() => {});

      // Monitor: detect disconnect/error at runtime (token invalidated, ban, etc.)
      client.on('error', (err: Error) => {
        console.error(`[accounts] ${clientUsername} (${discordId}) client error:`, err.message);
        updateRuntimeProxyAssignment(accountKey, { accountId: discordId, username: clientUsername, connected: false, lastError: err.message });
      });
      client.on('disconnect', () => {
        console.warn(`[accounts] ${clientUsername} (${discordId}) disconnected — marking as failed`);
        updateRuntimeProxyAssignment(accountKey, { accountId: discordId, username: clientUsername, connected: false, lastError: 'WebSocket disconnected' });
        db.execute(
          `INSERT INTO ${KEYSPACE}.failed_accounts (account_id, username, token_hint, reason, error_msg, detected_at) VALUES (?,?,?,?,?,?)`,
          [discordId, clientUsername, '', 'disconnected', 'WebSocket disconnected', new Date()],
        ).catch(() => {});
        emit('scrape_error', `${clientUsername || discordId} baglanti kesildi`, { accountId: discordId, accountName: clientUsername || discordId });
      });
      client.on('invalidated', () => {
        console.warn(`[accounts] ${clientUsername} (${discordId}) session invalidated — marking as failed`);
        updateRuntimeProxyAssignment(accountKey, { accountId: discordId, username: clientUsername, connected: false, lastError: 'Session invalidated by Discord' });
        db.execute(
          `INSERT INTO ${KEYSPACE}.failed_accounts (account_id, username, token_hint, reason, error_msg, detected_at) VALUES (?,?,?,?,?,?)`,
          [discordId, clientUsername, '', 'token_invalidated', 'Session invalidated by Discord', new Date()],
        ).catch(() => {});
        emit('scrape_error', `${clientUsername || discordId} oturum gecersiz`, { accountId: discordId, accountName: clientUsername || discordId });
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errCode = (err as any)?.code ?? (err as any)?.[Symbol.for('code')] ?? 'no_code';
      const errStack = err instanceof Error ? (err.stack ?? '').split('\n').slice(0, 4).join(' | ') : '';
      console.error(`[accounts] Hesap (idx ${gIdx}) giriş başarısız:`);
      console.error(`  → hata   : ${errMsg}`);
      console.error(`  → kod    : ${errCode}`);
      console.error(`  → token  : ${tokenHint2}`);
      console.error(`  → proxy  : ${bundle ? proxyAssignment?.proxy?.maskedUrl ?? 'bundle var ama url yok' : 'DIRECT'}`);
      console.error(`  → stack  : ${errStack}`);
      try {
        const { accountId: discordId, username, tokenHint } = await recordFailedAccount(db, acc.token, `unknown_idx_${gIdx}`, 'login_failed', errMsg, bundle?.agent);
        updateRuntimeProxyAssignment(accountKey, { accountId: discordId, username, connected: false, lastError: errMsg });
        emit('scrape_error', `${username || discordId} login başarısız`, { accountId: discordId, accountName: username || discordId });
        console.log(`[accounts] Failed account detected: ${username || discordId} (token: ${tokenHint})`);
      } catch { /* ignore */ }
      destroyBundle(bundle);
    }
    }));
    if (i + LOGIN_CONCURRENCY < accountPairs.length) {
      console.log(`[accounts] ${Math.min(i + LOGIN_CONCURRENCY, accountPairs.length)}/${accountPairs.length} hesap giriş yaptı — ${LOGIN_DELAY_MS}ms bekleniyor...`);
      await new Promise(r => setTimeout(r, LOGIN_DELAY_MS));
    }
  }

  const activeIds = [...clients.keys()];
  if (!activeIds.length) throw new Error('Hiçbir hesap giriş yapamadı');
  console.log(`[accounts] ${activeIds.length} hesap hazır | concurrency=${CONCURRENT_CHNL}`);
  startEventLog();
  // Build [discordId, config] pairs for guild-sync
  const syncPairs = accountPairs
    .filter(([gIdx]) => idxToDiscordId.has(gIdx))
    .map(([gIdx, acc]) => ({ accountId: idxToDiscordId.get(gIdx)!, accountIdx: gIdx, config: acc, agent: accountAgents.get(idxToDiscordId.get(gIdx)!)?.agent }));
  startGuildSync(db, syncPairs);

  // Build a quick lookup from discordId → token for guild fetching
  const tokenById = new Map<string, string>();
  for (const [gIdx, acc] of accountPairs) {
    const did = idxToDiscordId.get(gIdx);
    if (did) tokenById.set(did, acc.token);
  }

  const globalIdxByAccountId = new Map<string, number>();
  for (const [gIdx, did] of idxToDiscordId) globalIdxByAccountId.set(did, gIdx);

  const accountGuilds = new Map<string, Set<string>>();
  await Promise.all(activeIds.map(async accId => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = clients.get(accId) as any;
    let guildIds = new Set<string>([...(client.guilds?.cache?.keys?.() ?? [])] as string[]);
    const token = tokenById.get(accId);
    if (guildIds.size < 2 && token) guildIds = await fetchGuildIds(token, accountAgents.get(accId)?.agent);
    accountGuilds.set(accId, guildIds);
    console.log(`[accounts] ${client.user?.username} (${accId}) — ${guildIds.size} guild`);
  }));

  const guildToAccounts = new Map<string, string[]>();
  function rebuildGuildToAccounts(): void {
    guildToAccounts.clear();
    for (const [accId, guilds] of accountGuilds) {
      for (const gid of guilds) {
        if (!guildToAccounts.has(gid)) guildToAccounts.set(gid, []);
        guildToAccounts.get(gid)!.push(accId);
      }
    }
  }
  rebuildGuildToAccounts();

  const guildRR = new Map<string, number>();
  const trackedTargetState = new Map<string, string>();
  const assignedAccountByChannel = new Map<string, string>();
  const ownerAccountByChannel = new Map<string, string>();
  const currentTargetsByChannel = new Map<string, WorkerTarget>();
  const queuedChannelsByAccount = new Map<string, Set<string>>();
  const runningChannelsByAccount = new Map<string, Set<string>>();
  const channelRunToken = new Map<string, string>();
  const abortHandles = new Map<string, { controller: AbortController; runToken: string; accountId: string }>();
  const stopReasonByChannel = new Map<string, { reason: StopReason; runToken: string; pauseSource: PauseSource }>();
  let controlOverlay: ControlOverlay = { pausedAccounts: new Map(), pausedChannels: new Map(), hash: '' };
  let lastControlHash = controlOverlay.hash;
  let schedulerChain: Promise<void> = Promise.resolve();

  function withSchedulerLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = schedulerChain.catch(() => {}).then(fn);
    schedulerChain = next.then(() => undefined, () => undefined);
    return next;
  }

  function accountNameFor(accountId: string): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (clients.get(accountId) as any)?.user?.username ?? accountId;
  }

  function throttleScopeKey(kind: 'account' | 'guild' | 'channel', accountId?: string, guildId?: string, channelId?: string): string | null {
    if (!accountId) return null;
    if (kind === 'account') return `account:${accountId}`;
    if (kind === 'guild') return guildId ? `guild:${accountId}:${guildId}` : null;
    return channelId ? `channel:${accountId}:${channelId}` : null;
  }

  function clearRecoveryTimer(accountId: string): void {
    const timer = accountRecoveryTimers.get(accountId);
    if (timer) clearTimeout(timer);
    accountRecoveryTimers.delete(accountId);
  }

  function clearThrottleStateForAccount(accountId: string): void {
    clearRecoveryTimer(accountId);
    for (const key of [...throttleStates.keys()]) {
      if (key === `account:${accountId}` || key.startsWith(`guild:${accountId}:`) || key.startsWith(`channel:${accountId}:`)) {
        throttleStates.delete(key);
      }
    }
    accountBaseConcurrency.delete(accountId);
  }

  function registerScopeCooldown(scopeKey: string, baseWaitMs: number): { waitMs: number; cooldownUntil: number; hitsInWindow: number } {
    const now = Date.now();
    const prev = throttleStates.get(scopeKey);
    const withinWindow = !!prev && (now - prev.windowStartedAt) <= RL_COOLDOWN_WINDOW_MS;
    const hitsInWindow = withinWindow ? (prev!.hitsInWindow + 1) : 1;
    const budgetedHits = Math.min(hitsInWindow, RL_RETRY_BUDGET);
    const cap = Math.min(Math.max(baseWaitMs, 1_000) * (2 ** Math.max(0, budgetedHits - 1)), RL_MAX_SCOPE_COOLDOWN_MS);
    const jitterMs = Math.floor(Math.random() * cap);
    const waitMs = Math.max(baseWaitMs, jitterMs);
    const cooldownUntil = Math.max(prev?.cooldownUntil ?? 0, now + waitMs);
    throttleStates.set(scopeKey, {
      cooldownUntil,
      hitsInWindow,
      windowStartedAt: withinWindow ? prev!.windowStartedAt : now,
      lastHitAt: now,
    });
    return { waitMs, cooldownUntil, hitsInWindow };
  }

  function computeThrottleWait(accountId?: string, guildId?: string, channelId?: string): number {
    if (!SCOPED_THROTTLE_ENABLED || !accountId) return 0;
    const now = Date.now();
    const keys = [
      throttleScopeKey('account', accountId, guildId, channelId),
      throttleScopeKey('guild', accountId, guildId, channelId),
      throttleScopeKey('channel', accountId, guildId, channelId),
    ].filter((key): key is string => !!key);
    let waitMs = 0;
    for (const key of keys) {
      const state = throttleStates.get(key);
      if (!state || state.cooldownUntil <= now) continue;
      waitMs = Math.max(waitMs, state.cooldownUntil - now);
    }
    return waitMs;
  }

  function scheduleAccountRecovery(accountId: string): void {
    if (!SCOPED_THROTTLE_ENABLED) return;
    clearRecoveryTimer(accountId);
    const queue = queues.get(accountId);
    if (!queue) return;
    const baseConcurrency = accountBaseConcurrency.get(accountId) ?? CONCURRENT_CHNL;
    if (queue.concurrency >= baseConcurrency) return;
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
        emit('info', 'resume window', { accountId, accountName: accountNameFor(accountId), detail });
      }
      if (next < base) scheduleAccountRecovery(accountId);
      else accountRecoveryTimers.delete(accountId);
    }, Math.max(1_000, waitMs));
    accountRecoveryTimers.set(accountId, timer);
  }

  function reduceAccountConcurrency(accountId: string, guildId: string, channelId: string): void {
    const queue = queues.get(accountId);
    if (!queue) return;
    const prev = queue.concurrency;
    const next = Math.max(RL_ACCOUNT_CONCURRENCY_MIN, prev - 1);
    if (next < prev) {
      queue.concurrency = next;
      const detail = `event=concurrency_reduced accountId=${accountId} channelId=${channelId} guildId=${guildId} previousConcurrency=${prev} newConcurrency=${next}`;
      console.warn(`[scraper] ${detail}`);
      emit('info', 'concurrency reduced', { accountId, accountName: accountNameFor(accountId), channelId, guildId, detail });
    }
    scheduleAccountRecovery(accountId);
  }

  const throttleHooks: ScrapeThrottleHooks | undefined = SCOPED_THROTTLE_ENABLED ? {
    beforeFetch: ({ accountId, guildId, channelId }) => computeThrottleWait(accountId, guildId, channelId),
    onRateLimit: async (event: ScrapeRateLimitEvent) => {
      if (!event.accountId) return { waitMs: event.waitMs };
      const accountKey = throttleScopeKey('account', event.accountId, event.guildId, event.channelId);
      const guildKey = throttleScopeKey('guild', event.accountId, event.guildId, event.channelId);
      const channelKey = throttleScopeKey('channel', event.accountId, event.guildId, event.channelId);
      const accountState = accountKey ? registerScopeCooldown(accountKey, event.waitMs) : null;
      const guildState = guildKey ? registerScopeCooldown(guildKey, event.waitMs) : null;
      const channelState = channelKey ? registerScopeCooldown(channelKey, event.waitMs) : null;
      reduceAccountConcurrency(event.accountId, event.guildId, event.channelId);
      const appliedWaitMs = Math.max(
        event.waitMs,
        accountState?.waitMs ?? 0,
        guildState?.waitMs ?? 0,
        channelState?.waitMs ?? 0,
      );
      const cooldownUntil = Math.max(
        accountState?.cooldownUntil ?? 0,
        guildState?.cooldownUntil ?? 0,
        channelState?.cooldownUntil ?? 0,
      );
      const detail = `event=throttle_applied accountId=${event.accountId} channelId=${event.channelId} guildId=${event.guildId} accountWaitMs=${accountState?.waitMs ?? 0} guildWaitMs=${guildState?.waitMs ?? 0} channelWaitMs=${channelState?.waitMs ?? 0} waitMs=${appliedWaitMs} cooldownUntil=${new Date(cooldownUntil || (Date.now() + appliedWaitMs)).toISOString()} retryBudget=${RL_RETRY_BUDGET}`;
      console.warn(`[scraper] ${detail}`);
      emit('info', 'throttle applied', { accountId: event.accountId, accountName: accountNameFor(event.accountId), channelId: event.channelId, guildId: event.guildId, detail });
      return { waitMs: appliedWaitMs };
    },
  } : undefined;

  function addChannel(map: Map<string, Set<string>>, accountId: string, channelId: string): void {
    if (!map.has(accountId)) map.set(accountId, new Set());
    map.get(accountId)!.add(channelId);
  }

  function removeChannelFromAccount(map: Map<string, Set<string>>, accountId: string, channelId: string): void {
    const set = map.get(accountId);
    if (!set) return;
    set.delete(channelId);
    if (set.size === 0) map.delete(accountId);
  }

  function ownerAccountFor(target: WorkerTarget): string | null {
    if (target.pinnedAccountId) return target.pinnedAccountId;
    if (target.accountId) return target.accountId;
    if (target.pinnedAccountIdx != null) return idxToDiscordId.get(target.pinnedAccountIdx) ?? null;
    if (target.accountIdx != null) return idxToDiscordId.get(target.accountIdx) ?? null;
    return null;
  }

  function pauseSourceFor(target: WorkerTarget, overlay: ControlOverlay): PauseSource {
    if (!SCRAPER_FLAGS.pauseControlEnabled) return 'none';
    const channelPaused = overlay.pausedChannels.has(target.channelId);
    const ownerAccountId = ownerAccountFor(target);
    const accountPaused = !!(SCRAPER_FLAGS.accountPauseEnabled && ownerAccountId && overlay.pausedAccounts.has(ownerAccountId));
    if (channelPaused && accountPaused) return 'both';
    if (channelPaused) return 'channel';
    if (accountPaused) return 'account';
    return 'none';
  }

  function pauseReasonFor(target: WorkerTarget, overlay: ControlOverlay, pauseSource: PauseSource): string | null {
    if (pauseSource === 'channel' || pauseSource === 'both') {
      const reason = overlay.pausedChannels.get(target.channelId)?.reason?.trim();
      if (reason) return reason;
    }
    if (pauseSource === 'account' || pauseSource === 'both') {
      const ownerAccountId = ownerAccountFor(target);
      const reason = ownerAccountId ? overlay.pausedAccounts.get(ownerAccountId)?.reason?.trim() : '';
      if (reason) return reason;
    }
    if (pauseSource === 'channel') return 'paused by channel control';
    if (pauseSource === 'account') return 'paused by account control';
    if (pauseSource === 'both') return 'paused by account and channel control';
    return null;
  }

  function writeRuntimeState(
    target: WorkerTarget,
    schedulerState: 'queued' | 'running' | 'paused' | 'completed' | 'error_retryable' | 'error_terminal',
    opts?: {
      accountId?: string | null;
      pauseSource?: PauseSource;
      stateReason?: string | null;
      lastErrorClass?: 'retryable' | 'terminal' | null;
      lastErrorCode?: string | null;
      lastErrorAt?: string | null;
    },
  ): void {
    if (!SCRAPER_FLAGS.runtimeStateEnabled) return;
    ensureChannel(target.channelId, target.guildId, opts?.accountId ?? target.accountId);
    setRuntimeState(target.channelId, {
      schedulerState,
      pauseSource: opts?.pauseSource ?? 'none',
      stateReason: opts?.stateReason ?? null,
      workerId: WORKER_ID,
      lastErrorClass: opts?.lastErrorClass ?? null,
      lastErrorCode: opts?.lastErrorCode ?? null,
      lastErrorAt: opts?.lastErrorAt ?? null,
    });
  }

  function pinnedAccountFor(target: WorkerTarget): string | null {
    const pinned = target.pinnedAccountId ?? (target.pinnedAccountIdx != null ? idxToDiscordId.get(target.pinnedAccountIdx) ?? null : null);
    if (!pinned) return null;
    if (!activeIds.includes(pinned)) return null;
    const pool = guildToAccounts.get(target.guildId);
    if (!pool || pool.includes(pinned)) return pinned;
    console.warn(`[accounts] Pinned hesap guild dışı görünüyor, fallback: ${target.channelId} → ${pinned}`);
    return null;
  }

  function pickAccount(target: WorkerTarget, overlay: ControlOverlay = controlOverlay): string {
    const pinned = pinnedAccountFor(target);
    if (pinned) return pinned;
    const basePool = guildToAccounts.get(target.guildId) ?? activeIds;
    const eligiblePool = SCRAPER_FLAGS.accountPauseEnabled
      ? basePool.filter(accId => !overlay.pausedAccounts.has(accId))
      : basePool;
    const pool = eligiblePool.length > 0 ? eligiblePool : basePool;
    if (!guildToAccounts.has(target.guildId)) console.warn(`[accounts] Guild ${target.guildId} için uygun hesap yok, fallback`);
    const rr = guildRR.get(target.guildId) ?? 0;
    guildRR.set(target.guildId, (rr + 1) % pool.length);
    return pool[rr % pool.length];
  }

  function targetStateKey(target: WorkerTarget): string {
    return [
      target.guildId,
      target.pinnedAccountId ?? '',
      target.pinnedAccountIdx != null ? String(target.pinnedAccountIdx) : '',
    ].join('|');
  }

  async function upsertTargetMirror(target: WorkerTarget, activeAccountId: string): Promise<void> {
    const ownerAccountId = target.pinnedAccountId ?? activeAccountId;
    const previousOwnerId = ownerAccountByChannel.get(target.channelId) ?? target.pinnedAccountId ?? target.accountId ?? assignedAccountByChannel.get(target.channelId);
    if (previousOwnerId && previousOwnerId !== ownerAccountId) {
      await db.execute(
        `DELETE FROM ${KEYSPACE}.account_targets_by_account WHERE account_id = ? AND channel_id = ?`,
        [previousOwnerId, target.channelId],
      ).catch(() => {});
    }
    const ownerAccountIdx = globalIdxByAccountId.get(ownerAccountId);
    const activeAccountIdx = globalIdxByAccountId.get(activeAccountId);
    await db.execute(
      `INSERT INTO ${KEYSPACE}.account_targets_by_account (account_id, channel_id, guild_id, label, account_idx, active_account_id, active_account_idx, pinned_account_id, pinned_account_idx, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [ownerAccountId, target.channelId, target.guildId, target.label ?? '', ownerAccountIdx ?? null, activeAccountId, activeAccountIdx ?? null, target.pinnedAccountId ?? null, target.pinnedAccountIdx ?? null, new Date()],
    ).catch(() => {});
    assignedAccountByChannel.set(target.channelId, activeAccountId);
    ownerAccountByChannel.set(target.channelId, ownerAccountId);
  }

  async function deleteTargetMirror(channelId: string): Promise<void> {
    const ownerAccountId = ownerAccountByChannel.get(channelId) ?? assignedAccountByChannel.get(channelId);
    if (ownerAccountId) {
      await db.execute(
        `DELETE FROM ${KEYSPACE}.account_targets_by_account WHERE account_id = ? AND channel_id = ?`,
        [ownerAccountId, channelId],
      ).catch(() => {});
    }
    assignedAccountByChannel.delete(channelId);
    ownerAccountByChannel.delete(channelId);
  }

  async function seedTargetMirrors(targets: WorkerTarget[]): Promise<void> {
    const withAccount = targets.filter(t => t.accountId || t.pinnedAccountId);
    for (let i = 0; i < withAccount.length; i += 100) {
      await Promise.all(withAccount.slice(i, i + 100).map(t => upsertTargetMirror(t, t.accountId ?? t.pinnedAccountId!)));
    }
  }

  function clearQueuedForAccount(accountId: string, overlay: ControlOverlay): void {
    const waiting = [...(queuedChannelsByAccount.get(accountId) ?? [])];
    if (waiting.length === 0) return;
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
        emit('dequeue', `${channelId} duraklatildi`, { accountId, channelId, guildId: target.guildId, detail: reason ?? undefined });
      }
    }
  }

  async function finalizeScrapeExit(target: WorkerTarget, accId: string, runToken: string, result: ScrapeChannelResult): Promise<void> {
    if (channelRunToken.get(target.channelId) !== runToken) return;
    const stop = stopReasonByChannel.get(target.channelId);
    const stopMatches = stop?.runToken === runToken;
    const nowIso = new Date().toISOString();

    if (result.kind === 'completed') {
      writeRuntimeState(target, 'completed', { accountId: accId, stateReason: result.reason ?? 'complete' });
      await flushStats().catch(() => {});
    } else if (result.kind === 'error_retryable') {
      writeRuntimeState(target, 'error_retryable', {
        accountId: accId,
        stateReason: result.reason ?? 'retryable scrape error',
        lastErrorClass: 'retryable',
        lastErrorCode: result.code ?? 'retryable_error',
        lastErrorAt: nowIso,
      });
      await flushStats().catch(() => {});
    } else if (result.kind === 'error_terminal') {
      writeRuntimeState(target, 'error_terminal', {
        accountId: accId,
        stateReason: result.reason ?? 'terminal scrape error',
        lastErrorClass: 'terminal',
        lastErrorCode: result.code ?? 'terminal_error',
        lastErrorAt: nowIso,
      });
      await flushStats().catch(() => {});
    } else if (result.kind === 'aborted' && stopMatches && (stop.reason === 'pause_account' || stop.reason === 'pause_channel')) {
      const flushed = await flushCheckpoint(target.channelId);
      enqueued.delete(target.channelId);
      trackedTargetState.delete(target.channelId);
      if (flushed) {
        const reason = pauseReasonFor(target, controlOverlay, stop.pauseSource);
        writeRuntimeState(target, 'paused', {
          accountId: accId,
          pauseSource: stop.pauseSource,
          stateReason: reason,
        });
        emit('info', `${target.channelId} duraklatildi`, { accountId: accId, channelId: target.channelId, guildId: target.guildId, detail: reason ?? undefined });
      } else {
        writeRuntimeState(target, 'error_retryable', {
          accountId: accId,
          pauseSource: stop.pauseSource,
          stateReason: 'pause checkpoint flush failed',
          lastErrorClass: 'retryable',
          lastErrorCode: 'pause_checkpoint_flush_failed',
          lastErrorAt: nowIso,
        });
      }
      await flushStats().catch(() => {});
    } else if (result.kind === 'aborted') {
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
        await flushStats().catch(() => {});
      }
      if (stopMatches && (stop.reason === 'target_reassigned' || stop.reason === 'account_pool_changed')) {
        setImmediate(() => {
          withSchedulerLock(() => syncTargets(undefined, controlOverlay)).catch(() => {});
        });
      }
    } else if (result.kind === 'yield') {
      // Time-slicing: Channel yielded after MAX_BATCHES_PER_RUN - re-queue for fair scheduling
      enqueued.delete(target.channelId);
      trackedTargetState.delete(target.channelId);
      channelRunToken.delete(target.channelId);
      
      // Mark as queued again for immediate re-processing
      writeRuntimeState(target, 'queued', {
        accountId: accId,
        stateReason: `Yielded for fair scheduling - ${result.reason ?? 'time slice complete'}`,
      });
      
      // Emit yield event
      emit('info', `${target.channelId} re-queued`, { 
        accountId: accId, 
        channelId: target.channelId, 
        guildId: target.guildId, 
        detail: `totalScraped=${result.totalScraped ?? 0} batches=${process.env.MAX_BATCHES_PER_RUN ?? 10}` 
      });
      
      await flushStats().catch(() => {});
      
      // Re-enqueue the channel immediately - it will go to the back of the queue
      // giving other channels a chance to run (RoundRobin-style fair scheduling)
      setImmediate(() => {
        enqueueChannel(target, accId, controlOverlay);
      });
    } else if (result.kind === 'noop' && result.code === 'empty_channel') {
      writeRuntimeState(target, 'completed', { accountId: accId, stateReason: result.reason ?? 'channel is empty' });
      await flushStats().catch(() => {});
    } else if (result.kind === 'noop') {
      writeRuntimeState(target, 'error_retryable', {
        accountId: accId,
        stateReason: result.reason ?? 'scrape exited without progress',
        lastErrorClass: 'retryable',
        lastErrorCode: result.code ?? 'noop',
        lastErrorAt: nowIso,
      });
      await flushStats().catch(() => {});
    }

    if (stopMatches) stopReasonByChannel.delete(target.channelId);
    channelRunToken.delete(target.channelId);
  }

  function enqueueChannel(target: WorkerTarget, accId: string, overlay: ControlOverlay = controlOverlay): void {
    if (enqueued.has(target.channelId)) return;
    const cp = getAllCheckpoints()[target.channelId];
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
    const queue  = queues.get(accId);
    const client = clients.get(accId);
    if (!queue || !client) return;
    const abort  = new AbortController();
    const runToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    enqueued.add(target.channelId);
    channelRunToken.set(target.channelId, runToken);
    abortHandles.set(target.channelId, { controller: abort, runToken, accountId: accId });
    addChannel(queuedChannelsByAccount, accId, target.channelId);
    writeRuntimeState(target, 'queued', { accountId: accId, stateReason: 'queued for scrape' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accName = (client as any).user?.username ?? accId;
    console.log(`[accounts] ▶ ${target.channelId} → ${accName} (${accId}) kuyruğuna eklendi`);
    emit('enqueue', `${target.channelId} → ${accName}`, { accountId: accId, accountName: accName, channelId: target.channelId, guildId: target.guildId });
    const accountIdx = globalIdxByAccountId.get(accId);
    db.execute(`UPDATE ${KEYSPACE}.scrape_targets SET account_id = ?, account_idx = ? WHERE channel_id = ?`, [accId, accountIdx ?? null, target.channelId]).catch(() => {});
    upsertTargetMirror(target, accId).catch(() => {});

    queue.add(async () => {
      const handle = abortHandles.get(target.channelId);
      if (!handle || handle.runToken !== runToken) return;
      removeChannelFromAccount(queuedChannelsByAccount, accId, target.channelId);
      let result: ScrapeChannelResult;
      if (abort.signal.aborted) {
        result = { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received before run start' };
      } else {
        addChannel(runningChannelsByAccount, accId, target.channelId);
        writeRuntimeState(target, 'running', { accountId: accId, stateReason: 'scrape in progress' });
        try {
          result = await scrapeChannel(
            client, target.guildId, target.channelId,
            async (batch) => { if (!abort.signal.aborted) await sendToKafka(batch); },
            (total) => { if (total % 5_000 === 0) console.log(`[accounts] ${accName} | ${target.channelId} | ${total.toLocaleString()} mesaj`); },
            abort.signal,
            accId,
            throttleHooks,
            (client as any).token,  // RAW HTTP: Pass token for 5x faster message fetching
            accountAgents.get(accId)?.proxyUrl,  // RAW HTTP: Pass proxy URL so raw fetches go through proxy
          );
        } catch (err) {
          if (!abort.signal.aborted) console.error(`[accounts] ${accName} ${target.channelId} hata:`, err);
          result = {
            kind: 'error_retryable',
            code: 'worker_unhandled_error',
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      }
      removeChannelFromAccount(runningChannelsByAccount, accId, target.channelId);
      const currentHandle = abortHandles.get(target.channelId);
      if (currentHandle?.runToken === runToken) abortHandles.delete(target.channelId);
      await finalizeScrapeExit(target, accId, runToken, result);
    }).catch(err => {
      console.error(`[accounts] Queue task failed for ${target.channelId}:`, err);
    });
  }

  async function syncTargets(targetsOverride?: WorkerTarget[], overlayOverride?: ControlOverlay): Promise<void> {
    const targets = targetsOverride ?? await readTargets(db);
    const overlay = overlayOverride ?? controlOverlay;
    currentTargetsByChannel.clear();
    for (const target of targets) currentTargetsByChannel.set(target.channelId, target);
    const liveChannelIds = new Set(targets.map(t => t.channelId));
    const accountsToRebuild = new Set<string>();

    for (const channelId of [...enqueued]) {
      if (!liveChannelIds.has(channelId)) {
        const handle = abortHandles.get(channelId);
        if (handle) {
          stopReasonByChannel.set(channelId, { reason: 'target_removed', runToken: handle.runToken, pauseSource: 'none' });
          accountsToRebuild.add(handle.accountId);
          handle.controller.abort();
        } else {
          enqueued.delete(channelId);
        }
        trackedTargetState.delete(channelId);
        deleteTargetMirror(channelId).catch(() => {});
        removeChannel(channelId);
        console.log(`[accounts] ■ ${channelId} listeden çıkarıldı`);
        emit('dequeue', `${channelId} kaldirildi`, { channelId });
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
        } else {
          enqueued.delete(target.channelId);
          trackedTargetState.delete(target.channelId);
        }
        console.log(`[accounts] ↻ ${target.channelId} yeniden atanıyor`);
      }
    }

    for (const accountId of accountsToRebuild) clearQueuedForAccount(accountId, overlay);

    for (const target of targets) {
      const pauseSource = pauseSourceFor(target, overlay);
      const cp = getAllCheckpoints()[target.channelId];
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

  function requestAbortForAccount(accountId: string, reason: StopReason, overlay: ControlOverlay): void {
    clearQueuedForAccount(accountId, overlay);
    const running = [...(runningChannelsByAccount.get(accountId) ?? [])];
    for (const channelId of running) {
      const handle = abortHandles.get(channelId);
      if (!handle) continue;
      stopReasonByChannel.set(channelId, { reason, runToken: handle.runToken, pauseSource: 'none' });
      handle.controller.abort();
    }
  }

  function abortAllEnqueued(reason: StopReason, overlay: ControlOverlay): void {
    const accounts = new Set<string>([
      ...queuedChannelsByAccount.keys(),
      ...runningChannelsByAccount.keys(),
      ...[...abortHandles.values()].map(handle => handle.accountId),
    ]);
    for (const accountId of accounts) requestAbortForAccount(accountId, reason, overlay);
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
      const namesToSave: [string, string, string, string | null][] = [];

      // Guild names come from discord.js cache (free, no API calls)
      for (const accId of activeIds) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const client = clients.get(accId) as any;
        for (const [guildId, guild] of (client.guilds?.cache ?? new Map())) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ((guild as any)?.name) namesToSave.push([guildId, (guild as any).name, 'guild', (guild as any).icon ?? null]);
        }
      }

      // SCALE FIX: Check which channel IDs are already in name_cache before
      // making Discord API calls. At 90K channels this avoids 90K API requests on restart.
      const existingResult = await db.execute(`SELECT id FROM ${KEYSPACE}.name_cache WHERE kind = 'channel' ALLOW FILTERING`);
      const alreadyCached = new Set(existingResult.rows.map(r => r['id'] as string));
      const uncachedTargets = targets.filter(t => !alreadyCached.has(t.channelId));
      console.log(`[accounts] İsim cache: ${alreadyCached.size} mevcut, ${uncachedTargets.length} yeni kanal bulunacak`);

      // Fetch names only for uncached channels — in small batches with delay
      // to avoid Discord rate limits (1 batch of 5 every 2s)
      const NAME_FETCH_CONCURRENCY = parseInt(process.env.NAME_FETCH_CONCURRENCY ?? '5', 10);
      const NAME_FETCH_DELAY_MS    = parseInt(process.env.NAME_FETCH_DELAY_MS    ?? '2000', 10);
      const chunks: typeof uncachedTargets[] = [];
      for (let i = 0; i < uncachedTargets.length; i += NAME_FETCH_CONCURRENCY)
        chunks.push(uncachedTargets.slice(i, i + NAME_FETCH_CONCURRENCY));

      for (const chunk of chunks) {
        await Promise.all(chunk.map(async t => {
          // Pick account that is in this guild for the fetch
          const accId = pickAccount(t) || activeIds[0];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const client = clients.get(accId) as any;
          if (!client) return;
          try {
            const ch = await client.channels.fetch(t.channelId);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if ((ch as any)?.name) namesToSave.push([t.channelId, (ch as any).name, 'channel', null]);
          } catch { /* erişim yoksa atla */ }
        }));
        if (chunks.indexOf(chunk) < chunks.length - 1)
          await new Promise(r => setTimeout(r, NAME_FETCH_DELAY_MS));
      }

      // Write to DB in batches of 50 (not one giant Promise.all)
      const WRITE_CHUNK = 50;
      for (let i = 0; i < namesToSave.length; i += WRITE_CHUNK) {
        const slice = namesToSave.slice(i, i + WRITE_CHUNK);
        await Promise.all(slice.map(([id, name, kind, icon]) =>
          db.execute(`INSERT INTO ${KEYSPACE}.name_cache (id, name, kind, icon) VALUES (?,?,?,?)`, [id, name, kind, icon ?? null])
        ));
      }
      if (namesToSave.length > 0) console.log(`[accounts] ✓ ${namesToSave.length} isim kaydedildi`);
    } catch (err) { console.warn('[accounts] İsim yükleme hatası (non-fatal):', err); }
  });

  let pollTimer: ReturnType<typeof setInterval>;
  let lastTargetCount = initialTargets.length;
  let lastTargetHash  = [...initialTargets]
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
          if (added > 0) console.log(`[accounts] +${added} yeni kanal kuyruğa eklendi`);
          lastTargetCount = targets.length;
          lastTargetHash  = hash;
          lastControlHash = controlOverlay.hash;
        });
      }
    } catch { /* ignore */ }
  }, 2_000);

  // accounts.json hot-reload — compares tokens to detect changes
  let accWatchDebounce: ReturnType<typeof setTimeout> | null = null;
  // Track which tokens are currently loaded (to detect additions/removals)
  const activeTokens = new Set(accountPairs.filter(([gIdx]) => idxToDiscordId.has(gIdx)).map(([_, acc]) => acc.token));

  fs.watchFile(ACCOUNTS_FILE, { interval: 2_000 }, () => {
    if (accWatchDebounce) clearTimeout(accWatchDebounce);
    accWatchDebounce = setTimeout(async () => {
      await withSchedulerLock(async () => {
        let newPairs: Array<[number, AccountConfig]>;
        try { newPairs = loadAccounts(); } catch { return; }
        liveAccountPairs = newPairs;
        refreshProxyAssignmentPlan(liveAccountPairs);
        const newTokens = new Set(newPairs.map(([_, acc]) => acc.token));
        let accountPoolChanged = false;
        for (const [gIdx, acc] of newPairs) {
          if (activeTokens.has(acc.token)) continue;
          console.log(`[accounts] Yeni hesap — login olunuyor…`);
          const accountKey = `idx:${gIdx}`;
          const proxyAssignment = proxyAssignmentForIdx(gIdx);
          let bundle: ProxyAgentBundle | undefined;
          try {
            if (isProxyPoolEnabled()) {
              if (!proxyAssignment?.proxy) {
                const noProxyMsg = 'Proxy sistemi aktif ama hesaba atanmış proxy yok';
                updateRuntimeProxyAssignment(accountKey, { connected: false, lastError: noProxyMsg, direct: true });
                if (isProxyStrictMode()) throw new Error(noProxyMsg);
              } else {
                bundle = await createProxyAgentBundle(proxyAssignment.proxy);
                console.log(`[accounts] Yeni hesap (idx ${gIdx}) → proxy ${proxyAssignment.proxy.maskedUrl}`);
              }
            }
            const client = await createClient(acc.token, bundle) as any;
            const discordId: string = client.user?.id ?? `unknown-${Date.now()}`;
            const tokenHint = failedTokenHint(acc.token);
            idxToDiscordId.set(gIdx, discordId);
            globalIdxByAccountId.set(discordId, gIdx);
            accountKeyById.set(discordId, accountKey);
            clients.set(discordId, client);
            accountAgents.set(discordId, bundle);
            queues.set(discordId, new PQueue({ concurrency: CONCURRENT_CHNL }));
            accountBaseConcurrency.set(discordId, CONCURRENT_CHNL);
            activeIds.push(discordId);
            tokenById.set(discordId, acc.token);
            activeTokens.add(acc.token);
            updateRuntimeProxyAssignment(accountKey, { accountId: discordId, username: client.user?.username ?? '', connected: true, lastError: null, direct: !proxyAssignment?.proxy });
            db.execute(`DELETE FROM ${KEYSPACE}.failed_accounts WHERE account_id = ?`, [discordId]).catch(() => {});
            deleteFailedRowsByTokenHint(db, tokenHint).catch(() => {});
            db.execute(
              `INSERT INTO ${KEYSPACE}.token_account_map (token_key, account_id, username, updated_at) VALUES (?,?,?,?)`,
              [acc.token.slice(-16), discordId, client.user?.username ?? '', new Date()],
            ).catch(() => {});
            const guildIds = await fetchGuildIds(acc.token, bundle?.agent);
            accountGuilds.set(discordId, guildIds);
            rebuildGuildToAccounts();
            accountPoolChanged = true;
            console.log(`[accounts] ✓ ${client.user?.username} (${discordId}) sisteme katıldı (${guildIds.size} guild)`);
          } catch (err) {
            console.error(`[accounts] Yeni hesap hata:`, err);
            try {
              const errMsg = err instanceof Error ? err.message : String(err);
              const { accountId: discordId, username: uname } = await recordFailedAccount(db, acc.token, `unknown_hotreload_${Date.now()}`, 'login_failed', errMsg, bundle?.agent);
              updateRuntimeProxyAssignment(accountKey, { accountId: discordId, username: uname || null, connected: false, lastError: errMsg });
              emit('scrape_error', `${uname || discordId} login basarisiz (hot-reload)`, { accountId: discordId, accountName: uname || discordId });
              console.log(`[accounts] Failed account detected (hot-reload): ${uname || discordId}`);
            } catch { /* ignore */ }
            destroyBundle(bundle);
          }
        }
        for (const [accId] of [...clients]) {
          const token = tokenById.get(accId);
          if (token && newTokens.has(token)) continue;
          const removedIdx = globalIdxByAccountId.get(accId);
          requestAbortForAccount(accId, 'account_pool_changed', controlOverlay);
          queues.get(accId)?.clear();
          clearThrottleStateForAccount(accId);
          clients.delete(accId); queues.delete(accId);
          destroyBundle(accountAgents.get(accId));
          accountAgents.delete(accId);
          accountGuilds.delete(accId);
          globalIdxByAccountId.delete(accId);
          accountKeyById.delete(accId);
          queuedChannelsByAccount.delete(accId);
          runningChannelsByAccount.delete(accId);
          for (const [gIdx, discordId] of [...idxToDiscordId.entries()]) {
            if (discordId === accId) idxToDiscordId.delete(gIdx);
          }
          if (token) { tokenById.delete(accId); activeTokens.delete(token); }
          const ai = activeIds.indexOf(accId);
          if (ai !== -1) activeIds.splice(ai, 1);
          if (removedIdx != null) removeRuntimeProxyAssignment({ accountIdx: removedIdx });
          rebuildGuildToAccounts();
          accountPoolChanged = true;
          console.log(`[accounts] ${accId} kaldırıldı`);
        }
        if (accountPoolChanged && activeIds.length > 0) {
          abortAllEnqueued('account_pool_changed', controlOverlay);
          await syncTargets(undefined, controlOverlay);
        }
        updateGuildSyncAccounts(
          liveAccountPairs
            .filter(([gIdx]) => idxToDiscordId.has(gIdx))
            .map(([gIdx, acc]) => ({ accountId: idxToDiscordId.get(gIdx)!, accountIdx: gIdx, config: acc, agent: accountAgents.get(idxToDiscordId.get(gIdx)!)?.agent })),
        );
      });
    }, 1_000);
  });

  await new Promise<void>(resolve => {
    const shutdown = async () => {
      clearInterval(pollTimer);
      if (accWatchDebounce) clearTimeout(accWatchDebounce);
      fs.unwatchFile(ACCOUNTS_FILE);
      for (const accountId of accountRecoveryTimers.keys()) clearRecoveryTimer(accountId);
      for (const [accountId, accountKey] of accountKeyById) updateRuntimeProxyAssignment(accountKey, { accountId, connected: false, lastError: 'worker_shutdown' });
      abortAllEnqueued('shutdown', controlOverlay);
      await Promise.all([...queues.values()].map(queue => queue.onIdle().catch(() => {})));
      await flush();
      await flushStats().catch(() => {});
      stopGuildSync();
      await stopEventLog();
      stopProxyPool();
      await disconnectKafka();
      for (const [accId, client] of clients) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (client as any).destroy?.().catch(() => {});
        destroyBundle(accountAgents.get(accId));
        console.log(`[accounts] ${accId} kapatıldı`);
      }
      console.log(`[accounts] Durduruldu. Aktif: ${activeChannelCount()}`);
      resolve();
    };
    process.once('SIGINT',  shutdown);
    process.once('SIGTERM', shutdown);
  });
}

main().catch(err => { console.error('[accounts] Fatal:', err); process.exit(1); });