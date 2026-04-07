# ScyllaDB → ClickHouse Tam Geçiş Planı

**Tarih:** 2026-04-07  
**Hedef:** Mesaj tablolarını ClickHouse'a taşı, operasyonel tabloları ScyllaDB'de bırak

---

## Geçiş Stratejisi

### Taşınacak (ScyllaDB → ClickHouse)
- `messages_by_id` → ClickHouse `senneo_messages.messages` + `proj_by_msg_id`
- `messages_by_channel_bucket` → ClickHouse `senneo_messages.messages` (ana ORDER BY)
- `messages_by_author` → ClickHouse `senneo_messages.messages` + `proj_by_author`

### ScyllaDB'de Kalacak (Operasyonel)
- `scrape_targets` — Hangi kanallar kazınıyor
- `scrape_checkpoints` — İlerleme durumu
- `scrape_stats` — Kanal istatistikleri
- `scrape_paused_accounts` / `scrape_paused_channels` — Durdurma kontrolleri
- `scrape_control_audit` — Audit log
- `name_cache` — Guild/kanal isim önbelleği
- `account_guilds` / `guild_accounts` — Sunucu yönetimi
- `invite_pool` / `invite_pool_jobs` — Davet havuzu
- `join_categories` / `category_guilds` — Kategori yönetimi
- `guild_sync_status` — Senkronizasyon durumu
- `archived_accounts` / `archived_account_guilds` / `archived_account_channels` — Arşiv
- `failed_accounts` / `token_account_map` — Hesap yönetimi
- `dashboard_users` / `user_sessions` / `user_tasks` / `user_notifications` — Auth

---

## Değişiklik Listesi

### 1. docker-compose.yml Güncellemesi
- ✅ ClickHouse config dosyalarını ekle
- ✅ ClickHouse init SQL dosyalarını mount et
- ✅ ScyllaDB kalsın (operasyonel tablolar için)

### 2. Ingester Değişiklikleri

#### `packages/ingester/src/scylla.ts`
- ❌ Mesaj tablo şemasını kaldır (`messages_by_id`, `messages_by_channel_bucket`, `messages_by_author`)
- ✅ Sadece bağlantı kodu kalsın (operasyonel tablolar için)
- ✅ `writeMessages()` fonksiyonunu kaldır

#### `packages/ingester/src/clickhouse.ts`
- ✅ Database yapısını güncelle: `senneo_messages`, `senneo_users`, `senneo_analytics`, `senneo_operations`
- ✅ Tablo yollarını güncelle
- ✅ Projeksiyonları ekle (init SQL'de otomatik olacak)

#### `packages/ingester/src/index.ts`
- ✅ ScyllaDB yazma çağrısını kaldır
- ✅ ClickHouse'u primary store yap
- ✅ Offset commit'i ClickHouse yazısı başarılı olduktan sonra yap
- ✅ ScyllaDB bağlantısını koru (operasyonel tablolar için)

### 3. API Değişiklikleri

#### `packages/api/src/routes/messages.ts`
- ✅ Point lookup (`/:messageId`) → ClickHouse'dan oku (projection)
- ✅ Channel scroll (`/channel/:channelId`) → ClickHouse'dan oku
- ✅ Author messages (`/author/:authorId`) → ClickHouse'dan oku (projection)
- ✅ ScyllaDB bağlantısını koru (name enrichment için)

#### `packages/api/src/routes/live.ts`
- ✅ Mesaj sorgularını ClickHouse'a yönlendir
- ✅ ScyllaDB'den scrape_stats/targets/checkpoints okumaya devam et

#### `packages/api/src/routes/db.ts`
- ✅ Zaten ClickHouse kullanıyor, değişiklik minimal

### 4. ClickHouse Init SQL Dosyaları
- ✅ `001_databases.sql` - 4 database oluştur
- ✅ `002_messages_table.sql` - Ana mesaj tablosu
- ✅ `003_users_tables.sql` - users_latest + user_identity_log
- ✅ `004_analytics_tables.sql` - Pre-aggregated tablolar
- ✅ `005_analytics_views.sql` - Materialized views
- ✅ `006_operations_tables.sql` - error_log + ingester_metrics
- ✅ `007_projections.sql` - 3 projection (by_author, by_msg_id, by_inserted)
- ✅ `008_grants.sql` - Kullanıcı yetkileri

---

## Beklenen Performans

| Metrik | Öncesi (ScyllaDB) | Sonrası (ClickHouse) | İyileşme |
|---|---|---|---|
| Write per message | 3 INSERT | 1 INSERT | 3x azalma |
| Disk (500B mesaj) | ~400 TB | ~150-170 TB | %60 tasarruf |
| Analytics sorgu | Ayrı CH yazısı | Tek kaynak | Tek store |
| Point lookup | ~1-5ms | ~10-50ms | Biraz yavaş (kabul edilebilir) |
| Batch insert | ~50-100K msg/s | ~500K-1M msg/s | 5-10x artış |

---

## Geçiş Adımları

### Faz 1: Docker Compose + Init SQL (15 dk)
1. ✅ ClickHouse config dosyalarını `senneo/config/clickhouse/` altına kopyala
2. ✅ Init SQL dosyalarını `senneo/config/clickhouse/init/` altına kopyala
3. ✅ `senneo/docker-compose.yml`'i güncelle
4. ✅ `.env` dosyası oluştur (ClickHouse şifreleri)

### Faz 2: Ingester Güncellemesi (30 dk)
1. ✅ `clickhouse.ts`'i yeni DB yapısına güncelle
2. ✅ `scylla.ts`'ten mesaj tablolarını kaldır
3. ✅ `index.ts`'te ClickHouse'u primary yap
4. ✅ Test: Kafka'dan okuyup sadece ClickHouse'a yazdığını doğrula

### Faz 3: API Güncellemesi (45 dk)
1. ✅ `routes/messages.ts`'i ClickHouse sorgularına güncelle
2. ✅ `routes/live.ts`'te mesaj sorgularını ClickHouse'a yönlendir
3. ✅ Test: Dashboard'dan mesaj sorgularının çalıştığını doğrula

### Faz 4: Test ve Doğrulama (30 dk)
1. ✅ Ingester'ı başlat, mesajları ClickHouse'a yazdığını doğrula
2. ✅ Projeksiyonların oluştuğunu doğrula
3. ✅ API sorgularının çalıştığını test et
4. ✅ Dashboard'un düzgün çalıştığını test et

---

## Rollback Planı

Sorun çıkarsa:
1. `docker-compose.yml`'i eski haline döndür
2. Ingester'ı eski kodla başlat
3. ScyllaDB mesaj tabloları hala duruyor (silinmedi)

---

## Notlar

- ScyllaDB **tamamen kaldırılMAYACAK** — operasyonel tablolar için gerekli
- ClickHouse projections **otomatik** — eski 3 tablonun işlevini karşılıyor
- Geçiş sırasında **veri kaybı yok** — at-least-once semantik korunuyor
- Operasyonel tablolarda **hiçbir değişiklik yok**
