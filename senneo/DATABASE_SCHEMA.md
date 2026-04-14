# Senneo Veritabanı ve Veri Akış Şeması

## 📊 Mimari Genel Bakış

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              S E N N E O   A R C H I T E C T U R E                  │
└─────────────────────────────────────────────────────────────────────────────────┘

┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Discord    │────▶│    Accounts   │────▶│   Redpanda   │────▶│   Ingester   │
│   API        │     │   Scraper    │     │    (Kafka)   │     │              │
└──────────────┘     └──────────────┘     └──────────────┘     └──────┬───────┘
                           │                                         │
                           ▼                                         ▼
                    ┌──────────────┐                           ┌──────────────┐
                    │   ScyllaDB   │                           │  ClickHouse  │
                    │  (Operasyonel)│                          │  (Mesajlar)  │
                    └──────────────┘                           └──────────────┘
                           │                                         │
                           ▼                                         ▼
                    ┌──────────────┐                           ┌──────────────┐
                    │     API      │◀────────────────────────────────│
                    │   + Express  │                           └──────────────┘
                    └──────────────┘                                    │
                           │                                            │
                           ▼                                            ▼
                    ┌──────────────┐                           ┌──────────────┐
                    │   Dashboard  │                           │   Grafana    │
                    │  (React/Vite)│                           │  (Monitoring)│
                    └──────────────┘                           └──────────────┘
```

---

## 🗄️ Veritabanı Yapısı

### ClickHouse (Primary Message Store + Analytics)

| Database | Açıklama | Disk Kullanımı |
|----------|----------|----------------|
| `senneo_messages` | Mesaj depolama (ana tablo + projections) | 292 MB |
| `senneo_users` | Kullanıcı profilleri ve kimlik geçmişi | 45 MB |
| `senneo_analytics` | Önceden hesaplanmış istatistikler | 18 MB |
| `senneo_operations` | Sistem monitoring ve hata logları | - |
| **TOPLAM** | | **~355 MB** |

### ScyllaDB (Operasyonel State)

| Keyspace | Açıklama |
|----------|----------|
| `senneo` | Scraper kontrolü, guild envanteri, invite havuzu, auth |

---

## 📋 ClickHouse Tabloları

### 1. `senneo_messages.messages` — Ana Mesaj Tablosu

**Sorgu:** `001_databases.sql`, `002_messages_table.sql`

```sql
CREATE TABLE senneo_messages.messages (
  -- Birincil Anahtarlar
  message_id    UInt64,        -- Discord mesaj ID'si
  channel_id    UInt64,        -- Discord kanal ID'si
  guild_id      UInt64,        -- Discord sunucu ID'si
  author_id     UInt64,        -- Discord kullanıcı ID'si
  
  -- Zaman Bilgileri
  ts            DateTime64(3), -- Mesaj zamanı
  edited_ts     DateTime64(3), -- Düzenlenme zamanı (nullable)
  inserted_at   DateTime64(3) DEFAULT now(), -- ClickHouse'a yazma zamanı
  
  -- Mesaj İçeriği
  content       String,        -- Mesaj metni
  message_type  UInt8,         -- Mesaj tipi (0=default, 1=reply, 2=thread_starter, ...)
  message_flags UInt32,        -- Mesaj flag'leri (has_thread, is_pinned, ...)
  ref_msg_id    UInt64,        -- Referans mesaj ID'si (reply/forward)
  ref_channel_id UInt64,       -- Referans kanal ID'si
  
  -- Yazar Anlık Görüntüsü
  author_name       String,    -- Kullanıcı adı (değişebilir)
  author_discriminator String, -- Kullanıcı discriminators (#0000)
  display_name      String,    -- Global display name (değişebilir)
  nick              String,    -- Sunucu takma adı (nullable)
  author_avatar     String,    -- Avatar hash (nullable)
  badge_mask        UInt32,    -- Public flags + custom badges
  is_bot            UInt8,     -- Bot mu?
  
  -- Medya Bilgileri
  attachments       Array(String), -- Ek dosya URL'leri
  media_urls        Array(String), -- Gömülü medya URL'leri (gif, image, video)
  embed_types       Array(String), -- Embed tipleri
  sticker_names     Array(String), -- Sticker isimleri
  sticker_ids       Array(String), -- Sticker ID'leri
  media_type        String,        -- Medya tipi (none, image, gif, video, mixed, sticker)
  
  -- Metadata
  reply_count       UInt32,        -- Cevap sayısı (real-time değil, snapshot)
  INDEX idx_msg_id (message_id) TYPE minmax GRANULARITY 4,
  INDEX idx_channel (channel_id) TYPE set(50) GRANULARITY 4,
  INDEX idx_guild (guild_id) TYPE set(50) GRANULARITY 4,
  INDEX idx_author (author_id) TYPE set(50) GRANULARITY 4,
  INDEX idx_ts (ts) TYPE minmax GRANULARITY 8
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(ts)
ORDER BY (channel_id, message_id)
SETTINGS index_granularity = 8192;
```

**Projections (Hızlı Sorgu Optimizasyonları):**

| Projection | Açıklama | Sorgu Optimizasyonu |
|------------|----------|---------------------|
| `messages_by_channel` | Kanal başına mesaj timeline | `WHERE channel_id = ? ORDER BY ts DESC` |
| `messages_by_author` | Kullanıcı mesaj geçmişi | `WHERE author_id = ? ORDER BY ts DESC` |
| `messages_by_guild` | Sunucu mesaj timeline | `WHERE guild_id = ? ORDER BY ts DESC` |

---

### 2. `senneo_users` — Kullanıcı Profilleri

#### `users_latest` — En Son Kullanıcı Durumu

```sql
CREATE TABLE senneo_users.users_latest (
  author_id     UInt64,        -- Discord kullanıcı ID
  username      String,        -- Kullanıcı adı (en son)
  discriminator String,        -- Discriminator (en son)
  display_name  String,        -- Global display name (en son)
  avatar        String,        -- Avatar hash (en son)
  badge_mask    UInt32,        -- Public flags (en son)
  is_bot        UInt8,         -- Bot mu?
  last_seen     DateTime64(3), -- Son görülme zamanı
  updated_at    DateTime64(3)  -- Son güncelleme zamanı
)
ENGINE = ReplacingMergeTree()
ORDER BY author_id
PRIMARY KEY author_id;
```

#### `user_identity_log` — Kullanıcı Kimlik Geçmişi

```sql
CREATE TABLE senneo_users.user_identity_log (
  author_id     UInt64,        -- Discord kullanıcı ID
  username      String,        -- Kullanıcı adı (o anki)
  discriminator String,        -- Discriminator (o anki)
  display_name  String,        -- Global display name (o anki)
  avatar        String,        -- Avatar hash (o anki)
  badge_mask    UInt32,        -- Public flags (o anki)
  changed_at    DateTime64(3), -- Değişiklik zamanı
  change_type   String         -- Değişiklik tipi (username, avatar, badge)
)
ENGINE = MergeTree()
ORDER BY (author_id, changed_at);
```

---

### 3. `senneo_analytics` — Önceden Hesaplanmış İstatistikler

#### `author_daily` — Günlük Kullanıcı İstatistikleri

```sql
CREATE TABLE senneo_analytics.author_daily (
  author_id    UInt64,
  guild_id     UInt64,
  date         Date,
  message_count UInt32,
  media_count  UInt32,
  reply_count  UInt32,
  first_msg_ts DateTime64(3),
  last_msg_ts  DateTime64(3)
)
ENGINE = SummingMergeTree()
ORDER BY (author_id, guild_id, date);
```

#### `channel_daily` — Günlük Kanal İstatistikleri

```sql
CREATE TABLE senneo_analytics.channel_daily (
  channel_id   UInt64,
  guild_id     UInt64,
  date         Date,
  message_count UInt32,
  author_count UInt32,
  first_msg_ts DateTime64(3),
  last_msg_ts  DateTime64(3)
)
ENGINE = SummingMergeTree()
ORDER BY (channel_id, date);
```

#### `guild_daily` — Günlük Sunucu İstatistikleri

```sql
CREATE TABLE senneo_analytics.guild_daily (
  guild_id      UInt64,
  date          Date,
  message_count UInt32,
  channel_count UInt32,
  author_count  UInt32,
  first_msg_ts  DateTime64(3),
  last_msg_ts   DateTime64(3)
)
ENGINE = SummingMergeTree()
ORDER BY (guild_id, date);
```

#### `hourly_heatmap` — Saatlik Aktivite Heatmap'i

```sql
CREATE TABLE senneo_analytics.hourly_heatmap (
  guild_id   UInt64,
  channel_id UInt64,
  date       Date,
  hour       UInt8,
  count      UInt32
)
ENGINE = SummingMergeTree()
ORDER BY (guild_id, channel_id, date, hour);
```

---

## 🗃️ ScyllaDB Tabloları (Keyspace: `senneo`)

### Operasyonel Tablolar

| Tablo | Açıklama | Primary Key |
|-------|----------|-------------|
| `scrape_targets` | Hangi hesap hangi kanalı scrape'leyecek | `guild_id, channel_id, account_id` |
| `scrape_checkpoints` | Scrape ilerleme durumu | `channel_id` |
| `scrape_stats` | Anlık scrape istatistikleri | `channel_id` |
| `name_cache` | Kanal/Guild adları cache'i | `id` |
| `guild_inventory` | Tüm bilinen guild'ler | `guild_id` |
| `invite_pool` | Discord invite linkleri | `invite_code` |
| `categories` | Guild kategorileri | `guild_id, category_id` |
| `archived_accounts` | Arşivlenmiş hesap bilgileri | `account_id` |
| `auth_tokens` | JWT token'lar | `user_id` |
| `alert_rules` | Alert kuralları | `rule_id` |

#### `scrape_targets` Önemli Sütunlar

```sql
CREATE TABLE senneo.scrape_targets (
  guild_id      uuid,
  channel_id    uuid,
  label         text,
  account_id    uuid,
  pinned_account_id uuid,  -- Sahibi olan hesap
  priority      int,
  created_at    timestamp,
  PRIMARY KEY (guild_id, channel_id, account_id)
);
```

#### `scrape_checkpoints` Önemli Sütunlar

```sql
CREATE TABLE senneo.scrape_checkpoints (
  channel_id        uuid,
  guild_id          uuid,
  newest_message_id  text,
  cursor_id         text,
  total_scraped      bigint,
  complete          boolean,
  last_scraped_at   timestamp,
  PRIMARY KEY (channel_id)
);
```

#### `scrape_stats` Önemli Sütunlar

```sql
CREATE TABLE senneo.scrape_stats (
  channel_id      uuid,
  account_id      uuid,
  total_scraped   bigint,
  msgs_per_sec    double,
  rate_limit_hits int,
  errors          list<text>,
  complete        boolean,
  last_updated    timestamp,
  scheduler_state text,
  pause_source    text,
  state_updated_at timestamp,
  state_reason    text,
  worker_id       text,
  lease_expires_at timestamp,
  last_error_class text,
  last_error_code text,
  last_error_at   timestamp,
  PRIMARY KEY (channel_id)
);
```

---

## 🔄 Veri Akışı (Data Flow)

### 1. Mesaj Scraping Akışı

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        M E S A J   S C R A P I N G   F L O W                    │
└─────────────────────────────────────────────────────────────────────────────────┘

Discord API
    │
    │ rawFetchMessages(token, channelId, limit=100, beforeCursor)
    │
    ▼
┌───────────────────┐
│  Accounts Scraper │
│  (packages/       │
│   accounts/src/)  │
└───────────────────┘
    │
    ├─▶ ScyllaDB: scrape_checkpoints (cursor ilerlemesi)
    ├─▶ ScyllaDB: scrape_stats (anlık durum)
    │
    │ 100 mesaj/batch
    │
    ▼
┌───────────────────┐
│   Kafka Topic     │
│   "messages"     │
│   (Redpanda)     │
└───────────────────┘
    │
    │ 16 partition, lz4 compression
    │
    ▼
┌───────────────────┐
│   Ingester       │
│  (packages/      │
│   ingester/src/) │
└───────────────────┘
    │
    ├─▶ ClickHouse: senneo_messages.messages (INSERT)
    ├─▶ ClickHouse: senneo_users.users_latest (MERGE)
    ├─▶ ClickHouse: senneo_users.user_identity_log (INSERT)
    │
    ▼
┌───────────────────┐
│  Materialized     │
│  Views Trigger    │
└───────────────────┘
    │
    ├─▶ author_daily (SUM)
    ├─▶ channel_daily (SUM)
    ├─▶ guild_daily (SUM)
    └─▶ hourly_heatmap (SUM)
```

### 2. API Sorgu Akışı

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        A P I   Q U E R Y   F L O W                              │
└─────────────────────────────────────────────────────────────────────────────────┘

Dashboard /api/live/* 
    │
    ▼
┌───────────────────┐
│   API Server      │
│  (packages/api/)  │
└───────────────────┘
    │
    ├─▶ ClickHouse: senneo_messages.messages (recent messages, summary)
    ├─▶ ClickHouse: senneo_analytics.* (pre-aggregated stats)
    │
    ├─▶ ScyllaDB: scrape_stats (anlık scrape durumu)
    ├─▶ ScyllaDB: scrape_checkpoints (ilerleme)
    ├─▶ ScyllaDB: scrape_targets (hedef kanallar)
    ├─▶ ScyllaDB: name_cache (kanal/guild isimleri)
    │
    └─▶ ScyllaDB: auth_tokens (kullanıcı auth)
```

---

## 📈 Disk Kullanımı Detayları

| Tablo | Boyut | Satır Sayısı | Açıklama |
|-------|------|--------------|----------|
| `senneo_messages.messages` | 291.58 MiB | 6,576,433 | Ana mesaj tablosu |
| `senneo_users.user_identity_log` | 24.28 MiB | 1,072,231 | Kullanıcı geçmişi |
| `senneo_users.users_latest` | 20.49 MiB | 405,349 | Son kullanıcı durumu |
| `senneo_analytics.author_daily` | 6.97 MiB | 1,400,453 | Günlük kullanıcı istatistikleri |
| `senneo_analytics.channel_daily` | 5.36 MiB | 4,722 | Günlük kanal istatistikleri |
| `senneo_analytics.guild_daily` | 5.29 MiB | 3,077 | Günlük sunucu istatistikleri |
| `senneo_analytics.hourly_heatmap` | 61.71 KiB | 41,182 | Saatlik aktivite heatmap |
| **ClickHouse TOPLAM** | **354.03 MiB** | **~9.5M** | |

---

## 🚀 Rate Limiter Ayarları

| Parametre | Varsayılan | Açıklama |
|-----------|-----------|----------|
| `MAX_MSG_PER_SEC_CHANNEL` | 60 | Kanal başına max mesaj/sn |
| `MAX_MSG_PER_SEC_ACCOUNT` | 300 | Hesap başına max mesaj/sn (5 kanal × 60) |
| `SCRAPE_BATCH_SIZE` | 100 | Batch boyutu |
| `FETCH_DELAY_MS` | 300 | Batch arası bekleme |
| `MAX_BATCHES_PER_RUN` | 50 | Time-slicing limiti |

---

*Otomatik olarak oluşturuldu: 2026-04-10*
