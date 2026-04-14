import { Router } from 'express';
import { Client as CassandraClient } from 'cassandra-driver';
import { ClickHouseClient } from '@clickhouse/client';
export declare function healthRouter(scylla: CassandraClient, ch: ClickHouseClient, brokers: string[]): Router;
//# sourceMappingURL=health.d.ts.map