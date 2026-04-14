"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createScyllaClient = createScyllaClient;
exports.writeMessages = writeMessages;
const cassandra_driver_1 = require("cassandra-driver");
const shared_1 = require("@senneo/shared");
const KEYSPACE = process.env.SCYLLA_KEYSPACE ?? 'senneo';
const HOSTS = (process.env.SCYLLA_HOSTS ?? 'localhost').split(',');
function envPositiveInt(name, defaultValue) {
    const parsed = parseInt(process.env[name] ?? `${defaultValue}`, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}
// Max concurrent individual writes to Scylla (avoids coordinator overload)
const WRITE_CONCURRENCY = envPositiveInt('SCYLLA_WRITE_CONCURRENCY', 128);
// Sub-batch size for writeMessages chunking
const WRITE_CHUNK = 500;
async function createScyllaClient() {
    const client = new cassandra_driver_1.Client({
        contactPoints: HOSTS,
        localDataCenter: 'datacenter1',
        queryOptions: {
            consistency: cassandra_driver_1.types.consistencies.localQuorum,
            prepare: true,
        },
        pooling: {
            coreConnectionsPerHost: {
                [cassandra_driver_1.types.distance.local]: 6, // More connections for high throughput
                [cassandra_driver_1.types.distance.remote]: 1,
            },
        },
        socketOptions: {
            connectTimeout: 15_000,
            readTimeout: 30_000,
        },
    });
    await client.connect();
    console.log('[scylla] Connected');
    await initSchema(client);
    return client;
}
async function initSchema(client) {
    await client.execute(`
    CREATE KEYSPACE IF NOT EXISTS ${KEYSPACE}
    WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
    AND durable_writes = true
  `);
    // Full message store  point-lookup by ID
    await client.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.messages_by_id (
      message_id    bigint  PRIMARY KEY,
      channel_id    bigint,
      guild_id      bigint,
      author_id     bigint,
      author_name   text,
      author_disc   text,
      nick          text,
      content       text,
      ts            timestamp,
      attachments   list<text>,
      media_urls    list<text>,
      embed_types   list<text>,
      sticker_names list<text>,
      media_type    text,
      badge_mask    bigint,
      roles         list<bigint>,
      edited_ts     timestamp,
      ref_msg_id    bigint,
      tts           boolean
    )
  `);
    // Time-series scroll by channel (bucketed by day)
    await client.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.messages_by_channel_bucket (
      channel_id  bigint,
      bucket      int,
      ts          timestamp,
      message_id  bigint,
      guild_id    bigint,
      author_id   bigint,
      author_name text,
      nick        text,
      content     text,
      badge_mask  bigint,
      PRIMARY KEY ((channel_id, bucket), ts, message_id)
    ) WITH CLUSTERING ORDER BY (ts DESC, message_id DESC)
  `);
    // Author lookup table  find all channels an author posted in
    await client.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.messages_by_author (
      author_id   bigint,
      bucket      int,
      ts          timestamp,
      message_id  bigint,
      channel_id  bigint,
      guild_id    bigint,
      content     text,
      PRIMARY KEY ((author_id, bucket), ts, message_id)
    ) WITH CLUSTERING ORDER BY (ts DESC, message_id DESC)
  `);
    // Idempotent column migrations for messages_by_id (point-lookup table gets full detail)
    const addCols = [
        `ALTER TABLE ${KEYSPACE}.messages_by_id ADD is_bot boolean`,
        `ALTER TABLE ${KEYSPACE}.messages_by_id ADD display_name text`,
        `ALTER TABLE ${KEYSPACE}.messages_by_id ADD author_avatar text`,
    ];
    for (const ddl of addCols)
        await client.execute(ddl).catch(() => { });
    console.log('[scylla] Schema ready');
}
function L(s) {
    return cassandra_driver_1.types.Long.fromString(s);
}
// P0 FIX: Use individual prepared INSERTs instead of cross-partition UNLOGGED batches.
// Cross-partition batches increase coordinator memory pressure and are a Scylla anti-pattern.
// Individual writes with concurrency control are more efficient at scale.
const BY_ID_CQL = `INSERT INTO ${KEYSPACE}.messages_by_id
  (message_id,channel_id,guild_id,author_id,author_name,author_disc,
   nick,content,ts,attachments,media_urls,embed_types,sticker_names,
   media_type,badge_mask,roles,edited_ts,ref_msg_id,tts,
   is_bot,display_name,author_avatar)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
const BY_CHANNEL_CQL = `INSERT INTO ${KEYSPACE}.messages_by_channel_bucket
  (channel_id,bucket,ts,message_id,guild_id,author_id,author_name,nick,content,badge_mask)
  VALUES (?,?,?,?,?,?,?,?,?,?)`;
const BY_AUTHOR_CQL = `INSERT INTO ${KEYSPACE}.messages_by_author
  (author_id,bucket,ts,message_id,channel_id,guild_id,content)
  VALUES (?,?,?,?,?,?,?)`;
async function writeMessages(client, messages) {
    if (messages.length === 0)
        return;
    // Build all individual queries
    const queries = [];
    for (const m of messages) {
        if (!m.messageId || !m.channelId || !m.guildId || !m.authorId)
            continue;
        const ts = new Date(m.ts);
        const editedTs = m.editedTs ? new Date(m.editedTs) : null;
        const bucket = (0, shared_1.dateToBucket)(ts);
        // messages_by_id (point lookup)
        queries.push({
            query: BY_ID_CQL,
            params: [
                L(m.messageId), L(m.channelId), L(m.guildId), L(m.authorId),
                m.authorName, m.authorDiscriminator, m.nick ?? '', m.content ?? '', ts,
                m.attachments ?? [],
                [...(m.attachments ?? []), ...(m.mediaUrls ?? [])],
                m.embedTypes ?? [],
                m.stickerNames ?? [],
                m.mediaType ?? 'none',
                cassandra_driver_1.types.Long.fromNumber(m.badgeMask ?? 0),
                (m.roles ?? []).map((r) => L(r)),
                editedTs,
                m.referencedMessageId ? L(m.referencedMessageId) : null,
                !!m.tts,
                !!m.isBot,
                m.displayName ?? '',
                m.authorAvatar ?? '',
            ],
        });
        // messages_by_channel_bucket (time-series scroll)
        queries.push({
            query: BY_CHANNEL_CQL,
            params: [
                L(m.channelId), bucket, ts, L(m.messageId), L(m.guildId), L(m.authorId),
                m.authorName ?? '', m.nick ?? '', m.content ?? '',
                cassandra_driver_1.types.Long.fromNumber(m.badgeMask ?? 0),
            ],
        });
        // messages_by_author (author lookup)
        queries.push({
            query: BY_AUTHOR_CQL,
            params: [
                L(m.authorId), bucket, ts, L(m.messageId), L(m.channelId), L(m.guildId),
                m.content ?? '',
            ],
        });
    }
    // Execute all queries with bounded concurrency (no cross-partition batches)
    await executeConcurrent(client, queries, WRITE_CONCURRENCY);
}
async function executeConcurrent(client, queries, concurrency) {
    let idx = 0;
    const errors = [];
    async function worker() {
        while (idx < queries.length) {
            const q = queries[idx++];
            try {
                await client.execute(q.query, q.params, { prepare: true });
            }
            catch (err) {
                errors.push(err);
            }
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, queries.length) }, () => worker());
    await Promise.all(workers);
    if (errors.length > 0) {
        console.error(`[scylla] ${errors.length}/${queries.length} writes failed. First error:`, errors[0]);
        throw new Error(`Scylla write: ${errors.length}/${queries.length} failed — ${errors[0].message}`);
    }
}
//# sourceMappingURL=scylla.js.map