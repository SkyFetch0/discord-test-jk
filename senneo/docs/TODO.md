# Senneo Teknik Dokümantasyon - TODO Listesi

## 📁 Klasör Yapısı

```
docs/
├── TODO.md                   (Bu dosya - proje takibi)
├── README.md                 (Dokümantasyon indeksi)
├── architecture/             (Sistem mimarisi)
│   ├── overview.md          (Sistem genel bakış)
│   ├── data-flow.md         (Veri akış diyagramları)
│   └── deployment.md        (Deployment stratejisi)
├── services/                (Servis dökümantasyonları)
│   ├── scraper.md           (Accounts/Scraper servisi)
│   ├── ingester.md          (Ingester servisi)
│   ├── api.md               (API servisi)
│   └── bot.md               (Bot servisi)
├── database/                (Veritabanı)
│   ├── clickhouse.md        (ClickHouse şema)
│   ├── scylladb.md          (ScyllaDB şema)
│   └── kafka.md             (Kafka topic yapılandırması)
├── api/                     (API endpoint'leri)
│   ├── accounts.md          (Hesap yönetimi)
│   ├── guilds.md            (Sunucu yönetimi)
│   ├── auth.md              (Kimlik doğrulama)
│   └── scraping.md          (Scraping kontrolü)
├── configuration/           (Konfigürasyon)
│   ├── environment.md       (Environment değişkenleri)
│   └── docker-compose.md    (Docker servis tanımları)
└── shared/                  (Paylaşılan kod)
    ├── types.md             (TypeScript tipleri)
    └── utilities.md         (Utility fonksiyonlar)
```

---

## ✅ Tamamlananlar (2026-04-10 Güncelleme)

| Dosya | Durum | Notlar |
|-------|-------|--------|
| `TODO.md` | ✅ | Proje takip listesi oluşturuldu |
| `README.md` | ✅ | Ana indeks oluşturuldu (sistem genel bakış, tech stack, portlar) |
| `architecture/overview.md` | ✅ | Sistem mimari diyagramı (Mermaid), komponent hiyerarşisi |
| `services/scraper.md` | ✅ | Scraper detaylı döküman (727 satır analiz edildi) |
| `database/clickhouse.md` | ✅ | ClickHouse şema dökümanı (tüm tablolar, compression) |
| `database/scylladb.md` | ⏳ | ScyllaDB şema dökümanı (sırada) |
| `services/ingester.md` | ⏳ | Ingester detaylı döküman |
| `services/api.md` | ⏳ | API servisi dökümanı |

---

## 📋 Yapılacaklar (Detaylı)

### Architecture (Mimari)
- [x] `architecture/overview.md` - Sistem genel bakış diyagramı (Mermaid) ✅
- [ ] `architecture/data-flow.md` - Veri akış diyagramı (Discord → Scraper → Kafka → Ingester → ClickHouse)
- [ ] `architecture/deployment.md` - Deployment mimarisi (Docker, port mapping, network)

### Services (Servisler)
- [x] `services/scraper.md` - Scraper servisi detayları ✅
  - [x] Çalışma mantığı (scheduler, queue, concurrency)
  - [x] Rate limiting (Token Bucket)
  - [x] Checkpoint yönetimi
  - [x] Proxy desteği
  - [x] Environment değişkenleri
  - [x] Kod yapısı (dosya bazlı)

- [ ] `services/ingester.md` - Ingester servisi detayları
  - [ ] Kafka consumer konfigürasyonu
  - [ ] ClickHouse insert stratejisi
  - [ ] Batch size ve flush logic
  - [ ] User identity deduplication
  - [ ] Analytics aggregation
  - [ ] Error handling

- [ ] `services/api.md` - API servisi detayları
  - [ ] Tüm endpoint'ler (method, path, params, response)
  - [ ] Orchestration layer (scrape-control.ts)
  - [ ] Authentication (JWT, ScyllaDB)
  - [ ] SSE (Server-Sent Events) endpoints

- [ ] `services/bot.md` - Bot servisi detayları
  - [ ] Discord self-bot mantığı
  - [ ] Kafka producer integration

### Database (Veritabanı)
- [x] `database/clickhouse.md` - ClickHouse detayları ✅
  - [x] Tüm database'ler (senneo_messages, senneo_users, senneo_analytics, senneo_operations)
  - [x] Tüm tablolar (kolon, tip, codec)
  - [x] Partition stratejisi
  - [x] Index ve projection'lar
  - [x] Materialized views

- [ ] `database/scylladb.md` - ScyllaDB detayları
  - [ ] Keyspace yapısı
  - [ ] Tüm tablolar (PK, kolon, tip)
  - [ ] Compaction strategy
  - [ ] Replication factor

- [ ] `database/kafka.md` - Kafka detayları
  - [ ] Topic yapılandırması
  - [ ] Partition sayısı
  - [ ] Retention policy
  - [ ] Compression

### API Reference
- [ ] `api/accounts.md` - Hesap yönetimi API'leri
- [ ] `api/guilds.md` - Sunucu yönetimi API'leri
- [ ] `api/auth.md` - Authentication API'leri
- [ ] `api/scraping.md` - Scraping kontrol API'leri

### Configuration (Konfigürasyon)
- [ ] `configuration/environment.md` - Tüm environment değişkenleri
- [ ] `configuration/docker-compose.md` - Docker servis tanımları

### Shared (Paylaşılan Kod)
- [ ] `shared/types.md` - TypeScript interface'leri
- [ ] `shared/utilities.md` - Utility fonksiyonlar

---

## 🎯 Öncelik Sırası

### ✅ Tamamlanan (Yüksek Öncelik)
- [x] `architecture/overview.md` - Sistem genel bakış ✅
- [x] `services/scraper.md` - Scraper en kritik servis ✅
- [x] `database/clickhouse.md` - ClickHouse ana veritabanı ✅

### 🔄 Sırada (Orta Öncelik)
- [ ] `database/scylladb.md` - ScyllaDB operational DB
- [ ] `services/ingester.md` - Ingester kritik
- [ ] `api/scraping.md` - Scraping kontrol API'leri

### ⏳ Gelecek (Düşük Öncelik)
- [ ] Diğer API dökümanları
- [ ] Bot servisi (daha az kritik)
- [ ] Configuration dosyaları

---

## 📝 Notlar

- Tüm dökümanlar **Markdown** formatında olacak
- Kod örnekleri **TypeScript** syntax highlighting ile
- Diyagramlar **Mermaid** formatında
- Her dökümanın başında **Version** ve **Last Updated** tarihleri olacak
- Dökümanlar İngilizce-Türkçe karışık olabilir, ama ana terimler İngilizce kalacak

---

## 📊 İlerleme Durumu

```
Tamamlanan:    ████████░░░░░░░░░░░░░ 4/18 (%22)
Yüksek Öncelik: ████████████████░░░░ 3/3 (%100) ✅
Orta Öncelik:  ████░░░░░░░░░░░░░░░░░ 0/3 (%0)
Düşük Öncelik:  ░░░░░░░░░░░░░░░░░░░░ 0/12 (%0)
```

---

*Oluşturulma Tarihi: 2026-04-10*
*Son Güncelleme: 2026-04-10 19:51*
*Versiyon: 1.1*
