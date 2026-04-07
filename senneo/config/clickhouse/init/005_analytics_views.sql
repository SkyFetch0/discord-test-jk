-- ─────────────────────────────────────────────────────────────────────────────
-- 005_analytics_views.sql — Materialized View'lar
-- Çalışma sırası: 5 (hedef tablolar 004'te oluşturuldu)
--
-- Her MV, senneo_messages.messages tablosuna yeni satır geldiğinde otomatik olarak
-- tetiklenir ve ilgili hedef tabloya yazar.
--
-- ÖNEMLİ:
--   AggregatingMergeTree hedef tablolarına yazan MV'lerde
--   uniq() yerine uniqState() kullanılmalıdır.
--   Sorgu sırasında uniqMerge() ile sonuç alınır.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════
-- channel_daily_mv → channel_daily
-- ═══════════════════════════════════════════════════════════════════

CREATE MATERIALIZED VIEW IF NOT EXISTS senneo_analytics.channel_daily_mv
TO senneo_analytics.channel_daily
AS
SELECT
    channel_id,
    guild_id,
    toDate(ts)                                          AS date,
    count()                                             AS message_count,
    countIf(is_bot = 1)                                 AS bot_message_count,
    countIf(ref_msg_id > 0)                             AS reply_count,
    countIf(attachment_count > 0)                       AS attachment_message_count,
    sum(toUInt64(content_length))                       AS total_content_length,
    -- uniqState: HyperLogLog state'i olarak yazar, merge sırasında birleştirilir
    uniqState(author_id)                                AS unique_authors
FROM senneo_messages.messages
GROUP BY channel_id, guild_id, date
;


-- ═══════════════════════════════════════════════════════════════════
-- guild_daily_mv → guild_daily
-- ═══════════════════════════════════════════════════════════════════

CREATE MATERIALIZED VIEW IF NOT EXISTS senneo_analytics.guild_daily_mv
TO senneo_analytics.guild_daily
AS
SELECT
    guild_id,
    toDate(ts)                                          AS date,
    count()                                             AS message_count,
    countIf(is_bot = 1)                                 AS bot_message_count,
    uniqState(author_id)                                AS unique_authors,
    uniqState(channel_id)                               AS active_channels
FROM senneo_messages.messages
GROUP BY guild_id, date
;


-- ═══════════════════════════════════════════════════════════════════
-- author_daily_mv → author_daily
-- ═══════════════════════════════════════════════════════════════════

CREATE MATERIALIZED VIEW IF NOT EXISTS senneo_analytics.author_daily_mv
TO senneo_analytics.author_daily
AS
SELECT
    author_id,
    guild_id,
    toDate(ts)                                          AS date,
    count()                                             AS message_count,
    countIf(ref_msg_id > 0)                             AS reply_count,
    countIf(attachment_count > 0)                       AS attachment_count,
    uniqState(channel_id)                               AS active_channels
FROM senneo_messages.messages
GROUP BY author_id, guild_id, date
;


-- ═══════════════════════════════════════════════════════════════════
-- hourly_heatmap_mv → hourly_heatmap
-- ═══════════════════════════════════════════════════════════════════

CREATE MATERIALIZED VIEW IF NOT EXISTS senneo_analytics.hourly_heatmap_mv
TO senneo_analytics.hourly_heatmap
AS
SELECT
    guild_id,
    toDayOfWeek(ts)                                     AS day_of_week,
    toHour(ts)                                          AS hour_of_day,
    toDate(ts)                                          AS date,
    count()                                             AS message_count
FROM senneo_messages.messages
GROUP BY guild_id, day_of_week, hour_of_day, date
;


-- ═══════════════════════════════════════════════════════════════════
-- attachment_types_mv → attachment_types
-- ═══════════════════════════════════════════════════════════════════
-- ARRAY JOIN kullanılıyor çünkü attachments bir dizi Tuple.
-- Her (guild_id, date, content_type) kombinasyonu için
-- dosya sayısı ve toplam boyut hesaplanır.
-- Boş attachments dizisi için satır üretilmez (ARRAY JOIN semantiği).

CREATE MATERIALIZED VIEW IF NOT EXISTS senneo_analytics.attachment_types_mv
TO senneo_analytics.attachment_types
AS
SELECT
    guild_id,
    toDate(ts)                                          AS date,
    att.content_type                                    AS content_type,
    count()                                             AS file_count,
    sum(toUInt64(att.size))                             AS total_bytes
FROM senneo_messages.messages
ARRAY JOIN attachments AS att
WHERE attachment_count > 0
  AND att.content_type != ''
GROUP BY guild_id, date, content_type
;
