-- ─────────────────────────────────────────────────────────────────────────────
-- 006_operations_tables.sql — Sistem ve İzleme Tabloları
-- Çalışma sırası: 6
--
-- NOT: Bu tablolarda da veri silinmez.
--      error_log ve ingester_metrics için TTL tanımlanmamıştır.
--      Disk kullanımını kontrol etmek için monitoring sorgularını kullan.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════
-- error_log — Tüm Servislerden Hata ve Olay Logları
-- ═══════════════════════════════════════════════════════════════════
-- Yazma kaynakları:
--   - accounts: rate limit, login failure, Discord API hatası
--   - ingester: parse error, CH write error, Kafka error
--   - api: query timeout, validation error
--   - bot: Kafka send error
--
-- Sorgular:
--   SELECT * FROM senneo_operations.error_log
--   WHERE source = 'ingester' AND severity = 'error'
--     AND ts >= now() - INTERVAL 1 HOUR
--   ORDER BY ts DESC
--   LIMIT 100;

CREATE TABLE IF NOT EXISTS senneo_operations.error_log
(
    ts                      DateTime64(3, 'UTC')                    CODEC(DoubleDelta, ZSTD(1)),

    -- 'info' | 'warn' | 'error' | 'critical'
    severity                LowCardinality(String)                  CODEC(ZSTD(1)),

    -- 'rate_limit' | 'discord_api' | 'ch_write' | 'kafka_producer' |
    -- 'kafka_consumer' | 'parse_error' | 'checkpoint' | 'network' | 'auth_login'
    category                LowCardinality(String)                  CODEC(ZSTD(1)),

    -- 'accounts' | 'ingester' | 'api' | 'bot' | 'other'
    source                  LowCardinality(String)                  CODEC(ZSTD(1)),

    message                 String                                  CODEC(ZSTD(3)),

    -- Stack trace veya JSON blob (4096 karakter ile sınırlandırılmış)
    detail                  String              DEFAULT ''          CODEC(ZSTD(3)),

    -- Dedup anahtarı: aynı fingerprint → aynı hata kategorisi
    fingerprint             String              DEFAULT ''          CODEC(ZSTD(1)),

    -- Aggregated count (aynı hatanın kaç kez tekrarlandığı)
    count                   UInt32              DEFAULT 1           CODEC(ZSTD(1)),

    -- İlgili bağlam (opsiyonel, hata kaynağına göre doldurulur)
    channel_id              UInt64              DEFAULT 0           CODEC(ZSTD(1)),
    guild_id                UInt64              DEFAULT 0           CODEC(ZSTD(1)),
    account_id              String              DEFAULT ''          CODEC(ZSTD(1)),
    error_code              String              DEFAULT ''          CODEC(ZSTD(1)),

    inserted_at             DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
                                                                    CODEC(DoubleDelta, ZSTD(1))
)
ENGINE = MergeTree()
PARTITION BY toDate(ts)
ORDER BY (source, category, ts)
SETTINGS
    index_granularity = 8192
;


-- ═══════════════════════════════════════════════════════════════════
-- ingester_metrics — Ingester Performans Metrikleri
-- ═══════════════════════════════════════════════════════════════════
-- Her ingester instance'ı her flush sonunda buraya yazar.
-- Prometheus yerine veya ek olarak kullanılabilir.
--
-- Sorgu örneği (son 1 saatte throughput):
--   SELECT
--     worker_id,
--     sum(messages_ingested)  AS total_ingested,
--     avg(ch_insert_ms)       AS avg_insert_ms,
--     max(kafka_lag)          AS max_lag,
--     avg(batch_size)         AS avg_batch
--   FROM senneo_operations.ingester_metrics
--   WHERE ts >= now() - INTERVAL 1 HOUR
--   GROUP BY worker_id
--   ORDER BY total_ingested DESC;

CREATE TABLE IF NOT EXISTS senneo_operations.ingester_metrics
(
    ts                      DateTime                                CODEC(DoubleDelta, ZSTD(1)),
    worker_id               LowCardinality(String)                  CODEC(ZSTD(1)),

    -- Başarıyla işlenen mesaj sayısı (bu flush'ta)
    messages_ingested       UInt64                                  CODEC(ZSTD(1)),

    -- DLQ'ya gönderilen (parse edilemeyen) mesaj sayısı
    messages_failed         UInt64                                  CODEC(ZSTD(1)),

    -- In-memory LRU cache ile dedup edilip atlanan mesaj sayısı
    messages_deduped        UInt64                                  CODEC(ZSTD(1)),

    -- Bu flush'taki ClickHouse insert süresi (ms)
    ch_insert_ms            UInt32                                  CODEC(ZSTD(1)),

    -- Anlık Kafka consumer lag (mesaj sayısı)
    kafka_lag               UInt64                                  CODEC(ZSTD(1)),

    -- Bu flush'taki batch büyüklüğü (satır sayısı)
    batch_size              UInt32                                  CODEC(ZSTD(1)),

    -- Node.js process RSS memory kullanımı (MB)
    memory_used_mb          UInt32                                  CODEC(ZSTD(1))
)
ENGINE = MergeTree()
PARTITION BY toDate(ts)
ORDER BY (worker_id, ts)
SETTINGS
    index_granularity = 8192
;
