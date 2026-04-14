import { Client as CassandraClient } from 'cassandra-driver';
import type { PauseSource, SchedulerState } from '@senneo/shared';
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
export declare function combinePauseSource(accountPaused: boolean, channelPaused: boolean): PauseSource;
export declare function buildPauseIntentView(ownerAccountId: string | undefined | null, channelId: string, pausedAccounts: Map<string, PausedAccountRow>, pausedChannels: Map<string, PausedChannelRow>): PauseIntentView;
export declare function isPauseAcknowledged(runtimeState: SchedulerState | null | undefined, complete: boolean, pauseRequested: boolean): boolean;
export declare function emptyRuntimeStateCounts(): RuntimeStateCounts;
export declare function addRuntimeStateCount(counts: RuntimeStateCounts, state: SchedulerState | null | undefined): void;
export declare function countedRuntimeTotal(counts: RuntimeStateCounts): number;
export declare function readPausedAccounts(db: CassandraClient): Promise<Map<string, PausedAccountRow>>;
export declare function readPausedChannels(db: CassandraClient): Promise<Map<string, PausedChannelRow>>;
export declare function readAllRuntimeStates(db: CassandraClient): Promise<Map<string, RuntimeStateRow>>;
export declare function readRuntimeStatesByChannelIds(db: CassandraClient, channelIds: string[]): Promise<Map<string, RuntimeStateRow>>;
//# sourceMappingURL=scrape-control.d.ts.map