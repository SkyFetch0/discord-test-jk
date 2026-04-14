import { Router, Request, Response } from 'express';
import client from 'prom-client';
export declare const httpRequestDuration: client.Histogram<"method" | "route" | "status_code">;
export declare const httpRequestsTotal: client.Counter<"method" | "route" | "status_code">;
export declare const clickhouseQueryDuration: client.Histogram<"query_type">;
export declare const clickhouseSlowQueries: client.Counter<"query_type">;
export declare const scyllaErrorsTotal: client.Counter<"operation">;
export declare const ingesterMessagesIngested: client.Gauge<string>;
export declare const ingesterBatchesFlushed: client.Gauge<string>;
export declare const scraperActiveChannels: client.Gauge<string>;
export declare const scraperTotalScraped: client.Gauge<string>;
export declare const scraperMsgsPerSec: client.Gauge<string>;
export declare function trackChQuery(queryType: string, startMs: number): void;
export declare function metricsMiddleware(req: Request, res: Response, next: () => void): void;
export declare function updateIngesterGauges(metrics: {
    msgsProcessed?: number;
    batchesFlushed?: number;
}): void;
export declare function updateScraperGauges(summary: {
    activeChannels?: number;
    totalScraped?: number;
    msgsPerSec?: number;
}): void;
export declare function metricsRouter(): Router;
/**
 * Documented metrics:
 *
 * | Metric                              | Type      | Labels                          |
 * |-------------------------------------|-----------|---------------------------------|
 * | http_request_duration_seconds        | Histogram | method, route, status_code      |
 * | http_requests_total                  | Counter   | method, route, status_code      |
 * | clickhouse_query_duration_seconds    | Histogram | query_type                      |
 * | clickhouse_slow_queries_total        | Counter   | query_type                      |
 * | scylla_errors_total                  | Counter   | operation                       |
 * | ingester_messages_ingested_total     | Gauge     | —                               |
 * | ingester_batches_flushed_total       | Gauge     | —                               |
 * | scraper_active_channels              | Gauge     | —                               |
 * | scraper_total_scraped_messages       | Gauge     | —                               |
 * | scraper_msgs_per_sec                 | Gauge     | —                               |
 * | + Node.js default metrics (gc, heap, cpu, event loop)                        |
 */
//# sourceMappingURL=metrics.d.ts.map