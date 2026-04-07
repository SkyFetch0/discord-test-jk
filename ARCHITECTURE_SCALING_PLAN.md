# Senneo — Mimari Analiz ve Ölçekleme Planı

> Hazırlanma tarihi: 2026-03-22
> Kaynak: Tüm dosyalar satır düzeyinde okunarak doğrulanmıştır.

---

## 1. Mevcut Mimari — Doğrulanmış Akış

### Veri Akışı (Dosya/Satır Referanslı)

```
Discord API
    │
    ▼
@senneo/accounts  (packages/accounts/src/index.ts)
├── accounts.json → N hesap (AccountConfig = {token})
├── Her hesap: discord.js-selfbot-v13 ile login (L:43-53)
├── Her hesap: PQueue(concurrency=CONCURRENT_GUILDS=5) (L:93)
├── Guild→Hesap eşlemesi: round-robin pickAccount() (L:115-122)
├── Kanal scrape: scraper.ts → channel.messages.fetch({limit:100, before:cursor})
├── Batch→Kafka: producer.ts → kafkajs producer, key=channelId, GZIP (L:77-86)
├── Checkpoint: ScyllaDB scrape_checkpoints tablosu, 3s interval flush (checkpoint.ts)
└── Stats: ScyllaDB scrape_stats tablosu, 5s interval flush (stats.ts)
    │
    ▼
Redpanda/Kafka  (topic: "messages", 16 partition, 7d retention, gzip)
    │
    ▼
@senneo/ingester  (packages/ingester/src/index.ts)
├── Consumer group: "senneo-ingester", eachBatch mode
├── BATCH_FLUSH_SIZE = 2000 mesaj
├── eachBatchAutoResolve: false → offset yalnızca durable write sonrası commit
├── ScyllaDB yazımı: 3 tablo (messages_by_id, messages_by_channel_bucket, messages_by_author)
│   ├── Tek tek prepared INSERT, concurrency=64 worker (scylla.ts L:196-221)
│   └── BAŞARISIZSA → throw → offset commit YOK → at-least-once semantik ✓
├── ClickHouse yazımı: 3 tablo (messages, users_latest, user_identity_log)
│   ├── async_insert=1, wait_for_async_insert=1 (clickhouse.ts L:17-18)
│   └── Başarısızsa → log, non-fatal (analytics store)
└── DLQ: messages.dlq topic (parse edilemeyen mesajlar)
    │
    ▼
@senneo/api  (packages/api/)
├── SSE: /live/stream → summary (phaseCounts, totalScraped, msgsPerSec)
├── REST: /live/channels → sayfalı kanal listesi (buildStats from ScyllaDB)
├── REST: /db/ch/* → ClickHouse analytics queries
└── Dashboard: senneo-dashboard/ (React + Vite)
```

### Mermaid Diyagramı (Darboğazlar İşaretli)

```mermaid
flowchart TB
    subgraph SCRAPER["@senneo/accounts (TEK PROCESS)"]
        A1[accounts.json<br/>N hesap]
        A2[PQueue × N<br/>concurrency=5/hesap]
        A3[scraper.ts<br/>fetch limit=100<br/>delay=100ms adaptive]
        A1 --> A2 --> A3
    end

    subgraph KAFKA["Redpanda"]
        K1["topic: messages<br/>16 partition<br/>replication=1<br/>7d retention<br/>gzip compression"]
    end

    subgraph INGESTER["@senneo/ingester (TEK PROCESS)"]
        I1["Consumer group: senneo-ingester<br/>eachBatch, flush=2000<br/>maxBytes=50MB"]
    end

    subgraph SCYLLA["ScyllaDB (TEK NODE)"]
        S1[messages_by_id]
        S2[messages_by_channel_bucket]
        S3[messages_by_author]
        S4[scrape_checkpoints]
        S5[scrape_stats]
    end

    subgraph CH["ClickHouse (TEK NODE)"]
        C1[messages<br/>MergeTree]
        C2[users_latest<br/>ReplacingMergeTree]
        C3[user_identity_log<br/>ReplacingMergeTree]
        C4[channel_daily_mv<br/>SummingMergeTree]
    end

    subgraph API["@senneo/api"]
        AP1[SSE + REST]
        AP2[Dashboard]
    end

    DISCORD((Discord API)) -->|"⚠️ 50 req/s global<br/>per-account rate limit"| A3
    A3 -->|"kafkajs producer<br/>key=channelId"| K1
    K1 --> I1
    I1 -->|"⚠️ 3×N INSERT per msg<br/>concurrency=64"| SCYLLA
    I1 -->|"async_insert"| CH
    SCYLLA --> AP1
    CH --> AP1
    AP1 --> AP2

    style SCRAPER fill:#1a1a2e,stroke:#e94560,stroke-width:2px
    style INGESTER fill:#1a1a2e,stroke:#e94560,stroke-width:2px
    style K1 fill:#0f3460,stroke:#16213e
```

### Tanımlanan Darboğazlar

| # | Darboğaz | Konum | Etki |
|---|----------|-------|------|
| **B1** | **Tek accounts process** | `accounts/src/index.ts` — tek Node.js process, tüm hesaplar tek event loop | 1000 hesap × 5 kanal = 5000 PQueue task tek process'te; event loop, memory, GC baskısı |
| **B2** | **Tek ingester process** | `ingester/src/index.ts` — tek consumer, group="senneo-ingester" | 16 partition var ama 1 consumer → max throughput tek Node.js process'in Scylla write hızıyla sınırlı |
| **B3** | **Scylla 3× write amplification** | `scylla.ts` — her mesaj 3 INSERT (by_id, by_channel, by_author) | 500K msg/s hedefinde → 1.5M INSERT/s gerekli |
| **B4** | **Scylla tek node, RF=1** | `docker-compose.yml` L:14-16 — `--smp 1 --memory 1G` | Veri kaybı riski, throughput tavanı |
| **B5** | **Redpanda tek node** | `docker-compose.yml` L:55-58 — `--smp 1 --memory 1G` | Tek partition=16 yeterli ancak replication=1 → veri kaybı |
| **B6** | **ClickHouse tek node** | `docker-compose.yml` L:28-30 | 500B satır için shard/replica gerekli |
| **B7** | **Discord API rate limit** | Selfbot: ~50 req/s per IP, kanal başı throttle | 1000 hesap × aynı IP = aynı global rate limit bucket |
| **B8** | **JSON serialization** | `producer.ts` L:83 — `JSON.stringify(m)` per message | CPU-intensive at scale; Avro/Protobuf daha verimli |

---

## 2. Hedef Mimari (500K msg/s yazım, 500B+ satır)

### Topoloji

```
                    ┌──────────────────────────────────────┐
                    │        SCRAPER CLUSTER                │
                    │  10-20× accounts process              │
                    │  (her biri ~50-100 hesap)             │
                    │  proxy pool per instance              │
                    └──────────┬───────────────────────────┘
                               │ kafkajs producer
                               ▼
                    ┌──────────────────────────────────────┐
                    │     REDPANDA CLUSTER (3 node)        │
                    │  topic: messages                      │
                    │  256 partition, RF=3                   │
                    │  retention: 7d, gzip                  │
                    │  ~4GB/node RAM, NVMe SSD              │
                    └──────────┬───────────────────────────┘
                               │
                    ┌──────────┴───────────────────────────┐
                    │     INGESTER FLEET                    │
                    │  16-32× ingester process              │
                    │  consumer group: senneo-ingester      │
                    │  partition assignment: cooperative     │
                    │  her biri ~8-16 partition              │
                    └────┬─────────────────────┬───────────┘
                         │                     │
          ┌──────────────┴──────┐    ┌────────┴──────────────┐
          │  SCYLLADB CLUSTER   │    │  CLICKHOUSE CLUSTER    │
          │  6 node (3 rack)    │    │  3 shard × 2 replica   │
          │  RF=3, LQ write     │    │  = 6 node              │
          │  NVMe, 16+ core     │    │  Distributed table     │
          │  ~1TB+ per node     │    │  sharding: guild_id    │
          └─────────────────────┘    └────────────────────────┘
                         │                     │
                    ┌────┴─────────────────────┴───────────┐
                    │          API CLUSTER (2-4 node)       │
                    │  Load balancer, SSE fan-out            │
                    └──────────────────────────────────────┘
```

### Bileşen Detayları

#### 2.1 Redpanda/Kafka Cluster

| Parametre | Mevcut | Hedef |
|-----------|--------|-------|
| Node sayısı | 1 | **3** |
| Partition sayısı | 16 | **256** |
| Replication factor | 1 | **3** |
| Retention | 7d | 7d (değişmez) |
| Compression | gzip | **lz4** (daha hızlı compress/decompress) |
| SMP | 1 | **4-8** per node |
| Memory | 1G | **8G** per node |

**Neden 256 partition:** 500K msg/s hedefi. Tek consumer ~15-30K msg/s işleyebilir (Scylla write bound). 256/16 = 16 consumer instance yeterli, 256/32 = 8 partition/consumer — yeterince paralel.

**Env:**
```env
KAFKA_BROKERS=rp1:9092,rp2:9092,rp3:9092
KAFKA_PARTITIONS=256
KAFKA_REPLICATION_FACTOR=3
KAFKA_COMPRESSION=lz4
```

#### 2.2 ScyllaDB Cluster

| Parametre | Mevcut | Hedef |
|-----------|--------|-------|
| Node sayısı | 1 | **6** (3 rack × 2) |
| SMP | 1 | **16** per node |
| Memory | 1G | **32G** per node |
| Disk | Docker volume | **NVMe SSD, 2TB+** |
| RF | 1 (SimpleStrategy) | **3 (NetworkTopologyStrategy)** |
| Consistency (write) | localOne | **localQuorum** (zaten ingester'da var) |
| Consistency (read) | localOne | **localOne** (dashboard okuma) |

**Keyspace migration:**
```cql
ALTER KEYSPACE senneo WITH replication = {
  'class': 'NetworkTopologyStrategy',
  'dc1': 3
};
```

**Kapasite hesabı (500B satır):**
- Ortalama mesaj: ~500 bytes (Scylla'da 3 tablo = ~1.5KB per message)
- 500B × 1.5KB = **750TB** brüt
- 6 node × RF3 → her node ~375TB → NVMe dizisi veya tiered storage gerekli
- Pratikte: TTL (90d-365d hot, cold archive) veya bucket-based compaction

#### 2.3 ClickHouse Cluster

| Parametre | Mevcut | Hedef |
|-----------|--------|-------|
| Node sayısı | 1 | **6** (3 shard × 2 replica) |
| Engine | MergeTree | **ReplicatedMergeTree** |
| Sharding | yok | **guild_id hash** |
| Disk | Docker volume | **NVMe SSD, 4TB+** per node |

**Distributed table:**
```sql
-- Her shard'da local tablo
CREATE TABLE senneo.messages_local ON CLUSTER 'senneo_cluster' (
  -- mevcut şema aynen
) ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/messages', '{replica}')
PARTITION BY toYYYYMM(ts)
ORDER BY (guild_id, channel_id, ts, message_id);

-- Distributed sorgu tablosu
CREATE TABLE senneo.messages ON CLUSTER 'senneo_cluster' AS senneo.messages_local
ENGINE = Distributed('senneo_cluster', 'senneo', 'messages_local', sipHash64(guild_id));
```

**Kapasite:** 500B satır × ~200 bytes (CH sıkıştırma sonrası ~40 bytes) = **~20TB** sıkıştırılmış. 3 shard × 2 replica = shard başı ~6.7TB — NVMe ile rahat.

#### 2.4 Offset/Checkpoint State

| State | Nerede | Nasıl |
|-------|--------|-------|
| Kafka consumer offset | **Redpanda internal** (`__consumer_offsets`) | autoCommit + resolveOffset after durable write |
| Scrape checkpoint | **ScyllaDB** `scrape_checkpoints` | Her accounts process kendi kanallarını yazar (mevcut: 3s flush) |
| Scrape stats | **ScyllaDB** `scrape_stats` | Her accounts process kendi kanallarını yazar (mevcut: 5s flush) |
| Identity LRU cache | **Process-local** (ingester) | Her ingester kendi cache'ini tutar; ReplacingMergeTree correctness sağlar |

---

## 3. 1000 Hesap × 5 Kanal Süreç Modeli

### Mevcut Durum

```
1 accounts process → tüm hesaplar
├── Discord login: ~1000 WebSocket bağlantısı
├── PQueue: 1000 kuyruk × concurrency=5 = max 5000 eşzamanlı kanal
├── Node.js event loop: tek thread
├── Memory: ~500MB base + ~1KB/kanal state ≈ 5GB peak (WS buffers dahil)
└── Sorun: GC pause, event loop latency, tek hata noktası
```

### Hedef: Multi-Instance Dağıtım

```
┌─────────────────────────────────────────────┐
│           ACCOUNTS ORCHESTRATOR              │
│  (Makefile veya K8s StatefulSet)             │
│                                              │
│  Instance 0: accounts[0..49]    (50 hesap)   │
│  Instance 1: accounts[50..99]   (50 hesap)   │
│  Instance 2: accounts[100..149] (50 hesap)   │
│  ...                                         │
│  Instance 19: accounts[950..999] (50 hesap)  │
└─────────────────────────────────────────────┘
```

**Uygulama:**

```env
# Her instance için:
ACCOUNTS_RANGE_START=0
ACCOUNTS_RANGE_END=49
CONCURRENT_GUILDS=10     # Per-hesap concurrent channel
KAFKA_PRODUCER_LINGER=5  # ms batch linger
```

**Kod değişikliği (minimal):**

`accounts/src/index.ts` → `loadAccounts()` fonksiyonuna range filtresi:

```typescript
const start = parseInt(process.env.ACCOUNTS_RANGE_START ?? '0', 10);
const end   = parseInt(process.env.ACCOUNTS_RANGE_END ?? String(accounts.length), 10);
return accounts.slice(start, end);
```

**Kaynak limitleri per instance:**

| Kaynak | Limit | Açıklama |
|--------|-------|----------|
| Memory | 2-4 GB | 50 hesap × WS + PQueue buffers |
| CPU | 1-2 core | Event loop + JSON serialize |
| File descriptors | 4096 | WS bağlantıları |
| Network | ~50 Mbps | Discord API traffic |

**Dağıtım planı:**

| Ölçek | Instance sayısı | Hesap/instance | Toplam kanal |
|-------|----------------|----------------|-------------|
| 100 hesap | 2 | 50 | ~500 |
| 500 hesap | 10 | 50 | ~2500 |
| 1000 hesap | 20 | 50 | ~5000 |

---

## 4. Scraper Parametre Matrisi

### Discord API Gerçekleri

| Limit | Değer | Kaynak |
|-------|-------|--------|
| GET /channels/{id}/messages | **50 req/s per route per account** (user account) | Discord API docs + empirical |
| Global rate limit | **50 req/s per account** | X-RateLimit-Global header |
| Per-route limit | Genellikle 5-10 req/s per channel | X-RateLimit-Limit header |
| Burst | ~5 req anlık | X-RateLimit-Remaining |
| 429 penalty | retryAfter (1-60s) + cooldown | Backoff gerekli |
| Selfbot risk | **Her zaman ban riski** | Discord ToS — aşağıda detay |

**⚠️ "Hesap başına 200 veri öğesi/s" varsayımı:**
- Bir `messages.fetch({limit:100})` çağrısı 100 mesaj döndürür.
- Rate limit: ~5-10 req/s per channel endpoint.
- 10 req/s × 100 msg = **~1000 msg/s per hesap** (agresif, rate limit yok varsayımıyla).
- Pratikte adaptive delay (100-2000ms) nedeniyle: **200-500 msg/s per hesap** gerçekçi.
- 200 msg/s × 1000 hesap = **200K msg/s** toplam scraper throughput.
- **500K msg/s yazım hedefi:** scraper'dan 200K + replay/backfill + headroom.

### Parametre Matrisi

| Parametre | Env Variable | Mevcut | Güvenli | Agresif | Dosya |
|-----------|-------------|--------|---------|---------|-------|
| Batch size | — | 100 | 100 | 100 | scraper.ts L:10 |
| Fetch delay | — | 100ms | **150ms** | 80ms | scraper.ts L:11 |
| Adaptive min | — | 100ms | **120ms** | 80ms | scraper.ts L:18 |
| Adaptive max | — | 2000ms | 2000ms | 1500ms | scraper.ts L:19 |
| Adaptive step up (RL hit) | — | 100ms | 100ms | 150ms | scraper.ts L:16 |
| Adaptive step down | — | 5ms | 5ms | 3ms | scraper.ts L:17 |
| Rate limit cooldown | — | 8000ms | **10000ms** | 5000ms | scraper.ts L:15 |
| Max retries | — | 5 | 5 | 8 | scraper.ts L:14 |
| Concurrent channels/account | `CONCURRENT_GUILDS` | 5 | **5** | 10 | index.ts L:23 |
| Kafka batch linger | — | 0 (immediate) | **5ms** | 10ms | producer.ts |
| Kafka max inflight | — | 5 | 5 | 10 | producer.ts L:33 |
| Kafka chunk size | — | 500 | 500 | 1000 | producer.ts L:6 |
| Checkpoint flush interval | — | 3000ms | 3000ms | 5000ms | checkpoint.ts |
| Stats flush interval | — | 5000ms | 5000ms | 10000ms | stats.ts |

**Önerilen güvenli varsayılanlar (env):**

```env
# Scraper tuning
CONCURRENT_GUILDS=5
FETCH_DELAY_MS=150
ADAPTIVE_MIN_MS=120
ADAPTIVE_MAX_MS=2000
RATE_LIMIT_COOLDOWN_MS=10000

# Kafka producer
KAFKA_PARTITIONS=256
KAFKA_MAX_INFLIGHT=5
KAFKA_CHUNK_SIZE=500
```

### Backoff Stratejisi

```
Normal: delay=150ms (adaptive)
429 hit → delay += 100ms, wait retryAfter + 10s cooldown
429 × 3 → delay = max(delay, 1000ms), cooldown 30s
Sustained 429 → kanal geçici pause (60s), sonra retry
403/404 → kanal iptal (permanent error)
```

---

## 5. Proxy Hazırlığı

### Konfigürasyon Şeması

```typescript
// shared/src/types.ts'e eklenecek
interface ProxyConfig {
  url:       string;        // socks5://user:pass@host:port veya http://host:port
  region?:   string;        // us, eu, asia — Discord CDN locality
  maxConns:  number;        // Bu proxy üzerinden max eşzamanlı bağlantı (default: 50)
  weight:    number;        // Ağırlıklı rotation (1-10, yüksek = daha çok kullanılır)
  enabled:   boolean;
}

interface ProxyPoolConfig {
  proxies:        ProxyConfig[];
  healthCheckMs:  number;         // 30000 — proxy sağlık kontrolü aralığı
  failThreshold:  number;         // 3 — kaç ardışık hata sonrası devre dışı
  cooldownMs:     number;         // 60000 — devre dışı sonrası bekleme
  rotationMode:   'round-robin' | 'weighted' | 'least-connections';
}
```

**Dosya:** `proxies.json`
```json
{
  "rotation": "weighted",
  "healthCheckMs": 30000,
  "failThreshold": 3,
  "cooldownMs": 60000,
  "proxies": [
    { "url": "socks5://user1:pass@proxy1.example.com:1080", "region": "us", "maxConns": 50, "weight": 5, "enabled": true },
    { "url": "socks5://user2:pass@proxy2.example.com:1080", "region": "eu", "maxConns": 50, "weight": 5, "enabled": true }
  ]
}
```

### Operasyonel Notlar

| Konu | Detay |
|------|-------|
| **Hesap↔Proxy eşleme** | 1 hesap = 1 proxy (IP sabitleme). Hesap proxy değiştirirse Discord suspicious login tetikler |
| **Health check** | Her 30s HEAD request `https://discord.com/api/v10/gateway` — 200 OK = sağlıklı |
| **Failover** | 3 ardışık hata → proxy disable → 60s cooldown → re-enable ve health check |
| **Rotation** | Yeni hesap login'inde en az kullanılan proxy seçilir |
| **Hot reload** | `fs.watchFile('proxies.json')` — accounts.json gibi |
| **Monitoring** | Prometheus counter: `proxy_requests_total{proxy, status}`, `proxy_health{proxy}` |

### Minimal Kod Değişikliği

`accounts/src/index.ts` → `createClient()` fonksiyonuna proxy desteği:

```typescript
const proxyAgent = proxy ? new SocksProxyAgent(proxy.url) : undefined;
const client = new Client({
  checkUpdate: false,
  ws: { agent: proxyAgent },
  http: { agent: proxyAgent },
});
```

Dependency: `socks-proxy-agent` (npm paketi).

---

## 6. Riskler

### Discord ToS / Rate Limit Riskleri

| Risk | Olasılık | Etki | Azaltma |
|------|----------|------|---------|
| **Hesap bani (selfbot tespiti)** | **YÜKSEK** (1000 hesap ile) | Veri kaybı, hesap kaybı | Proxy rotation, human-like delay jitter, gradual ramp-up |
| **IP bani (429 cascade)** | ORTA | Tüm hesaplar aynı IP'den → toplu ban | Proxy pool zorunlu; IP başına max 5-10 hesap |
| **Token invalidation** | ORTA | Hesap offline → kanal boşta | Hot-reload + otomatik re-login + alerting |
| **Discord API değişikliği** | DÜŞÜK ama etkili | Scraper kırılır | discord.js-selfbot pinned version, API response validation |
| **Guild kick/ban** | ORTA | Kanal erişim kaybı | 403 handling zaten var; dashboard'da görünür hata |

### Teknik Riskler

| Risk | Olasılık | Etki | Azaltma |
|------|----------|------|---------|
| **Scylla write amplification** | KESİN (3× per msg) | IOPS darboğazı | Bucket compaction, TTL, NVMe |
| **Kafka partition rebalance** | ORTA (consumer ekleme/çıkarma) | Geçici throughput düşüşü | CooperativeStickyAssignor, gradual scale |
| **Memory pressure (ingester)** | ORTA (50MB maxBytes) | OOM kill | Pod memory limit, batch size tuning |
| **Checkpoint kayıp (accounts crash)** | DÜŞÜK (3s flush) | Max 3s veri tekrarı | At-least-once semantik zaten var |
| **ClickHouse merge pressure** | ORTA (500B satır) | Slow queries | Partition pruning, TTL, materialized views |

---

## 7. Fazlı Uygulama Planı

### Faz 0: Mevcut (Tamamlanmış)
- ✅ Tek node tüm bileşenler
- ✅ 3-10 hesap, ~200 msg/s
- ✅ Temel dashboard

### Faz 1: Multi-Instance Scraper (1-2 hafta)
**Değişiklikler:**
- `accounts/src/index.ts`: `ACCOUNTS_RANGE_START/END` env desteği
- `Makefile`: `start-accounts-N` target'ları veya `INSTANCE=0 make start-accounts`
- Proxy config dosyası + temel proxy desteği (`socks-proxy-agent`)

**Kabul Kriterleri:**
- [ ] 2+ accounts process paralel çalışabiliyor
- [ ] Her process kendi hesap aralığını çekiyor
- [ ] Checkpoint çakışması yok (her kanal tek process'e atanmış)
- [ ] Build kırılmıyor, mevcut tek-instance mode çalışıyor

### Faz 2: Ingester Ölçekleme (1 hafta)
**Değişiklikler:**
- Kafka partition: 16 → 64 (geçiş: yeni topic oluştur, consumer'ı taşı)
- 2-4 ingester instance (aynı consumer group, partition otomatik dağılır)
- `KAFKA_GROUP` env zaten var — ek kod yok

**Kabul Kriterleri:**
- [ ] 2+ ingester paralel consumer olarak çalışıyor
- [ ] Partition assignment dengeli (lag monitoring)
- [ ] Scylla write throughput: 50K+ msg/s sürdürülebilir
- [ ] p99 batch flush < 5s
- [ ] Veri kaybı yok (at-least-once doğrulanmış)

### Faz 3: Veritabanı Cluster (2-3 hafta)
**Değişiklikler:**
- Scylla: 1 → 3 node, RF 1→3, NetworkTopologyStrategy
- ClickHouse: 1 → 3 node (1 shard × 3 replica başlangıç)
- Redpanda: 1 → 3 node, RF 1→3
- `docker-compose.yml` güncelleme veya K8s migration

**Kabul Kriterleri:**
- [ ] Tek node kaybında veri kaybı yok
- [ ] Scylla `nodetool status` → UN (Up Normal) tüm node'lar
- [ ] ClickHouse replica sync < 10s lag
- [ ] Toplam write throughput: 100K+ msg/s sürdürülebilir

### Faz 4: 1000 Hesap (2-3 hafta)
**Değişiklikler:**
- 20 accounts instance dağıtımı
- Proxy pool (50+ IP)
- Prometheus alerting: ban rate, error rate, lag
- Dashboard: instance-level monitoring

**Kabul Kriterleri:**
- [ ] 1000 hesap simultane login
- [ ] Toplam scraper throughput: 100K+ msg/s
- [ ] Ban rate: < %1/gün
- [ ] Rate limit hit rate: < %5 toplam request

### Faz 5: 500K msg/s Hedefi (4-6 hafta)
**Değişiklikler:**
- Kafka: 256 partition
- Ingester: 16-32 instance
- Scylla: 6 node
- ClickHouse: 3 shard × 2 replica
- Serialization: JSON → Avro/Protobuf (isteğe bağlı)

**Kabul Kriterleri:**
- [ ] Sustained write: 500K msg/s (10 dakika benchmark)
- [ ] p99 end-to-end latency (scrape → queryable): < 30s
- [ ] Scylla disk kullanımı: < %70 per node
- [ ] ClickHouse query latency (dashboard): p95 < 2s
- [ ] Zero data loss (chaos test: random node kill)

---

## 8. Executive Summary (10 Madde)

1. **Mevcut sistem çalışıyor ve doğru tasarlanmış.** At-least-once semantik, checkpoint yönetimi, adaptive rate limiting — temel mimari sağlam. Sorun ölçek değil, tek node sınırı.

2. **En acil darboğaz: tek accounts process.** 1000 hesap tek Node.js event loop'ta çalışamaz. Çözüm: `ACCOUNTS_RANGE_START/END` env ile multi-instance. Minimal kod değişikliği (~5 satır).

3. **İkinci darboğaz: tek ingester.** 16 Kafka partition var ama 1 consumer. 2-4 ingester instance eklemek sıfır kod değişikliği gerektirir (aynı consumer group).

4. **Veritabanları cluster'a geçmeli.** Scylla RF=1, ClickHouse tek node — veri kaybı riski. RF=3 minimum. Bu operasyonel iş, kod değişikliği gerektirmez.

5. **500K msg/s mümkün ama hardware gerektirir.** 6 Scylla node (16 core, 32GB, NVMe) + 6 ClickHouse node + 3 Redpanda node + 16-32 ingester instance. Tahmini aylık maliyet: ~$3-5K cloud (bare metal daha ucuz).

6. **Discord rate limit gerçek tavan.** 1000 hesap × ~200 msg/s = ~200K msg/s scraper throughput. 500K yazım hedefi replay/backfill headroom içerir. Proxy zorunlu — aynı IP'den 1000 hesap = IP ban garantili.

7. **Proxy altyapısı Faz 1'de başlamalı.** Başlangıçta 50+ residential proxy, hesap başına sabit IP. Maliyet: ~$200-500/ay (residential proxy pool).

8. **Gözlemlenebilirlik hazır.** Prometheus + Grafana zaten docker-compose'da. Eksik: Node.js process metrikleri (prom-client), custom dashboard'lar, alerting rules.

9. **Fazlı uygulama 6-8 haftada tamamlanabilir.** Her faz bağımsız çalışır, önceki faz bozulmaz. En büyük risk: Discord ban wave — proxy + jitter ile azaltılır.

10. **Veri şeması ve API kontratları değişmez.** Tüm ölçekleme altyapısal — `RawMessage`, Scylla/CH tabloları, API endpoint'leri aynen kalır. Dashboard'a yeni monitoring paneli eklenir ama mevcut sayfalar bozulmaz.

---

## Ek: Prometheus Entegrasyonu (Node.js)

Mevcut `prometheus.yml`'de Scylla, ClickHouse, Redpanda metrikleri toplanıyor. Eksik: Node.js servisleri.

**Eklenecek (her servis):**

```typescript
// prom-client kullanarak
import { collectDefaultMetrics, Counter, Histogram, register } from 'prom-client';
collectDefaultMetrics({ prefix: 'senneo_' });

const msgsProduced = new Counter({ name: 'senneo_messages_produced_total', help: 'Total messages sent to Kafka' });
const scrapeLatency = new Histogram({ name: 'senneo_scrape_batch_duration_seconds', help: 'Scrape batch duration' });

// Express endpoint
app.get('/metrics', async (req, res) => { res.set('Content-Type', register.contentType); res.end(await register.metrics()); });
```

**prometheus.yml'e eklenecek job'lar:**

```yaml
- job_name: 'senneo-api'
  static_configs:
    - targets: ['host.docker.internal:4000']

- job_name: 'senneo-accounts'
  static_configs:
    - targets: ['host.docker.internal:4001']  # Her instance farklı port

- job_name: 'senneo-ingester'
  static_configs:
    - targets: ['host.docker.internal:4002']  # Her instance farklı port
```
