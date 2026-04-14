"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const kafkajs_1 = require("kafkajs");
const scylla_1 = require("./scylla");
const clickhouse_1 = require("./clickhouse");
function envPositiveInt(name, defaultValue) {
    const parsed = parseInt(process.env[name] ?? `${defaultValue}`, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}
const KAFKA_BROKERS = process.env.KAFKA_BROKERS ?? 'localhost:9092';
const KAFKA_TOPIC = process.env.KAFKA_TOPIC ?? 'messages';
const KAFKA_DLQ_TOPIC = `${KAFKA_TOPIC}.dlq`; // Dead-letter queue topic
const KAFKA_GROUP = 'senneo-ingester';
const KAFKA_REPLICATION_FACTOR = envPositiveInt('KAFKA_REPLICATION_FACTOR', 1);
const TARGET_TOPIC_PARTITIONS = envPositiveInt('KAFKA_PARTITIONS', 16);
const BATCH_FLUSH_SIZE = envPositiveInt('INGESTER_BATCH_FLUSH_SIZE', 2_000);
const CONSUMER_MAX_BYTES = envPositiveInt('INGESTER_MAX_BYTES', 100 * 1024 * 1024);
const CONSUMER_MAX_BYTES_PER_PARTITION = envPositiveInt('INGESTER_MAX_BYTES_PER_PARTITION', 8 * 1024 * 1024);
const CONSUMER_MIN_BYTES = envPositiveInt('INGESTER_MIN_BYTES', 1);
const CONSUMER_MAX_WAIT_TIME_MS = envPositiveInt('INGESTER_MAX_WAIT_TIME_MS', 250);
const PARTITIONS_CONSUMED_CONCURRENTLY = envPositiveInt('INGESTER_PARTITIONS_CONSUMED_CONCURRENTLY', 8);
// ── Sampled error logging (Task 4: prevent log flood on sustained errors) ────
const _lastLogTs = {};
const LOG_SAMPLE_MS = 10_000; // At most 1 log per key per 10s
function logSampled(key, level, ...args) {
    const now = Date.now();
    if (now - (_lastLogTs[key] ?? 0) < LOG_SAMPLE_MS)
        return;
    _lastLogTs[key] = now;
    console[level](...args);
}
// ── Error log reporter (writes to CH error_log, sampled to prevent flood) ────
const CH_DB_NAME = process.env.CLICKHOUSE_DB ?? 'senneo';
const _lastErrorLogTs = {};
function reportError(ch, category, severity, message, err) {
    const fp = `ingester:${category}`;
    const now = Date.now();
    if (now - (_lastErrorLogTs[fp] ?? 0) < LOG_SAMPLE_MS)
        return;
    _lastErrorLogTs[fp] = now;
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}`.slice(0, 4096) : String(err ?? '').slice(0, 4096);
    ch.insert({
        table: `${CH_DB_NAME}.error_log`,
        values: [{ ts: new Date().toISOString().replace('T', ' ').replace('Z', ''), severity, category, source: 'ingester', message: message.slice(0, 2000), detail, fingerprint: fp }],
        format: 'JSONEachRow',
    }).catch(() => { }); // best-effort — don't throw on error-log write failure
}
// ── Metrics (in-memory, exposed via /metrics endpoint) ──────────────────────
const metrics = {
    msgsProcessed: 0,
    msgsFailedDlq: 0,
    batchesFlushed: 0,
    scyllaErrors: 0,
    chErrors: 0,
    startedAt: new Date().toISOString(),
};
const METRICS_FILE = path_1.default.resolve(process.cwd(), 'ingester_metrics.json');
function flushMetrics() {
    try {
        fs_1.default.writeFileSync(METRICS_FILE, JSON.stringify({ ...metrics, updatedAt: new Date().toISOString() }, null, 2));
    }
    catch { /* best-effort */ }
}
setInterval(flushMetrics, 10_000);
// ── Retry helper ─────────────────────────────────────────────────────────────
async function connectWithRetry(name, factory, maxAttempts = 20, delayMs = 5_000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await factory();
        }
        catch (err) {
            const wait = Math.min(delayMs * attempt, 30_000); // Incremental backoff
            console.warn(`[ingester] ${name} not ready (attempt ${attempt}/${maxAttempts}) — retrying in ${wait / 1_000}s...`);
            if (attempt === maxAttempts)
                throw err;
            await new Promise(r => setTimeout(r, wait));
        }
    }
    throw new Error(`${name} never became available`);
}
// ── Batch flush — commit-after-durable-write semantics ──────────────────────
// Scylla is source of truth: if Scylla write fails, this function THROWS
// so the caller does NOT commit the Kafka offset → at-least-once delivery.
// CH is analytics-only: failure is logged but non-blocking.
async function flushBatch(scylla, clickhouse, messages) {
    if (messages.length === 0)
        return;
    const start = Date.now();
    // Fire both writes in parallel, await BOTH fully (no timeout race)
    const [scyllaResult, chResult] = await Promise.allSettled([
        (0, scylla_1.writeMessages)(scylla, messages),
        (0, clickhouse_1.writeMessages)(clickhouse, messages),
    ]);
    // Scylla failure = THROW — caller must NOT commit offset
    if (scyllaResult.status === 'rejected') {
        metrics.scyllaErrors++;
        logSampled('scylla-write', 'error', `[ingester] ScyllaDB write FAILED (${metrics.scyllaErrors} total) — offset NOT committed:`, scyllaResult.reason);
        reportError(clickhouse, 'scylla_write', 'error', `ScyllaDB write failed (${metrics.scyllaErrors} total)`, scyllaResult.reason);
        throw scyllaResult.reason;
    }
    // CH failure is non-fatal (analytics store), but log for visibility
    if (chResult.status === 'rejected') {
        metrics.chErrors++;
        logSampled('ch-write', 'error', `[ingester] ClickHouse write error (${metrics.chErrors} total, non-fatal):`, chResult.reason);
        reportError(clickhouse, 'clickhouse_write', 'warn', `ClickHouse write error (${metrics.chErrors} total, non-fatal)`, chResult.reason);
    }
    metrics.msgsProcessed += messages.length;
    metrics.batchesFlushed++;
    const elapsed = Date.now() - start;
    const mps = Math.round(messages.length / (elapsed / 1_000));
    if (metrics.batchesFlushed % 10 === 0)
        console.log(`[ingester] Flushed ${messages.length} msgs in ${elapsed}ms (~${mps} msg/s)`);
}
async function run() {
    console.log('[ingester] Waiting for databases...');
    const [scylla, clickhouse] = await Promise.all([
        connectWithRetry('ScyllaDB', scylla_1.createScyllaClient),
        connectWithRetry('ClickHouse', clickhouse_1.createClickHouseClient),
    ]);
    console.log('[ingester] Both databases ready — connecting to Kafka...');
    const kafka = new kafkajs_1.Kafka({
        clientId: 'senneo-ingester',
        brokers: KAFKA_BROKERS.split(','),
        retry: { retries: 10, initialRetryTime: 300, factor: 2 },
    });
    // Ensure DLQ topic exists
    const admin = kafka.admin();
    try {
        await admin.connect();
        const existing = await admin.listTopics();
        if (!existing.includes(KAFKA_TOPIC)) {
            await admin.createTopics({
                topics: [{
                        topic: KAFKA_TOPIC,
                        numPartitions: TARGET_TOPIC_PARTITIONS,
                        replicationFactor: KAFKA_REPLICATION_FACTOR,
                    }],
            });
            console.log(`[ingester] Topic '${KAFKA_TOPIC}' created (${TARGET_TOPIC_PARTITIONS} partitions)`);
        }
        else {
            const metadata = await admin.fetchTopicMetadata({ topics: [KAFKA_TOPIC] });
            const currentPartitions = metadata.topics.find(item => item.name === KAFKA_TOPIC)?.partitions.length ?? 0;
            if (currentPartitions > 0 && currentPartitions < TARGET_TOPIC_PARTITIONS) {
                await admin.createPartitions({
                    topicPartitions: [{ topic: KAFKA_TOPIC, count: TARGET_TOPIC_PARTITIONS }],
                });
                console.log(`[ingester] Topic '${KAFKA_TOPIC}' partitions increased (${currentPartitions} -> ${TARGET_TOPIC_PARTITIONS})`);
            }
        }
        if (!existing.includes(KAFKA_DLQ_TOPIC)) {
            await admin.createTopics({
                topics: [{
                        topic: KAFKA_DLQ_TOPIC,
                        numPartitions: 1,
                        replicationFactor: KAFKA_REPLICATION_FACTOR,
                        configEntries: [{ name: 'retention.ms', value: String(30 * 24 * 3600 * 1000) }], // 30d
                    }],
            });
            console.log(`[ingester] DLQ topic '${KAFKA_DLQ_TOPIC}' created`);
        }
    }
    catch (err) {
        console.warn('[ingester] Could not create DLQ topic (non-fatal):', err);
    }
    finally {
        await admin.disconnect();
    }
    // DLQ producer — sends unparseable messages for later inspection
    const dlqProducer = kafka.producer();
    await dlqProducer.connect();
    const consumer = kafka.consumer({
        groupId: KAFKA_GROUP,
        maxBytes: CONSUMER_MAX_BYTES,
        maxBytesPerPartition: CONSUMER_MAX_BYTES_PER_PARTITION,
        minBytes: CONSUMER_MIN_BYTES,
        maxWaitTimeInMs: CONSUMER_MAX_WAIT_TIME_MS,
        sessionTimeout: 90_000,
        heartbeatInterval: 10_000,
    });
    await consumer.connect();
    await consumer.subscribe({ topic: KAFKA_TOPIC, fromBeginning: true });
    console.log(`[ingester] Subscribed to '${KAFKA_TOPIC}' | DLQ: '${KAFKA_DLQ_TOPIC}'`);
    await consumer.run({
        // P0 FIX: Disable auto-resolve — we resolve offsets ONLY after durable write
        eachBatchAutoResolve: false,
        autoCommitInterval: 5_000,
        autoCommitThreshold: BATCH_FLUSH_SIZE,
        partitionsConsumedConcurrently: PARTITIONS_CONSUMED_CONCURRENTLY,
        eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary, }) => {
            const messages = [];
            const offsets = []; // Track offsets per message in current sub-batch
            const dlqMessages = [];
            let lastDlqOffset = null;
            for (const kafkaMsg of batch.messages) {
                if (!kafkaMsg.value)
                    continue;
                const raw = kafkaMsg.value.toString();
                let parsed = null;
                try {
                    parsed = JSON.parse(raw);
                    // Basic schema validation
                    if (!parsed.messageId || !parsed.channelId || !parsed.guildId || !parsed.authorId) {
                        throw new Error('Missing required fields');
                    }
                }
                catch (err) {
                    console.warn(`[ingester] Unparseable message → DLQ: ${err.message}`);
                    reportError(clickhouse, 'dlq_parse', 'warn', `Unparseable message → DLQ: ${err.message}`, err);
                    dlqMessages.push({
                        key: kafkaMsg.key?.toString() ?? '',
                        value: JSON.stringify({ error: err.message, raw: raw.slice(0, 500), offset: kafkaMsg.offset }),
                    });
                    metrics.msgsFailedDlq++;
                    // DLQ messages are safe to resolve — they are intentionally skipped
                    lastDlqOffset = kafkaMsg.offset;
                    continue;
                }
                messages.push(parsed);
                offsets.push(kafkaMsg.offset);
                if (messages.length >= BATCH_FLUSH_SIZE) {
                    const subBatch = messages.splice(0, BATCH_FLUSH_SIZE);
                    const subOffset = offsets.splice(0, BATCH_FLUSH_SIZE);
                    // flushBatch throws on Scylla failure → offset NOT committed → at-least-once
                    await flushBatch(scylla, clickhouse, subBatch);
                    // Only resolve after durable write succeeds
                    resolveOffset(subOffset[subOffset.length - 1]);
                    await heartbeat();
                    await commitOffsetsIfNecessary();
                }
            }
            // Flush remaining messages
            if (messages.length > 0) {
                await flushBatch(scylla, clickhouse, messages);
                resolveOffset(offsets[offsets.length - 1]);
            }
            else if (lastDlqOffset) {
                // If only DLQ messages remained, resolve up to last DLQ offset
                resolveOffset(lastDlqOffset);
            }
            // Send failed messages to DLQ in one batch
            if (dlqMessages.length > 0) {
                try {
                    await dlqProducer.send({ topic: KAFKA_DLQ_TOPIC, messages: dlqMessages });
                }
                catch (err) {
                    console.error('[ingester] Failed to write to DLQ:', err);
                }
            }
        },
    });
    const shutdown = async () => {
        console.log('[ingester] Shutting down...');
        flushMetrics();
        await consumer.disconnect();
        await dlqProducer.disconnect();
        await scylla.shutdown();
        console.log('[ingester] Stopped');
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
run().catch(err => {
    console.error('[ingester] Fatal:', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map