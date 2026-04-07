# Senneo — ClickHouse Tam Geçiş

ScyllaDB mesaj depolarından (`messages_by_id`, `messages_by_channel_bucket`, `messages_by_author`) tamamen ClickHouse'a geçiş için tam kurulum paketi.

## Dizin Yapısı

```
clickhouse-migration/
├── docker-compose.yml                  # Tek-node CH kurulumu
├── .env.example                        # Şifre template'i
├── clickhouse/
│   ├── config.d/
│   │   ├── performance.xml             # Thread, memory, async insert ayarları
│   │   ├── compression.xml             # Hot/cold part sıkıştırma politikası
│   │   ├── logging.xml                 # Log seviyeleri, query log, part log
│   │   └── storage.xml                 # Tiered storage (SSD+HDD, opsiyonel)
│   ├── users.d/
│   │   └── default.xml                 # Kullanıcı profilleri ve quota'lar
│   └── init/                           # İlk başlatmada sırayla çalışır
│       ├── 001_databases.sql           # 4 database oluştur
│       ├── 002_messages_table.sql      # Ana mesaj tablosu (500B satır hedef)
│       ├── 003_users_tables.sql        # users_latest + user_identity_log
│       ├── 004_analytics_tables.sql    # Pre-aggregated hedef tablolar
│       ├── 005_analytics_views.sql     # Materialized view'lar
│       ├── 006_operations_tables.sql   # error_log + ingester_metrics
│       ├── 007_projections.sql         # 3 projeksiyon (author, msg_id, inserted)
│       └── 008_grants.sql             # Kullanıcı yetki tanımları
```

## Hızlı Başlangıç

### 1. Şifreleri Ayarla

```bash
cp .env.example .env
```

`.env` dosyasını düzenle:
```
CH_INGESTER_PASSWORD=guclu_bir_sifre
CH_API_PASSWORD=baska_bir_sifre
CH_DASHBOARD_PASSWORD=ucuncu_bir_sifre
```

### 2. SHA-256 Hash Üret

`users.d/default.xml` içindeki `PLACEHOLDER_HASH_*` değerlerini değiştir:

```bash
# Linux/Mac
echo -n "guclu_bir_sifre" | sha256sum

# Windows (PowerShell)
[System.Security.Cryptography.SHA256]::Create().ComputeHash(
  [System.Text.Encoding]::UTF8.GetBytes("guclu_bir_sifre")
) | ForEach-Object { $_.ToString("x2") } | Join-String
```

### 3. Container'ı Başlat

```bash
docker compose up -d
```

İlk başlatmada `clickhouse/init/` içindeki SQL dosyaları alfabetik sırayla çalışır.

### 4. Kurulumu Doğrula

```bash
docker exec -it senneo-clickhouse clickhouse-client

-- Veritabanları oluşturuldu mu?
SHOW DATABASES;

-- Tablolar oluşturuldu mu?
SHOW TABLES FROM senneo_messages;
SHOW TABLES FROM senneo_users;
SHOW TABLES FROM senneo_analytics;
SHOW TABLES FROM senneo_operations;

-- Projeksiyonlar var mı?
SELECT name FROM system.projection_parts
WHERE active = 1 AND database = 'senneo_messages'
GROUP BY name;
```

---

## Mimari

### Veritabanı Ayrımı

| Database | İçerik | Tahmini Boyut |
|---|---|---|
| `senneo_messages` | Ana mesaj tablosu + 3 projeksiyon | ~145-160 TB (500B mesaj) |
| `senneo_users` | `users_latest` + `user_identity_log` | ~10-50 GB |
| `senneo_analytics` | 5 MV hedef tablosu | ~10-50 GB |
| `senneo_operations` | `error_log` + `ingester_metrics` | ~1-10 GB |

### Mesaj Tablosu Sorgu Haritası

| Sorgu Tipi | Kullandığı Index |
|---|---|
| Kanal scroll (`WHERE guild_id=X AND channel_id=Y ORDER BY ts DESC`) | Ana tablo ORDER BY ✅ |
| Yazar mesajları (`WHERE author_id=X ORDER BY ts DESC`) | `proj_by_author` ✅ |
| Point lookup (`WHERE message_id=X`) | `proj_by_msg_id` ✅ |
| Live feed (`ORDER BY inserted_at DESC`) | `proj_by_inserted` ✅ |
| Full-text arama (`positionCaseInsensitive(content, q)`) | Full scan ⚠️ (guild/channel filtresi ekle) |

### Kullanıcı Ayrımı

| Kullanıcı | Rol | İzinler |
|---|---|---|
| `senneo_ingester` | Kafka→CH ingester | INSERT+SELECT (messages, users, analytics, operations) |
| `senneo_api` | REST API backend | SELECT her yerde + ALTER UPDATE (users_latest badge) |
| `senneo_dashboard` | Dashboard frontend | SELECT (analytics + users_latest) |

---

## Mevcut Kodu Güncelleme

### Ingester (`packages/ingester/src/clickhouse.ts`)

Yeni database yapısına göre tablo yollarını güncelle:

```typescript
// ÖNCE
await client.insert({ table: `${CH_DB}.messages`, ... });
await client.insert({ table: `${CH_DB}.users_latest`, ... });

// SONRA
await client.insert({ table: 'senneo_messages.messages', ... });
await client.insert({ table: 'senneo_users.users_latest', ... });
await client.insert({ table: 'senneo_users.user_identity_log', ... });
await client.insert({ table: 'senneo_operations.error_log', ... });
```

### Yeni Alanlar (Scraper'dan Toplanmalı)

```typescript
// scraper.ts — toRawMessage() fonksiyonuna ekle:
messageType: msg.type ?? 0,           // Discord mesaj tipi (0=normal, 19=reply...)
messageFlags: msg.flags?.bitfield ?? 0,
pinned: msg.pinned ? 1 : 0,

// attachments artık URL değil, tam metadata:
attachments: [...msg.attachments.values()].map(a => ({
  url: a.url,
  filename: a.name ?? '',
  size: a.size ?? 0,
  content_type: a.contentType ?? '',
})),
```

### ScyllaDB Bağımlılıklarını Kaldır

Aşağıdaki Scylla tabloları artık gerekmeyecek:
- `senneo.messages_by_id` → CH `proj_by_msg_id` karşılıyor
- `senneo.messages_by_channel_bucket` → CH ana tablo ORDER BY karşılıyor
- `senneo.messages_by_author` → CH `proj_by_author` karşılıyor

Operasyonel tablolar (`scrape_targets`, `scrape_checkpoints`, `dashboard_users` vb.) ScyllaDB'de kalmaya devam edebilir.

---

## Monitoring Sorguları

```sql
-- Tablo boyutları
SELECT
    database, table,
    formatReadableSize(sum(bytes_on_disk)) AS disk_size,
    formatReadableNumber(sum(rows))        AS total_rows,
    count()                                AS parts
FROM system.parts
WHERE active = 1
GROUP BY database, table
ORDER BY sum(bytes_on_disk) DESC;

-- Aktif merge işlemleri
SELECT database, table,
    round(elapsed, 1) AS elapsed_sec,
    round(progress * 100, 1) AS progress_pct,
    formatReadableSize(total_size_bytes_compressed) AS size,
    num_parts AS merging_parts
FROM system.merges
ORDER BY elapsed DESC;

-- Yavaş sorgular (son 1 gün, 5 sn üstü)
SELECT query_duration_ms, read_rows,
    formatReadableSize(read_bytes) AS read_size,
    left(query, 120) AS query_preview
FROM system.query_log
WHERE type = 'QueryFinish'
  AND query_duration_ms > 5000
  AND event_date = today()
ORDER BY query_duration_ms DESC
LIMIT 20;

-- Projeksiyon durumu
SELECT name, count() AS parts,
    formatReadableSize(sum(bytes_on_disk)) AS size
FROM system.projection_parts
WHERE active = 1 AND database = 'senneo_messages'
GROUP BY name
ORDER BY name;

-- Part sayısı sağlık kontrolü (çok fazla part = merge sorunu)
SELECT database, table, count() AS active_parts
FROM system.parts
WHERE active = 1
GROUP BY database, table
HAVING active_parts > 300
ORDER BY active_parts DESC;

-- Async insert buffer durumu
SELECT database, table, bytes, rows, flush_time
FROM system.asynchronous_insert_log
WHERE event_date = today()
ORDER BY flush_time DESC
LIMIT 20;
```

---

## Disk Tahmini (500 Milyar Mesaj)

| Bileşen | Tahmini |
|---|---|
| `messages` ana tablo | ~70-80 TB |
| `proj_by_author` | ~25-30 TB |
| `proj_by_msg_id` | ~25-30 TB |
| `proj_by_inserted` | ~25-30 TB |
| `users_latest` | ~5-10 GB |
| `user_identity_log` | ~50-100 GB |
| Analytics MV'ler | ~10-50 GB |
| error_log + metrics | ~1-5 GB |
| **TOPLAM** | **~150-170 TB** |

**Eski yapı ile karşılaştırma:**
- Eski (CH + Scylla 3 tablo): ~400 TB
- Yeni (tek CH + projeksiyonlar): ~150-170 TB
- **Tasarruf: ~%58-60**

---

## Production Checklist

```
[ ] .env dosyası oluşturuldu ve şifreler girildi
[ ] users.d/default.xml PLACEHOLDER_HASH değerleri gerçek hash ile değiştirildi
[ ] Docker volume'lar NVMe SSD'ye bağlandı
[ ] ulimits (nofile: 262144, memlock: unlimited) ayarlandı
[ ] performance.xml background_pool_size sunucu CPU çekirdeğine göre ayarlandı
[ ] performance.xml max_server_memory_usage_to_ram_ratio sunucu RAM'ine göre ayarlandı
[ ] Container başlatıldı ve healthcheck geçti
[ ] 8 init SQL dosyası sırayla çalıştı (SHOW TABLES ile kontrol)
[ ] 3 projeksiyon oluşturuldu (system.projection_parts ile kontrol)
[ ] 5 materialized view aktif (SHOW TABLES FROM senneo_analytics)
[ ] Ingester bağlantısı test edildi (INSERT + SELECT)
[ ] API bağlantısı test edildi (SELECT)
[ ] Monitoring sorguları çalışıyor
[ ] Backup stratejisi belirlendi
```
