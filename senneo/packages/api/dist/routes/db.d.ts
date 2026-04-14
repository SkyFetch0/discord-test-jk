import { Router } from 'express';
import { Client as CassandraClient } from 'cassandra-driver';
import { ClickHouseClient } from '@clickhouse/client';
export declare function dbRouter(scylla: CassandraClient, ch: ClickHouseClient): Router;
//# sourceMappingURL=db.d.ts.map