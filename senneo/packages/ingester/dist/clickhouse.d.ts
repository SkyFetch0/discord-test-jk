import { ClickHouseClient } from '@clickhouse/client';
import { RawMessage } from '@senneo/shared';
export declare function createClickHouseClient(): Promise<ClickHouseClient>;
export declare function writeMessages(client: ClickHouseClient, messages: RawMessage[]): Promise<void>;
//# sourceMappingURL=clickhouse.d.ts.map