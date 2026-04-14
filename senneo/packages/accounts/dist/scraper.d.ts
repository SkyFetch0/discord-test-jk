import { RawMessage } from '@senneo/shared';
type DiscordClient = any;
export interface ScrapeChannelResult {
    kind: 'completed' | 'aborted' | 'error_retryable' | 'error_terminal' | 'noop';
    reason?: string;
    code?: string;
}
export interface ScrapeRateLimitEvent {
    accountId?: string;
    guildId: string;
    channelId: string;
    httpStatus: number;
    retryAfterMs: number;
    waitMs: number;
    adaptiveDelayMs: number;
    attempt: number;
}
export interface ScrapeThrottleHooks {
    beforeFetch?: (ctx: {
        accountId?: string;
        guildId: string;
        channelId: string;
        attempt: number;
    }) => Promise<number | void> | number | void;
    onRateLimit?: (event: ScrapeRateLimitEvent) => Promise<{
        waitMs?: number;
    } | void> | {
        waitMs?: number;
    } | void;
}
export declare function scrapeChannel(client: DiscordClient, guildId: string, channelId: string, onBatch: (messages: RawMessage[]) => Promise<void>, onProgress?: (total: number) => void, signal?: AbortSignal, accountId?: string, throttleHooks?: ScrapeThrottleHooks): Promise<ScrapeChannelResult>;
export {};
//# sourceMappingURL=scraper.d.ts.map