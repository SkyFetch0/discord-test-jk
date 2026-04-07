-- ─────────────────────────────────────────────────────────────────────────────
-- 002_messages_table.sql — Ana mesaj tablosu
-- Çalışma sırası: 2
--
-- Bu tablo 500 milyar satır için tasarlanmıştır.
-- ORDER BY: (guild_id, channel_id, ts, message_id)
--   → Kanal scroll sorgularının ana sıralama düzeniyle tam uyumlu.
--   → guild_id prefix'i, guild-bazlı shard'lama yapılırsa distribution key olur.
--
-- Engine: ReplacingMergeTree(inserted_at)
--   → Aynı message_id birden fazla gelirse, en yüksek inserted_at'li satır kalır.
--   → Kafka redelivery ve scraper restart'larından kaynaklanan duplikatları kaldırır.
--   → Merge asenkron gerçekleşir; sorgu sırasında FINAL ile anlık dedup yapılabilir.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS senneo_messages.messages
(
    -- ═══════════════════════════════════════════════════════
    -- Kimlik Alanları
    -- Delta codec: snowflake ID'ler sıralı artığından Delta çok etkili.
    -- ═══════════════════════════════════════════════════════
    message_id              UInt64                                  CODEC(Delta, ZSTD(1)),
    channel_id              UInt64                                  CODEC(Delta, ZSTD(1)),
    guild_id                UInt64                                  CODEC(Delta, ZSTD(1)),
    author_id               UInt64                                  CODEC(Delta, ZSTD(1)),

    -- ═══════════════════════════════════════════════════════
    -- Mesaj İçeriği
    -- ═══════════════════════════════════════════════════════
    content                 String                                  CODEC(ZSTD(3)),
    -- ZSTD(3): mesaj içeriği uzun ve tekrarlıdır; level 3 %30+ ek tasarruf sağlar.

    -- Discord mesaj tipi:
    --   0  = DEFAULT (normal mesaj)
    --   6  = CHANNEL_PINNED_MESSAGE
    --   7  = GUILD_MEMBER_JOIN
    --   8  = USER_PREMIUM_GUILD_SUBSCRIPTION
    --   19 = REPLY
    --   20 = APPLICATION_COMMAND
    --   21 = THREAD_STARTER_MESSAGE
    --   22 = GUILD_INVITE_REMINDER
    message_type            UInt8               DEFAULT 0           CODEC(ZSTD(1)),

    -- Discord mesaj flag'leri (bitfield):
    --   bit 0  = CROSSPOSTED
    --   bit 1  = IS_CROSSPOST
    --   bit 2  = SUPPRESS_EMBEDS
    --   bit 3  = SOURCE_MESSAGE_DELETED
    --   bit 4  = URGENT
    --   bit 6  = EPHEMERAL
    --   bit 7  = LOADING (interaction deferred)
    --   bit 12 = SUPPRESS_NOTIFICATIONS
    --   bit 13 = IS_VOICE_MESSAGE
    message_flags           UInt32              DEFAULT 0           CODEC(ZSTD(1)),

    tts                     UInt8               DEFAULT 0           CODEC(ZSTD(1)),
    pinned                  UInt8               DEFAULT 0           CODEC(ZSTD(1)),

    -- ═══════════════════════════════════════════════════════
    -- Zaman Alanları
    -- DoubleDelta: zaman serisinde artışlar düzenli → en iyi codec.
    -- ═══════════════════════════════════════════════════════
    ts                      DateTime64(3, 'UTC')                    CODEC(DoubleDelta, ZSTD(1)),

    -- 1970-01-01 00:00:00.000 = hiç düzenlenmemiş (null yerine default)
    edited_ts               DateTime64(3, 'UTC')
                                DEFAULT toDateTime64('1970-01-01 00:00:00.000', 3, 'UTC')
                                                                    CODEC(DoubleDelta, ZSTD(1)),

    -- ═══════════════════════════════════════════════════════
    -- Yazar Bilgisi (Mesaj Anındaki Snapshot)
    -- Her mesajla birlikte kaydedilir; kullanıcı adı değişse de
    -- geçmiş mesajlarda o anki değer saklanmış olur.
    -- ═══════════════════════════════════════════════════════
    author_name             String                                  CODEC(ZSTD(1)),
    author_discriminator    String              DEFAULT '0'         CODEC(ZSTD(1)),
    display_name            String              DEFAULT ''          CODEC(ZSTD(1)),
    nick                    String              DEFAULT ''          CODEC(ZSTD(1)),
    author_avatar           String              DEFAULT ''          CODEC(ZSTD(1)),
    is_bot                  UInt8               DEFAULT 0           CODEC(ZSTD(1)),

    -- Badge bitfield (public_flags):
    --   bit 0  = STAFF
    --   bit 1  = PARTNER
    --   bit 2  = HYPESQUAD
    --   bit 3  = BUG_HUNTER_LEVEL_1
    --   bit 6  = HYPESQUAD_BRAVERY
    --   bit 7  = HYPESQUAD_BRILLIANCE
    --   bit 8  = HYPESQUAD_BALANCE
    --   bit 9  = EARLY_SUPPORTER
    --   bit 14 = BUG_HUNTER_LEVEL_2
    --   bit 17 = VERIFIED_BOT
    --   bit 18 = EARLY_VERIFIED_BOT_DEVELOPER
    --   bit 22 = CERTIFIED_MODERATOR
    --   bit 24 = Nitro heuristic (animated avatar)
    --   bit 25 = Server Booster heuristic (member.premiumSince)
    badge_mask              UInt64              DEFAULT 0           CODEC(ZSTD(1)),

    -- ═══════════════════════════════════════════════════════
    -- Attachment ve Medya
    -- ═══════════════════════════════════════════════════════

    -- Ön-hesaplanmış medya kategorisi (hızlı filtreleme için):
    --   'none' | 'image' | 'gif' | 'video' | 'sticker' | 'mixed'
    media_type              LowCardinality(String) DEFAULT 'none'   CODEC(ZSTD(1)),

    -- Attachment sayısı (has_attachment materialized kolonunun kaynağı)
    attachment_count        UInt8               DEFAULT 0           CODEC(ZSTD(1)),

    -- Tam attachment metadata — Tuple ile birden fazla alan saklanır.
    -- Eski veri (sadece URL) için: [('url', '', 0, '')]
    -- size: bytes cinsinden dosya boyutu
    attachments             Array(Tuple(
                                url          String,
                                filename     String,
                                size         UInt32,
                                content_type String
                            ))                  DEFAULT []          CODEC(ZSTD(3)),

    -- ═══════════════════════════════════════════════════════
    -- Embed ve Sticker Alanları
    -- ═══════════════════════════════════════════════════════

    -- Embed tip listesi: 'image' | 'gifv' | 'video' | 'link' | 'rich' | 'unknown'
    embed_types             Array(LowCardinality(String)) DEFAULT [] CODEC(ZSTD(1)),
    embed_count             UInt8               DEFAULT 0           CODEC(ZSTD(1)),

    -- Embed'den çıkarılan medya URL'leri (tenor, giphy, imgur, CDN)
    media_urls              Array(String)       DEFAULT []          CODEC(ZSTD(3)),

    sticker_names           Array(String)       DEFAULT []          CODEC(ZSTD(1)),
    sticker_ids             Array(String)       DEFAULT []          CODEC(ZSTD(1)),

    -- ═══════════════════════════════════════════════════════
    -- İlişkiler
    -- ═══════════════════════════════════════════════════════

    -- Reply hedef mesajın ID'si. 0 = reply değil.
    ref_msg_id              UInt64              DEFAULT 0           CODEC(Delta, ZSTD(1)),

    -- ═══════════════════════════════════════════════════════
    -- Guild Member Rolleri (Mesaj Anındaki Snapshot)
    -- ═══════════════════════════════════════════════════════
    roles                   Array(UInt64)       DEFAULT []          CODEC(ZSTD(1)),

    -- ═══════════════════════════════════════════════════════
    -- Sistem Alanları
    -- ═══════════════════════════════════════════════════════

    -- Ingestion zamanı — ReplacingMergeTree'nin version kolonudur.
    -- Aynı message_id için en yüksek inserted_at'li satır kazanır.
    inserted_at             DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
                                                                    CODEC(DoubleDelta, ZSTD(1)),

    -- ═══════════════════════════════════════════════════════
    -- Materialized Kolonlar (otomatik hesaplanır, disk'te saklanır)
    -- ═══════════════════════════════════════════════════════

    -- Günlük partition filtresi için (channel_daily_mv gibi MV'lerde kullanılır)
    created_date            Date                MATERIALIZED toDate(ts),

    -- Aylık gruplama için
    created_month           UInt32              MATERIALIZED toYYYYMM(ts),

    -- Hızlı "mesajda attachment var mı?" filtresi
    has_attachment          UInt8               MATERIALIZED if(attachment_count > 0, 1, 0),

    -- Hızlı "bu mesaj bir reply mi?" filtresi
    is_reply                UInt8               MATERIALIZED if(ref_msg_id > 0, 1, 0),

    -- İçerik uzunluğu analizi için (mesaj boyutu istatistikleri)
    content_length          UInt32              MATERIALIZED length(content)
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(ts)
ORDER BY (guild_id, channel_id, ts, message_id)
SETTINGS
    -- Part başına satır ve boyut eşikleri (wide format için)
    min_bytes_for_wide_part             = 10485760,   -- 10 MB
    min_rows_for_wide_part              = 100000,     -- 100K satır

    -- 200K/s ingest için yeterli part limiti
    parts_to_delay_insert               = 400,
    parts_to_throw_insert               = 500,

    -- Standart granularity (8192 = ClickHouse default)
    index_granularity                   = 8192
;
