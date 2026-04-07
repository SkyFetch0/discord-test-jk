import { Router, Request, Response } from 'express';
import client, { Registry, Counter, Histogram, Summary, Gauge } from 'prom-client';

const register = new Registry();
client.collectDefaultMetrics({ register });

// ── HTTP request metrics ──
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

// ── ClickHouse query metrics ──
export const clickhouseQueryDuration = new Histogram({
  name: 'clickhouse_query_duration_seconds',
  help: 'Duration of ClickHouse queries in seconds',
  labelNames: ['query_type'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const clickhouseSlowQueries = new Counter({
  name: 'clickhouse_slow_queries_total',
  help: 'Number of ClickHouse queries exceeding 2s threshold',
  labelNames: ['query_type'] as const,
  registers: [register],
});

// ── Scylla metrics ──
export const scyllaErrorsTotal = new Counter({
  name: 'scylla_errors_total',
  help: 'Total Scylla/Cassandra errors',
  labelNames: ['operation'] as const,
  registers: [register],
});

// ── Ingester metrics (read from JSON file) ──
export const ingesterMessagesIngested = new Gauge({
  name: 'ingester_messages_ingested_total',
  help: 'Total messages ingested (from ingester metrics file)',
  registers: [register],
});

export const ingesterBatchesFlushed = new Gauge({
  name: 'ingester_batches_flushed_total',
  help: 'Total batches flushed by ingester',
  registers: [register],
});

// ── Scraper metrics (from scraper stats cache) ──
export const scraperActiveChannels = new Gauge({
  name: 'scraper_active_channels',
  help: 'Number of currently active scraping channels',
  registers: [register],
});

export const scraperTotalScraped = new Gauge({
  name: 'scraper_total_scraped_messages',
  help: 'Total messages scraped across all channels',
  registers: [register],
});

export const scraperMsgsPerSec = new Gauge({
  name: 'scraper_msgs_per_sec',
  help: 'Current aggregate scraper throughput (msg/s)',
  registers: [register],
});

// ── Slow query logging helper ──
const SLOW_QUERY_THRESHOLD_MS = 2000;

export function trackChQuery(queryType: string, startMs: number): void {
  const elapsed = (Date.now() - startMs) / 1000;
  clickhouseQueryDuration.labels(queryType).observe(elapsed);
  if (elapsed * 1000 > SLOW_QUERY_THRESHOLD_MS) {
    clickhouseSlowQueries.labels(queryType).inc();
    console.warn(`[metrics] Slow CH query: ${queryType} took ${(elapsed * 1000).toFixed(0)}ms`);
  }
}

// ── Express middleware for HTTP metrics ──
export function metricsMiddleware(req: Request, res: Response, next: () => void): void {
  const start = Date.now();
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route?.path ?? req.path;
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    httpRequestDuration.labels(labels).observe(duration);
    httpRequestsTotal.labels(labels).inc();
  });
  next();
}

// ── Update gauges from external sources ──
export function updateIngesterGauges(metrics: { msgsProcessed?: number; batchesFlushed?: number }): void {
  if (metrics.msgsProcessed != null) ingesterMessagesIngested.set(metrics.msgsProcessed);
  if (metrics.batchesFlushed != null) ingesterBatchesFlushed.set(metrics.batchesFlushed);
}

export function updateScraperGauges(summary: { activeChannels?: number; totalScraped?: number; msgsPerSec?: number }): void {
  if (summary.activeChannels != null) scraperActiveChannels.set(summary.activeChannels);
  if (summary.totalScraped != null) scraperTotalScraped.set(summary.totalScraped);
  if (summary.msgsPerSec != null) scraperMsgsPerSec.set(summary.msgsPerSec);
}

// ── Router: GET /metrics ──
export function metricsRouter(): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      res.set('Content-Type', register.contentType);
      res.end(await register.metrics());
    } catch (err) {
      res.status(500).end();
    }
  });

  return router;
}

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
