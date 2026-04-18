import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import fs   from 'fs';
import path from 'path';
import { Client as CassandraClient } from 'cassandra-driver';
import { addRuntimeStateCount, buildPauseIntentView, countedRuntimeTotal, emptyRuntimeStateCounts, isPauseAcknowledged, readAllRuntimeStates, readPausedAccounts, readPausedChannels, readRuntimeStatesByChannelIds, type RuntimeStateCounts, type RuntimeStateRow } from '../scrape-control';
import { autoCategorize } from './guild-inventory';
import { discordApiGet } from '../discord-proxy';

const KEYSPACE    = process.env.SCYLLA_KEYSPACE ?? 'senneo';
const ACCOUNTS_FILE = path.resolve(process.cwd(), 'accounts.json');
const ACC_COLORS    = ['#0a84ff','#32d74b','#bf5af2','#ff9f0a','#ff453a','#5e5ce6','#ff6b35','#30d158'];
const TEXT_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12]);

// -- Accounts (still JSON  tokens should not go in DB) ----------------
function readAccounts(): { token: string }[] {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'))?.accounts ?? [];
  } catch { return []; }
}

function writeAccounts(accounts: { token: string }[]): void {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({ accounts }, null, 2));
}

// -- Targets via ScyllaDB ----------------------------------------------
export interface ScrapeTarget {
  guildId: string; channelId: string; label?: string; accountId?: string; accountIdx?: number; pinnedAccountId?: string; pinnedAccountIdx?: number;
}

interface AccountTargetMirrorRow {
  accountId: string;
  channelId: string;
  guildId: string;
  label?: string;
  accountIdx?: number;
  activeAccountId?: string;
  activeAccountIdx?: number;
  pinnedAccountId?: string;
  pinnedAccountIdx?: number;
  createdAt?: string | null;
}

function resolveOwnerAccountId(target: Pick<ScrapeTarget, 'accountId' | 'pinnedAccountId'>): string | undefined {
  return target.pinnedAccountId ?? target.accountId;
}

function resolveOwnerAccountIdx(target: Pick<ScrapeTarget, 'accountIdx' | 'pinnedAccountIdx'>): number | undefined {
  return target.pinnedAccountIdx ?? target.accountIdx;
}

async function readTargets(db: CassandraClient): Promise<ScrapeTarget[]> {
  const result = await db.execute(`SELECT * FROM ${KEYSPACE}.scrape_targets`);
  return result.rows.map(row => ({
    channelId:         row['channel_id'],
    guildId:           row['guild_id']   ?? '',
    label:             row['label']      ?? undefined,
    accountId:         row['account_id'] ?? undefined,
    accountIdx:        row['account_idx'] != null ? Number(row['account_idx']) : undefined,
    pinnedAccountId:   row['pinned_account_id'] ?? undefined,
    pinnedAccountIdx:  row['pinned_account_idx'] != null ? Number(row['pinned_account_idx']) : undefined,
  }));
}

async function addTarget(db: CassandraClient, t: ScrapeTarget): Promise<void> {
  await db.execute(
    `INSERT INTO ${KEYSPACE}.scrape_targets (channel_id, guild_id, label, account_id, account_idx, pinned_account_id, pinned_account_idx, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    [t.channelId, t.guildId, t.label ?? '', t.accountId ?? null, t.accountIdx ?? null, t.pinnedAccountId ?? null, t.pinnedAccountIdx ?? null, new Date()],
    { prepare: true },
  );
}

async function upsertAccountTargetMirror(db: CassandraClient, target: ScrapeTarget, opts?: { ownerAccountId?: string; ownerAccountIdx?: number; activeAccountId?: string | null; activeAccountIdx?: number | null; previousOwnerAccountId?: string }): Promise<void> {
  const ownerAccountId = opts?.ownerAccountId ?? resolveOwnerAccountId(target);
  if (!ownerAccountId) return;
  const ownerAccountIdx = opts?.ownerAccountIdx ?? resolveOwnerAccountIdx(target);
  const hasActiveAccountIdOverride = opts != null && Object.prototype.hasOwnProperty.call(opts, 'activeAccountId');
  const hasActiveAccountIdxOverride = opts != null && Object.prototype.hasOwnProperty.call(opts, 'activeAccountIdx');
  const activeAccountId = hasActiveAccountIdOverride ? (opts?.activeAccountId ?? null) : (target.accountId ?? ownerAccountId);
  const activeAccountIdx = hasActiveAccountIdxOverride ? (opts?.activeAccountIdx ?? null) : (target.accountIdx ?? ownerAccountIdx);
  const previousOwnerAccountId = opts?.previousOwnerAccountId;
  if (previousOwnerAccountId && previousOwnerAccountId !== ownerAccountId) {
    await db.execute(
      `DELETE FROM ${KEYSPACE}.account_targets_by_account WHERE account_id = ? AND channel_id = ?`,
      [previousOwnerAccountId, target.channelId],
    ).catch(() => {});
  }
  await db.execute(
    `INSERT INTO ${KEYSPACE}.account_targets_by_account (account_id, channel_id, guild_id, label, account_idx, active_account_id, active_account_idx, pinned_account_id, pinned_account_idx, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [ownerAccountId, target.channelId, target.guildId, target.label ?? '', ownerAccountIdx ?? null, activeAccountId ?? null, activeAccountIdx ?? null, target.pinnedAccountId ?? null, target.pinnedAccountIdx ?? null, new Date()],
    { prepare: true },
  );
}

async function deleteAccountTargetMirror(db: CassandraClient, target: ScrapeTarget): Promise<void> {
  const ownerAccountId = resolveOwnerAccountId(target);
  if (!ownerAccountId) return;
  await db.execute(
    `DELETE FROM ${KEYSPACE}.account_targets_by_account WHERE account_id = ? AND channel_id = ?`,
    [ownerAccountId, target.channelId],
  );
}

async function readAccountTargetMirrors(db: CassandraClient, accountId?: string): Promise<AccountTargetMirrorRow[]> {
  const result = accountId
    ? await db.execute(`SELECT * FROM ${KEYSPACE}.account_targets_by_account WHERE account_id = ?`, [accountId]).catch(() => null)
    : await db.execute(`SELECT * FROM ${KEYSPACE}.account_targets_by_account`).catch(() => null);
  if (!result) return [];
  return result.rows.map(row => ({
    accountId:        (row['account_id'] as string) ?? '',
    channelId:        (row['channel_id'] as string) ?? '',
    guildId:          (row['guild_id'] as string) ?? '',
    label:            (row['label'] as string) ?? undefined,
    accountIdx:       row['account_idx'] != null ? Number(row['account_idx']) : undefined,
    activeAccountId:  (row['active_account_id'] as string) ?? undefined,
    activeAccountIdx: row['active_account_idx'] != null ? Number(row['active_account_idx']) : undefined,
    pinnedAccountId:  (row['pinned_account_id'] as string) ?? undefined,
    pinnedAccountIdx: row['pinned_account_idx'] != null ? Number(row['pinned_account_idx']) : undefined,
    createdAt:        row['created_at']?.toISOString?.() ?? null,
  }));
}

async function readNamesByIds(db: CassandraClient, ids: string[]): Promise<Record<string, string>> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  const out: Record<string, string> = {};
  await Promise.all(uniqueIds.map(async id => {
    const result = await db.execute(`SELECT name FROM ${KEYSPACE}.name_cache WHERE id = ?`, [id]).catch(() => null);
    const name = (result?.rows[0]?.['name'] as string) ?? '';
    if (name) out[id] = name;
  }));
  return out;
}

async function deleteTarget(db: CassandraClient, channelId: string): Promise<void> {
  await db.execute(`DELETE FROM ${KEYSPACE}.scrape_targets WHERE channel_id = ?`, [channelId]);
}

// -- Name cache via ScyllaDB -------------------------------------------
async function readNames(db: CassandraClient): Promise<Record<string, string>> {
  const result = await db.execute(`SELECT id, name FROM ${KEYSPACE}.name_cache`);
  const out: Record<string, string> = {};
  result.rows.forEach(row => { out[row['id']] = row['name']; });
  return out;
}

async function saveNames(db: CassandraClient, names: Record<string, string>): Promise<void> {
  await Promise.all(
    Object.entries(names).map(([id, name]) =>
      db.execute(
        `INSERT INTO ${KEYSPACE}.name_cache (id, name, kind) VALUES (?,?,?)`,
        [id, name, id.length > 18 ? 'channel' : 'guild'],
      )
    )
  );
}

// -- Discord API -------------------------------------------------------
function maskToken(token: string): string {
  if (token.length < 20) return '';
  return token.slice(0, 10) + '' + token.slice(-4);
}

function discordGet(endpoint: string, token: string): Promise<unknown> {
  return discordApiGet(endpoint, { token });
}

interface DiscordUser  { id: string; username: string; discriminator: string; global_name?: string; avatar?: string; }
interface DiscordGuild { id: string; name: string; icon: string | null; }
interface DiscordChannelInfo { id?: string; guild_id?: string; name?: string; type?: number; message?: string; }

const _cache: Record<string, { ts: number; user?: DiscordUser; guilds?: DiscordGuild[]; error?: string }> = {};
const TTL = 15_000;

// Persistent mapping: token key (last 16 chars) → Discord account info.
// Populated when tokens are valid; used to identify accounts when tokens become invalid.
const _knownAccounts: Record<string, { accountId: string; username: string }> = {};
let _knownAccountsLoaded = false;

async function ensureKnownAccountsLoaded(db: CassandraClient): Promise<void> {
  if (_knownAccountsLoaded) return;
  _knownAccountsLoaded = true;
  try {
    const mapRows = await db.execute(`SELECT token_key, account_id, username FROM ${KEYSPACE}.token_account_map`);
    for (const r of mapRows.rows) {
      const tk = r['token_key'] as string;
      if (tk) _knownAccounts[tk] = { accountId: r['account_id'] as string, username: (r['username'] as string) ?? '' };
    }
  } catch { /* table may not exist yet */ }
}

function findAccountIdxById(accounts: { token: string }[], accountId: string): number {
  for (let i = 0; i < accounts.length; i++) {
    const known = _knownAccounts[accounts[i].token.slice(-16)];
    if (known?.accountId === accountId) return i;
  }
  return -1;
}

async function resolveGuildEligibleAccounts(db: CassandraClient, guildId: string): Promise<Array<{ accountId: string; idx: number; username: string }>> {
  await ensureKnownAccountsLoaded(db);
  const accounts = readAccounts();
  const [guildRows, infoRows] = await Promise.all([
    db.execute(`SELECT account_id FROM ${KEYSPACE}.guild_accounts WHERE guild_id = ?`, [guildId]).catch(() => null),
    db.execute(`SELECT account_id, username FROM ${KEYSPACE}.account_info`).catch(() => null),
  ]);
  const usernameById = new Map<string, string>();
  for (const row of infoRows?.rows ?? []) usernameById.set((row['account_id'] as string) ?? '', (row['username'] as string) ?? '');
  const eligibleIds = new Set<string>((guildRows?.rows ?? []).map(r => (r['account_id'] as string) ?? '').filter(Boolean));
  let resolved = accounts
    .map((acc, idx) => {
      const accountId = _knownAccounts[acc.token.slice(-16)]?.accountId;
      if (!accountId || !eligibleIds.has(accountId)) return null;
      return { accountId, idx, username: usernameById.get(accountId) ?? '' };
    })
    .filter((row): row is { accountId: string; idx: number; username: string } => row != null);

  if (resolved.length > 0) return resolved;

  const liveResolved = await Promise.all(accounts.map(async (acc, idx) => {
    try {
      const guilds = await discordGet('/users/@me/guilds', acc.token) as Array<{ id: string }>;
      if (!Array.isArray(guilds) || !guilds.some(g => g.id === guildId)) return null;
      let accountId = _knownAccounts[acc.token.slice(-16)]?.accountId;
      let username = _knownAccounts[acc.token.slice(-16)]?.username ?? '';
      if (!accountId) {
        const me = await discordGet('/users/@me', acc.token) as { id?: string; username?: string };
        if (!me?.id) return null;
        accountId = me.id;
        username = me.username ?? '';
        _knownAccounts[acc.token.slice(-16)] = { accountId, username };
        await db.execute(
          `INSERT INTO ${KEYSPACE}.token_account_map (token_key, account_id, username, updated_at) VALUES (?,?,?,?)`,
          [acc.token.slice(-16), accountId, username, new Date()],
        ).catch(() => {});
      }
      return { accountId, idx, username: username || usernameById.get(accountId) || '' };
    } catch {
      return null;
    }
  }));
  resolved = liveResolved.filter((row): row is { accountId: string; idx: number; username: string } => row != null);
  return resolved;
}

async function validateChannelViaAccounts(guildId: string, channelId: string): Promise<{ ok: true; guildId: string; channelName?: string } | { ok: false; error: string }> {
  const accounts = readAccounts();
  if (!accounts.length) return { ok: false, error: 'Hesap yok' };
  for (const acc of accounts) {
    try {
      const channel = await discordGet(`/channels/${channelId}`, acc.token) as DiscordChannelInfo;
      if (!channel?.id) continue;
      if (channel.guild_id !== guildId) return { ok: false, error: 'Kanal secilen sunucuya ait degil' };
      if (channel.type == null || !TEXT_CHANNEL_TYPES.has(channel.type)) return { ok: false, error: 'Yalnizca metin kanallari kabul edilir' };
      return { ok: true, guildId: channel.guild_id, channelName: channel.name ?? undefined };
    } catch { /* try next account */ }
  }
  return { ok: false, error: 'Kanal dorulanamadi; hicbir hesap erisemedi' };
}

async function getActiveAccountToken(db: CassandraClient, accountId: string): Promise<{ token: string; idx: number; username: string } | null> {
  await ensureKnownAccountsLoaded(db);
  const accounts = readAccounts();
  const directIdx = findAccountIdxById(accounts, accountId);
  if (directIdx >= 0 && accounts[directIdx]?.token) {
    return {
      token: accounts[directIdx].token,
      idx: directIdx,
      username: _knownAccounts[accounts[directIdx].token.slice(-16)]?.username ?? '',
    };
  }

  for (let idx = 0; idx < accounts.length; idx++) {
    const token = accounts[idx]?.token;
    if (!token) continue;
    try {
      const me = await discordGet('/users/@me', token) as { id?: string; username?: string };
      if (!me?.id) continue;
      const username = me.username ?? '';
      _knownAccounts[token.slice(-16)] = { accountId: me.id, username };
      await db.execute(
        `INSERT INTO ${KEYSPACE}.token_account_map (token_key, account_id, username, updated_at) VALUES (?,?,?,?)`,
        [token.slice(-16), me.id, username, new Date()],
      ).catch(() => {});
      if (me.id === accountId) return { token, idx, username };
    } catch {
      continue;
    }
  }

  return null;
}

async function verifyGuildMembershipForAccount(token: string, guildId: string): Promise<boolean> {
  try {
    const guild = await discordGet(`/guilds/${guildId}`, token) as { id?: string };
    return !!guild?.id;
  } catch {
    return false;
  }
}

async function validateChannelsForAccount(token: string, guildId: string, channelIds: string[]): Promise<{ ok: true; channels: Array<{ id: string; name: string }> } | { ok: false; error: string }> {
  const validated: Array<{ id: string; name: string }> = [];
  for (const channelId of channelIds) {
    let channel: DiscordChannelInfo;
    try {
      channel = await discordGet(`/channels/${channelId}`, token) as DiscordChannelInfo;
    } catch {
      return { ok: false, error: `${channelId} — kanal bulunamadi veya hesap bu kanala erisemiyor` };
    }
    if (!channel?.id) return { ok: false, error: `${channelId} — kanal bulunamadi` };
    if (channel.guild_id !== guildId) {
      return { ok: false, error: `${channelId} — bu kanal secilen sunucuya ait degil` };
    }
    if (channel.type == null || !TEXT_CHANNEL_TYPES.has(channel.type)) {
      return { ok: false, error: `${channelId} — yalnizca metin kanallari kabul edilir` };
    }
    validated.push({ id: channel.id, name: channel.name ?? '' });
  }
  return { ok: true, channels: validated };
}

async function getAccountInfo(idx: number, assignedTargets: ScrapeTarget[], db?: CassandraClient): Promise<{ 
  idx: number;
  tokenKey: string;
  tokenMasked: string;
 color: string; user?: DiscordUser; guilds?: DiscordGuild[]; error?: string; targets: ScrapeTarget[]; accountId?: string }> {
  const token = readAccounts()[idx]?.token ?? '';
  const key = token.slice(-16);
  const now = Date.now();
  const hit = _cache[key];
  let user: DiscordUser | undefined;
  let guilds: DiscordGuild[] = [];
  let error: string | undefined;

  if (hit && now - hit.ts < TTL) {
    user = hit.user; guilds = hit.guilds ?? []; error = hit.error;
  } else {
    try {
      const [uRes, gRes] = await Promise.allSettled([
        discordGet('/users/@me', token),
        discordGet('/users/@me/guilds', token),
      ]);
      if (uRes.status === 'fulfilled') {
        const u = uRes.value as DiscordUser & { message?: string };
        if (u.id) user = u; else error = u.message ?? 'Geersiz token';
      }
      if (gRes.status === 'fulfilled' && Array.isArray(gRes.value)) {
        guilds = (gRes.value as DiscordGuild[])
          .map(g => ({ id: g.id, name: g.name, icon: g.icon }))
          .sort((a, b) => a.name.localeCompare(b.name));
      }
      _cache[key] = { ts: now, user, guilds, error };
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : 'Baglanti hatasi';
      _cache[key] = { ts: now, error };
    }
  }

  // Persist token→account mapping when token is valid
  if (user?.id) {
    _knownAccounts[key] = { accountId: user.id, username: user.username ?? '' };
    if (db) {
      db.execute(
        `INSERT INTO ${KEYSPACE}.token_account_map (token_key, account_id, username, updated_at) VALUES (?,?,?,?)`,
        [key, user.id, user.username ?? '', new Date()],
      ).catch(() => {});
    }
  }

  const resolvedAccountId = user?.id ?? _knownAccounts[key]?.accountId;
  return { idx, tokenKey: key, tokenMasked: maskToken(token), color: ACC_COLORS[idx % ACC_COLORS.length], user, guilds, error, targets: assignedTargets, accountId: resolvedAccountId };
}

async function syncFailedAccounts(
  db: CassandraClient,
  infos: Array<{ tokenKey: string; tokenMasked: string; error?: string; user?: DiscordUser }>,
): Promise<void> {
  if (infos.length === 0) return;
  const existingResult = await db.execute(
    `SELECT account_id FROM ${KEYSPACE}.failed_accounts`,
  ).catch(() => null);
  const existingFailed = new Set<string>(
    (existingResult?.rows ?? [])
      .map(row => (row['account_id'] as string) ?? '')
      .filter(Boolean),
  );

  await Promise.all(infos.map(async info => {
    if (info.error && !info.user) {
      const known = _knownAccounts[info.tokenKey];
      if (!known?.accountId || existingFailed.has(known.accountId)) return;
      existingFailed.add(known.accountId);
      await db.execute(
        `INSERT INTO ${KEYSPACE}.failed_accounts (account_id, username, token_hint, reason, error_msg, detected_at) VALUES (?,?,?,?,?,?)`,
        [known.accountId, known.username, info.tokenMasked, 'token_invalid', info.error, new Date()],
      ).catch(() => {});
      console.log(`[accounts] Auto-detected failed account: ${known.username} (${known.accountId}) — ${info.error}`);
      return;
    }
    if (info.user?.id) {
      existingFailed.delete(info.user.id);
      await db.execute(`DELETE FROM ${KEYSPACE}.failed_accounts WHERE account_id = ?`, [info.user.id]).catch(() => {});
    }
  }));
}

function distribute(targets: ScrapeTarget[], n: number): Map<number, ScrapeTarget[]> {
  const map = new Map<number, ScrapeTarget[]>();
  for (let i = 0; i < n; i++) map.set(i, []);
  targets.forEach((t, i) => map.get(i % n)!.push(t));
  return map;
}

// -- Router factory ----------------------------------------------------
export function accountsRouter(db: CassandraClient): Router {
  const router = Router();

  function requestedBy(req: Request): string {
    const user = (req as Request & { user?: { username?: string; displayName?: string } }).user;
    return user?.username ?? user?.displayName ?? 'system';
  }

  async function writeScrapeControlAudit(
    scope: 'account' | 'channel',
    entityId: string,
    action: 'pause' | 'resume',
    requestedByValue: string,
    reason: string | null,
    requestId: string,
    result: string,
  ): Promise<void> {
    await db.execute(
      `INSERT INTO ${KEYSPACE}.scrape_control_audit (scope, entity_id, created_at, request_id, action, requested_by, reason, result) VALUES (?,?,?,?,?,?,?,?)`,
      [scope, entityId, new Date(), requestId, action, requestedByValue, reason ?? null, result],
      { prepare: true },
    ).catch(() => {});
  }

  async function hasKnownAccount(accountId: string): Promise<boolean> {
    const [infoResult, failedResult, targetResult, pauseResult] = await Promise.all([
      db.execute(`SELECT account_id FROM ${KEYSPACE}.account_info WHERE account_id = ?`, [accountId], { prepare: true }).catch(() => null),
      db.execute(`SELECT account_id FROM ${KEYSPACE}.failed_accounts WHERE account_id = ?`, [accountId], { prepare: true }).catch(() => null),
      db.execute(`SELECT account_id FROM ${KEYSPACE}.account_targets_by_account WHERE account_id = ? LIMIT 1`, [accountId], { prepare: true }).catch(() => null),
      db.execute(`SELECT account_id FROM ${KEYSPACE}.scrape_paused_accounts WHERE account_id = ?`, [accountId], { prepare: true }).catch(() => null),
    ]);
    return (infoResult?.rowLength ?? 0) > 0 || (failedResult?.rowLength ?? 0) > 0 || (targetResult?.rowLength ?? 0) > 0 || (pauseResult?.rowLength ?? 0) > 0;
  }

  function decorateTargetRuntimeState(target: ScrapeTarget, runtime: RuntimeStateRow | undefined, pauseIntent: ReturnType<typeof buildPauseIntentView>): Record<string, unknown> {
    return {
      schedulerState: runtime?.schedulerState ?? null,
      pauseSource: runtime?.pauseSource ?? 'none',
      stateUpdatedAt: runtime?.stateUpdatedAt ?? null,
      stateReason: runtime?.stateReason ?? null,
      workerId: runtime?.workerId ?? null,
      leaseExpiresAt: runtime?.leaseExpiresAt ?? null,
      lastErrorClass: runtime?.lastErrorClass ?? null,
      lastErrorCode: runtime?.lastErrorCode ?? null,
      lastErrorAt: runtime?.lastErrorAt ?? null,
      pauseRequested: pauseIntent.pauseRequested,
      accountPauseRequested: pauseIntent.accountPauseRequested,
      channelPauseRequested: pauseIntent.channelPauseRequested,
      requestedPauseSource: pauseIntent.requestedPauseSource,
      pauseReason: pauseIntent.pauseReason,
      pauseRequestedBy: pauseIntent.pauseRequestedBy,
      pauseRequestedAt: pauseIntent.pauseRequestedAt,
      pauseRequestId: pauseIntent.pauseRequestId,
      pauseAcknowledged: isPauseAcknowledged(runtime?.schedulerState, runtime?.schedulerState === 'completed', pauseIntent.pauseRequested),
      ownerAccountId: resolveOwnerAccountId(target) ?? null,
      ownerAccountIdx: resolveOwnerAccountIdx(target) ?? null,
    };
  }

  async function buildAccountPauseSnapshot(accountId: string): Promise<Record<string, unknown>> {
    const [pausedAccounts, targets, runtimeStates] = await Promise.all([
      readPausedAccounts(db),
      readTargets(db),
      readAllRuntimeStates(db),
    ]);
    const ownedTargets = targets.filter(target => resolveOwnerAccountId(target) === accountId);
    const runtimeStateCounts: RuntimeStateCounts = emptyRuntimeStateCounts();
    for (const target of ownedTargets) {
      addRuntimeStateCount(runtimeStateCounts, runtimeStates.get(target.channelId)?.schedulerState);
    }
    const pauseRow = pausedAccounts.get(accountId);
    const targetCount = ownedTargets.length;
    const accountedTargets = countedRuntimeTotal(runtimeStateCounts);
    return {
      accountId,
      paused: !!pauseRow,
      pauseReason: pauseRow?.reason ?? null,
      pauseRequestedBy: pauseRow?.requestedBy ?? null,
      pauseRequestedAt: pauseRow?.requestedAt ?? null,
      pauseRequestId: pauseRow?.requestId ?? null,
      pauseAcknowledged: !!pauseRow && (targetCount === 0 || (runtimeStateCounts.running === 0 && runtimeStateCounts.queued === 0 && accountedTargets >= targetCount)),
      targetCount,
      runtimeStateCounts,
      runningTargetCount: runtimeStateCounts.running,
      queuedTargetCount: runtimeStateCounts.queued,
      pausedTargetCount: runtimeStateCounts.paused,
    };
  }

  async function buildChannelPauseSnapshot(target: ScrapeTarget): Promise<Record<string, unknown>> {
    const ownerAccountId = resolveOwnerAccountId(target);
    const [pausedAccounts, pausedChannels, runtimeStates] = await Promise.all([
      readPausedAccounts(db),
      readPausedChannels(db),
      readRuntimeStatesByChannelIds(db, [target.channelId]),
    ]);
    const runtime = runtimeStates.get(target.channelId);
    const pauseIntent = buildPauseIntentView(ownerAccountId, target.channelId, pausedAccounts, pausedChannels);
    return {
      channelId: target.channelId,
      guildId: target.guildId,
      label: target.label ?? null,
      accountId: target.accountId ?? null,
      accountIdx: target.accountIdx ?? null,
      ...decorateTargetRuntimeState(target, runtime, pauseIntent),
    };
  }

  router.get('/', async (_req: Request, res: Response) => {
    const accounts = readAccounts();
    const targets  = await readTargets(db);
    const names    = await readNames(db);
    const n        = Math.max(accounts.length, 1);

    // Hesap basina kanal listesi  DB'deki gerek atamaya gre
    const assignedByIdx = new Map<number, ScrapeTarget[]>();
    const assignedByAccountId = new Map<string, ScrapeTarget[]>();
    for (let i = 0; i < n; i++) assignedByIdx.set(i, []);
    targets.forEach((t, i) => {
      const ownerAccountId = resolveOwnerAccountId(t);
      if (ownerAccountId) {
        const byId = assignedByAccountId.get(ownerAccountId) ?? [];
        byId.push(t);
        assignedByAccountId.set(ownerAccountId, byId);
      }
      const idx = resolveOwnerAccountIdx(t) ?? (i % n);
      assignedByIdx.get(idx % n)?.push(t);
    });

    // Load known accounts from Scylla on first call (survives API restarts)
    await ensureKnownAccountsLoaded(db);

    const infos = (await Promise.all(
      accounts.map((_a, i) => getAccountInfo(i, [], db))
    )).map(info => {
      const byId = info.accountId ? (assignedByAccountId.get(info.accountId) ?? []) : [];
      const byIdx = assignedByIdx.get(info.idx) ?? [];
      const seen = new Set<string>();
      const mergedTargets = [...byId, ...byIdx].filter(t => {
        if (seen.has(t.channelId)) return false;
        seen.add(t.channelId);
        return true;
      });
      return { ...info, targets: mergedTargets };
    });

    await syncFailedAccounts(db, infos);

    const enriched = targets.map(t => ({ ...t, channelName: t.label || names[t.channelId] || null }));
    infos.forEach(info => {
      info.targets = info.targets.map(t => ({ ...t, channelName: t.label || names[t.channelId] || null }));
    });

    return res.json({
      accounts: infos, targets: enriched,
      totalAccounts: accounts.length,
      totalTargets:  targets.length,
      totalGuilds:   new Set(targets.map(t => t.guildId)).size,
    });
  });

  router.post('/', async (req: Request, res: Response) => {
    const { token, email, accountPassword, mailPassword, mailSite } = req.body as Record<string, string | undefined>;
    if (!token?.trim()) return res.status(400).json({ error: 'Token bos olamaz' });
    const trimmed = token.trim().replace(/^["']+|["']+$/g, '').trim();
    const accounts = readAccounts();
    if (accounts.some(a => a.token === trimmed)) return res.status(409).json({ error: 'Bu token zaten ekli' });

    // Validate token BEFORE saving to accounts.json
    let userInfo: any;
    try {
      userInfo = await discordGet('/users/@me', trimmed) as any;
    } catch { userInfo = null; }
    if (!userInfo?.id) {
      return res.status(400).json({ error: 'Geçersiz token — Discord doğrulaması başarısız' });
    }

    accounts.push({ token: trimmed });
    writeAccounts(accounts);
    delete _cache[trimmed.slice(-16)];
    const newAccountIdx = accounts.findIndex(a => a.token === trimmed);

    // Check if this token belongs to a previously archived account → auto-restore
    let restored: { accountId: string; username: string; guildsRestored: number; channelsRestored: number } | null = null;
    try {
      if (userInfo?.id) {
        const accountId = userInfo.id as string;
        const username = (userInfo.username as string) ?? '';
        const now = new Date();

        // Always save/update account_info (ensures account appears in guild inventory)
        await db.execute(
          `INSERT INTO ${KEYSPACE}.account_info (account_id, discord_id, username, avatar, last_fetched, email, account_password, mail_password, mail_site) VALUES (?,?,?,?,?,?,?,?,?)`,
          [accountId, accountId, username, userInfo.avatar ?? '', now,
           email ?? null, accountPassword ?? null, mailPassword ?? null, mailSite ?? null],
        ).catch((err: unknown) => {
          console.error('[accounts-api] account_info upsert failed:', err);
        });

        // Save token → account mapping (needed for task verification via getTokenForAccount)
        await db.execute(
          `INSERT INTO ${KEYSPACE}.token_account_map (token_key, account_id, username, updated_at) VALUES (?,?,?,?)`,
          [trimmed.slice(-16), accountId, username, now],
        ).catch(() => {});

        // Ensure category exists for this account (guild inventory needs it for HESAPLAR list)
        const catsResult = await db.execute(`SELECT category_id, name FROM ${KEYSPACE}.join_categories`, []).catch(() => null);
        let hasCat = false;
        if (catsResult) {
          for (const r of catsResult.rows) {
            if (((r['name'] as string) ?? '').includes(accountId)) { hasCat = true; break; }
          }
        }
        if (!hasCat) {
          const catId = `acc_${accountId}_` + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
          await db.execute(
            `INSERT INTO ${KEYSPACE}.join_categories (category_id, name, description, guild_count, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
            [catId, `${username} - ${accountId}`, 'Otomatik', 0, now, now],
          ).catch(() => {});
        }
        // Sync categories + assign any existing invite_pool guilds to this account
        autoCategorize(db).catch(() => {});

        // Check archived data — header OR guilds (header may be missing due to partial archive)
        const archiveResult = await db.execute(
          `SELECT account_id, transferred_to FROM ${KEYSPACE}.archived_accounts WHERE account_id = ?`, [accountId],
        );
        const archiveGuildsCheck = await db.execute(
          `SELECT guild_id FROM ${KEYSPACE}.archived_account_guilds WHERE account_id = ? LIMIT 1`, [accountId],
        ).catch(() => null);
        const archiveRow = archiveResult.rowLength > 0 ? archiveResult.rows[0] : null;
        const transferredTo = (archiveRow?.['transferred_to'] as string) ?? null;
        const hasArchiveData = archiveRow ? (!transferredTo || transferredTo === accountId) : (archiveGuildsCheck && archiveGuildsCheck.rowLength > 0);

        if (hasArchiveData) {
          // Found archived account → restore (same account: preserve membership status)

          // Restore scrape_targets from archived channels
          const channelsResult = await db.execute(
            `SELECT * FROM ${KEYSPACE}.archived_account_channels WHERE account_id = ?`, [accountId],
          );
          let channelsRestored = 0;
          for (const row of channelsResult.rows) {
            const channelId = row['channel_id'] as string;
            const guildId = (row['guild_id'] as string) ?? '';
            const complete = row['complete'] ?? false;
            if (!complete) {
              // Only restore if not already a target
              const existingTarget = await db.execute(
                `SELECT channel_id FROM ${KEYSPACE}.scrape_targets WHERE channel_id = ?`, [channelId],
              ).catch(() => null);
              if (!existingTarget || existingTarget.rowLength === 0) {
                const archivedChannelName = (row['channel_name'] as string) ?? '';
                await db.execute(
                  `INSERT INTO ${KEYSPACE}.scrape_targets (channel_id, guild_id, account_id, account_idx, pinned_account_id, pinned_account_idx, created_at) VALUES (?,?,?,?,?,?,?)`,
                  [channelId, guildId, accountId, newAccountIdx >= 0 ? newAccountIdx : null, accountId, newAccountIdx >= 0 ? newAccountIdx : null, now],
                  { prepare: true },
                ).catch(() => {});
                await db.execute(
                  `INSERT INTO ${KEYSPACE}.account_targets_by_account (account_id, channel_id, guild_id, label, account_idx, active_account_id, active_account_idx, pinned_account_id, pinned_account_idx, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
                  [accountId, channelId, guildId, archivedChannelName, newAccountIdx >= 0 ? newAccountIdx : null, accountId, newAccountIdx >= 0 ? newAccountIdx : null, accountId, newAccountIdx >= 0 ? newAccountIdx : null, now],
                  { prepare: true },
                ).catch(() => {});
                if (archivedChannelName) {
                  await db.execute(
                    `INSERT INTO ${KEYSPACE}.name_cache (id, name, kind) VALUES (?,?,?)`,
                    [channelId, archivedChannelName, 'channel'],
                  ).catch(() => {});
                }
                channelsRestored++;
              }
            }
          }

          // Restore guilds → invite_pool (same account = preserve membership status)
          const guildsResult = await db.execute(
            `SELECT * FROM ${KEYSPACE}.archived_account_guilds WHERE account_id = ?`, [accountId],
          );

          // Build guild_id → invite_code map from current pool (one scan, avoids duplicates)
          const poolScan = await db.execute(`SELECT invite_code, guild_id FROM ${KEYSPACE}.invite_pool`);
          const guildToPoolCode = new Map<string, string>();
          for (const prow of poolScan.rows) {
            const gid = prow['guild_id'] as string;
            if (gid) guildToPoolCode.set(gid, prow['invite_code'] as string);
          }

          let guildsRestored = 0;
          for (const row of guildsResult.rows) {
            const guildId = row['guild_id'] as string;
            if (!guildId) continue;
            const guildName = (row['guild_name'] as string) ?? '';
            const guildIcon = (row['guild_icon'] as string) ?? '';
            const membership = (row['membership'] as string) ?? '';

            // Same account restored: member guilds → already_in, to_join stays to_join
            const status = (membership === 'member') ? 'already_in' : 'to_join';
            const ownerField = status === 'already_in' ? accountId : null;
            const ownerName = status === 'already_in' ? username : null;
            const assignedField = status === 'to_join' ? accountId : null;
            const assignedName = status === 'to_join' ? username : null;

            // Check if this guild already has an entry in invite_pool (by guild_id, not just invite_code)
            const existingCode = guildToPoolCode.get(guildId);

            if (existingCode) {
              // Guild already in pool (possibly reassigned to another account) — update it back
              await db.execute(
                `UPDATE ${KEYSPACE}.invite_pool SET status = ?, owner_account_id = ?, owner_account_name = ?, assigned_account_id = ?, assigned_account_name = ?, checked_at = ? WHERE invite_code = ?`,
                [status, ownerField, ownerName, assignedField, assignedName, now, existingCode],
              );
            } else {
              // Guild not in pool — insert new entry
              let inviteCode = (row['invite_code'] as string) ?? '';
              if (!inviteCode) inviteCode = `existing_${guildId}`;
              await db.execute(
                `INSERT INTO ${KEYSPACE}.invite_pool (invite_code, guild_id, guild_name, guild_icon, status, owner_account_id, owner_account_name, assigned_account_id, assigned_account_name, created_at, checked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                [inviteCode, guildId, guildName, guildIcon, status, ownerField, ownerName, assignedField, assignedName, now, now],
              );
              guildToPoolCode.set(guildId, inviteCode);
            }
            guildsRestored++;
          }

          // Mark archived account as restored to self
          await db.execute(
            `UPDATE ${KEYSPACE}.archived_accounts SET transferred_to = ?, transferred_at = ? WHERE account_id = ?`,
            [accountId, now, accountId],
          );

          restored = { accountId, username, guildsRestored, channelsRestored };
          console.log(`[accounts] Auto-restored archived account ${username} (${accountId}): ${guildsRestored} guilds, ${channelsRestored} channels`);
        }

        // After any token add (archived or not): fix orphaned invite_pool entries
        // 1. already_in with null owner → set owner to this account
        // 2. to_join in this account's category but assigned to another account → reassign back
        try {
          const allPool = await db.execute(`SELECT invite_code, guild_id, status, owner_account_id, assigned_account_id FROM ${KEYSPACE}.invite_pool`);
          // Get this account's guild memberships from account_guilds (if guild-sync ran)
          // + from category_guilds (always available since categories are preserved)
          const myGuildIds = new Set<string>();
          const catRows = await db.execute(`SELECT category_id, name FROM ${KEYSPACE}.join_categories`).catch(() => null);
          let myCatId: string | null = null;
          if (catRows) {
            for (const cr of catRows.rows) {
              if (((cr['name'] as string) ?? '').includes(accountId)) { myCatId = cr['category_id'] as string; break; }
            }
          }
          if (myCatId) {
            const cgRows = await db.execute(`SELECT guild_id FROM ${KEYSPACE}.category_guilds WHERE category_id = ?`, [myCatId]);
            for (const cg of cgRows.rows) myGuildIds.add(cg['guild_id'] as string);
          }

          for (const row of allPool.rows) {
            const code = row['invite_code'] as string;
            const gid = row['guild_id'] as string;
            const st = (row['status'] as string) ?? '';
            const ownerId = (row['owner_account_id'] as string) ?? '';
            const assignedId = (row['assigned_account_id'] as string) ?? '';

            if (!myGuildIds.has(gid)) continue;

            // Fix 1: already_in with null owner that belongs to this account's category
            if (st === 'already_in' && !ownerId) {
              await db.execute(
                `UPDATE ${KEYSPACE}.invite_pool SET owner_account_id = ?, owner_account_name = ? WHERE invite_code = ?`,
                [accountId, username, code],
              );
            }
            // Fix 2: to_join assigned to a DIFFERENT account but in THIS account's category
            //         (happens when delete reassigned entries, then account was restored)
            if (st === 'to_join' && assignedId && assignedId !== accountId) {
              await db.execute(
                `UPDATE ${KEYSPACE}.invite_pool SET assigned_account_id = ?, assigned_account_name = ? WHERE invite_code = ?`,
                [accountId, username, code],
              );
              console.log(`[accounts] Fixed orphan to_join: ${gid} reassigned from ${assignedId} → ${accountId}`);
            }
          }
        } catch { /* non-fatal */ }
      }
    } catch (err) {
      console.warn('[accounts] Archive auto-restore check failed (non-fatal):', err);
    }

    return res.json({ ok: true, total: accounts.length, restored });
  });

  router.get('/guild/:guildId/info', async (req: Request, res: Response) => {
    const { guildId } = req.params;
    const accounts = readAccounts();
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId.trim() : '';
    const hasLegacyIdx = req.query.accIdx != null;
    const fallbackIdx = parseInt(req.query.accIdx as string ?? '0', 10);
    let accIdx = Number.isNaN(fallbackIdx) ? 0 : fallbackIdx;
    if (accountId) {
      await ensureKnownAccountsLoaded(db);
      const resolvedIdx = findAccountIdxById(accounts, accountId);
      if (resolvedIdx >= 0) accIdx = resolvedIdx;
      else if (!hasLegacyIdx) return res.status(404).json({ error: 'Hesap bulunamadi' });
    }
    const token = accounts[accIdx]?.token;
    if (!token) return res.json(null);
    try {
      const g = await discordApiGet<{ id: string; name: string; icon: string | null }>(`/guilds/${guildId}`, { token, accountIdx: accIdx });
      res.json({ id: g.id, name: g.name, icon: g.icon });
    } catch {
      res.json(null);
    }
  });

  router.delete('/:idx', async (req: Request, res: Response) => {
    const idx = parseInt(req.params.idx, 10);
    const accounts = readAccounts();
    if (isNaN(idx) || idx < 0 || idx >= accounts.length) return res.status(404).json({ error: 'Hesap bulunamadi' });

    const token = accounts[idx].token;
    const tokenKey = token.slice(-16);

    // Resolve Discord account ID before removing token
    let accountId: string | null = null;
    let username = '';

    // Try in-memory mapping first
    const known = _knownAccounts[tokenKey];
    if (known?.accountId) {
      accountId = known.accountId;
      username = known.username;
    } else {
      // Try Discord API
      try {
        const u = await discordGet('/users/@me', token) as any;
        if (u?.id) { accountId = u.id; username = u.username ?? ''; }
      } catch { /* token already invalid */ }
    }

    // Try Scylla mapping as last resort
    if (!accountId) {
      try {
        const r = await db.execute(`SELECT account_id, username FROM ${KEYSPACE}.token_account_map WHERE token_key = ?`, [tokenKey]);
        if (r.rowLength > 0) { accountId = r.rows[0]['account_id'] as string; username = (r.rows[0]['username'] as string) ?? ''; }
      } catch { /* ignore */ }
    }

    // Remove from accounts.json
    accounts.splice(idx, 1);
    writeAccounts(accounts);
    delete _cache[tokenKey];
    delete _knownAccounts[tokenKey];

    // Clean up Scylla data for this account
    if (accountId) {
      console.log(`[accounts] Hesap silindi: ${username} (${accountId}) — auto-archive + Scylla temizleniyor...`);

      // ── AUTO-ARCHIVE: Snapshot guild memberships + channels before cleanup ──
      try {
        // Clear old archive data (re-archive idempotent)
        await Promise.allSettled([
          db.execute(`DELETE FROM ${KEYSPACE}.archived_accounts WHERE account_id = ?`, [accountId]),
          db.execute(`DELETE FROM ${KEYSPACE}.archived_account_guilds WHERE account_id = ?`, [accountId]),
          db.execute(`DELETE FROM ${KEYSPACE}.archived_account_channels WHERE account_id = ?`, [accountId]),
        ]);

        // Snapshot guilds from account_guilds (must run before guild cleanup)
        const agResult = await db.execute(
          `SELECT guild_id, guild_name, guild_icon, guild_owner FROM ${KEYSPACE}.account_guilds WHERE account_id = ?`, [accountId],
        );
        const memberGuildIds = new Set(agResult.rows.map(r => r['guild_id'] as string));

        // Get invite codes + ownership/assignment info from invite_pool
        const poolResult = await db.execute(
          `SELECT invite_code, guild_id, status, owner_account_id, assigned_account_id FROM ${KEYSPACE}.invite_pool`,
        );
        const inviteByGuild = new Map<string, string>();
        const assignedGuilds: Array<{ guildId: string; guildName: string; guildIcon: string; inviteCode: string; membership: string }> = [];
        for (const row of poolResult.rows) {
          const gid = row['guild_id'] as string;
          const code = (row['invite_code'] as string) ?? '';
          if (!gid) continue;
          // Map guild → invite code for member guilds
          if (memberGuildIds.has(gid) && code) inviteByGuild.set(gid, code);
          // Collect to_join guilds assigned to this account (not member)
          const isAssigned = (row['assigned_account_id'] as string) === accountId;
          if (isAssigned && (row['status'] as string) === 'to_join' && !memberGuildIds.has(gid)) {
            assignedGuilds.push({ guildId: gid, guildName: '', guildIcon: '', inviteCode: code, membership: 'to_join' });
          }
        }

        // Write member guilds to archive
        for (const row of agResult.rows) {
          const gid = row['guild_id'] as string;
          await db.execute(
            `INSERT INTO ${KEYSPACE}.archived_account_guilds (account_id, guild_id, guild_name, guild_icon, invite_code, membership) VALUES (?,?,?,?,?,?)`,
            [accountId, gid, row['guild_name'] ?? '', row['guild_icon'] ?? '', inviteByGuild.get(gid) ?? '', 'member'],
          ).catch(() => {});
        }
        // Write assigned (to_join) guilds
        for (const ag of assignedGuilds) {
          await db.execute(
            `INSERT INTO ${KEYSPACE}.archived_account_guilds (account_id, guild_id, guild_name, guild_icon, invite_code, membership) VALUES (?,?,?,?,?,?)`,
            [accountId, ag.guildId, ag.guildName, ag.guildIcon, ag.inviteCode, ag.membership],
          ).catch(() => {});
        }

        // Snapshot scrape targets + checkpoints
        const targetsResult = await db.execute(`SELECT channel_id, guild_id, account_id, pinned_account_id FROM ${KEYSPACE}.scrape_targets`);
        const myTargets = targetsResult.rows.filter(r => ((r['pinned_account_id'] as string) ?? (r['account_id'] as string)) === accountId);
        let totalScrapedAll = 0;

        for (const row of myTargets) {
          const cid = row['channel_id'] as string;
          const gid = (row['guild_id'] as string) ?? '';
          const cpResult = await db.execute(
            `SELECT total_scraped, complete, cursor_id, newest_message_id FROM ${KEYSPACE}.scrape_checkpoints WHERE channel_id = ?`, [cid],
          ).catch(() => null);
          const cp = cpResult && cpResult.rowLength > 0 ? cpResult.rows[0] : null;
          const ts = Number(cp?.['total_scraped'] ?? 0);
          totalScrapedAll += ts;
          // Get channel name from name_cache
          const nameResult = await db.execute(`SELECT name FROM ${KEYSPACE}.name_cache WHERE id = ?`, [cid]).catch(() => null);
          const chName = (nameResult?.rows[0]?.['name'] as string) ?? '';
          await db.execute(
            `INSERT INTO ${KEYSPACE}.archived_account_channels (account_id, channel_id, guild_id, channel_name, total_scraped, complete, cursor_id, newest_message_id) VALUES (?,?,?,?,?,?,?,?)`,
            [accountId, cid, gid, chName, ts, cp?.['complete'] ?? false, cp?.['cursor_id'] ?? null, cp?.['newest_message_id'] ?? null],
          ).catch(() => {});
        }

        // Write archive header
        await db.execute(
          `INSERT INTO ${KEYSPACE}.archived_accounts (account_id, username, avatar, archived_at, reason, guild_count, channel_count, total_scraped) VALUES (?,?,?,?,?,?,?,?)`,
          [accountId, username, '', new Date(), 'auto_delete', memberGuildIds.size + assignedGuilds.length, myTargets.length, totalScrapedAll],
        );
        console.log(`[accounts] Auto-archived ${username} (${accountId}): ${memberGuildIds.size} member guilds, ${assignedGuilds.length} assigned, ${myTargets.length} channels`);
      } catch (archErr) {
        console.warn('[accounts] Auto-archive failed (non-fatal, proceeding with delete):', archErr);
      }

      const cleanup = [
        db.execute(`DELETE FROM ${KEYSPACE}.account_info WHERE account_id = ?`, [accountId]),
        db.execute(`DELETE FROM ${KEYSPACE}.failed_accounts WHERE account_id = ?`, [accountId]),
        db.execute(`DELETE FROM ${KEYSPACE}.token_account_map WHERE token_key = ?`, [tokenKey]),
      ];
      await Promise.allSettled(cleanup);

      try {
        const ownedTargets = await readTargets(db);
        const staleTargets = ownedTargets.filter(t => t.accountId === accountId || resolveOwnerAccountId(t) === accountId);
        for (const target of staleTargets) {
          const ownerIsDeleted = resolveOwnerAccountId(target) === accountId;
          const survivingActiveAccountId = target.accountId && target.accountId !== accountId ? target.accountId : null;
          const survivingActiveAccountIdx = target.accountId && target.accountId !== accountId ? (target.accountIdx ?? null) : null;
          await db.execute(
            `UPDATE ${KEYSPACE}.scrape_targets SET account_id = ?, account_idx = ?, pinned_account_id = ?, pinned_account_idx = ? WHERE channel_id = ?`,
            [survivingActiveAccountId, survivingActiveAccountIdx, ownerIsDeleted ? null : target.pinnedAccountId ?? null, ownerIsDeleted ? null : target.pinnedAccountIdx ?? null, target.channelId],
            { prepare: true },
          ).catch(() => {});
          if (ownerIsDeleted) {
            await deleteAccountTargetMirror(db, target).catch(() => {});
            if (survivingActiveAccountId) {
              await upsertAccountTargetMirror(db, {
                ...target,
                accountId: survivingActiveAccountId,
                accountIdx: survivingActiveAccountIdx ?? undefined,
                pinnedAccountId: undefined,
                pinnedAccountIdx: undefined,
              }, {
                ownerAccountId: survivingActiveAccountId,
                ownerAccountIdx: survivingActiveAccountIdx ?? undefined,
                activeAccountId: survivingActiveAccountId,
                activeAccountIdx: survivingActiveAccountIdx,
              }).catch(() => {});
            }
          } else {
            await upsertAccountTargetMirror(db, target, {
              ownerAccountId: target.pinnedAccountId,
              ownerAccountIdx: target.pinnedAccountIdx,
              activeAccountId: null,
              activeAccountIdx: null,
            }).catch(() => {});
          }
        }
      } catch (err) {
        console.warn('[accounts] pinned target cleanup failed (non-fatal):', err);
      }

      // Reassign invite_pool entries for this account to remaining accounts
      try {
        // Use account_info table (fast, no Discord API calls) instead of calling /users/@me per account
        const accInfoResult = await db.execute(`SELECT account_id, username FROM ${KEYSPACE}.account_info`).catch(() => null);
        const remInfos: Array<{ id: string; name: string }> = [];
        if (accInfoResult) {
          for (const r of accInfoResult.rows) {
            const aid = (r['account_id'] as string) ?? '';
            if (aid && aid !== accountId) remInfos.push({ id: aid, name: (r['username'] as string) ?? '' });
          }
        }
        const tjCounts = new Map<string, number>();
        const poolRows = await db.execute(`SELECT invite_code, assigned_account_id, owner_account_id, status FROM ${KEYSPACE}.invite_pool`);
        for (const row of poolRows.rows) {
          if (row['status'] === 'to_join') {
            const aid = (row['assigned_account_id'] as string) ?? '';
            if (aid && aid !== accountId) tjCounts.set(aid, (tjCounts.get(aid) ?? 0) + 1);
          }
        }
        for (const row of poolRows.rows) {
          const code = row['invite_code'] as string;
          const assignedId = (row['assigned_account_id'] as string) ?? '';
          const status = (row['status'] as string) ?? '';
          // Only reassign to_join entries — already_in entries keep their owner
          // (categories + invite_pool are preserved for archive/transfer/restore)
          if (assignedId === accountId && status === 'to_join' && remInfos.length > 0) {
            let best = remInfos[0]; let bc = tjCounts.get(best.id) ?? 0;
            for (const ri of remInfos) { const c = tjCounts.get(ri.id) ?? 0; if (c < bc) { best = ri; bc = c; } }
            tjCounts.set(best.id, bc + 1);
            await db.execute(`UPDATE ${KEYSPACE}.invite_pool SET assigned_account_id = ?, assigned_account_name = ? WHERE invite_code = ?`, [best.id, best.name, code]);
          } else if (assignedId === accountId) {
            await db.execute(`UPDATE ${KEYSPACE}.invite_pool SET assigned_account_id = ?, assigned_account_name = ? WHERE invite_code = ?`, [null, null, code]);
          }
          // NOTE: Do NOT null out owner_account_id for already_in entries.
          // These must persist so that restore/transfer preserves membership status.
        }
      } catch (e) { console.warn('[accounts] invite_pool temizleme hatasi (non-fatal):', e); }

      // Clean up guild membership (account_guilds + guild_accounts)
      // Use account_guilds (PK: account_id, guild_id) to find guilds, then delete from both tables
      try {
        const ag = await db.execute(`SELECT guild_id FROM ${KEYSPACE}.account_guilds WHERE account_id = ?`, [accountId]);
        for (const row of ag.rows) {
          const guildId = row['guild_id'] as string;
          await db.execute(`DELETE FROM ${KEYSPACE}.guild_accounts WHERE guild_id = ? AND account_id = ?`, [guildId, accountId]);
        }
        await db.execute(`DELETE FROM ${KEYSPACE}.account_guilds WHERE account_id = ?`, [accountId]);
      } catch { /* ignore */ }

      // NOTE: Do NOT delete join_categories or category_guilds for this account.
      // Categories and guild assignments are preserved so that archive → transfer/restore
      // keeps the full guild history intact. The category stays visible in the dashboard.

      console.log(`[accounts] ✓ ${username} (${accountId}) Scylla verileri temizlendi`);
    }

    return res.json({ ok: true, total: accounts.length, removedAccountId: accountId });
  });

  router.get('/:accountId/pause', async (req: Request, res: Response) => {
    const { accountId } = req.params;
    if (!/^\d{17,20}$/.test(accountId)) return res.status(400).json({ error: 'Gecersiz accountId' });
    if (!(await hasKnownAccount(accountId))) return res.status(404).json({ error: 'Hesap bulunamadi' });
    return res.json(await buildAccountPauseSnapshot(accountId));
  });

  router.put('/:accountId/pause', async (req: Request, res: Response) => {
    const { accountId } = req.params;
    if (!/^\d{17,20}$/.test(accountId)) return res.status(400).json({ error: 'Gecersiz accountId' });
    if (!(await hasKnownAccount(accountId))) return res.status(404).json({ error: 'Hesap bulunamadi' });
    const requestedByValue = requestedBy(req);
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : null;
    const requestId = typeof req.body?.requestId === 'string' && req.body.requestId.trim() ? req.body.requestId.trim() : crypto.randomUUID();
    await db.execute(
      `INSERT INTO ${KEYSPACE}.scrape_paused_accounts (account_id, reason, requested_by, request_id, requested_at) VALUES (?,?,?,?,?)`,
      [accountId, reason, requestedByValue, requestId, new Date()],
      { prepare: true },
    );
    await writeScrapeControlAudit('account', accountId, 'pause', requestedByValue, reason, requestId, 'accepted');
    return res.json({ ok: true, requestId, ...(await buildAccountPauseSnapshot(accountId)) });
  });

  router.delete('/:accountId/pause', async (req: Request, res: Response) => {
    const { accountId } = req.params;
    if (!/^\d{17,20}$/.test(accountId)) return res.status(400).json({ error: 'Gecersiz accountId' });
    if (!(await hasKnownAccount(accountId))) return res.status(404).json({ error: 'Hesap bulunamadi' });
    const currentPause = (await readPausedAccounts(db)).get(accountId) ?? null;
    const requestedByValue = requestedBy(req);
    const requestId = typeof req.body?.requestId === 'string' && req.body.requestId.trim() ? req.body.requestId.trim() : crypto.randomUUID();
    await db.execute(
      `DELETE FROM ${KEYSPACE}.scrape_paused_accounts WHERE account_id = ?`,
      [accountId],
      { prepare: true },
    );
    await writeScrapeControlAudit('account', accountId, 'resume', requestedByValue, currentPause?.reason ?? null, requestId, currentPause ? 'cleared' : 'noop');
    return res.json({ ok: true, requestId, ...(await buildAccountPauseSnapshot(accountId)) });
  });

  router.get('/targets/:channelId/pause', async (req: Request, res: Response) => {
    const { channelId } = req.params;
    if (!/^\d{17,20}$/.test(channelId)) return res.status(400).json({ error: 'Gecersiz channelId' });
    const target = (await readTargets(db)).find(item => item.channelId === channelId);
    if (!target) return res.status(404).json({ error: 'Kanal bulunamadi' });
    return res.json(await buildChannelPauseSnapshot(target));
  });

  router.put('/targets/:channelId/pause', async (req: Request, res: Response) => {
    const { channelId } = req.params;
    if (!/^\d{17,20}$/.test(channelId)) return res.status(400).json({ error: 'Gecersiz channelId' });
    const target = (await readTargets(db)).find(item => item.channelId === channelId);
    if (!target) return res.status(404).json({ error: 'Kanal bulunamadi' });
    const requestedByValue = requestedBy(req);
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : null;
    const requestId = typeof req.body?.requestId === 'string' && req.body.requestId.trim() ? req.body.requestId.trim() : crypto.randomUUID();
    await db.execute(
      `INSERT INTO ${KEYSPACE}.scrape_paused_channels (channel_id, guild_id, account_id, reason, requested_by, request_id, requested_at) VALUES (?,?,?,?,?,?,?)`,
      [channelId, target.guildId, resolveOwnerAccountId(target) ?? target.accountId ?? null, reason, requestedByValue, requestId, new Date()],
      { prepare: true },
    );
    await writeScrapeControlAudit('channel', channelId, 'pause', requestedByValue, reason, requestId, 'accepted');
    return res.json({ ok: true, requestId, ...(await buildChannelPauseSnapshot(target)) });
  });

  router.delete('/targets/:channelId/pause', async (req: Request, res: Response) => {
    const { channelId } = req.params;
    if (!/^\d{17,20}$/.test(channelId)) return res.status(400).json({ error: 'Gecersiz channelId' });
    const target = (await readTargets(db)).find(item => item.channelId === channelId);
    if (!target) return res.status(404).json({ error: 'Kanal bulunamadi' });
    const pausedChannels = await readPausedChannels(db);
    const currentPause = pausedChannels.get(channelId) ?? null;
    const requestedByValue = requestedBy(req);
    const requestId = typeof req.body?.requestId === 'string' && req.body.requestId.trim() ? req.body.requestId.trim() : crypto.randomUUID();
    await db.execute(
      `DELETE FROM ${KEYSPACE}.scrape_paused_channels WHERE channel_id = ?`,
      [channelId],
      { prepare: true },
    );
    await writeScrapeControlAudit('channel', channelId, 'resume', requestedByValue, currentPause?.reason ?? null, requestId, currentPause ? 'cleared' : 'noop');
    return res.json({ ok: true, requestId, ...(await buildChannelPauseSnapshot(target)) });
  });

  router.get('/targets', async (_req: Request, res: Response) => {
    const targets = await readTargets(db);
    const [runtimeStates, pausedAccounts, pausedChannels] = await Promise.all([
      readRuntimeStatesByChannelIds(db, targets.map(target => target.channelId)),
      readPausedAccounts(db),
      readPausedChannels(db),
    ]);
    return res.json(targets.map(target => {
      const runtime = runtimeStates.get(target.channelId);
      const pauseIntent = buildPauseIntentView(resolveOwnerAccountId(target), target.channelId, pausedAccounts, pausedChannels);
      return {
        ...target,
        ...decorateTargetRuntimeState(target, runtime, pauseIntent),
      };
    }));
  });

  router.post('/targets', async (req: Request, res: Response) => {
    const { guildId, channelId, label, accountId } = req.body as Record<string, string>;
    if (!guildId?.trim() || !channelId?.trim()) return res.status(400).json({ error: 'guildId ve channelId zorunlu' });
    if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(channelId)) return res.status(400).json({ error: 'Geersiz Discord Snowflake' });

    const validated = await validateChannelViaAccounts(guildId.trim(), channelId.trim());
    if (!validated.ok) return res.status(400).json({ error: validated.error });

    const targets = await readTargets(db);
    if (targets.some(t => t.channelId === channelId.trim())) return res.status(409).json({ error: 'Bu kanal zaten eklendi' });

    const eligible = await resolveGuildEligibleAccounts(db, guildId.trim());
    if (eligible.length === 0) return res.status(400).json({ error: 'Bu sunucuda uygun hesap bulunamadi' });

    let owner = eligible[0];
    if (accountId?.trim()) {
      const explicit = eligible.find(a => a.accountId === accountId.trim());
      if (!explicit) return res.status(400).json({ error: 'Secilen hesap bu sunucuda degil veya aktif degil' });
      owner = explicit;
    } else {
      const existing = targets.filter(t => t.guildId === guildId.trim());
      owner = eligible[existing.length % eligible.length];
    }

    const nextTarget: ScrapeTarget = {
      guildId: guildId.trim(),
      channelId: channelId.trim(),
      label: label?.trim() || validated.channelName || undefined,
      accountId: owner.accountId,
      accountIdx: owner.idx,
      pinnedAccountId: owner.accountId,
      pinnedAccountIdx: owner.idx,
    };

    await addTarget(db, nextTarget);
    await upsertAccountTargetMirror(db, nextTarget, {
      ownerAccountId: owner.accountId,
      ownerAccountIdx: owner.idx,
      activeAccountId: owner.accountId,
      activeAccountIdx: owner.idx,
    }).catch(() => {});

    // Kanal adini name_cache'e kaydet
    if (validated.channelName) {
      await db.execute(
        `INSERT INTO ${KEYSPACE}.name_cache (id, name, kind) VALUES (?,?,?)`,
        [channelId.trim(), validated.channelName, 'channel']
      ).catch(() => {});
    }

    return res.json({ ok: true, total: targets.length + 1, realGuildId: guildId.trim(), ownerAccountId: owner.accountId, ownerAccountIdx: owner.idx });
  });

  router.delete('/targets/:channelId', async (req: Request, res: Response) => {
    const targets = await readTargets(db);
    const target = targets.find(t => t.channelId === req.params.channelId);
    if (!target) return res.status(404).json({ error: 'Kanal bulunamadi' });
    await deleteTarget(db, req.params.channelId);
    await deleteAccountTargetMirror(db, target).catch(() => {});
    return res.json({ ok: true, total: targets.length - 1 });
  });

  router.put('/:accountId/guilds/:guildId/targets', async (req: Request, res: Response) => {
    try {
      const { accountId, guildId } = req.params;
      if (!/^\d{17,20}$/.test(accountId)) return res.status(400).json({ error: 'Gecersiz accountId' });
      if (!/^\d{17,20}$/.test(guildId)) return res.status(400).json({ error: 'Gecersiz guildId' });

      const rawIds = Array.isArray(req.body?.channelIds) ? req.body.channelIds as unknown[] : null;
      if (!rawIds) return res.status(400).json({ error: 'channelIds alanı zorunlu' });

      const normalizedIds = rawIds
        .filter((id): id is string => typeof id === 'string')
        .map(id => id.trim())
        .filter(Boolean);
      const invalidIds = [...new Set(normalizedIds.filter(id => !/^\d{17,20}$/.test(id)))];
      if (invalidIds.length > 0) {
        return res.status(400).json({ error: `Gecersiz kanal ID'leri: ${invalidIds.join(', ')}`, invalidIds });
      }

      const desiredIds: string[] = [...new Set(
        normalizedIds
          .filter(id => /^\d{17,20}$/.test(id))
      )];

      const allTargets = await readTargets(db);
      const currentTargets = allTargets.filter(t => resolveOwnerAccountId(t) === accountId && t.guildId === guildId);
      const currentIds = new Set(currentTargets.map(t => t.channelId));
      const desiredSet = new Set(desiredIds);

      if (desiredIds.length === 0) {
        for (const target of currentTargets) {
          await deleteTarget(db, target.channelId);
          await deleteAccountTargetMirror(db, target).catch(() => {});
        }
        return res.json({ ok: true, verified: true, added: [], removed: [...currentIds], addedCount: 0, removedCount: currentIds.size, total: 0 });
      }

      const accountCtx = await getActiveAccountToken(db, accountId);
      if (!accountCtx) return res.status(400).json({ error: 'Hesap tokeni bulunamadi — hesap sistemde aktif degil' });

      const isMember = await verifyGuildMembershipForAccount(accountCtx.token, guildId);
      if (!isMember) {
        return res.status(400).json({ error: 'Hesap sunucuya katilmamis veya su anda dogrulanamiyor' });
      }

      const validatedChannels = await validateChannelsForAccount(accountCtx.token, guildId, desiredIds);
      if (!validatedChannels.ok) return res.status(400).json({ error: validatedChannels.error, verified: false });

      const duplicates = desiredIds.filter(channelId => {
        const existing = allTargets.find(t => t.channelId === channelId);
        return !!existing && !currentIds.has(channelId);
      });
      if (duplicates.length > 0) {
        return res.status(400).json({ error: `Bu kanal ID'leri zaten sistemde mevcut: ${duplicates.join(', ')}`, duplicates });
      }

      const added: string[] = [];
      const removed: string[] = [];

      for (const target of currentTargets) {
        if (desiredSet.has(target.channelId)) continue;
        await deleteTarget(db, target.channelId);
        await deleteAccountTargetMirror(db, target).catch(() => {});
        removed.push(target.channelId);
      }

      for (const channel of validatedChannels.channels) {
        if (currentIds.has(channel.id)) continue;
        const nextTarget: ScrapeTarget = {
          guildId,
          channelId: channel.id,
          label: channel.name || undefined,
          accountId,
          accountIdx: accountCtx.idx >= 0 ? Number(accountCtx.idx) : undefined,
          pinnedAccountId: accountId,
          pinnedAccountIdx: accountCtx.idx >= 0 ? Number(accountCtx.idx) : undefined,
        };
        await addTarget(db, nextTarget);
        await upsertAccountTargetMirror(db, nextTarget, {
          ownerAccountId: accountId,
          ownerAccountIdx: accountCtx.idx >= 0 ? Number(accountCtx.idx) : undefined,
          activeAccountId: accountId,
          activeAccountIdx: accountCtx.idx >= 0 ? Number(accountCtx.idx) : undefined,
        }).catch(() => {});
        if (channel.name) {
          await db.execute(
            `INSERT INTO ${KEYSPACE}.name_cache (id, name, kind) VALUES (?,?,?)`,
            [channel.id, channel.name, 'channel'],
          ).catch(() => {});
        }
        added.push(channel.id);
      }

      const guildInfo = await db.execute(
        `SELECT guild_name, guild_icon FROM ${KEYSPACE}.account_guilds WHERE account_id = ? AND guild_id = ?`,
        [accountId, guildId],
        { prepare: true },
      ).catch(() => null);
      const guildName = (guildInfo?.rows[0]?.['guild_name'] as string) ?? '';
      const guildIcon = (guildInfo?.rows[0]?.['guild_icon'] as string) ?? '';
      const ownerName = accountCtx.username || accountId;

      if (guildName) {
        await db.execute(
          `INSERT INTO ${KEYSPACE}.name_cache (id, name, kind) VALUES (?,?,?)`,
          [guildId, guildName, 'guild'],
        ).catch(() => {});
      }

      const poolScan = await db.execute(`SELECT invite_code, guild_id FROM ${KEYSPACE}.invite_pool`).catch(() => null);
      const inviteCode = poolScan?.rows.find(row => (row['guild_id'] as string) === guildId)?.['invite_code'] as string | undefined;
      if (inviteCode) {
        await db.execute(
          `UPDATE ${KEYSPACE}.invite_pool SET status = 'already_in', owner_account_id = ?, owner_account_name = ?, assigned_account_id = ?, assigned_account_name = ?, checked_at = ? WHERE invite_code = ?`,
          [accountId, ownerName, null, null, new Date(), inviteCode],
          { prepare: true },
        ).catch(() => {});
      }

      await db.execute(
        `INSERT INTO ${KEYSPACE}.guild_accounts (guild_id, account_id, guild_name, last_synced) VALUES (?,?,?,?)`,
        [guildId, accountId, guildName, new Date()],
        { prepare: true },
      ).catch(() => {});
      await db.execute(
        `INSERT INTO ${KEYSPACE}.account_guilds (account_id, guild_id, guild_name, guild_icon, guild_owner, last_synced) VALUES (?,?,?,?,?,?)`,
        [accountId, guildId, guildName, guildIcon, false, new Date()],
        { prepare: true },
      ).catch(() => {});

      return res.json({
        ok: true,
        verified: true,
        added,
        removed,
        addedCount: added.length,
        removedCount: removed.length,
        total: desiredIds.length,
      });
    } catch (err: any) {
      console.error('[accounts] bulk guild target sync failed:', err);
      return res.status(500).json({ error: err?.message ?? 'Sunucu kanal hedefleri guncellenemedi' });
    }
  });

  router.get('/:accountId/targets', async (req: Request, res: Response) => {
    const { accountId } = req.params;
    if (!/^\d{17,20}$/.test(accountId)) return res.status(400).json({ error: 'Gecersiz accountId' });
    const limit = Math.min(1000, Math.max(1, parseInt(req.query['limit'] as string ?? '100', 10) || 100));
    const offset = Math.max(0, parseInt(req.query['offset'] as string ?? '0', 10) || 0);
    const q = (req.query['q'] as string ?? '').trim().toLowerCase();
    const guildId = (req.query['guildId'] as string ?? '').trim();

    let rows = await readAccountTargetMirrors(db, accountId);
    if (rows.length === 0) {
      const fallbackTargets = (await readTargets(db)).filter(t => resolveOwnerAccountId(t) === accountId);
      for (const target of fallbackTargets) await upsertAccountTargetMirror(db, target).catch(() => {});
      rows = fallbackTargets.map(t => ({
        accountId,
        channelId: t.channelId,
        guildId: t.guildId,
        label: t.label,
        accountIdx: resolveOwnerAccountIdx(t),
        activeAccountId: t.accountId,
        activeAccountIdx: t.accountIdx,
        pinnedAccountId: t.pinnedAccountId,
        pinnedAccountIdx: t.pinnedAccountIdx,
        createdAt: null,
      }));
    }

    const names = await readNamesByIds(db, rows.flatMap(r => [r.channelId, r.guildId]));
    const activeAccountIds = [...new Set(rows.map(r => r.activeAccountId).filter(Boolean))] as string[];
    const activeAccountNames = new Map<string, string>();
    await Promise.all(activeAccountIds.map(async id => {
      const info = await db.execute(`SELECT username FROM ${KEYSPACE}.account_info WHERE account_id = ?`, [id]).catch(() => null);
      activeAccountNames.set(id, (info?.rows[0]?.['username'] as string) ?? id);
    }));

    const [runtimeStates, pausedAccounts, pausedChannels] = await Promise.all([
      readRuntimeStatesByChannelIds(db, rows.map(row => row.channelId)),
      readPausedAccounts(db),
      readPausedChannels(db),
    ]);

    let filtered = rows.map(r => ({
      channelId: r.channelId,
      guildId: r.guildId,
      label: r.label ?? '',
      channelName: names[r.channelId] ?? '',
      guildName: names[r.guildId] ?? '',
      ownerAccountId: r.accountId,
      ownerAccountIdx: r.accountIdx ?? null,
      activeAccountId: r.activeAccountId ?? null,
      activeAccountIdx: r.activeAccountIdx ?? null,
      activeAccountName: r.activeAccountId ? (activeAccountNames.get(r.activeAccountId) ?? r.activeAccountId) : null,
      pinned: !!r.pinnedAccountId,
      createdAt: r.createdAt ?? null,
      ...decorateTargetRuntimeState({
        channelId: r.channelId,
        guildId: r.guildId,
        label: r.label ?? undefined,
        accountId: r.activeAccountId ?? undefined,
        accountIdx: r.activeAccountIdx ?? undefined,
        pinnedAccountId: r.accountId,
        pinnedAccountIdx: r.accountIdx,
      }, runtimeStates.get(r.channelId), buildPauseIntentView(r.accountId, r.channelId, pausedAccounts, pausedChannels)),
    }));

    if (guildId) filtered = filtered.filter(t => t.guildId === guildId);
    if (q) {
      filtered = filtered.filter(t =>
        t.channelId.includes(q) ||
        t.guildId.includes(q) ||
        t.channelName.toLowerCase().includes(q) ||
        t.guildName.toLowerCase().includes(q) ||
        t.label.toLowerCase().includes(q)
      );
    }

    filtered.sort((a, b) => (a.guildName || a.guildId).localeCompare(b.guildName || b.guildId) || (a.channelName || a.channelId).localeCompare(b.channelName || b.channelId));
    return res.json({
      targets: filtered.slice(offset, offset + limit),
      total: filtered.length,
      totalUnfiltered: rows.length,
      offset,
      limit,
    });
  });

  router.put('/targets/:channelId', async (req: Request, res: Response) => {
    const { channelId } = req.params;
    if (!/^\d{17,20}$/.test(channelId)) return res.status(400).json({ error: 'Gecersiz channelId' });
    const { accountId, label } = req.body as Record<string, string | undefined>;
    const targets = await readTargets(db);
    const current = targets.find(t => t.channelId === channelId);
    if (!current) return res.status(404).json({ error: 'Kanal bulunamadi' });

    let ownerAccountId = resolveOwnerAccountId(current);
    let ownerAccountIdx = resolveOwnerAccountIdx(current);
    if (accountId?.trim()) {
      const eligible = await resolveGuildEligibleAccounts(db, current.guildId);
      const nextOwner = eligible.find(a => a.accountId === accountId.trim());
      if (!nextOwner) return res.status(400).json({ error: 'Secilen hesap bu sunucuda degil veya aktif degil' });
      ownerAccountId = nextOwner.accountId;
      ownerAccountIdx = nextOwner.idx;
    }
    if (!ownerAccountId) return res.status(400).json({ error: 'Hedef icin sahip hesap belirlenemedi' });

    const nextLabel = typeof label === 'string' ? label.trim() : (current.label ?? '');
    await db.execute(
      `UPDATE ${KEYSPACE}.scrape_targets SET label = ?, account_id = ?, account_idx = ?, pinned_account_id = ?, pinned_account_idx = ? WHERE channel_id = ?`,
      [nextLabel, ownerAccountId, ownerAccountIdx ?? null, ownerAccountId, ownerAccountIdx ?? null, channelId],
      { prepare: true },
    );

    const nextTarget: ScrapeTarget = {
      ...current,
      label: nextLabel || undefined,
      accountId: ownerAccountId,
      accountIdx: ownerAccountIdx,
      pinnedAccountId: ownerAccountId,
      pinnedAccountIdx: ownerAccountIdx,
    };
    await upsertAccountTargetMirror(db, nextTarget, {
      ownerAccountId,
      ownerAccountIdx,
      activeAccountId: current.accountId ?? ownerAccountId,
      activeAccountIdx: current.accountIdx ?? ownerAccountIdx,
      previousOwnerAccountId: resolveOwnerAccountId(current),
    }).catch(() => {});
    if (nextLabel) {
      await db.execute(
        `INSERT INTO ${KEYSPACE}.name_cache (id, name, kind) VALUES (?,?,?)`,
        [channelId, nextLabel, 'channel'],
      ).catch(() => {});
    }

    return res.json({ ok: true, target: nextTarget });
  });

  // POST /accounts/fix-guild-ids  mevcut tm kanallarin guild_id'sini Discord'dan dogrula
  router.post('/fix-guild-ids', async (_req: Request, res: Response) => {
    const accounts = readAccounts();
    if (!accounts.length) return res.status(500).json({ error: 'Hesap yok' });
    const targets = await readTargets(db);
    const fixed: string[] = [];
    const errors: string[] = [];

    for (const target of targets) {
      for (const acc of accounts) {
        try {
          const ch = await discordGet(`/channels/${target.channelId}`, acc.token) as { guild_id?: string; name?: string };
          if (ch.guild_id) {
            if (ch.guild_id !== target.guildId) {
              await db.execute(
                `UPDATE ${KEYSPACE}.scrape_targets SET guild_id = ? WHERE channel_id = ?`,
                [ch.guild_id, target.channelId]
              );
              fixed.push(`${target.channelId}: ${target.guildId} ? ${ch.guild_id}`);
            }
            if (ch.name) {
              await db.execute(
                `INSERT INTO ${KEYSPACE}.name_cache (id, name, kind) VALUES (?,?,?)`,
                [target.channelId, ch.name, 'channel']
              );
            }
            break;
          }
        } catch (e: unknown) {
          errors.push(`${target.channelId}: ${e instanceof Error ? e.message : 'hata'}`);
        }
      }
    }
    return res.json({ fixed, errors, total: targets.length });
  });

  router.post('/refresh-cache', (_req: Request, res: Response) => {
    Object.keys(_cache).forEach(k => delete _cache[k]);
    return res.json({ ok: true });
  });

  router.get('/status', (_req: Request, res: Response) => {
    const PID_FILE = path.join(process.cwd(), '.pids', 'accounts.pid');
    try {
      if (!fs.existsSync(PID_FILE)) return res.json({ running: false });
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
      if (isNaN(pid)) return res.json({ running: false });
      process.kill(pid, 0);
      return res.json({ running: true, pid });
    } catch { return res.json({ running: false }); }
  });

  // GET /accounts/guild/:guildId/channels
  router.get('/guild/:guildId/channels', async (req: Request, res: Response) => {
    const { guildId } = req.params;
    if (!/^\d{17,20}$/.test(guildId)) return res.status(400).json({ error: 'Geersiz guildId' });
    const accounts = readAccounts();
    const accountId = typeof req.query['accountId'] === 'string' ? req.query['accountId'].trim() : '';
    const hasLegacyIdx = req.query['accIdx'] != null;
    const fallbackIdx = parseInt(req.query['accIdx'] as string ?? '0', 10);
    let accIdx = Number.isNaN(fallbackIdx) ? 0 : fallbackIdx;
    if (accountId) {
      await ensureKnownAccountsLoaded(db);
      const resolvedIdx = findAccountIdxById(accounts, accountId);
      if (resolvedIdx >= 0) accIdx = resolvedIdx;
      else if (!hasLegacyIdx) return res.status(404).json({ error: 'Hesap bulunamadi' });
    }
    if (!accounts[accIdx]) return res.status(404).json({ error: 'Hesap bulunamadi' });

    try {
      const [channelsRes, rolesRes, memberRes] = await Promise.allSettled([
        discordGet(`/guilds/${guildId}/channels`, accounts[accIdx].token),
        discordGet(`/guilds/${guildId}/roles`, accounts[accIdx].token),
        discordGet(`/guilds/${guildId}/members/@me`, accounts[accIdx].token),
      ]);

      type DiscordChannel = {
        id: string; name: string; type: number; position: number;
        last_message_id?: string | null; parent_id?: string | null;
        permission_overwrites?: Array<{ id: string; type: number; deny: string; allow: string }>;
      };
      type DiscordRole = { id: string; name: string; permissions: string; managed: boolean; position: number };
      type Overwrite   = { id: string; type: number; deny: string; allow: string };

      const channels = channelsRes.status === 'fulfilled' ? channelsRes.value as DiscordChannel[] : null;
      if (!Array.isArray(channels)) {
        const reason = channelsRes.status === 'rejected' ? (channelsRes.reason?.message ?? String(channelsRes.reason)) : 'Beklenmeyen yanit';
        return res.status(403).json({ error: `Sunucu kanal listesi alinamadi: ${reason}` });
      }

      const allRoles: DiscordRole[] = rolesRes.status === 'fulfilled' && Array.isArray(rolesRes.value)
        ? rolesRes.value as DiscordRole[] : [];

      // Hesabin sahip oldugu rol ID'leri
      const memberRoleIds = new Set<string>([guildId]); // @everyone her zaman dahil
      if (memberRes.status === 'fulfilled') {
        const member = memberRes.value as { roles?: string[] };
        (member.roles ?? []).forEach(r => memberRoleIds.add(r));
      }

      // Hesabin sahip oldugu rollerin objeleri
      const myRoles = allRoles.filter(r => memberRoleIds.has(r.id));

      // Temel izinler (tm rollerden birlesik)
      const VIEW = 1024n;
      const ADMIN = 8n;
      const basePerms = myRoles.reduce((acc, r) => acc | BigInt(r.permissions ?? '0'), 0n);
      const isAdmin = (basePerms & ADMIN) !== 0n;

      function canAccess(c: DiscordChannel): boolean {
        if (isAdmin) return true; // Admin her seyi grr

        let perms = basePerms;

        // Permission overwrites uygula
        const ows = c.permission_overwrites ?? [];

        // nce @everyone overwrite
        const everyoneOw = ows.find((o: Overwrite) => o.id === guildId && o.type === 0);
        if (everyoneOw) {
          perms &= ~BigInt(everyoneOw.deny  ?? '0');
          perms |=  BigInt(everyoneOw.allow ?? '0');
        }

        // Sonra hesabin rollerinin overwrites'lari
        let roleAllow = 0n, roleDeny = 0n;
        for (const ow of ows) {
          if (ow.type === 0 && memberRoleIds.has(ow.id) && ow.id !== guildId) {
            roleAllow |= BigInt(ow.allow ?? '0');
            roleDeny  |= BigInt(ow.deny  ?? '0');
          }
        }
        perms &= ~roleDeny;
        perms |=  roleAllow;

        return (perms & VIEW) !== 0n;
      }

      const TEXT_TYPES = new Set([0, 5, 10, 11, 12]);
      const targets = await readTargets(db);
      const existing = new Set(targets.map(t => t.channelId));

      const result = channels
        .filter(c => TEXT_TYPES.has(c.type))
        .filter(c => canAccess(c))
        .map(c => ({
          id: c.id, name: c.name, type: c.type,
          lastActivity: c.last_message_id
            ? Number(BigInt(c.last_message_id) >> 22n) + 1420070400000 : 0,
          alreadyAdded: existing.has(c.id),
        }))
        .sort((a, b) => b.lastActivity - a.lastActivity)
        .slice(0, 50); // Top 50

      // Kanal isimlerini cache'e kaydet
      const namesToSave: Record<string, string> = {};
      result.forEach(c => { namesToSave[c.id] = c.name; });
      await saveNames(db, namesToSave).catch(() => {});

      return res.json(result);
    } catch (err: unknown) {
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Hata' });
    }
  });

  router.get('/guild/:guildId/owners', async (req: Request, res: Response) => {
    const { guildId } = req.params;
    if (!/^\d{17,20}$/.test(guildId)) return res.status(400).json({ error: 'Geçersiz guildId' });
    try {
      const accounts = await resolveGuildEligibleAccounts(db, guildId);
      return res.json({ accounts, total: accounts.length });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Hata' });
    }
  });

  // ── GET /accounts/accounts-list — paginated list from account_info ──────────
  router.get('/accounts-list', async (req: Request, res: Response) => {
    const page  = Math.max(1, parseInt(req.query['page']  as string ?? '1',  10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query['limit'] as string ?? '50', 10) || 50));
    const q     = (req.query['q'] as string ?? '').trim().toLowerCase();
    const offset = (page - 1) * limit;
    try {
      await ensureKnownAccountsLoaded(db);
      const liveAccounts = readAccounts();
      const liveInfos = liveAccounts.length > 0
        ? await Promise.all(liveAccounts.map((_a, i) => getAccountInfo(i, [], db)))
        : [];
      if (liveInfos.length > 0) {
        await syncFailedAccounts(db, liveInfos);
      }

      const [infoRes, targetsRes, failedRes, guildsRes, tmRes, pausedAccounts, runtimeStates, statsRes] = await Promise.all([
        db.execute(`SELECT account_id, username, avatar, email FROM ${KEYSPACE}.account_info`).catch(() => null),
        db.execute(`SELECT channel_id, account_id, pinned_account_id FROM ${KEYSPACE}.scrape_targets`),
        db.execute(`SELECT account_id, username, token_hint, reason, error_msg, detected_at FROM ${KEYSPACE}.failed_accounts`),
        db.execute(`SELECT account_id, guild_id FROM ${KEYSPACE}.account_guilds`),
        db.execute(`SELECT token_key, account_id FROM ${KEYSPACE}.token_account_map`),
        readPausedAccounts(db),
        readAllRuntimeStates(db),
        db.execute(`SELECT channel_id, rate_limit_hits, total_scraped, last_updated FROM ${KEYSPACE}.scrape_stats`).catch(() => null),
      ]);

      // A1/A2 — Compute health score per account from scrape_stats
      // Map channel_id → { rateLimitHits, lastUpdated } for later join
      const statsByChannel = new Map<string, { rateLimitHits: number; lastUpdated: Date | null }>();
      if (statsRes) {
        for (const r of statsRes.rows) {
          const cid = r['channel_id'] as string;
          if (cid) statsByChannel.set(cid, {
            rateLimitHits: Number(r['rate_limit_hits'] ?? 0),
            lastUpdated:   (r['last_updated'] as Date | null) ?? null,
          });
        }
      }
      // Build per-account aggregates
      const accountStatAgg = new Map<string, { rlHits: number; chCount: number; lastActiveMs: number }>();
      function getAccStatAgg(aid: string) {
        let s = accountStatAgg.get(aid);
        if (!s) { s = { rlHits: 0, chCount: 0, lastActiveMs: 0 }; accountStatAgg.set(aid, s); }
        return s;
      }
      for (const r of targetsRes.rows) {
        const aid = ((r['pinned_account_id'] as string) ?? (r['account_id'] as string) ?? '');
        const cid = (r['channel_id'] as string) ?? '';
        if (!aid || !cid) continue;
        const stat = statsByChannel.get(cid);
        if (!stat) continue;
        const agg = getAccStatAgg(aid);
        agg.rlHits += stat.rateLimitHits;
        agg.chCount++;
        const ms = stat.lastUpdated ? stat.lastUpdated.getTime() : 0;
        if (ms > agg.lastActiveMs) agg.lastActiveMs = ms;
      }
      function computeHealthScore(aid: string): { healthScore: number; healthLabel: string; totalRateLimitHits: number; lastActiveAt: string | null } {
        const agg = accountStatAgg.get(aid);
        if (!agg || agg.chCount === 0) return { healthScore: 100, healthLabel: 'excellent', totalRateLimitHits: 0, lastActiveAt: null };
        const rlRate = agg.rlHits / agg.chCount; // avg rate-limit hits per channel
        const rlPenalty = Math.min(40, rlRate * 4);
        const staleMs = agg.lastActiveMs > 0 ? Date.now() - agg.lastActiveMs : 0;
        const stalePenalty = staleMs > 3_600_000 ? 20 : staleMs > 600_000 ? 10 : 0;
        const score = Math.max(0, Math.round(100 - rlPenalty - stalePenalty));
        const label = score >= 85 ? 'excellent' : score >= 70 ? 'good' : score >= 50 ? 'warning' : 'critical';
        return {
          healthScore: score,
          healthLabel: label,
          totalRateLimitHits: agg.rlHits,
          lastActiveAt: agg.lastActiveMs > 0 ? new Date(agg.lastActiveMs).toISOString() : null,
        };
      }

      // token_key → account_id reverse map
      const tokenKeyByAccountId = new Map<string, string>();
      for (const r of tmRes.rows) tokenKeyByAccountId.set(r['account_id'] as string, r['token_key'] as string);

      // idx lookup: token.slice(-16) → idx in accounts.json
      const idxByTokenKey = new Map<string, number>(liveAccounts.map((t, i) => [t.token.slice(-16), i]));

      // target count per account_id
      const targetCnt = new Map<string, number>();
      for (const r of targetsRes.rows) {
        const aid = ((r['pinned_account_id'] as string) ?? (r['account_id'] as string) ?? '');
        if (aid) targetCnt.set(aid, (targetCnt.get(aid) ?? 0) + 1);
      }

      const runtimeCountsByAccount = new Map<string, RuntimeStateCounts>();
      function countsForAccount(accountId: string): RuntimeStateCounts {
        let counts = runtimeCountsByAccount.get(accountId);
        if (!counts) {
          counts = emptyRuntimeStateCounts();
          runtimeCountsByAccount.set(accountId, counts);
        }
        return counts;
      }
      for (const r of targetsRes.rows) {
        const aid = ((r['pinned_account_id'] as string) ?? (r['account_id'] as string) ?? '');
        const channelId = (r['channel_id'] as string) ?? '';
        if (!aid || !channelId) continue;
        addRuntimeStateCount(countsForAccount(aid), runtimeStates.get(channelId)?.schedulerState);
      }

      // guild count per account_id
      const guildCnt = new Map<string, number>();
      for (const r of guildsRes.rows) {
        const aid = (r['account_id'] as string) ?? '';
        if (aid) guildCnt.set(aid, (guildCnt.get(aid) ?? 0) + 1);
      }

      // unique guilds global
      const uniqueGuilds = new Set(guildsRes.rows.map(r => r['guild_id'] as string)).size;

      // failed set
      const failedByAccountId = new Map<string, { username: string; tokenHint: string; reason: string; errorMsg: string; detectedAt: string | null; placeholder: boolean }>();
      const staleFailedCleanup: Promise<unknown>[] = [];
      for (const row of failedRes.rows) {
        const rawFailedAccountId = (row['account_id'] as string) ?? '';
        if (!rawFailedAccountId) continue;
        let failedAccountId = rawFailedAccountId;
        const unknownIdxMatch = /^unknown_idx_(\d+)$/.exec(rawFailedAccountId);
        if (unknownIdxMatch) {
          const failedIdx = parseInt(unknownIdxMatch[1], 10);
          const mappedTokenKey = liveAccounts[failedIdx]?.token?.slice(-16) ?? '';
          const mappedAccountId = mappedTokenKey ? tokenKeyByAccountId.get(mappedTokenKey) ?? '' : '';
          if (mappedAccountId) {
            failedAccountId = mappedAccountId;
            staleFailedCleanup.push(
              db.execute(`DELETE FROM ${KEYSPACE}.failed_accounts WHERE account_id = ?`, [rawFailedAccountId]).catch(() => {}),
            );
          }
        }
        const nextFailed = {
          username: (row['username'] as string) ?? '',
          tokenHint: (row['token_hint'] as string) ?? '',
          reason: (row['reason'] as string) ?? '',
          errorMsg: (row['error_msg'] as string) ?? '',
          detectedAt: row['detected_at']?.toISOString?.() ?? null,
          placeholder: rawFailedAccountId.startsWith('unknown_'),
        };
        const prevFailed = failedByAccountId.get(failedAccountId);
        if (!prevFailed) {
          failedByAccountId.set(failedAccountId, nextFailed);
          continue;
        }
        if (prevFailed.placeholder && !nextFailed.placeholder) {
          failedByAccountId.set(failedAccountId, nextFailed);
          continue;
        }
        const prevDetectedAt = prevFailed.detectedAt ? new Date(prevFailed.detectedAt).getTime() : 0;
        const nextDetectedAt = nextFailed.detectedAt ? new Date(nextFailed.detectedAt).getTime() : 0;
        if (nextDetectedAt >= prevDetectedAt) failedByAccountId.set(failedAccountId, nextFailed);
      }
      if (staleFailedCleanup.length > 0) await Promise.all(staleFailedCleanup);
      const infoRows = infoRes?.rows ?? [];
      const existingInfoAccountIds = new Set<string>(
        infoRows
          .map(row => (row['account_id'] as string) ?? '')
          .filter(Boolean),
      );
      const missingLiveInfoUpserts = liveInfos
        .filter(info => info.user?.id && !existingInfoAccountIds.has(info.user.id))
        .map(info => {
          existingInfoAccountIds.add(info.user!.id);
          return db.execute(
            `INSERT INTO ${KEYSPACE}.account_info (account_id, discord_id, username, avatar, last_fetched, email, account_password, mail_password, mail_site) VALUES (?,?,?,?,?,?,?,?,?)`,
            [info.user!.id, info.user!.id, info.user!.username ?? '', info.user!.avatar ?? '', new Date(), null, null, null, null],
          ).catch((err: unknown) => {
            console.error('[accounts-api] live account_info backfill failed:', err);
          });
        });
      if (missingLiveInfoUpserts.length > 0) await Promise.all(missingLiveInfoUpserts);

      type AccItem = {
        accountId: string;
        username: string;
        avatar: string;
        email: string;
        guildCount: number;
        targetCount: number;
        status: 'active' | 'failed';
        tokenHint: string | null;
        failedReason: string | null;
        failedError: string | null;
        failedDetectedAt: string | null;
        paused: boolean;
        pauseReason: string | null;
        pauseRequestedBy: string | null;
        pauseRequestedAt: string | null;
        pauseRequestId: string | null;
        pauseAcknowledged: boolean;
        runtimeStateCounts: RuntimeStateCounts;
        runningTargetCount: number;
        queuedTargetCount: number;
        pausedTargetCount: number;
        idx: number;
        // A1/A2 health
        healthScore: number;
        healthLabel: string;
        totalRateLimitHits: number;
        lastActiveAt: string | null;
      };
      const seenAccountIds = new Set<string>();
      let all: AccItem[] = infoRows.map(row => {
        const accountId = (row['account_id'] as string) ?? '';
        const tokenKey  = tokenKeyByAccountId.get(accountId) ?? '';
        const failed = failedByAccountId.get(accountId);
        const pause = pausedAccounts.get(accountId);
        const runtimeStateCounts = runtimeCountsByAccount.get(accountId) ?? emptyRuntimeStateCounts();
        const totalTargets = targetCnt.get(accountId) ?? 0;
        const accountedTargets = countedRuntimeTotal(runtimeStateCounts);
        seenAccountIds.add(accountId);
        return {
          accountId,
          username:    (row['username'] as string) ?? failed?.username ?? '',
          avatar:      (row['avatar']   as string) ?? '',
          email:       (row['email']    as string) ?? '',
          guildCount:  guildCnt.get(accountId)  ?? 0,
          targetCount: targetCnt.get(accountId) ?? 0,
          status:      failed ? 'failed' : 'active',
          tokenHint:   failed?.tokenHint ?? null,
          failedReason: failed?.reason ?? null,
          failedError: failed?.errorMsg ?? null,
          failedDetectedAt: failed?.detectedAt ?? null,
          paused:      !!pause,
          pauseReason: pause?.reason ?? null,
          pauseRequestedBy: pause?.requestedBy ?? null,
          pauseRequestedAt: pause?.requestedAt ?? null,
          pauseRequestId: pause?.requestId ?? null,
          pauseAcknowledged: !!pause && (totalTargets === 0 || (runtimeStateCounts.running === 0 && runtimeStateCounts.queued === 0 && accountedTargets >= totalTargets)),
          runtimeStateCounts,
          runningTargetCount: runtimeStateCounts.running,
          queuedTargetCount: runtimeStateCounts.queued,
          pausedTargetCount: runtimeStateCounts.paused,
          idx:         idxByTokenKey.get(tokenKey) ?? -1,
          ...computeHealthScore(accountId),
        };
      });

      for (const [failedAccountId, failed] of failedByAccountId) {
        if (seenAccountIds.has(failedAccountId)) continue;
        const tokenKey = tokenKeyByAccountId.get(failedAccountId) ?? '';
        const pause = pausedAccounts.get(failedAccountId);
        const runtimeStateCounts = runtimeCountsByAccount.get(failedAccountId) ?? emptyRuntimeStateCounts();
        const totalTargets = targetCnt.get(failedAccountId) ?? 0;
        const accountedTargets = countedRuntimeTotal(runtimeStateCounts);
        all.push({
          accountId: failedAccountId,
          username: failed.username,
          avatar: '',
          email: '',
          guildCount: guildCnt.get(failedAccountId) ?? 0,
          targetCount: targetCnt.get(failedAccountId) ?? 0,
          status: 'failed',
          tokenHint: failed.tokenHint,
          failedReason: failed.reason,
          failedError: failed.errorMsg,
          failedDetectedAt: failed.detectedAt,
          paused: !!pause,
          pauseReason: pause?.reason ?? null,
          pauseRequestedBy: pause?.requestedBy ?? null,
          pauseRequestedAt: pause?.requestedAt ?? null,
          pauseRequestId: pause?.requestId ?? null,
          pauseAcknowledged: !!pause && (totalTargets === 0 || (runtimeStateCounts.running === 0 && runtimeStateCounts.queued === 0 && accountedTargets >= totalTargets)),
          runtimeStateCounts,
          runningTargetCount: runtimeStateCounts.running,
          queuedTargetCount: runtimeStateCounts.queued,
          pausedTargetCount: runtimeStateCounts.paused,
          idx: idxByTokenKey.get(tokenKey) ?? -1,
          ...computeHealthScore(failedAccountId),
        });
      }

      for (const info of liveInfos) {
        const resolvedAccountId = info.user?.id ?? _knownAccounts[info.tokenKey]?.accountId;
        if (!resolvedAccountId || seenAccountIds.has(resolvedAccountId)) continue;
        const failed = failedByAccountId.get(resolvedAccountId);
        const pause = pausedAccounts.get(resolvedAccountId);
        const runtimeStateCounts = runtimeCountsByAccount.get(resolvedAccountId) ?? emptyRuntimeStateCounts();
        const totalTargets = targetCnt.get(resolvedAccountId) ?? 0;
        const accountedTargets = countedRuntimeTotal(runtimeStateCounts);
        seenAccountIds.add(resolvedAccountId);
        all.push({
          accountId: resolvedAccountId,
          username: info.user?.username ?? failed?.username ?? `Hesap #${info.idx}`,
          avatar: info.user?.avatar ?? '',
          email: '',
          guildCount: guildCnt.get(resolvedAccountId) ?? info.guilds?.length ?? 0,
          targetCount: targetCnt.get(resolvedAccountId) ?? 0,
          status: failed ? 'failed' : 'active',
          tokenHint: failed?.tokenHint ?? null,
          failedReason: failed?.reason ?? null,
          failedError: failed?.errorMsg ?? info.error ?? null,
          failedDetectedAt: failed?.detectedAt ?? null,
          paused: !!pause,
          pauseReason: pause?.reason ?? null,
          pauseRequestedBy: pause?.requestedBy ?? null,
          pauseRequestedAt: pause?.requestedAt ?? null,
          pauseRequestId: pause?.requestId ?? null,
          pauseAcknowledged: !!pause && (totalTargets === 0 || (runtimeStateCounts.running === 0 && runtimeStateCounts.queued === 0 && accountedTargets >= totalTargets)),
          runtimeStateCounts,
          runningTargetCount: runtimeStateCounts.running,
          queuedTargetCount: runtimeStateCounts.queued,
          pausedTargetCount: runtimeStateCounts.paused,
          idx: info.idx,
          ...computeHealthScore(resolvedAccountId),
        });
      }

      const totalUnfiltered = all.length;
      if (q) {
        all = all.filter(a =>
          a.username.toLowerCase().includes(q) ||
          a.accountId.includes(q) ||
          a.email.toLowerCase().includes(q)
        );
      }
      const total = all.length;
      const pages = Math.max(1, Math.ceil(total / limit));
      return res.json({
        accounts:        all.slice(offset, offset + limit),
        total,
        totalUnfiltered,
        globalGuildCount:  uniqueGuilds,
        globalTargetCount: targetsRes.rows.length,
        page,
        limit,
        pages,
      });
    } catch (err: unknown) {
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Hata' });
    }
  });

  // ── A4 — POST /accounts/bulk-action ────────────────────────────────────────
  router.post('/bulk-action', async (req: Request, res: Response) => {
    const { accountIds, action, reason } = req.body ?? {};
    if (!Array.isArray(accountIds) || accountIds.length === 0) {
      return res.status(400).json({ error: 'accountIds[] gerekli' });
    }
    if (!['pause', 'resume'].includes(action as string)) {
      return res.status(400).json({ error: 'action pause|resume olmali' });
    }
    const requestedByUser = requestedBy(req);
    const results: { accountId: string; ok: boolean; error?: string }[] = [];
    for (const accountId of accountIds as string[]) {
      if (typeof accountId !== 'string' || !/^\d{17,20}$/.test(accountId)) continue;
      try {
        if (action === 'pause') {
          const requestId = crypto.randomUUID();
          await db.execute(
            `INSERT INTO ${KEYSPACE}.scrape_paused_accounts (account_id, reason, requested_by, request_id, requested_at) VALUES (?,?,?,?,?)`,
            [accountId, (reason as string | null) ?? null, requestedByUser, requestId, new Date()],
            { prepare: true },
          );
          results.push({ accountId, ok: true });
        } else if (action === 'resume') {
          await db.execute(`DELETE FROM ${KEYSPACE}.scrape_paused_accounts WHERE account_id = ?`, [accountId], { prepare: true });
          results.push({ accountId, ok: true });
        }
      } catch (e: unknown) {
        results.push({ accountId, ok: false, error: e instanceof Error ? e.message : 'Hata' });
      }
    }
    return res.json({ ok: true, results, succeeded: results.filter(r => r.ok).length });
  });

  // ── GET /accounts/:accountId/credentials ────────────────────────────────────────
  router.get('/:accountId/credentials', async (req: Request, res: Response) => {
    const { accountId } = req.params;
    if (!/^\d{17,20}$/.test(accountId)) return res.status(400).json({ error: 'Geçersiz accountId' });
    try {
      const result = await db.execute(
        `SELECT email, account_password, mail_password, mail_site FROM ${KEYSPACE}.account_info WHERE account_id = ?`,
        [accountId],
      );
      if (result.rowLength === 0) return res.json({ email: '', accountPassword: '', mailPassword: '', mailSite: '' });
      const row = result.first();
      return res.json({
        email:           (row['email']            as string) ?? '',
        accountPassword: (row['account_password'] as string) ?? '',
        mailPassword:    (row['mail_password']    as string) ?? '',
        mailSite:        (row['mail_site']        as string) ?? '',
      });
    } catch (err: unknown) {
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Hata' });
    }
  });

  // ── PUT /accounts/:accountId/credentials ─────────────────────────────────────
  router.put('/:accountId/credentials', async (req: Request, res: Response) => {
    const { accountId } = req.params;
    if (!/^\d{17,20}$/.test(accountId)) return res.status(400).json({ error: 'Geçersiz accountId' });
    const { email, accountPassword, mailPassword, mailSite } = req.body as Record<string, string | undefined>;
    try {
      await db.execute(
        `UPDATE ${KEYSPACE}.account_info SET email = ?, account_password = ?, mail_password = ?, mail_site = ? WHERE account_id = ?`,
        [email ?? null, accountPassword ?? null, mailPassword ?? null, mailSite ?? null, accountId],
      );
      return res.json({ ok: true });
    } catch (err: unknown) {
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Hata' });
    }
  });

  return router;
}