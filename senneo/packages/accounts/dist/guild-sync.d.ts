import { Client as CassandraClient } from 'cassandra-driver';
import { AccountConfig } from '@senneo/shared';
import type { Agent } from 'http';
export interface GuildSyncAccount {
    accountId: string;
    accountIdx: number;
    config: AccountConfig;
    agent?: Agent;
}
export declare function startGuildSync(db: CassandraClient, accounts: GuildSyncAccount[]): void;
export declare function stopGuildSync(): void;
export declare function updateGuildSyncAccounts(accounts: GuildSyncAccount[]): void;
export declare function triggerGuildSync(): Promise<void>;
export declare function getGuildSyncState(): {
    syncing: boolean;
    lastSyncAt: string | null;
    syncedAccounts: number;
    totalGuilds: number;
};
//# sourceMappingURL=guild-sync.d.ts.map