import { Router } from 'express';
import { Client as CassandraClient } from 'cassandra-driver';
import { ClickHouseClient } from '@clickhouse/client';
export declare function systemStatsRouter(scylla: CassandraClient, ch: ClickHouseClient, brokers: string[]): Router;
//# sourceMappingURL=system-stats.d.ts.map