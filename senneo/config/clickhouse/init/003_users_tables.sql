-- ─────────────────────────────────────────────────────────────────────────────
-- 003_users_tables.sql — Kullanıcı profil tabloları
-- Çalışma sırası: 3
-- ─────────────────────────────────────────────────────────────────────────────

-- ═══════════════════════════════════════════════════════════════════
-- users_latest — En güncel kullanıcı profili
-- ═══════════════════════════════════════════════════════════════════
--
-- Her mesaj ingest edildiğinde bu tabloya da yazılır.
-- Engine: ReplacingMergeTree(inserted_at)
--   → author_id başına en güncel satır (yüksek inserted_at) merge sırasında kalır.
--   → Sorgu sırasında FINAL ile anlık dedup sağlanır (küçük tablo, uygun).
-- index_granularity = 256:
--   → Küçük tabloda granularity'yi düşürmek point lookup'ı hızlandırır.
--   → Yüz milyonlarca user için hala yönetilebilir overhead.

CREATE TABLE IF NOT EXISTS senneo_users.users_latest
(
    author_id               UInt64                                  CODEC(Delta, ZSTD(1)),
    author_name             String                                  CODEC(ZSTD(1)),
    display_name            String              DEFAULT ''          CODEC(ZSTD(1)),
    author_avatar           String              DEFAULT ''          CODEC(ZSTD(1)),
    author_discriminator    String              DEFAULT '0'         CODEC(ZSTD(1)),
    badge_mask              UInt64              DEFAULT 0           CODEC(ZSTD(1)),
    is_bot                  UInt8               DEFAULT 0           CODEC(ZSTD(1)),

    -- last_seen_ts: ReplacingMergeTree'nin version alanı.
    -- Aynı author_id için en büyük last_seen_ts'li satır kazanır.
    last_seen_ts            DateTime64(3, 'UTC')                    CODEC(DoubleDelta, ZSTD(1)),

    -- first_seen_ts: Kullanıcının sistemde ilk görüldüğü zaman.
    -- Bu alan ReplacingMergeTree ile güvenilir şekilde saklanamaz
    -- (her write'ta now64 yazılır). Periyodik aggregation ile güncellenebilir.
    first_seen_ts           DateTime64(3, 'UTC')
                                DEFAULT now64(3, 'UTC')             CODEC(DoubleDelta, ZSTD(1)),

    -- Örnek guild — "bu kullanıcı hangi guild'de görüldü?" sorusu için heuristik
    sample_guild_id         UInt64              DEFAULT 0           CODEC(Delta, ZSTD(1)),

    -- Kullanıcının gönderdiği toplam mesaj sayısı.
    -- Her insert'te artırılmaz (aşırı write amplification).
    -- Bunun yerine: messages tablosundan periyodik COUNT ile doldurulan referans.
    message_count           UInt64              DEFAULT 0           CODEC(ZSTD(1)),

    inserted_at             DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
                                                                    CODEC(DoubleDelta, ZSTD(1))
)
ENGINE = ReplacingMergeTree(inserted_at)
ORDER BY (author_id)
SETTINGS
    index_granularity = 256
;


-- ═══════════════════════════════════════════════════════════════════
-- user_identity_log — Kullanıcı Kimlik Değişiklik Geçmişi
-- ═══════════════════════════════════════════════════════════════════
--
-- Kullanıcı adı, avatar, display_name, nick değiştirdiğinde buraya yazılır.
-- Ingester: LRU cache ile önceki değeri karşılaştırır, farklıysa insert eder.
--
-- field değerleri:
--   'username'      → Discord global username (author_name)
--   'display_name'  → Discord display name (globalName)
--   'avatar'        → Avatar hash string
--   'nick'          → Guild-specific nickname (guild_id > 0)
--
-- guild_id:
--   0 = global alan (username, display_name, avatar)
--   >0 = guild-specific alan (nick)
--
-- Engine: ReplacingMergeTree(inserted_at)
--   ORDER BY: (author_id, field, guild_id, value)
--   → Her (kullanıcı, alan, guild, değer) kombinasyonu bir satır.
--   → Aynı değer tekrar gelirse güncellenir (inserted_at artar).
--   → Değer değiştiğinde farklı bir satır eklenir (farklı value).
--
-- VERİ SİLİNMEZ — TTL yok, geçmiş sonsuza kadar saklanır.

CREATE TABLE IF NOT EXISTS senneo_users.user_identity_log
(
    author_id               UInt64                                  CODEC(Delta, ZSTD(1)),

    -- 'username' | 'display_name' | 'avatar' | 'nick'
    field                   LowCardinality(String)                  CODEC(ZSTD(1)),

    -- Değer (kullanıcı adı, avatar hash, vb.)
    value                   String                                  CODEC(ZSTD(3)),

    -- 0 = global, >0 = guild ID (nick için)
    guild_id                UInt64              DEFAULT 0           CODEC(Delta, ZSTD(1)),

    -- Ingestion zamanı (değişikliğin tespit edildiği an)
    observed_ts             DateTime64(3, 'UTC')                    CODEC(DoubleDelta, ZSTD(1)),

    -- Değişikliğin kaynağı olan mesajın zamanı (bilgi amaçlı)
    source_msg_ts           DateTime64(3, 'UTC')
                                DEFAULT toDateTime64('1970-01-01 00:00:00.000', 3, 'UTC')
                                                                    CODEC(DoubleDelta, ZSTD(1)),

    inserted_at             DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
                                                                    CODEC(DoubleDelta, ZSTD(1))
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(observed_ts)
ORDER BY (author_id, field, guild_id, value)
SETTINGS
    index_granularity = 4096
;
