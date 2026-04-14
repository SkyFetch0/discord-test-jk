import { Router } from 'express';
import { ClickHouseClient } from '@clickhouse/client';
import { Client as CassandraClient } from 'cassandra-driver';
export declare function messagesRouter(scylla: CassandraClient, ch: ClickHouseClient): Router;
//# sourceMappingURL=messages.d.ts.map