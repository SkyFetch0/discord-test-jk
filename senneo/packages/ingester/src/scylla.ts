import { Client as CassandraClient, types as CassandraTypes } from 'cassandra-driver';

const KEYSPACE = process.env.SCYLLA_KEYSPACE ?? 'senneo';
const HOSTS    = (process.env.SCYLLA_HOSTS   ?? 'localhost').split(',');

// ── ScyllaDB — Operational tables only ─────────────────────────────────────
// Message tables (messages_by_id, messages_by_channel_bucket, messages_by_author)
// have been migrated to ClickHouse. ScyllaDB is retained for operational state:
//   scrape_targets, scrape_checkpoints, scrape_stats, name_cache,
//   dashboard_users, account_guilds, invite_pool, etc.
//
// This module provides ONLY a connection factory — no message write logic.
// The ingester connects to ScyllaDB for operational table access if needed,
// but all message writes go to ClickHouse.

export async function createScyllaClient(): Promise<CassandraClient> {
  const client = new CassandraClient({
    contactPoints:   HOSTS,
    localDataCenter: 'datacenter1',
    queryOptions: {
      consistency:   CassandraTypes.consistencies.localQuorum,
      prepare:       true,
    },
    pooling: {
      coreConnectionsPerHost: {
        [CassandraTypes.distance.local]:  6,
        [CassandraTypes.distance.remote]: 1,
      },
    },
    socketOptions: {
      connectTimeout: 15_000,
      readTimeout:    30_000,
    },
  });
  await client.connect();
  console.log('[scylla] Connected (operational tables only — messages are in ClickHouse)');
  return client;
}
