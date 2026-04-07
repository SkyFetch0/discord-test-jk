# Senneo — Sistem Mimarisi

## Genel Bakış

```
Discord API ──► Scraper ──► Kafka (Redpanda) ──► Ingester ──► ScyllaDB + ClickHouse
                  │                                               │
                  │              ┌─────────────────────────────────┘
                  │              │
                  ▼              ▼
            accounts.json    API Server (Express :4000)
            proxies.json        │
                                ├── Auth (JWT + Cookie)
                                ├── /admin → Dashboard (React SPA)
                                └── /     → User Login
```

## Servisler

| Servis | Paket | Port | Başlatma |
|--------|-------|------|----------|
| **Scraper** | `@senneo/accounts` | — | `make start-accounts` |
| **Ingester** | `@senneo/ingester` | — | `make start-ingester` |
| **API** | `@senneo/api` | 4000 | `make start-api` |
| **Bot** | `@senneo/bot` | — | (opsiyonel, canlı dinleme) |
| **Dashboard** | `senneo-dashboard` | — | Vite build → `api/public/` |

## Altyapı (Docker Compose)

| Servis | Image | Port | Rol |
|--------|-------|------|-----|
| **ScyllaDB** | scylladb/scylla:5.4 | 9042 | Kaynak doğruluk (mesajlar, hedefler, checkpoints) |
| **ClickHouse** | clickhouse:23.8 | 8123 | Analitik (arama, istatistik, kimlik geçmişi) |
| **Redpanda** | redpanda:v23.2.21 | 9092 | Kafka-uyumlu mesaj kuyruğu |
| **Prometheus** | prom/prometheus | 9090 | Metrik toplama |
| **Grafana** | grafana | 3000 | Metrik görselleştirme |

---

## Veri Akışı

```
1. TOPLAMA
   accounts.json → Scraper login (discord.js-selfbot-v13 WebSocket)
   Her hesap → PQueue (concurrency 15) → scrapeChannel() döngüsü
   100 mesaj/batch → adaptif gecikme (120ms–2000ms) → RawMessage JSON

2. KUYRUK
   Scraper → Kafka "messages" topic (16 partition, gzip, 7d retention)
   Key: channelId → aynı kanal = aynı partition = sıralı

3. İŞLEME
   Ingester → Kafka consumer (group: senneo-ingester)
   eachBatch → flushBatch(2000):
     ├── ScyllaDB yazma (3 tablo: by_id, by_channel_bucket, by_author)
     ├── ClickHouse yazma (messages, users_latest, identity_log)
     └── Scylla başarısız = offset commit YOK (at-least-once garanti)

4. SORGULAMA
   API → ScyllaDB (nokta sorgu, zaman serisi scroll)
   API → ClickHouse (analitik, arama, toplam)
   Dashboard → API (REST + SSE)
```

---

## ScyllaDB Tabloları (Keyspace: senneo)

### Mesaj Tabloları (Ingester yazar)
| Tablo | PK | Açıklama |
|-------|-----|----------|
| `messages_by_id` | message_id | Nokta sorgu |
| `messages_by_channel_bucket` | (channel_id, bucket) | Zaman serisi scroll |
| `messages_by_author` | (author_id, bucket) | Yazar bazlı sorgu |

### Scraper Tabloları
| Tablo | PK | Açıklama |
|-------|-----|----------|
| `scrape_targets` | channel_id | Hangi kanallar kazınıyor |
| `scrape_checkpoints` | channel_id | cursor_id, total_scraped, complete |
| `scrape_stats` | channel_id | msgs/sec, rate_limit, account_id |
| `name_cache` | id | Guild/kanal isim önbelleği |

### Sunucu Yönetimi Tabloları
| Tablo | PK | Açıklama |
|-------|-----|----------|
| `account_guilds` | (account_id, guild_id) | Hesabın üye olduğu sunucular |
| `guild_accounts` | (guild_id, account_id) | Sunucudaki hesaplar (ters arama) |
| `invite_pool` | invite_code | Davet havuzu (status: to_join/already_in/invalid) |
| `invite_pool_jobs` | job_id | Async batch işleme takibi |
| `join_categories` | category_id | Hesap bazlı kategori metadata |
| `category_guilds` | (category_id, guild_id) | Kategori ↔ sunucu eşleme |
| `guild_sync_status` | id='current' | Singleton sync progress |
| `account_info` | account_id | Discord user bilgi cache |

### Arşiv & Hata Tabloları
| Tablo | PK | Açıklama |
|-------|-----|----------|
| `archived_accounts` | account_id | Kapanan hesap snapshot başlığı |
| `archived_account_guilds` | (account_id, guild_id) | Kapanan hesabın sunucuları |
| `archived_account_channels` | (account_id, channel_id) | Kapanan hesabın kanal ilerlemeleri |
| `failed_accounts` | account_id | Otomatik algılanan kapanan hesaplar |
| `token_account_map` | token_key | Token → account_id eşleme |

### Auth Tabloları
| Tablo | PK | Açıklama |
|-------|-----|----------|
| `dashboard_users` | username | Dashboard kullanıcıları (bcrypt hash) |
| `user_tasks` | (assigned_to, task_id) | Görev atama sistemi |
| `user_notifications` | (username, notification_id) | Bildirimler |
| `user_sessions` | session_id | JWT oturum takibi |

---

## ClickHouse Tabloları (DB: senneo)

| Tablo | Engine | Açıklama |
|-------|--------|----------|
| `messages` | MergeTree | Tüm mesajlar (PARTITION BY toYYYYMM) |
| `users_latest` | ReplacingMergeTree | Son kullanıcı profili |
| `channel_daily_mv` | SummingMergeTree MV | Kanal bazlı günlük istatistik |
| `user_identity_log` | ReplacingMergeTree | Kullanıcı değişiklik geçmişi (TTL 365d) |
| `error_log` | MergeTree | Merkezi hata logu (TTL 30d) |

---

## API Route Haritası

```
/auth            → Login, logout, me, user CRUD, tasks, notifications
  POST /login    → JWT cookie (7d expiry)
  GET  /me       → Oturum kontrolü
  POST /users    → Hesap oluşturma (admin only)

/health          → Liveness + deep check (Scylla, CH, Kafka)
/accounts        → Token yönetimi, hedef ekleme/silme
/live            → Scraper dashboard (SSE summary, channels, guilds)
/messages        → Mesaj sorguları (search, context, badges)
/db              → ClickHouse/ScyllaDB explorer
/metrics         → Prometheus scrape endpoint
/alerts          → Webhook alert rules
/errors          → Merkezi hata logu
/guilds          → Sunucu yönetimi, davet havuzu, kategoriler
/archive         → Kapanan hesaplar, arşivleme, transfer
```

---

## Dashboard Sayfaları

```
/              → Login (tüm kullanıcılar)
/admin         → Admin Dashboard (sadece admin rolü)
  ├── Overview         → 6 stat card, health, throughput chart
  ├── Scraper          → Kanal listesi (guild grouped), phase filter, account filter
  ├── Hesaplar         → Token ekle/sil, guild browse, kanal atama
  ├── Canlı Mesajlar   → Gerçek zamanlı feed (1.5s poll)
  ├── Analitik         → Günlük aktivite, saatlik dağılım, top users/channels
  ├── Kullanıcılar     → Profil, badge, kimlik geçmişi
  ├── Mesaj Ara        → Full-text search, reply chain, CSV export
  ├── ClickHouse       → SQL editor + tablo explorer
  ├── ScyllaDB         → CQL editor + tablo explorer
  ├── Hata Günlüğü     → Filtrelenebilir hata logu
  ├── Sunucu Yönetimi  → 3 tab:
  │   ├── Davet Havuzu      → Batch invite, resolve, verify
  │   ├── Hesap Kategorileri → Per-account guild grouping
  │   └── Kapanan Hesaplar   → Auto-detect, archive, transfer
  └── Kullanıcı Yönetimi → Dashboard hesap CRUD
```

---

## Hesap Tanımlama: Discord User ID

```
accounts.json [idx] → login → client.user.id (snowflake string)
                                    │
                    Tüm sistemde anahtar: account_id text
                    ├── scrape_targets.account_id
                    ├── scrape_stats.account_id
                    ├── account_guilds PK: (account_id, guild_id)
                    ├── guild_accounts PK: (guild_id, account_id)
                    ├── invite_pool.owner_account_id / assigned_account_id
                    └── archived_accounts PK: account_id

Eski: #0, #1 (array index) → Yeni: Discord user ID (string)
Sebep: hesap silinince index kayıyor, ID sabit kalıyor
```

---

## Ölçek Hedefleri

| Metrik | Dev | Prod Hedef |
|--------|-----|------------|
| Hesap sayısı | 2 | 1000+ |
| Sunucu sayısı | 30 | 100,000+ |
| Kanal/hesap | 15 concurrent | 15 concurrent |
| Kafka partition | 16 | 256 |
| Scylla node | 1 (Docker) | 6 node, RF=3 |
| ClickHouse | 1 (Docker) | 3 shard × 2 replica |
| Redpanda | 1 (Docker) | 3 node, RF=3 |

---

## Dosya Yapısı

```
Project-Senneo/
├── senneo/                          # Backend monorepo
│   ├── packages/
│   │   ├── shared/src/              # Ortak tipler (RawMessage, ErrorLogEntry...)
│   │   ├── accounts/src/            # Scraper
│   │   │   ├── index.ts             # Ana orkestratör
│   │   │   ├── scraper.ts           # Kanal kazıma döngüsü
│   │   │   ├── checkpoint.ts        # İlerleme persistence
│   │   │   ├── producer.ts          # Kafka producer
│   │   │   ├── stats.ts             # Kanal istatistikleri
│   │   │   ├── proxy.ts             # Proxy havuzu
│   │   │   ├── guild-sync.ts        # Guild membership sync
│   │   │   ├── scrape-event-log.ts  # Ring buffer event log
│   │   │   └── db.ts                # Scylla şema init (tüm tablolar)
│   │   ├── ingester/src/            # Kafka → DB
│   │   │   ├── index.ts             # Consumer loop
│   │   │   ├── scylla.ts            # Scylla writer (3 tablo)
│   │   │   └── clickhouse.ts        # CH writer + identity cache
│   │   ├── api/src/                 # Express API
│   │   │   ├── index.ts             # Route registration + auth middleware
│   │   │   └── routes/
│   │   │       ├── auth.ts          # JWT auth + user CRUD
│   │   │       ├── accounts.ts      # Token + target yönetimi
│   │   │       ├── live.ts          # Scraper dashboard + SSE
│   │   │       ├── messages.ts      # Mesaj sorguları
│   │   │       ├── guild-inventory.ts # Sunucu yönetimi (60KB)
│   │   │       ├── account-archive.ts # Kapanan hesap arşivi
│   │   │       ├── db.ts            # DB explorer
│   │   │       ├── alerts.ts        # Webhook alertler
│   │   │       ├── errors.ts        # Hata logu
│   │   │       ├── metrics.ts       # Prometheus
│   │   │       ├── health.ts        # Health check
│   │   │       └── name-resolve.ts  # İsim enrichment
│   │   └── bot/src/                 # Canlı mesaj dinleme
│   ├── docker-compose.yml           # Altyapı (5 container)
│   ├── Makefile                     # Tüm komutlar
│   ├── ARCHITECTURE.md              # Bu dosya
│   ├── accounts.json                # Token deposu
│   └── .env                         # Ortam değişkenleri
│
└── senneo-dashboard/                # Frontend (Vite + React + TS)
    └── src/
        ├── main.tsx                 # AuthProvider + routing
        ├── App.tsx                  # Admin dashboard shell
        ├── AuthContext.tsx           # JWT auth state
        ├── api.ts                   # Merkezi API client
        ├── hooks.ts                 # SSE, debounce, fetch, toast...
        ├── types.ts                 # Tüm TypeScript interface'ler
        ├── pages/                   # 12 sayfa
        └── components/              # Paylaşılan bileşenler
```

---

*Son güncelleme: 2026-03-26 | Tüm build'ler temiz*
