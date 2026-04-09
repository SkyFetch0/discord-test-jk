import 'dotenv/config';
import path from 'path';
import express from 'express';
import { Client as CassandraClient, types as CassandraTypes } from 'cassandra-driver';
import { createClient as createClickHouseClient } from '@clickhouse/client';
import { messagesRouter } from './routes/messages';
import { liveRouter }     from './routes/live';
import { healthRouter }   from './routes/health';
import { accountsRouter } from './routes/accounts';
import { dbRouter }       from './routes/db';
import { metricsRouter, metricsMiddleware } from './routes/metrics';
import { alertsRouter } from './routes/alerts';
import { errorsRouter } from './routes/errors';
import { guildInventoryRouter } from './routes/guild-inventory';
import { authRouter, initAuthSchema, requireAuth, requireAdmin } from './routes/auth';
import { accountArchiveRouter } from './routes/account-archive';
import { proxiesRouter } from './routes/proxies';
import { systemStatsRouter } from './routes/system-stats';

const PORT         = parseInt(process.env.PORT          ?? '4000', 10);
const KEYSPACE     = process.env.SCYLLA_KEYSPACE        ?? 'senneo';
const SCYLLA_HOSTS = (process.env.SCYLLA_HOSTS          ?? 'localhost').split(',');
const CH_HOST      = process.env.CLICKHOUSE_HOST        ?? 'localhost';
const CH_PORT      = process.env.CLICKHOUSE_PORT        ?? '8123';
const CH_DB        = process.env.CLICKHOUSE_DB          ?? 'senneo_messages';
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS        ?? 'localhost:9092').split(',');

async function main(): Promise<void> {
  const scylla = new CassandraClient({
    contactPoints:   SCYLLA_HOSTS,
    localDataCenter: 'datacenter1',
    keyspace:        KEYSPACE,
    queryOptions: { consistency: CassandraTypes.consistencies.localOne },
    pooling: { coreConnectionsPerHost: { [CassandraTypes.distance.local]: 2 } },
  });
  await scylla.connect();
  console.log('[api] ScyllaDB connected');

  const ch = createClickHouseClient({
    host:            `http://${CH_HOST}:${CH_PORT}`,
    database:        CH_DB,
    // OPTIMIZE TABLE FINAL on 110M rows takes 300-600s; default 30s causes socket hang up.
    request_timeout: 700_000,
  });
  console.log('[api] ClickHouse ready');

  // Auth schema + seed admin
  await initAuthSchema(scylla);
  console.log('[api] Auth schema ready');

  const app = express();
  app.use(express.json());
  app.use(metricsMiddleware);

  //  Static dashboard 
  app.use(express.static(path.join(__dirname, '../public')));

  //  Auth (unprotected) 
  app.use('/auth', authRouter(scylla));

  //  Health (unprotected — for monitoring) 
  app.use('/health',   healthRouter(scylla, ch, KAFKA_BROKERS));

  //  Admin-only routes (scraper, DB, accounts — sensitive data) 
  app.use('/messages', requireAdmin, messagesRouter(scylla, ch));
  app.use('/live',     requireAdmin, liveRouter(ch, scylla));
  app.use('/accounts', requireAdmin, accountsRouter(scylla));
  app.use('/db',       requireAdmin, dbRouter(scylla, ch));
  app.use('/metrics',  requireAdmin, metricsRouter());
  app.use('/alerts',   requireAdmin, alertsRouter(scylla));
  app.use('/errors',   requireAdmin, errorsRouter(ch));
  app.use('/guilds',   requireAdmin, guildInventoryRouter(scylla));
  app.use('/archive',  requireAdmin, accountArchiveRouter(scylla));
  app.use('/proxies',  requireAdmin, proxiesRouter());
  app.use('/system-stats', requireAdmin, systemStatsRouter(scylla, ch, KAFKA_BROKERS));

  // SPA fallback — serve index.html for / and /admin*
  const indexHtml = path.join(__dirname, '../public/index.html');
  app.get('/',       (_req, res) => res.sendFile(indexHtml));
  app.get('/admin',  (_req, res) => res.sendFile(indexHtml));
  app.get('/admin/*',(_req, res) => res.sendFile(indexHtml));

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  app.listen(PORT, () => {
    console.log(`[api] Listening on http://0.0.0.0:${PORT}`);
    console.log(`[api] Dashboard  http://0.0.0.0:${PORT}/admin`);
  });

  const shutdown = async () => {
    await scylla.shutdown();
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => { console.error('[api] Fatal:', err); process.exit(1); });