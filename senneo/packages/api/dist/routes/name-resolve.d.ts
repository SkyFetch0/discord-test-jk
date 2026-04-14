import { Client as CassandraClient } from 'cassandra-driver';
import { ClickHouseClient } from '@clickhouse/client';
/**
 * Batch lookup channel/guild names from Scylla name_cache.
 * Returns Map<id, name>. Scales to large ID lists via chunked IN queries.
 */
export declare function fetchNamesByIds(scylla: CassandraClient, ids: string[]): Promise<Map<string, string>>;
/**
 * Batch lookup guild icon hashes from Scylla name_cache.
 * Returns Map<guildId, iconHash>. Only returns rows where icon is set.
 */
export declare function fetchIconsByIds(scylla: CassandraClient, ids: string[]): Promise<Map<string, string>>;
/**
 * Enrich an array of message rows (from ClickHouse) with:
 *   1. channel_name / guild_name from Scylla name_cache
 *   2. author_avatar / display_name / is_bot from CH users_latest (when ch provided)
 *
 * Avatar priority: message row hash (non-empty) > users_latest hash > empty (frontend fallback).
 * Mutates rows in-place and returns them.
 */
export declare function enrichMessagesWithNames<T extends Record<string, unknown>>(scylla: CassandraClient, rows: T[], ch?: ClickHouseClient): Promise<T[]>;
//# sourceMappingURL=name-resolve.d.ts.map