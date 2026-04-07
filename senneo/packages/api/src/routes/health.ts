import { Router, Request, Response } from 'express';
import { Client as CassandraClient } from 'cassandra-driver';
import { ClickHouseClient } from '@clickhouse/client';

interface ServiceHealth {
  ok:         boolean;
  latencyMs?: number;
  error?:     string;
}

async function checkScylla(scylla: CassandraClient): Promise<ServiceHealth> {
  const t = Date.now();
  try {
    await scylla.execute('SELECT now() FROM system.local');
    return { ok: true, latencyMs: Date.now() - t };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'unknown' };
  }
}

async function checkClickHouse(ch: ClickHouseClient): Promise<ServiceHealth> {
  const t = Date.now();
  try {
    const r = await ch.query({ query: 'SELECT 1', format: 'JSONEachRow' });
    await r.json();
    return { ok: true, latencyMs: Date.now() - t };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'unknown' };
  }
}

async function checkKafka(brokers: string[]): Promise<ServiceHealth> {
  const t = Date.now();
  try {
    const { Kafka } = await import('kafkajs');
    const kafka = new Kafka({ clientId: 'senneo-health', brokers, retry: { retries: 1 } });
    const admin = kafka.admin();
    await admin.connect();
    await admin.listTopics();
    await admin.disconnect();
    return { ok: true, latencyMs: Date.now() - t };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'unknown' };
  }
}

export function healthRouter(
  scylla:  CassandraClient,
  ch:      ClickHouseClient,
  brokers: string[],
): Router {
  const router = Router();

  // GET /health — simple liveness (load balancer ping)
  router.get('/', (_req: Request, res: Response) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
  });

  // GET /health/all — deep check of all services
  router.get('/all', async (_req: Request, res: Response) => {
    const [scyllaH, chH, kafkaH] = await Promise.all([
      checkScylla(scylla),
      checkClickHouse(ch),
      checkKafka(brokers),
    ]);

    const allOk = scyllaH.ok && chH.ok && kafkaH.ok;
    res.status(allOk ? 200 : 503).json({
      API:        { ok: true, latencyMs: 0 },
      ScyllaDB:   scyllaH,
      ClickHouse: chH,
      Kafka:      kafkaH,
    });
  });

  return router;
}