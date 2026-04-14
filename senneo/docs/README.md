# Senneo Teknik Dokümantasyon

> Discord mesaj arşivleme ve analitik platformu - Kapsamlı teknik dökümantasyon

## 📚 Dokümantasyon İndeksi

### 🏗️ Mimari (Architecture)
| Doküman | Açıklama | Durum |
|----------|----------|-------|
| [`architecture/overview.md`](architecture/overview.md) | Sistem genel bakış ve komponent diyagramı | ⏳ |
| [`architecture/data-flow.md`](architecture/data-flow.md) | Veri akış diyagramları | ⏳ |
| [`architecture/deployment.md`](architecture/deployment.md) | Deployment stratejisi | ⏳ |

### 🔧 Servisler (Services)
| Doküman | Açıklama | Durum |
|----------|----------|-------|
| [`services/scraper.md`](services/scraper.md) | Discord scraper servisi (multi-account) | ⏳ |
| [`services/ingester.md`](services/ingester.md) | Kafka → ClickHouse ingester | ⏳ |
| [`services/api.md`](services/api.md) | REST API ve dashboard backend | ⏳ |
| [`services/bot.md`](services/bot.md) | Discord self-bot servisi | ⏳ |

### 💾 Veritabanı (Database)
| Doküman | Açıklama | Durum |
|----------|----------|-------|
| [`database/clickhouse.md`](database/clickhouse.md) | ClickHouse şema ve partition stratejisi | ⏳ |
| [`database/scylladb.md`](database/scylladb.md) | ScyllaDB operational data store | ⏳ |
| [`database/kafka.md`](database/kafka.md) | Kafka topic konfigürasyonu | ⏳ |

### 🌐 API Reference
| Doküman | Açıklama | Durum |
|----------|----------|-------|
| [`api/accounts.md`](api/accounts.md) | Hesap yönetimi endpoint'leri | ⏳ |
| [`api/guilds.md`](api/guilds.md) | Sunucu yönetimi endpoint'leri | ⏳ |
| [`api/auth.md`](api/auth.md) | JWT authentication | ⏳ |
| [`api/scraping.md`](api/scraping.md) | Scraping kontrol endpoint'leri | ⏳ |

### ⚙️ Konfigürasyon (Configuration)
| Doküman | Açıklama | Durum |
|----------|----------|-------|
| [`configuration/environment.md`](configuration/environment.md) | Environment değişkenleri rehberi | ⏳ |
| [`configuration/docker-compose.md`](configuration/docker-compose.md) | Docker servis tanımları | ⏳ |

### 🔗 Paylaşılan Kod (Shared)
| Doküman | Açıklama | Durum |
|----------|----------|-------|
| [`shared/types.md`](shared/types.md) | TypeScript interface tanımları | ⏳ |
| [`shared/utilities.md`](shared/utilities.md) | Utility fonksiyonlar | ⏳ |

---

## 🚀 Hızlı Başlangıç

### Sistem Komponentleri

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              S E N N E O   A R C H I T E C T U R E                  │
└─────────────────────────────────────────────────────────────────────────────────┘

┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Discord    │────▶│    Bot       │────▶│   Redpanda   │────▶│   Ingester   │
│   Gateway    │     │  (Self-bot)  │     │    (Kafka)   │     │              │
└──────────────┘     └──────────────┘     └──────────────┘     └──────┬───────┘
                                                  │                     │
                                                  ▼                     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│   Accounts/Scraper (Multi-account orchestrator + Rate Limiter)                │
└─────────────────────────────────────────────────────────────────────────────────┘
│
├─▶ ScyllaDB (checkpoints, stats, targets, auth)
│
└─▶ Redpanda (raw messages via HTTP fetch)
    
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                ClickHouse                                     │
│   ┌───────────────┐  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐  │
│   │ senneo_       │  │ senneo_       │  │ senneo_       │  │ senneo_       │  │
│   │ messages      │  │ users         │  │ analytics     │  │ operations    │  │
│   └───────────────┘  └───────────────┘  └───────────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
                                                  │
                                                  ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              API + Dashboard                                  │
│   Express REST API / React + Vite Frontend                                    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Teknoloji Stack'i

| Kategori | Teknoloji | Versiyon |
|----------|-----------|----------|
| **Backend** | Node.js | 20.x |
| **Language** | TypeScript | 5.5.x |
| **Message Queue** | Redpanda (Kafka-compatible) | Latest |
| **Analytical DB** | ClickHouse | 24.8.x |
| **Operational DB** | ScyllaDB | 5.x |
| **Frontend** | React + Vite | 18.3 + 5.4 |
| **Charts** | Chart.js | 4.4.x |
| **Container** | Docker Compose | - |
| **HTTP Client** | discord.js | 14.x |

### Port Atamaları

| Servis | Internal Port | External Port |
|--------|---------------|---------------|
| ClickHouse | 8123 | 8123 |
| ScyllaDB | 9042 | 9042 |
| Redpanda (Kafka) | 9092 | 9092 |
| Redpanda (Admin) | 9644 | - |
| Accounts API | 3001 | 3001 |
| API Server | 3000 | 3000 |
| Dashboard (dev) | 5173 | 5173 |

---

## 📖 Önemli Kavramlar

### Scraping Terminolojisi

| Terim | Açıklama |
|-------|----------|
| **Account** | Discord hesabı (bot token ile ilişkilendirilmiş) |
| **Channel** | Discord kanal ID'si (scrape hedefi) |
| **Guild** | Discord sunucu ID'si |
| **Checkpoint** | Scraping ilerleme durumu (cursor + total_scraped) |
| **Target** | Scrape edilecek kanal (channel_id + account_id mapping) |
| **Yield** | Time-slicing mekanizması - bir kanaldan diğerine geçiş |
| **Concurrency** | Aynı anda kaç kanal scrape edileceği |

### Rate Limiting

| Terim | Değer |
|-------|-------|
| **Channel bucket** | 60 msg/s (burst 100) |
| **Account bucket** | 300 msg/s (burst 100) |
| **Token bucket** | Dinamik refill algoritması |

---

## 🎓 Hızlı Referans

### Environment Değişkenleri

```bash
# Database
CLICKHOUSE_HOST=http://clickhouse:8123
SCYLLA_HOSTS=scylla:9042

# Kafka
KAFKA_BROKERS=redpanda:9092
KAFKA_TOPIC=messages
KAFKA_PARTITIONS=16

# Scraper
SCRAPE_BATCH_SIZE=100
FETCH_DELAY_MS=300
MAX_MSG_PER_SEC_CHANNEL=60
MAX_MSG_PER_SEC_ACCOUNT=300
MAX_BATCHES_PER_RUN=50

# API
API_PORT=3000
JWT_SECRET=your-secret-here
```

### Önemli Dosyalar

| Dosya | Açıklama |
|-------|----------|
| `packages/accounts/src/index.ts` | Ana orchestrator (1322 satır) |
| `packages/accounts/src/scraper.ts` | Core scraping logic (727 satır) |
| `packages/ingester/src/index.ts` | Kafka → ClickHouse pipeline |
| `packages/api/src/routes/accounts.ts` | Accounts API endpoints |
| `config/clickhouse/init/` | ClickHouse schema tanımları |
| `config/scylladb/init.cql` | ScyllaDB schema tanımları |

---

## 📞 Destek

- **Proje:** discord-test-jk/senneo
- **Dokümantasyon:** docs/ klasörü
- **Issues:** GitHub issues

---

*Versiyon: 1.0*  
*Son Güncelleme: 2026-04-10*
