"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const path_1 = __importDefault(require("path"));
const express_1 = __importDefault(require("express"));
const cassandra_driver_1 = require("cassandra-driver");
const client_1 = require("@clickhouse/client");
const messages_1 = require("./routes/messages");
const live_1 = require("./routes/live");
const health_1 = require("./routes/health");
const accounts_1 = require("./routes/accounts");
const db_1 = require("./routes/db");
const metrics_1 = require("./routes/metrics");
const alerts_1 = require("./routes/alerts");
const errors_1 = require("./routes/errors");
const guild_inventory_1 = require("./routes/guild-inventory");
const auth_1 = require("./routes/auth");
const account_archive_1 = require("./routes/account-archive");
const proxies_1 = require("./routes/proxies");
const system_stats_1 = require("./routes/system-stats");
const PORT = parseInt(process.env.PORT ?? '4000', 10);
const KEYSPACE = process.env.SCYLLA_KEYSPACE ?? 'senneo';
const SCYLLA_HOSTS = (process.env.SCYLLA_HOSTS ?? 'localhost').split(',');
const CH_HOST = process.env.CLICKHOUSE_HOST ?? 'localhost';
const CH_PORT = process.env.CLICKHOUSE_PORT ?? '8123';
const CH_DB = process.env.CLICKHOUSE_DB ?? 'senneo';
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
async function main() {
    const scylla = new cassandra_driver_1.Client({
        contactPoints: SCYLLA_HOSTS,
        localDataCenter: 'datacenter1',
        keyspace: KEYSPACE,
        queryOptions: { consistency: cassandra_driver_1.types.consistencies.localOne },
        pooling: { coreConnectionsPerHost: { [cassandra_driver_1.types.distance.local]: 2 } },
    });
    await scylla.connect();
    console.log('[api] ScyllaDB connected');
    const ch = (0, client_1.createClient)({
        host: `http://${CH_HOST}:${CH_PORT}`,
        database: CH_DB,
        // OPTIMIZE TABLE FINAL on 110M rows takes 300-600s; default 30s causes socket hang up.
        request_timeout: 700_000,
    });
    console.log('[api] ClickHouse ready');
    // Auth schema + seed admin
    await (0, auth_1.initAuthSchema)(scylla);
    console.log('[api] Auth schema ready');
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.use(metrics_1.metricsMiddleware);
    //  Static dashboard 
    app.use(express_1.default.static(path_1.default.join(__dirname, '../public')));
    //  Auth (unprotected) 
    app.use('/auth', (0, auth_1.authRouter)(scylla));
    //  Health (unprotected — for monitoring) 
    app.use('/health', (0, health_1.healthRouter)(scylla, ch, KAFKA_BROKERS));
    //  Admin-only routes (scraper, DB, accounts — sensitive data) 
    app.use('/messages', auth_1.requireAdmin, (0, messages_1.messagesRouter)(scylla, ch));
    app.use('/live', auth_1.requireAdmin, (0, live_1.liveRouter)(ch, scylla));
    app.use('/accounts', auth_1.requireAdmin, (0, accounts_1.accountsRouter)(scylla));
    app.use('/db', auth_1.requireAdmin, (0, db_1.dbRouter)(scylla, ch));
    app.use('/metrics', auth_1.requireAdmin, (0, metrics_1.metricsRouter)());
    app.use('/alerts', auth_1.requireAdmin, (0, alerts_1.alertsRouter)(scylla));
    app.use('/errors', auth_1.requireAdmin, (0, errors_1.errorsRouter)(ch));
    app.use('/guilds', auth_1.requireAdmin, (0, guild_inventory_1.guildInventoryRouter)(scylla));
    app.use('/archive', auth_1.requireAdmin, (0, account_archive_1.accountArchiveRouter)(scylla));
    app.use('/proxies', auth_1.requireAdmin, (0, proxies_1.proxiesRouter)());
    app.use('/system-stats', auth_1.requireAdmin, (0, system_stats_1.systemStatsRouter)(scylla, ch, KAFKA_BROKERS));
    // SPA fallback — serve index.html for / and /admin*
    const indexHtml = path_1.default.join(__dirname, '../public/index.html');
    app.get('/', (_req, res) => res.sendFile(indexHtml));
    app.get('/admin', (_req, res) => res.sendFile(indexHtml));
    app.get('/admin/*', (_req, res) => res.sendFile(indexHtml));
    app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
    app.listen(PORT, () => {
        console.log(`[api] Listening on http://0.0.0.0:${PORT}`);
        console.log(`[api] Dashboard  http://0.0.0.0:${PORT}/admin`);
    });
    const shutdown = async () => {
        await scylla.shutdown();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
main().catch(err => { console.error('[api] Fatal:', err); process.exit(1); });
//# sourceMappingURL=index.js.map