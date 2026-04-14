import { Router } from 'express';
import { Client as CassandraClient } from 'cassandra-driver';
export interface ScrapeTarget {
    guildId: string;
    channelId: string;
    label?: string;
    accountId?: string;
    accountIdx?: number;
    pinnedAccountId?: string;
    pinnedAccountIdx?: number;
}
export declare function accountsRouter(db: CassandraClient): Router;
//# sourceMappingURL=accounts.d.ts.map