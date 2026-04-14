import type { PauseSource, SchedulerState, ScrapeRuntimeState } from '@senneo/shared';
export interface ChannelStats {
    channelId: string;
    guildId: string;
    totalScraped: number;
    lastBatchSize: number;
    msgsPerSec: number;
    rateLimitHits: number;
    errors: string[];
    lastUpdated: string;
    complete: boolean;
    accountId?: string;
    schedulerState?: SchedulerState;
    pauseSource?: PauseSource;
    stateUpdatedAt?: string;
    stateReason?: string | null;
    workerId?: string | null;
    leaseExpiresAt?: string | null;
    lastErrorClass?: 'retryable' | 'terminal' | null;
    lastErrorCode?: string | null;
    lastErrorAt?: string | null;
}
export declare function ensureChannel(channelId: string, guildId: string, accountId?: string): void;
export declare function initChannel(channelId: string, guildId: string, accountId?: string): void;
export declare function setRuntimeState(channelId: string, state: Omit<ScrapeRuntimeState, 'channelId'> & {
    stateUpdatedAt?: string | null;
}): void;
export declare function getRuntimeState(channelId: string): ScrapeRuntimeState | null;
export declare function flushStats(): Promise<void>;
export declare function recordBatch(channelId: string, batchSize: number, absoluteTotal: number): void;
export declare function recordRateLimit(channelId: string, waitMs: number): void;
export declare function recordError(channelId: string, msg: string): void;
export declare function recordComplete(channelId: string): void;
export declare function removeChannel(channelId: string): void;
export declare function activeChannelCount(): number;
export declare function readAllStats(): Promise<Record<string, unknown>>;
//# sourceMappingURL=stats.d.ts.map