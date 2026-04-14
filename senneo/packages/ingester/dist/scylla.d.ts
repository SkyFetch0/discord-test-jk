import { Client as CassandraClient } from 'cassandra-driver';
import { RawMessage } from '@senneo/shared';
export declare function createScyllaClient(): Promise<CassandraClient>;
export declare function writeMessages(client: CassandraClient, messages: RawMessage[]): Promise<void>;
//# sourceMappingURL=scylla.d.ts.map