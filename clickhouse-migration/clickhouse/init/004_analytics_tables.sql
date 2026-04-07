-- ─────────────────────────────────────────────────────────────────────────────
-- 004_analytics_tables.sql — Pre-Aggregated Hedef Tablolar
-- Çalışma sırası: 4 (views'dan önce — MV'ler bu tablolara yazar)
--
-- NOT: Bu tablolar direkt sorgulanmaz, Materialized View'lar tarafından
-- doldurulur (005_analytics_views.sql). Sorgu sırasında kullanılacak
-- fonksiyonlar şema açıklamalarında belirtilmiştir.
--
-- Engine seçimi:
--   AggregatingMergeTree → uniq() gibi AggregateFunction içeren tablolar için
--   SummingMergeTree     → sadece toplanabilir sayısal kolonlar için
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════
-- channel_daily — Kanal Günlük İstatistikleri
-- ═══════════════════════════════════════════════════════════════════
-- Sorgu örneği:
--   SELECT channel_id, date,
--          sum(message_count)         AS messages,
--          uniqMerge(unique_authors)  AS unique_authors,
--          sum(reply_count)           AS replies
--   FROM senneo_analytics.channel_daily
--   WHERE channel_id = 1234 AND date >= today() - 30
--   GROUP BY channel_id, date
--   ORDER BY date ASC

CREATE TABLE IF NOT EXISTS senneo_analytics.channel_daily
(
    channel_id              UInt64                                  CODEC(Delta, ZSTD(1)),
    guild_id                UInt64                                  CODEC(Delta, ZSTD(1)),
    date                    Date                                    CODEC(DoubleDelta, ZSTD(1)),

    -- Toplanabilir kolonlar (SUM ile birleştirilebilir)
    message_count           UInt64                                  CODEC(ZSTD(1)),
    bot_message_count       UInt64                                  CODEC(ZSTD(1)),
    reply_count             UInt64                                  CODEC(ZSTD(1)),
    attachment_message_count UInt64                                 CODEC(ZSTD(1)),
    total_content_length    UInt64                                  CODEC(ZSTD(1)),

    -- HyperLogLog state (uniqMerge ile sorgula)
    unique_authors          AggregateFunction(uniq, UInt64)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (guild_id, channel_id, date)
SETTINGS
    index_granularity = 8192
;


-- ═══════════════════════════════════════════════════════════════════
-- guild_daily — Guild Günlük İstatistikleri
-- ═══════════════════════════════════════════════════════════════════
-- Sorgu örneği:
--   SELECT guild_id, date,
--          sum(message_count)         AS messages,
--          uniqMerge(unique_authors)  AS users,
--          uniqMerge(active_channels) AS channels
--   FROM senneo_analytics.guild_daily
--   WHERE guild_id = 5678 AND date >= today() - 7
--   GROUP BY guild_id, date

CREATE TABLE IF NOT EXISTS senneo_analytics.guild_daily
(
    guild_id                UInt64                                  CODEC(Delta, ZSTD(1)),
    date                    Date                                    CODEC(DoubleDelta, ZSTD(1)),
    message_count           UInt64                                  CODEC(ZSTD(1)),
    bot_message_count       UInt64                                  CODEC(ZSTD(1)),
    unique_authors          AggregateFunction(uniq, UInt64),
    active_channels         AggregateFunction(uniq, UInt64)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (guild_id, date)
SETTINGS
    index_granularity = 8192
;


-- ═══════════════════════════════════════════════════════════════════
-- author_daily — Yazar Günlük İstatistikleri
-- ═══════════════════════════════════════════════════════════════════
-- Sorgu örneği:
--   SELECT author_id, date,
--          sum(message_count)         AS messages,
--          uniqMerge(active_channels) AS channels,
--          sum(reply_count)           AS replies
--   FROM senneo_analytics.author_daily
--   WHERE author_id = 9999
--   GROUP BY author_id, date
--   ORDER BY date DESC

CREATE TABLE IF NOT EXISTS senneo_analytics.author_daily
(
    author_id               UInt64                                  CODEC(Delta, ZSTD(1)),
    guild_id                UInt64                                  CODEC(Delta, ZSTD(1)),
    date                    Date                                    CODEC(DoubleDelta, ZSTD(1)),
    message_count           UInt64                                  CODEC(ZSTD(1)),
    reply_count             UInt64                                  CODEC(ZSTD(1)),
    attachment_count        UInt64                                  CODEC(ZSTD(1)),
    active_channels         AggregateFunction(uniq, UInt64)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (author_id, guild_id, date)
SETTINGS
    index_granularity = 8192
;


-- ═══════════════════════════════════════════════════════════════════
-- hourly_heatmap — Saatlik Aktivite Heatmap'i
-- ═══════════════════════════════════════════════════════════════════
-- Sorgu örneği (guild bazlı heatmap):
--   SELECT day_of_week, hour_of_day, sum(message_count) AS messages
--   FROM senneo_analytics.hourly_heatmap
--   WHERE guild_id = 5678
--   GROUP BY day_of_week, hour_of_day
--   ORDER BY day_of_week, hour_of_day

CREATE TABLE IF NOT EXISTS senneo_analytics.hourly_heatmap
(
    guild_id                UInt64                                  CODEC(Delta, ZSTD(1)),
    -- 1=Pazartesi, 7=Pazar (ClickHouse toDayOfWeek standardı)
    day_of_week             UInt8                                   CODEC(ZSTD(1)),
    -- 0-23
    hour_of_day             UInt8                                   CODEC(ZSTD(1)),
    -- Hangi gün için (detaylı analiz ve GROUP BY zaman aralığı için)
    date                    Date                                    CODEC(DoubleDelta, ZSTD(1)),
    message_count           UInt64                                  CODEC(ZSTD(1))
)
ENGINE = SummingMergeTree()
ORDER BY (guild_id, day_of_week, hour_of_day, date)
SETTINGS
    index_granularity = 8192
;


-- ═══════════════════════════════════════════════════════════════════
-- attachment_types — Dosya Türü Dağılımı
-- ═══════════════════════════════════════════════════════════════════
-- Sorgu örneği:
--   SELECT content_type,
--          sum(file_count)   AS dosya_sayisi,
--          sum(total_bytes)  AS toplam_boyut
--   FROM senneo_analytics.attachment_types
--   WHERE guild_id = 5678 AND date >= today() - 30
--   GROUP BY content_type
--   ORDER BY dosya_sayisi DESC

CREATE TABLE IF NOT EXISTS senneo_analytics.attachment_types
(
    guild_id                UInt64                                  CODEC(Delta, ZSTD(1)),
    date                    Date                                    CODEC(DoubleDelta, ZSTD(1)),
    content_type            LowCardinality(String)                  CODEC(ZSTD(1)),
    file_count              UInt64                                  CODEC(ZSTD(1)),
    total_bytes             UInt64                                  CODEC(ZSTD(1))
)
ENGINE = SummingMergeTree()
ORDER BY (guild_id, date, content_type)
SETTINGS
    index_granularity = 8192
;
