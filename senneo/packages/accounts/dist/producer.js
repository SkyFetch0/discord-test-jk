"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createProducer = createProducer;
const kafkajs_1 = require("kafkajs");
// Send at most MAX_MESSAGES_PER_REQUEST messages per Kafka request
// to avoid oversized batches that get rejected
const MAX_MESSAGES_PER_REQUEST = 500;
// Map KAFKA_COMPRESSION env to kafkajs CompressionTypes.
// Same env controls both topic-level and producer-side compression.
const COMPRESSION_MAP = {
    none: kafkajs_1.CompressionTypes.None,
    gzip: kafkajs_1.CompressionTypes.GZIP,
    snappy: kafkajs_1.CompressionTypes.Snappy,
    lz4: kafkajs_1.CompressionTypes.LZ4,
    zstd: kafkajs_1.CompressionTypes.ZSTD,
};
const SEND_COMPRESSION = (() => {
    const raw = (process.env.KAFKA_COMPRESSION ?? 'lz4').toLowerCase();
    if (raw === 'none')
        return kafkajs_1.CompressionTypes.None;
    if (raw === 'snappy')
        return kafkajs_1.CompressionTypes.Snappy;
    if (raw === 'lz4')
        return kafkajs_1.CompressionTypes.LZ4;
    return kafkajs_1.CompressionTypes.GZIP;
})();
function envFlag(name, defaultValue) {
    const raw = process.env[name];
    if (raw == null)
        return defaultValue;
    return ['true', '1', 'yes', 'on'].includes(raw.toLowerCase());
}
function envPositiveInt(name, defaultValue) {
    const parsed = parseInt(process.env[name] ?? `${defaultValue}`, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}
const BACKPRESSURE_ENABLED = envFlag('SCRAPER_KAFKA_BACKPRESSURE_ENABLED', false);
const MAX_INFLIGHT_BATCHES = envPositiveInt('SCRAPER_KAFKA_MAX_INFLIGHT_BATCHES', 32);
const MAX_INFLIGHT_BYTES = envPositiveInt('SCRAPER_KAFKA_MAX_INFLIGHT_BYTES', 32 * 1024 * 1024);
const BACKPRESSURE_LOG_ENABLED = envFlag('SCRAPER_KAFKA_BACKPRESSURE_LOG_ENABLED', false);
const MAX_INFLIGHT_REQUESTS = envPositiveInt('SCRAPER_KAFKA_MAX_REQUESTS', 10);
const TARGET_TOPIC_PARTITIONS = envPositiveInt('KAFKA_PARTITIONS', 16);
const PARTITION_KEY_STRATEGY = (process.env.SCRAPER_KAFKA_KEY_STRATEGY ?? 'channel_id').toLowerCase();
let producer = null;
function isCompressionNotImplementedError(err) {
    const message = err instanceof Error ? err.message : String(err ?? '');
    return /compression not implemented/i.test(message);
}
function partitionKeyFor(message) {
    if (PARTITION_KEY_STRATEGY === 'none')
        return undefined;
    if (PARTITION_KEY_STRATEGY === 'message_id')
        return message.messageId;
    return message.channelId;
}
async function createProducer(brokers, topic) {
    let inflightBatches = 0;
    let inflightBytes = 0;
    let sendCompression = SEND_COMPRESSION;
    let compressionFallbackLogged = false;
    const waiters = [];
    function notifyWaiters() {
        if (waiters.length === 0)
            return;
        const pending = waiters.splice(0, waiters.length);
        for (const resolve of pending)
            resolve();
    }
    async function acquireBudget(batchBytes) {
        if (!BACKPRESSURE_ENABLED)
            return { reservedBytes: 0, waitedMs: 0 };
        const reservedBytes = Math.min(batchBytes, MAX_INFLIGHT_BYTES);
        const startedAt = Date.now();
        while (true) {
            if (inflightBatches < MAX_INFLIGHT_BATCHES && inflightBytes + reservedBytes <= MAX_INFLIGHT_BYTES) {
                inflightBatches += 1;
                inflightBytes += reservedBytes;
                const waitedMs = Date.now() - startedAt;
                if (waitedMs > 0 && BACKPRESSURE_LOG_ENABLED) {
                    console.warn(`[kafka] event=backpressure_wait topic=${topic} waitedMs=${waitedMs} batchBytes=${batchBytes} inflightBatches=${inflightBatches} inflightBytes=${inflightBytes}`);
                }
                return { reservedBytes, waitedMs };
            }
            await new Promise(resolve => waiters.push(resolve));
        }
    }
    function releaseBudget(reservedBytes) {
        if (!BACKPRESSURE_ENABLED)
            return;
        inflightBatches = Math.max(0, inflightBatches - 1);
        inflightBytes = Math.max(0, inflightBytes - reservedBytes);
        notifyWaiters();
    }
    const kafka = new kafkajs_1.Kafka({
        clientId: 'senneo-accounts',
        brokers,
        retry: {
            retries: 8,
            initialRetryTime: 300,
            maxRetryTime: 30_000,
            factor: 2,
        },
    });
    producer = kafka.producer({
        allowAutoTopicCreation: true,
        transactionTimeout: 30_000,
        // idempotent off  allows acks:1 and higher inflight = lower latency
        idempotent: false,
        maxInFlightRequests: MAX_INFLIGHT_REQUESTS,
        metadataMaxAge: 60_000,
    });
    await producer.connect();
    // Ensure topic exists with sensible defaults
    const admin = kafka.admin();
    try {
        await admin.connect();
        const existing = await admin.listTopics();
        if (!existing.includes(topic)) {
            const topicConfig = {
                topic,
                numPartitions: TARGET_TOPIC_PARTITIONS,
                // KAFKA_REPLICATION_FACTOR: dev=1, prod=3 (see ARCHITECTURE_SCALING_PLAN.md §2.1)
                replicationFactor: parseInt(process.env.KAFKA_REPLICATION_FACTOR ?? '1', 10),
                configEntries: [
                    { name: 'retention.ms', value: String(1 * 24 * 3600 * 1000) }, // 1d retention
                    // KAFKA_COMPRESSION: lz4 default (faster compress/decompress at scale)
                    { name: 'compression.type', value: process.env.KAFKA_COMPRESSION ?? 'lz4' },
                ],
            };
            await admin.createTopics({ topics: [topicConfig] });
            console.log(`[kafka] Topic '${topic}' created (${TARGET_TOPIC_PARTITIONS} partitions)`);
        }
        else {
            const metadata = await admin.fetchTopicMetadata({ topics: [topic] });
            const currentPartitions = metadata.topics.find(item => item.name === topic)?.partitions.length ?? 0;
            if (currentPartitions > 0 && currentPartitions < TARGET_TOPIC_PARTITIONS) {
                await admin.createPartitions({
                    topicPartitions: [{ topic, count: TARGET_TOPIC_PARTITIONS }],
                });
                console.log(`[kafka] Topic '${topic}' partitions increased (${currentPartitions} -> ${TARGET_TOPIC_PARTITIONS})`);
            }
        }
    }
    catch (err) {
        console.warn('[kafka] Could not configure topic (non-fatal):', err);
    }
    finally {
        await admin.disconnect();
    }
    console.log('[kafka] Producer connected (idempotent mode)');
    return {
        async send(messages) {
            if (!producer || messages.length === 0)
                return;
            const chunks = [];
            for (let i = 0; i < messages.length; i += MAX_MESSAGES_PER_REQUEST)
                chunks.push(messages.slice(i, i + MAX_MESSAGES_PER_REQUEST));
            await Promise.all(chunks.map(chunk => (async () => {
                const payload = chunk.map(m => ({
                    key: partitionKeyFor(m),
                    value: JSON.stringify(m),
                }));
                const batchBytes = payload.reduce((sum, item) => sum + Buffer.byteLength(item.value), 0);
                const { reservedBytes } = await acquireBudget(batchBytes);
                try {
                    try {
                        await producer.send({
                            topic,
                            acks: 1,
                            compression: sendCompression,
                            messages: payload,
                        });
                    }
                    catch (err) {
                        if (sendCompression !== kafkajs_1.CompressionTypes.GZIP && isCompressionNotImplementedError(err)) {
                            sendCompression = kafkajs_1.CompressionTypes.GZIP;
                            if (!compressionFallbackLogged) {
                                compressionFallbackLogged = true;
                                console.warn(`[kafka] Requested compression '${process.env.KAFKA_COMPRESSION ?? 'gzip'}' is not implemented by the current runtime. Falling back to gzip.`);
                            }
                            await producer.send({
                                topic,
                                acks: 1,
                                compression: sendCompression,
                                messages: payload,
                            });
                        }
                        else {
                            throw err;
                        }
                    }
                }
                finally {
                    releaseBudget(reservedBytes);
                }
            })()));
        },
        async disconnect() {
            if (!producer)
                return;
            // Flush any pending messages before disconnecting
            await producer.disconnect();
            producer = null;
            console.log('[kafka] Producer disconnected');
        },
    };
}
//# sourceMappingURL=producer.js.map