# Senneo — Discord Message Archive & Analytics Platform

Yüksek hacimli Discord mesaj arşivleme ve analiz platformu.

## 🚀 Hızlı Başlangıç

### Gereksinimler
- Docker & Docker Compose
- Node.js 18+ (backend geliştirme için)
- 8GB RAM minimum (16GB önerilen)

### 1. Kurulum

```bash
# Depoyu klonla
git clone <repo-url>
cd senneo

# Ortam değişkenlerini ayarla
cp .env.example .env
# .env dosyasını düzenle (JWT_SECRET, ADMIN_PASSWORD vb.)

# Tüm servisleri başlat (ClickHouse, ScyllaDB, Kafka, Prometheus, Grafana)
docker compose up -d

# Logları kontrol et
docker compose logs -f
```

### 2. Schema Kontrolü

```bash
# ClickHouse
docker exec -it senneo-clickhouse clickhouse-client
SHOW DATABASES;
USE senneo_messages;
SHOW TABLES;

# ScyllaDB
docker exec -it senneo-scylla cqlsh
DESCRIBE KEYSPACES;
USE senneo;
DESCRIBE TABLES;
```

### 3. Backend Başlatma

```bash
# Ingester (Kafka → ClickHouse)
cd packages/ingester
npm install
npm run dev

# API (Express REST API)
cd packages/api
npm install
npm run dev

# Accounts (Discord scraper controller)
cd packages/accounts
npm install
npm run dev
```

## 📊 Mimari

```
┌─────────────────────────────────────────────────────────────┐
│  Discord Scraper (accounts)                                 │
│    └─> Kafka (Redpanda) topic: messages                    │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Ingester (Kafka Consumer)                                  │
│    ├─> ClickHouse (PRIMARY — mesajlar)                     │
│    │     • senneo_messages.messages (1 tablo + 3 projeksiyon)│
│    │     • senneo_users.users_latest                        │
│    │     • senneo_analytics.* (MV'ler)                      │
│    └─> (ScyllaDB artık mesaj yazmıyor)                    │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Query Layer (API)                                          │
│    ├─> ClickHouse (mesaj sorguları)                        │
│    │     • Point lookup (message_id)                       │
│    │     • Channel scroll (channel_id, ts DESC)            │
│    │     • Author messages (author_id)                     │
│    │     • Full-text search                                │
│    │     • Analytics queries                               │
│    └─> ScyllaDB (operasyonel)                              │
│          • scrape_targets, checkpoints                     │
│          • auth (dashboard_users, user_tasks)              │
│          • guild_inventory, invite_pool                    │
└─────────────────────────────────────────────────────────────┘
```

## 🗄️ Veritabanları

### ClickHouse (Primary Message Store)
- **senneo_messages** — Ana mesaj tablosu + 3 projection
  - Projections: `proj_by_msg_id`, `proj_by_author`, `proj_by_inserted`
  - ORDER BY: `(guild_id, channel_id, ts, message_id)`
- **senneo_users** — Kullanıcı profilleri
  - `users_latest` — En güncel profil
  - `user_identity_log` — İsim/avatar değişiklik geçmişi
- **senneo_analytics** — Pre-aggregated tablolar
  - `channel_daily`, `guild_daily`, `author_daily`
  - `hourly_heatmap`, `attachment_types`
- **senneo_operations** — Sistem tabloları
  - `error_log` — Tüm servislerden hata logları

### ScyllaDB (Operational Tables)
- **Scraper Control** — scrape_targets, checkpoints, stats, paused_*
- **Auth & Tasks** — dashboard_users, user_tasks, activity_log
- **Guild Inventory** — account_guilds, guild_accounts, sync_status
- **Invite Pool** — invite_pool, invite_pool_jobs, categories
- **Name Cache** — name_cache (guild/channel adları)
- **Archived** — archived_accounts, failed_accounts

## 🔧 Servisler

| Servis | Port | Açıklama |
|--------|------|----------|
| ClickHouse | 8123 (HTTP), 9000 (Native) | Primary message store |
| ScyllaDB | 9042 (CQL) | Operational tables |
| Redpanda | 9092 (Kafka) | Event streaming |
| Prometheus | 9090 | Metrics |
| Grafana | 3000 | Dashboards (admin/admin) |
| API | 4000 | REST API |
| Ingester | - | Background service |

## 📈 Performans

| Metrik | Değer |
|--------|-------|
| **Write throughput** | ~500K msg/s (batch) |
| **Disk compression** | ~65% (ZSTD3 content, Delta IDs) |
| **Point lookup** | ~10-50ms (projection) |
| **Channel scroll** | ~5-20ms (ORDER BY match) |
| **Full-text search** | ~100-500ms (depends on filters) |
| **Write amplification** | 1x (tek INSERT, projections otomatik) |

## 🛠️ Geliştirme

### Backend Paketleri
- **accounts** — Discord scraper controller
- **ingester** — Kafka consumer → ClickHouse/ScyllaDB writer
- **api** — Express REST API
- **shared** — Ortak tip tanımları ve utility'ler
- **bot** — (İsteğe bağlı) Discord bot

### Komutlar
```bash
# Tüm bağımlılıkları kur (root)
npm install

# Belirli paketi çalıştır
cd packages/<package-name>
npm run dev

# Build (production)
npm run build

# Test
npm test
```

## 📝 API Endpoints

### Messages
- `GET /api/messages/:messageId` — Point lookup
- `GET /api/messages/channel/:channelId` — Channel scroll (pagination: `?before=`)
- `GET /api/messages/author/:authorId` — Author messages
- `GET /api/messages/search` — Full-text search (`?q=`, filters: guild, channel, author, from, to)
- `GET /api/messages/count` — Global stats
- `GET /api/messages/stats/:channelId` — Channel daily stats

### Auth
- `POST /api/auth/login` — Login (JWT)
- `GET /api/auth/me` — Current user
- `GET /api/auth/users` — List users (admin)
- `POST /api/auth/users` — Create user (admin)

### Scraper
- `GET /api/scrape/targets` — List targets
- `POST /api/scrape/targets` — Add target
- `GET /api/scrape/stats` — Scraper stats

## 🐳 Docker Compose Referans

```bash
# Tüm servisleri başlat
docker compose up -d

# Belirli servisi başlat
docker compose up -d clickhouse scylla redpanda

# Logları görüntüle
docker compose logs -f <service-name>

# Yeniden başlat
docker compose restart <service-name>

# Durdur
docker compose down

# Volume'leri de sil (TAM RESET)
docker compose down -v
```

## 🔒 Güvenlik

### Production Checklist
- [ ] `.env` dosyasında güçlü `JWT_SECRET` ayarla
- [ ] `ADMIN_PASSWORD` değiştir
- [ ] ScyllaDB RF=3, NetworkTopologyStrategy kullan
- [ ] ClickHouse için TLS yapılandır
- [ ] Firewall kuralları (sadece gerekli portlar açık)
- [ ] Rate limiting ekle (nginx/traefik)
- [ ] Backup stratejisi oluştur

## 📚 Daha Fazla Bilgi

- [CLICKHOUSE_MIGRATION_PLAN.md](./CLICKHOUSE_MIGRATION_PLAN.md) — Geçiş detayları
- [ARCHITECTURE_SCALING_PLAN.md](./ARCHITECTURE_SCALING_PLAN.md) — Production mimari

## 📄 Lisans

MIT
