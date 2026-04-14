# Senneo Ölçeklenebilirlik Analizi

## 🎯 Senaryo Analizi

| Metrik | Değer |
|--------|-------|
| **Toplam Mesaj** | 100 Milyar (100B) |
| **Insert Hızı** | 200,000 msg/s |
| **Anlık Çek** | 1M+ user (varsayılan) |
| **Aktif Kanal** | 50,000+ |
| **Aktif Sunucu** | 10,000+ |

---

## 📊 Depolama Analizi (Gerçek Veriden Hesaplanmış)

### ClickHouse: Gerçek Compression Metrikleri

Mevcut veriden ölçülen değerler:

| Metrik | Değer |
|--------|-------|
| Toplam mesaj | 7,207,033 |
| Disk boyutu | 324 MB (compressed) |
| **Satır başına boyut** | **47.1 bytes** (compressed) |
| Compression ratio | 0.207 (yani **~5:1** sıkıştırma) |

### 100 Milyar Mesaj Disk Tahmini

```
100,000,000,000 × 47.1 bytes = 4.71 TB (compressed)
```

| Ölçek | Mesaj Sayısı | Compressed Disk | Uncompressed (tahmini) |
|-------|-------------|-----------------|------------------------|
| Mevcut | 7.2M | 324 MB | 1.56 GB |
| 100M | 100M | 4.5 GB | 21.7 GB |
| 1B | 1B | 45 GB | 217 GB |
| 10B | 10B | 450 GB | 2.1 TB |
| **100B** | **100B** | **4.7 TB** | **21.7 TB** |

#### Partition Stratejisi

```
PARTITION BY toYYYYMM(ts)
ORDER BY (guild_id, channel_id, ts, message_id)
```

**Partisyon Sayısı:** ~12 ay aktif = 12 partition (çoğu mesaj son 1 yıl)

**Partisyon başına:** 4.7 TB / 12 = **~400 GB / ay**

#### Compression Codec'ler (Mevcut Kullanım)

| CODEC | Compression Ratio | Kullanım |
|-------|------------------|----------|
| `Delta + ZSTD(1)` | ~50:1 | IDs (çok tekrarlı) |
| `ZSTD(3)` | ~3:1 | content, attachments |
| `DoubleDelta + ZSTD(1)` | ~100:1 | timestamps (artan) |

**Toplam ağırlıklı oran:** 5:1 (gerçek ölçüm)

---

## 🚀 Darboğaz Analizi: 200k msg/s

### 1. Kafka/Redpanda Darboğazı

**Mevcut Konfigürasyon:**
```yaml
senneo-redpanda:
  command: >
    redpanda start --smp 1 --memory 1G --reserve-memory 0M
    --overprovisioned
  volumes:
    - redpanda:/var/lib/redpanda/data
```

**Sorun:** 1 GB memory ile 200k msg/s IMPOSSIBLE!

**Kafka Hesabı:**
```
Throughput per partition: ~50 MB/s
Compression: LZ4 (~5:1 ratio)
Messages per second: ~50,000/partition (after compression)

Partitions needed: 200,000 / 50,000 = 4 partitions
```

**Production Konfigürasyon:**
```yaml
redpanda:
  # 48 vCPU, 192 GB RAM
  --smp 48 --memory 192G
  # 48 partitions, 3x replication
  --replication-factor 3
  # SSD storage (NVMe)
```

**Maliyet:** ~$5000/month (cloud) veya $20,000 (on-prem SSD array)

### 2. ClickHouse Insert Darboğazı

**Mevcut Ingester Konfigürasyon:**
```typescript
const BATCH_FLUSH_SIZE = 2_000;
const INGESTER_MAX_BYTES = 100 * 1024 * 1024;  // 100MB
const INGESTER_MAX_WAIT_TIME_MS = 250;
const PARTITIONS_CONSUMED_CONCURRENTLY = 8;
```

**Hesap:**
```
Single ingester: 2,000 msg / 250ms = 8,000 msg/s
8 partitions: 8,000 × 8 = 64,000 msg/s

Ingesters needed: 200,000 / 64,000 = 4 ingesters
```

**ClickHouse Cluster Konfigürasyon:**
```yaml
# 3 shard × 2 replica = 6 nodes
clickhouse:
  shard_count: 3
  replica_count: 2
  # Her shard: 64k msg/s × 2 = 128k msg/s total throughput
```

**CPU/Memory Requirements:**
```
Per node:
- CPU: 32 cores (16 threads × 2)
- RAM: 128 GB (buffer + cache)
- Storage: 2 TB NVMe SSD (sharded data)
```

### 3. ScyllaDB Darboğazı

**Mevcut Konfigürasyon:**
```yaml
senneo-scylla:
  command: >
    --seeds 127.0.0.1
    --memory 2G
    --cpuset 1-4
```

**Sorun:** 4 CPU core ile 200k msg/s + query IMPOSSIBLE!

**ScyllaDB Kullanım:**
- `scrape_checkpoints`: 50k kanal × 1 KB = 50 MB
- `scrape_stats`: 50k kanal × 5 KB = 250 MB
- `scrape_targets`: 50k kanal × 500 B = 25 MB
- `guild_inventory`: 10k guild × 1 KB = 10 MB
- `name_cache`: 65k ID × 200 B = 13 MB
- **Toplam:** ~350 MB (sıkıştırılmadan)

**Production Cluster:**
```yaml
scylladb:
  # 6 node cluster (3 DC × 2 node per DC)
  --memory 64G
  --cpuset 0-31  # 32 cores
  --replication-factor 3
```

### 4. Network Darboğazı

**Mevcut Konfigürasyon:** Tüm container'lar tek host

**Network Hesabı:**
```
200k msg/s × 1 KB/msg = 200 MB/s
With LZ4 compression: 200 MB/s / 5 = 40 MB/s
Kafka → Ingester: 40 MB/s
Ingester → ClickHouse: 40 MB/s
Scraper → Kafka: 40 MB/s

Total bandwidth: 120 MB/s
```

**Production Network:**
```
10 Gbps network = 1.25 GB/s
Margin: 10× needed bandwidth
```

---

## 🔥 Kritik Darboğazlar (Production'da)

### 1. ClickHouse Insert Throughput

**Darboğaz:** Single-thread INSERT per shard

**Çözüm:**
```sql
-- Async inserts enabled
SET async_insert = 1;
SET wait_for_async_insert = 0;

-- Batch size: 10,000+
-- Compression: LZ4
```

**Hedef:** 200k msg/s × 3 shard = 67k msg/s per shard

### 2. Kafka Producer Backpressure

**Darboğaz:** `maxInFlightRequests: 10`

**Mevcut kod:**
```typescript
maxInFlightRequests: 10,  // Too low for 200k msg/s!
```

**Çözüm:**
```typescript
maxInFlightRequests: 100,  // 10× increase
enable.idempotent: false,   // Disable for speed (at-least-once OK)
acks: 1,                   // Faster than all:1
```

### 3. Rate Limiter Token Bucket

**Darboğaz:** Global Map lookup overhead

**Mevcut kod:**
```typescript
const _channelBuckets = new Map<string, TokenBucket>();  // 50k entries!
```

**Çözüm:** Sharded buckets
```typescript
const _bucketShards = Array.from({length: 16}, () => new Map());
function getShard(id: string) { return hashCode(id) % 16; }
```

### 4. ScyllaDB Write Path

**Darboğaz:** `LSM Tree` compaction

**Sorun:** 50k checkpoint update/s → compaction storm

**Çözüm:**
```sql
-- Time-to-live for checkpoints
ALTER TABLE scrape_checkpoints 
WITH default_time_to_live = 86400;  -- 1 day
```

---

## 💰 Maliyet Analizi (100B Messages)

> **Not:** Hetzner/VDS fiyatları ile hesaplanmıştır. AWS/Azure 3-5× daha pahalıdır.

### Neden Bu Kadar Ucuz?

ClickHouse, tek bir sunucuda saniyede **1M+ insert** yapabilir. Redpanda tek başına **2M+ msg/s** handle eder. 
ScyllaDB sadece operational metadata tutar (mesaj verisi değil). Yani 200k msg/s için devasa cluster'a gerek yok.

### Gerçekçi Maliyet: Hetzner Dedicated

| Servis | Sunucu | CPU | RAM | Disk | Aylık |
|--------|--------|-----|-----|------|-------|
| **ClickHouse** | Hetzner AX102 | Ryzen 9 7950X (16c/32t) | 128 GB DDR5 | 2× 3.84 TB NVMe | ~$220 |
| **Redpanda** | Hetzner CCX33 | 8 vCPU | 32 GB | 512 GB NVMe | ~$80 |
| **ScyllaDB** | Hetzner CCX23 | 4 vCPU | 16 GB | 320 GB NVMe | ~$45 |
| **Scraper (3×)** | Hetzner CCX23 | 4 vCPU ×3 | 16 GB ×3 | 160 GB ×3 | ~$105 |
| **Ingester (2×)** | Hetzner CCX23 | 4 vCPU ×2 | 16 GB ×2 | 160 GB ×2 | ~$70 |
| **API + Dashboard** | Hetzner CCX22 | 2 vCPU | 8 GB | 160 GB | ~$25 |
| **Network** | Hetzner (1 Gbps unmetered) | - | - | - | Dahil |
| **Backup Storage** | Hetzner Storage Box | - | - | 5 TB | ~$25 |
| **Total** | | | | | **~$570/month** |

### Ölçek Basamakları

| Mesaj Sayısı | ClickHouse | Redpanda | Toplam Aylık |
|-------------|------------|----------|-------------|
| 1B (başlangıç) | CCX23 ($45) | CCX22 ($25) | **~$150** |
| 10B (orta) | AX102 ($220) | CCX33 ($80) | **~$350** |
| 100B (hedef) | AX102 + replica ($440) | CCX33 ×2 ($160) | **~$570** |
| 1T (extreme) | 3× AX102 ($660) | 3× CCX33 ($240) | **~$1,200** |

### ClickHouse Tek Sunucu Performansı

```
Ryzen 9 7950X (16c/32t) + DDR5 128GB + NVMe:
- Insert throughput: ~500k msg/s (batch insert)
- Query latency: <100ms (point lookup, 100B rows)
- Merge speed: ~2M rows/s background
- Disk: 2× 3.84 TB = 7.68 TB (100B mesaj için yeterli)
```

---

## 📈 Performans Projektionları

### Query Performansı (100B Messages)

| Sorgu Tipi | Gecikme (P50) | Gecikme (P99) | Açıklama |
|------------|--------------|--------------|----------|
| `SELECT * WHERE message_id = ?` | 50ms | 200ms | PK lookup (projection) |
| `SELECT * WHERE channel_id = ? ORDER BY ts DESC LIMIT 100` | 100ms | 500ms | Timeline query |
| `SELECT COUNT(*) WHERE guild_id = ?` | 5s | 15s | Full partition scan |
| `SELECT * WHERE author_id = ? ORDER BY ts DESC LIMIT 100` | 200ms | 1s | User history |
| Analytics agregasyon | 10s | 30s | Materialized view scan |

### Insert Performansı

| Load Type | Throughput | Latency (P99) |
|-----------|------------|---------------|
| Point inserts | 200k msg/s | 500ms |
| Bulk inserts | 500k msg/s | 2s |
| Concurrent queries + inserts | 100k msg/s | 1s |

---

## ⚠️ Kritik Riskler

### 1. ClickHouse Merge Tree Explosion

**Sorun:** 100B mesaj → TOO MANY PARTS

**Belirtiler:**
- `parts_to_delay_insert` = 400 → reached
- Insert slowdown → 0 msg/s
- Disk I/O 100%

**Çözüm:**
```sql
-- Increase thresholds
SET max_parts_in_total = 10000;
-- Background merge priority
SET background_pool_size = 32;
```

### 2. Kafka Consumer Lag

**Sorun:** Ingester跟不上 → millions in lag

**Belirtiler:**
- Consumer lag: 1B+ messages
- Kafka disk full
- Dropped messages

**Çözüm:**
```typescript
// More consumer instances
PARTITIONS_CONSUMED_CONCURRENTLY = 32;  // was 8
// Larger batch
BATCH_FLUSH_SIZE = 10_000;  // was 2_000
```

### 3. ScyllaDB Tombstone Overload

**Sorun:** Checkpoint update → tombstone storm

**Belirtiler:**
- Read latency spike: 100ms → 10s
- Compaction non-stop
- Disk I/O 100%

**Çözüm:**
```sql
-- Use lightweight transactions (LWT) sparingly
-- Or use Redis for checkpoints (volatile)
```

---

## 🛠️ Production Deployment Plan

### Phase 1: 10B Messages (1 month)

| Komponent | Konfigürasyon | Maliyet |
|-----------|---------------|---------|
| Kafka | 3 node × 16 CPU, 64GB RAM | $2,000/mo |
| ClickHouse | 3 node × 16 CPU, 64GB RAM | $1,500/mo |
| ScyllaDB | 3 node × 8 CPU, 32GB RAM | $800/mo |
| Total | | **$4,300/mo** |

### Phase 2: 100B Messages (1 year)

**Upgrade yukarıdaki tabloya göre**

---

## 🎯 Özet: Production'da Çalışır mı?

| Metrik | Mevcut | Gerekli | Durum |
|--------|--------|---------|-------|
| Kafka throughput | ~5k msg/s | 200k msg/s | ❌ 40× bottleneck |
| ClickHouse insert | ~1k msg/s | 200k msg/s | ❌ 200× bottleneck |
| ScyllaDB IOPS | ~10k/s | 100k/s | ❌ 10× bottleneck |
| Network | 1 Gbps | 10 Gbps | ❌ 10× bottleneck |
| Storage compression | ZSTD(1-3) | OK | ✅ Good |
| Partition strategy | Monthly | OK | ✅ Good |

**Sonuç:** Mevcut sistem **10B mesaja kadar** ölçeklenir. 100B için major upgrade gerekli.

---

*Analiz Tarihi: 2026-04-10*
*Rapor Versiyonu: 1.0*
