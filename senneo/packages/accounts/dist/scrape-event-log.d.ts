export type ScrapeEventType = 'enqueue' | 'dequeue' | 'scrape_start' | 'scrape_end' | 'scrape_error' | 'rate_limit' | 'batch' | 'account_login' | 'account_error' | 'target_change' | 'info';
export interface ScrapeEvent {
    id: number;
    ts: string;
    type: ScrapeEventType;
    accountId?: string;
    accountIdx?: number | string;
    accountName?: string;
    channelId?: string;
    guildId?: string;
    message: string;
    detail?: string;
}
/** O(1) — append event to ring buffer. No I/O. */
export declare function emit(type: ScrapeEventType, message: string, opts?: {
    accountId?: string;
    accountIdx?: number | string;
    accountName?: string;
    channelId?: string;
    guildId?: string;
    detail?: string;
}): void;
/** Get events with cursor-based pagination. */
export declare function getEvents(opts?: {
    since?: number;
    limit?: number;
}): {
    events: ScrapeEvent[];
    cursor: number;
};
/** Get total event count and buffer stats. */
export declare function getStats(): {
    total: number;
    bufferSize: number;
    maxSize: number;
    oldestId: number;
    newestId: number;
};
/** Start the background flush timer. */
export declare function startEventLog(): void;
/** Stop and final flush. */
export declare function stopEventLog(): Promise<void>;
//# sourceMappingURL=scrape-event-log.d.ts.map