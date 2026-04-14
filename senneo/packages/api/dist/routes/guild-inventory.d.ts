/**
 * Guild Inventory, Invite Pool & Per-Account Category Management
 *
 * 3 key features:
 *   1. Account names: fetches Discord username+ID, shows "username - discordId" in badges
 *   2. Import existing guilds: pulls all guilds from account_guilds into system (code=null for non-invite ones)
 *   3. Smart membership: checks ALL accounts when verifying, handles cross-account joins
 *
 * ALL execute() calls use { prepare: true }
 */
import { Router } from 'express';
import { Client as CassandraClient } from 'cassandra-driver';
export declare function autoCategorize(db: CassandraClient): Promise<{
    created: number;
    assigned: number;
    merged: number;
}>;
export declare function guildInventoryRouter(scylla: CassandraClient): Router;
//# sourceMappingURL=guild-inventory.d.ts.map