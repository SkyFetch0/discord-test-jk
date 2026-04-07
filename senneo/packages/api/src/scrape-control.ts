import { Client as CassandraClient } from 'cassandra-driver';
import type { PauseSource, SchedulerState } from '@senneo/shared';

const KEYSPACE = process.env.SCYLLA_KEYSPACE ?? 'senneo';
const RUNTIME_STATE_SELECT = `SELECT channel_id, scheduler_state, pause_source, state_updated_at, state_reason, worker_id, lease_expires_at, last_error_class, last_error_code, last_error_at FROM ${KEYSPACE}.scrape_stats`;

export interface PausedAccountRow {
  accountId: string;
  reason: string | null;
  requestedBy: string | null;
  requestId: string | null;
  requestedAt: string | null;
}

export interface PausedChannelRow {
  channelId: string;
  guildId: string;
  accountId: string;
  reason: string | null;
  requestedBy: string | null;
  requestId: string | null;
  requestedAt: string | null;
}

export interface RuntimeStateRow {
  channelId: string;
  schedulerState: SchedulerState | null;
  pauseSource: PauseSource | null;
  stateUpdatedAt: string | null;
  stateReason: string | null;
  workerId: string | null;
  leaseExpiresAt: string | null;
  lastErrorClass: 'retryable' | 'terminal' | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
}

export interface PauseIntentView {
  pauseRequested: boolean;
  accountPauseRequested: boolean;
  channelPauseRequested: boolean;
  requestedPauseSource: PauseSource;
  pauseReason: string | null;
  pauseRequestedBy: string | null;
  pauseRequestedAt: string | null;
  pauseRequestId: string | null;
}

export type RuntimeStateCounts = Record<SchedulerState, number>;

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return null;
}

function mapRuntimeRow(row: Record<string, unknown>): RuntimeStateRow {
  return {
    channelId: (row['channel_id'] as string) ?? '',
    schedulerState: (row['scheduler_state'] as SchedulerState | null) ?? null,
    pauseSource: (row['pause_source'] as PauseSource | null) ?? null,
    stateUpdatedAt: toIso(row['state_updated_at']),
    stateReason: (row['state_reason'] as string | null) ?? null,
    workerId: (row['worker_id'] as string | null) ?? null,
    leaseExpiresAt: toIso(row['lease_expires_at']),
    lastErrorClass: (row['last_error_class'] as 'retryable' | 'terminal' | null) ?? null,
    lastErrorCode: (row['last_error_code'] as string | null) ?? null,
    lastErrorAt: toIso(row['last_error_at']),
  };
}

export function combinePauseSource(accountPaused: boolean, channelPaused: boolean): PauseSource {
  if (accountPaused && channelPaused) return 'both';
  if (channelPaused) return 'channel';
  if (accountPaused) return 'account';
  return 'none';
}

export function buildPauseIntentView(
  ownerAccountId: string | undefined | null,
  channelId: string,
  pausedAccounts: Map<string, PausedAccountRow>,
  pausedChannels: Map<string, PausedChannelRow>,
): PauseIntentView {
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

export function isPauseAcknowledged(
  runtimeState: SchedulerState | null | undefined,
  complete: boolean,
  pauseRequested: boolean,
): boolean {
  if (!pauseRequested) return false;
  if (complete) return true;
  return runtimeState === 'paused';
}

export function emptyRuntimeStateCounts(): RuntimeStateCounts {
  return {
    queued: 0,
    running: 0,
    paused: 0,
    completed: 0,
    error_retryable: 0,
    error_terminal: 0,
  };
}

export function addRuntimeStateCount(counts: RuntimeStateCounts, state: SchedulerState | null | undefined): void {
  if (!state) return;
  counts[state] = (counts[state] ?? 0) + 1;
}

export function countedRuntimeTotal(counts: RuntimeStateCounts): number {
  return counts.queued + counts.running + counts.paused + counts.completed + counts.error_retryable + counts.error_terminal;
}

export async function readPausedAccounts(db: CassandraClient): Promise<Map<string, PausedAccountRow>> {
  const result = await db.execute(
    `SELECT account_id, reason, requested_by, request_id, requested_at FROM ${KEYSPACE}.scrape_paused_accounts`,
  ).catch(() => null);
  if (!result) return new Map();
  const entries: Array<[string, PausedAccountRow]> = result.rows.map(row => {
    const accountId = (row['account_id'] as string) ?? '';
    return [accountId, {
      accountId,
      reason: (row['reason'] as string | null) ?? null,
      requestedBy: (row['requested_by'] as string | null) ?? null,
      requestId: (row['request_id'] as string | null) ?? null,
      requestedAt: toIso(row['requested_at']),
    }] as [string, PausedAccountRow];
  }).filter(([accountId]) => !!accountId);
  return new Map(entries);
}

export async function readPausedChannels(db: CassandraClient): Promise<Map<string, PausedChannelRow>> {
  const result = await db.execute(
    `SELECT channel_id, guild_id, account_id, reason, requested_by, request_id, requested_at FROM ${KEYSPACE}.scrape_paused_channels`,
  ).catch(() => null);
  if (!result) return new Map();
  const entries: Array<[string, PausedChannelRow]> = result.rows.map(row => {
    const channelId = (row['channel_id'] as string) ?? '';
    return [channelId, {
      channelId,
      guildId: (row['guild_id'] as string) ?? '',
      accountId: (row['account_id'] as string) ?? '',
      reason: (row['reason'] as string | null) ?? null,
      requestedBy: (row['requested_by'] as string | null) ?? null,
      requestId: (row['request_id'] as string | null) ?? null,
      requestedAt: toIso(row['requested_at']),
    }] as [string, PausedChannelRow];
  }).filter(([channelId]) => !!channelId);
  return new Map(entries);
}

export async function readAllRuntimeStates(db: CassandraClient): Promise<Map<string, RuntimeStateRow>> {
  const result = await db.execute(RUNTIME_STATE_SELECT).catch(() => null);
  if (!result) return new Map();
  const entries: Array<[string, RuntimeStateRow]> = result.rows.map(row => {
    const runtime = mapRuntimeRow(row as Record<string, unknown>);
    return [runtime.channelId, runtime] as [string, RuntimeStateRow];
  }).filter(([channelId]) => !!channelId);
  return new Map(entries);
}

export async function readRuntimeStatesByChannelIds(db: CassandraClient, channelIds: string[]): Promise<Map<string, RuntimeStateRow>> {
  const ids = [...new Set(channelIds.map(id => id.trim()).filter(Boolean))];
  if (ids.length === 0) return new Map();
  if (ids.length > 150) {
    const all = await readAllRuntimeStates(db);
    const filtered: Array<[string, RuntimeStateRow]> = ids
      .map(id => {
        const runtime = all.get(id);
        return runtime ? [id, runtime] as [string, RuntimeStateRow] : null;
      })
      .filter((entry): entry is [string, RuntimeStateRow] => entry != null);
    return new Map(filtered);
  }

  const out = new Map<string, RuntimeStateRow>();
  const chunkSize = 50;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const rows = await Promise.all(chunk.map(async channelId => {
      const result = await db.execute(
        `${RUNTIME_STATE_SELECT} WHERE channel_id = ?`,
        [channelId],
      ).catch(() => null);
      const row = result?.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      const runtime = mapRuntimeRow(row);
      return [channelId, runtime] as [string, RuntimeStateRow];
    }));
    rows.filter((entry): entry is [string, RuntimeStateRow] => entry != null).forEach(([channelId, runtime]) => {
      out.set(channelId, runtime);
    });
  }
  return out;
}
