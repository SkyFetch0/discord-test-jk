import { Router } from 'express';
import { ClickHouseClient } from '@clickhouse/client';
import { Client as CassandraClient } from 'cassandra-driver';
export declare function liveRouter(ch: ClickHouseClient, scylla: CassandraClient): Router;
//# sourceMappingURL=live.d.ts.map