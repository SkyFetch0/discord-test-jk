"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createClickHouseClient = createClickHouseClient;
exports.writeMessages = writeMessages;
const client_1 = require("@clickhouse/client");
const CH_HOST = process.env.CLICKHOUSE_HOST ?? 'localhost';
const CH_PORT = process.env.CLICKHOUSE_PORT ?? '8123';
const CH_DB = process.env.CLICKHOUSE_DB ?? 'senneo';
function toChTs(iso) {
    return iso.replace('T', ' ').replace('Z', '');
}
async function createClickHouseClient() {
    const client = (0, client_1.createClient)({
        host: `http://${CH_HOST}:${CH_PORT}`,
        database: CH_DB,
        clickhouse_settings: {
            async_insert: 1,
            wait_for_async_insert: 1,
            async_insert_max_data_size: String(50 * 1024 * 1024),
            async_insert_busy_timeout_ms: 500,
            async_insert_max_query_number: '1000',
            // FIX: Dedup identical async inserts within the same buffer window.
            // Prevents duplicates from rapid Kafka redeliveries within flush interval.
            async_insert_deduplicate: 1,
        },
        request_timeout: 30_000,
        max_open_connections: 10,
    });
    await initSchema(client);
    return client;
}
async function initSchema(client) {
    await client.exec({ query: `CREATE DATABASE IF NOT EXISTS ${CH_DB}` });
    await client.exec({
        query: `
      CREATE TABLE IF NOT EXISTS ${CH_DB}.messages (
        message_id     UInt64,
        channel_id     UInt64,
        guild_id       UInt64,
        author_id      UInt64,
        author_name    String COMMENT 'Discord global username (msg.author.username)',
        nick           String COMMENT 'Guild-specific nickname (msg.member.nickname)',
        content        String,
        ts             DateTime64(3, 'UTC'),
        badge_mask     UInt64,
        has_attachment UInt8,
        embed_count    UInt8,
        ref_msg_id     UInt64,
        media_type     LowCardinality(String) DEFAULT 'none',
        media_urls     Array(String)          DEFAULT [],
        sticker_names  Array(String)          DEFAULT [],
        author_avatar  String                 DEFAULT '',
        inserted_at    DateTime64(3, 'UTC')   DEFAULT now64(),
        created_date   Date   MATERIALIZED toDate(ts),
        created_month  UInt32 MATERIALIZED toYYYYMM(ts)
      )
      -- FIX: ReplacingMergeTree deduplicates rows with same ORDER BY key during merges.
      -- Keeps the row with the greatest inserted_at (latest write wins).
      ENGINE = ReplacingMergeTree(inserted_at)
      PARTITION BY toYYYYMM(ts)
      ORDER BY (guild_id, channel_id, ts, message_id)
      SETTINGS index_granularity = 8192
    `,
    });
    await client.exec({
        query: `
      CREATE TABLE IF NOT EXISTS ${CH_DB}.users_latest (
        author_id    UInt64,
        author_name  String COMMENT 'Discord global username (NOT display name)',
        badge_mask   UInt64,
        last_seen_ts DateTime64(3, 'UTC'),
        sample_guild    UInt64,
        author_avatar   String DEFAULT ''
      )
      ENGINE = ReplacingMergeTree(last_seen_ts)
      ORDER BY (author_id)
    `,
    });
    // Materialized view: per-channel daily activity (pre-aggregated for fast dashboards)
    await client.exec({
        query: `
      CREATE MATERIALIZED VIEW IF NOT EXISTS ${CH_DB}.channel_daily_mv
      ENGINE = SummingMergeTree()
      ORDER BY (channel_id, date)
      POPULATE
      AS SELECT
        channel_id,
        toDate(ts) AS date,
        count()    AS message_count,
        uniq(author_id) AS unique_authors
      FROM ${CH_DB}.messages
      GROUP BY channel_id, date
    `,
    });
    // Identity history log v2 — ReplacingMergeTree for automatic dedup.
    // ORDER BY includes value: each distinct (author, field, guild, value) = one row.
    // ReplacingMergeTree(observed_ts) keeps the newest observation per unique key.
    // Duplicates from restart / multi-instance / LRU eviction merge away automatically.
    // LRU cache stays as write-volume optimization, NOT correctness dependency.
    await client.exec({
        query: `
      CREATE TABLE IF NOT EXISTS ${CH_DB}.user_identity_log (
        author_id      UInt64,
        field          LowCardinality(String) COMMENT 'username | display_name | avatar | nick',
        value          String,
        guild_id       UInt64 DEFAULT 0 COMMENT '0=global, >0=guild-specific (nick)',
        observed_ts    DateTime64(3, 'UTC') COMMENT 'ingestion time (when change was detected)',
        source_msg_ts  DateTime64(3, 'UTC') DEFAULT '1970-01-01' COMMENT 'original message timestamp (informational)',
        inserted_at    DateTime64(3, 'UTC') DEFAULT now64()
      )
      ENGINE = ReplacingMergeTree(observed_ts)
      PARTITION BY toYYYYMM(observed_ts)
      ORDER BY (author_id, field, guild_id, value)
      TTL toDateTime(observed_ts) + INTERVAL 365 DAY
      SETTINGS index_granularity = 8192
    `,
    });
    // Centralized error log — all services write here via direct CH insert.
    // MergeTree (append-only, no dedup needed), 30-day TTL, partitioned by day.
    await client.exec({
        query: `
      CREATE TABLE IF NOT EXISTS ${CH_DB}.error_log (
        ts               DateTime64(3, 'UTC'),
        severity         LowCardinality(String) COMMENT 'warn | error | critical',
        category         LowCardinality(String) COMMENT 'rate_limit | discord_api | scylla_write | ...',
        source           LowCardinality(String) COMMENT 'accounts | ingester | api | bot | other',
        message          String,
        detail           String           DEFAULT '',
        fingerprint      String           DEFAULT '',
        count            UInt32           DEFAULT 1,
        channel_id       String           DEFAULT '',
        guild_id         String           DEFAULT '',
        account_id       String           DEFAULT '',
        account_idx      Int32            DEFAULT -1,
        kafka_topic      String           DEFAULT '',
        error_code       String           DEFAULT '',
        correlation_id   String           DEFAULT '',
        inserted_at      DateTime64(3, 'UTC') DEFAULT now64()
      )
      ENGINE = MergeTree()
      PARTITION BY toDate(ts)
      ORDER BY (source, category, ts)
      TTL toDateTime(ts) + INTERVAL 30 DAY
      SETTINGS index_granularity = 8192
    `,
    });
    await client.exec({ query: `ALTER TABLE ${CH_DB}.error_log ADD COLUMN IF NOT EXISTS account_id String DEFAULT ''` }).catch(() => { });
    // Migration: add source_msg_ts to existing table if it was created with old schema
    await client.exec({ query: `ALTER TABLE ${CH_DB}.user_identity_log ADD COLUMN IF NOT EXISTS source_msg_ts DateTime64(3, 'UTC') DEFAULT '1970-01-01'` }).catch(() => { });
    // Idempotent column migrations (metadata-only, no data rewrite)
    await client.exec({ query: `ALTER TABLE ${CH_DB}.messages ADD COLUMN IF NOT EXISTS author_avatar String DEFAULT ''` }).catch(() => { });
    await client.exec({ query: `ALTER TABLE ${CH_DB}.messages ADD COLUMN IF NOT EXISTS is_bot UInt8 DEFAULT 0` }).catch(() => { });
    await client.exec({ query: `ALTER TABLE ${CH_DB}.messages ADD COLUMN IF NOT EXISTS display_name String DEFAULT ''` }).catch(() => { });
    await client.exec({ query: `ALTER TABLE ${CH_DB}.users_latest ADD COLUMN IF NOT EXISTS author_avatar String DEFAULT ''` }).catch(() => { });
    await client.exec({ query: `ALTER TABLE ${CH_DB}.users_latest ADD COLUMN IF NOT EXISTS is_bot UInt8 DEFAULT 0` }).catch(() => { });
    await client.exec({ query: `ALTER TABLE ${CH_DB}.users_latest ADD COLUMN IF NOT EXISTS display_name String DEFAULT ''` }).catch(() => { });
    // FIX: Migrate existing MergeTree table to ReplacingMergeTree.
    // MODIFY ENGINE is a metadata-only operation — no data rewrite, instant.
    // Safe to run on every startup (idempotent: already-ReplacingMergeTree tables are a no-op).
    await client.exec({
        query: `ALTER TABLE ${CH_DB}.messages MODIFY ENGINE = ReplacingMergeTree(inserted_at)`,
    }).catch((err) => {
        // Non-fatal: older CH versions may not support MODIFY ENGINE
        console.warn('[clickhouse] Engine migration skipped (non-fatal):', err?.message?.slice(0, 120));
    });
    console.log('[clickhouse] Schema ready');
}
// ── FIX: LRU message dedup cache ─────────────────────────────────────────────
// Prevents duplicate CH inserts caused by:
//   1. Kafka at-least-once redelivery on ingester crash
//   2. Scraper restart re-sending already-scraped messages
// Holds last DEDUP_CACHE_MAX message_ids. On cache hit → row is silently skipped.
// ReplacingMergeTree at the storage layer is the backstop for anything that gets through.
const DEDUP_CACHE_MAX = 500_000;
const _msgDedup = new Map();
function seenMessageId(id) {
    if (_msgDedup.has(id))
        return true;
    if (_msgDedup.size >= DEDUP_CACHE_MAX) {
        // Evict oldest entry (Map preserves insertion order)
        const first = _msgDedup.keys().next().value;
        if (first !== undefined)
            _msgDedup.delete(first);
    }
    _msgDedup.set(id, 1);
    return false;
}
// ── P1: LRU identity cache for change detection (process-local, no DB read) ──
// Key: "authorId:field[:guildId]" → last seen value
// On cache miss: write unconditionally (safe — append-only table)
// On cache hit with same value: skip (reduces write amplification ~90%)
const IDENTITY_CACHE_MAX = 100_000;
const _identityCache = new Map();
function identityCacheKey(authorId, field, guildId) {
    return guildId && guildId !== '0' ? `${authorId}:${field}:${guildId}` : `${authorId}:${field}`;
}
function identityChanged(authorId, field, value, guildId) {
    const key = identityCacheKey(authorId, field, guildId);
    const prev = _identityCache.get(key);
    if (prev === value)
        return false; // no change
    // Evict oldest if at capacity (simple: delete first key)
    if (_identityCache.size >= IDENTITY_CACHE_MAX && !_identityCache.has(key)) {
        const firstKey = _identityCache.keys().next().value;
        if (firstKey !== undefined)
            _identityCache.delete(firstKey);
    }
    _identityCache.set(key, value);
    return true; // changed or first observation
}
async function writeMessages(client, messages) {
    if (messages.length === 0)
        return;
    const valid = messages.filter(m => m.messageId && m.channelId && m.guildId && m.authorId && m.ts
        && !seenMessageId(m.messageId));
    if (valid.length === 0)
        return;
    const now = toChTs(new Date().toISOString());
    const msgRows = valid.map(m => ({
        message_id: m.messageId,
        channel_id: m.channelId,
        guild_id: m.guildId,
        author_id: m.authorId,
        author_name: m.authorName ?? '',
        nick: m.nick ?? '',
        content: m.content ?? '',
        ts: toChTs(m.ts),
        badge_mask: String(m.badgeMask ?? 0),
        has_attachment: (m.attachments?.length ?? 0) > 0 ? 1 : 0,
        embed_count: m.embedTypes?.length ?? 0,
        ref_msg_id: m.referencedMessageId ?? '0',
        media_type: m.mediaType ?? 'none',
        media_urls: [...(m.attachments ?? []), ...(m.mediaUrls ?? [])],
        sticker_names: m.stickerNames ?? [],
        author_avatar: m.authorAvatar ?? '',
        is_bot: m.isBot ? 1 : 0,
        display_name: m.displayName ?? '',
        inserted_at: now,
    }));
    const userRows = valid.map(m => ({
        author_id: m.authorId,
        author_name: m.authorName ?? '',
        badge_mask: String(m.badgeMask ?? 0),
        last_seen_ts: toChTs(m.ts),
        sample_guild: m.guildId,
        author_avatar: m.authorAvatar ?? '',
        is_bot: m.isBot ? 1 : 0,
        display_name: m.displayName ?? '',
    }));
    const identityRows = [];
    const seenAuthors = new Set();
    for (const m of valid) {
        if (seenAuthors.has(m.authorId))
            continue;
        seenAuthors.add(m.authorId);
        const msgTs = toChTs(m.ts);
        // Global fields (guild_id = 0)
        const username = m.authorName ?? '';
        if (username && identityChanged(m.authorId, 'username', username)) {
            identityRows.push({ author_id: m.authorId, field: 'username', value: username, guild_id: '0', observed_ts: now, source_msg_ts: msgTs });
        }
        const displayName = m.displayName ?? '';
        if (displayName && identityChanged(m.authorId, 'display_name', displayName)) {
            identityRows.push({ author_id: m.authorId, field: 'display_name', value: displayName, guild_id: '0', observed_ts: now, source_msg_ts: msgTs });
        }
        const avatar = m.authorAvatar ?? '';
        if (avatar && identityChanged(m.authorId, 'avatar', avatar)) {
            identityRows.push({ author_id: m.authorId, field: 'avatar', value: avatar, guild_id: '0', observed_ts: now, source_msg_ts: msgTs });
        }
        // Guild-specific: nick (guild_id > 0)
        const nick = m.nick ?? '';
        if (nick && m.guildId && identityChanged(m.authorId, 'nick', nick, m.guildId)) {
            identityRows.push({ author_id: m.authorId, field: 'nick', value: nick, guild_id: m.guildId, observed_ts: now, source_msg_ts: msgTs });
        }
    }
    // Fire all three inserts in parallel — identity_log is non-blocking (like users_latest)
    const inserts = [
        client.insert({ table: `${CH_DB}.messages`, values: msgRows, format: 'JSONEachRow' }),
        client.insert({ table: `${CH_DB}.users_latest`, values: userRows, format: 'JSONEachRow' }),
    ];
    if (identityRows.length > 0) {
        inserts.push(client.insert({ table: `${CH_DB}.user_identity_log`, values: identityRows, format: 'JSONEachRow' }));
    }
    await Promise.all(inserts);
}
//# sourceMappingURL=clickhouse.js.map