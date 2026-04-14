"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.scraperMsgsPerSec = exports.scraperTotalScraped = exports.scraperActiveChannels = exports.ingesterBatchesFlushed = exports.ingesterMessagesIngested = exports.scyllaErrorsTotal = exports.clickhouseSlowQueries = exports.clickhouseQueryDuration = exports.httpRequestsTotal = exports.httpRequestDuration = void 0;
exports.trackChQuery = trackChQuery;
exports.metricsMiddleware = metricsMiddleware;
exports.updateIngesterGauges = updateIngesterGauges;
exports.updateScraperGauges = updateScraperGauges;
exports.metricsRouter = metricsRouter;
const express_1 = require("express");
const prom_client_1 = __importStar(require("prom-client"));
const register = new prom_client_1.Registry();
prom_client_1.default.collectDefaultMetrics({ register });
// ── HTTP request metrics ──
exports.httpRequestDuration = new prom_client_1.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [register],
});
exports.httpRequestsTotal = new prom_client_1.Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status_code'],
    registers: [register],
});
// ── ClickHouse query metrics ──
exports.clickhouseQueryDuration = new prom_client_1.Histogram({
    name: 'clickhouse_query_duration_seconds',
    help: 'Duration of ClickHouse queries in seconds',
    labelNames: ['query_type'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
    registers: [register],
});
exports.clickhouseSlowQueries = new prom_client_1.Counter({
    name: 'clickhouse_slow_queries_total',
    help: 'Number of ClickHouse queries exceeding 2s threshold',
    labelNames: ['query_type'],
    registers: [register],
});
// ── Scylla metrics ──
exports.scyllaErrorsTotal = new prom_client_1.Counter({
    name: 'scylla_errors_total',
    help: 'Total Scylla/Cassandra errors',
    labelNames: ['operation'],
    registers: [register],
});
// ── Ingester metrics (read from JSON file) ──
exports.ingesterMessagesIngested = new prom_client_1.Gauge({
    name: 'ingester_messages_ingested_total',
    help: 'Total messages ingested (from ingester metrics file)',
    registers: [register],
});
exports.ingesterBatchesFlushed = new prom_client_1.Gauge({
    name: 'ingester_batches_flushed_total',
    help: 'Total batches flushed by ingester',
    registers: [register],
});
// ── Scraper metrics (from scraper stats cache) ──
exports.scraperActiveChannels = new prom_client_1.Gauge({
    name: 'scraper_active_channels',
    help: 'Number of currently active scraping channels',
    registers: [register],
});
exports.scraperTotalScraped = new prom_client_1.Gauge({
    name: 'scraper_total_scraped_messages',
    help: 'Total messages scraped across all channels',
    registers: [register],
});
exports.scraperMsgsPerSec = new prom_client_1.Gauge({
    name: 'scraper_msgs_per_sec',
    help: 'Current aggregate scraper throughput (msg/s)',
    registers: [register],
});
// ── Slow query logging helper ──
const SLOW_QUERY_THRESHOLD_MS = 2000;
function trackChQuery(queryType, startMs) {
    const elapsed = (Date.now() - startMs) / 1000;
    exports.clickhouseQueryDuration.labels(queryType).observe(elapsed);
    if (elapsed * 1000 > SLOW_QUERY_THRESHOLD_MS) {
        exports.clickhouseSlowQueries.labels(queryType).inc();
        console.warn(`[metrics] Slow CH query: ${queryType} took ${(elapsed * 1000).toFixed(0)}ms`);
    }
}
// ── Express middleware for HTTP metrics ──
function metricsMiddleware(req, res, next) {
    const start = Date.now();
    res.on('finish', () => {
        const duration = (Date.now() - start) / 1000;
        const route = req.route?.path ?? req.path;
        const labels = { method: req.method, route, status_code: String(res.statusCode) };
        exports.httpRequestDuration.labels(labels).observe(duration);
        exports.httpRequestsTotal.labels(labels).inc();
    });
    next();
}
// ── Update gauges from external sources ──
function updateIngesterGauges(metrics) {
    if (metrics.msgsProcessed != null)
        exports.ingesterMessagesIngested.set(metrics.msgsProcessed);
    if (metrics.batchesFlushed != null)
        exports.ingesterBatchesFlushed.set(metrics.batchesFlushed);
}
function updateScraperGauges(summary) {
    if (summary.activeChannels != null)
        exports.scraperActiveChannels.set(summary.activeChannels);
    if (summary.totalScraped != null)
        exports.scraperTotalScraped.set(summary.totalScraped);
    if (summary.msgsPerSec != null)
        exports.scraperMsgsPerSec.set(summary.msgsPerSec);
}
// ── Router: GET /metrics ──
function metricsRouter() {
    const router = (0, express_1.Router)();
    router.get('/', async (_req, res) => {
        try {
            res.set('Content-Type', register.contentType);
            res.end(await register.metrics());
        }
        catch (err) {
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
//# sourceMappingURL=metrics.js.map