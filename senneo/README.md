# Senneo

Discord message scraping + analytics platform.

## Architecture

```
Discord API
    │  (selfbot, ~100 msg/s per channel, max 5 concurrent)
    ▼
accounts package  ──────────────────►  Redpanda (Kafka)
                                            │
                                            ▼
                                      ingester package
                                       ├──► ScyllaDB         (fast reads, cursor scroll)
                                       └──► ClickHouse        (analytics, badge directory)
                                            │
                                            ▼
                                        api package          (REST, port 4000)
```

### Database split

| Use case | Database |
|---|---|
| Point lookup by message ID | ScyllaDB `messages_by_id` |
| Channel scroll (upward pagination) | ScyllaDB `messages_by_channel_bucket` |
| Analytics, date-range queries | ClickHouse `messages` |
| Badge directory (bitAnd filter) | ClickHouse `users_latest` |

## Quick Start

### 1. Start infrastructure
```bash
docker compose up -d
# Wait ~60s for Scylla to be ready
docker compose ps   # all should be "healthy"
```

### 2. Install dependencies
```bash
npm install
```

### 3. Build
```bash
npm run build
```

### 4. Configure
Edit `.env`:
- `TARGET_GUILD_IDS` + `TARGET_CHANNEL_IDS` — comma-separated, index-matched pairs
- `CONCURRENT_GUILDS` — channels scraped simultaneously per account (keep at 5)

Edit `accounts.json`:
```json
{
  "accounts": [
    { "token": "YOUR_TOKEN" }
  ]
}
```

Multiple accounts are supported. Targets are distributed round-robin across accounts.

### 5. Run

**Terminal 1 — ingester** (must start before accounts):
```bash
npm run start:ingester
```

**Terminal 2 — accounts scraper**:
```bash
npm run start:accounts
```

**Terminal 3 — API** (optional):
```bash
npm run start:api
```

## API Endpoints

```
GET /health

# Point lookup (ScyllaDB)
GET /messages/:messageId

# Cursor-based scroll (ScyllaDB, newest-first)
GET /messages/channel/:channelId?before=<ISO timestamp>&limit=50

# Analytics search (ClickHouse)
GET /messages/search?guildId=&channelId=&authorId=&from=&to=&limit=100

# Badge directory — users with all requested badge bits
GET /messages/badges?badgeMask=64&limit=100

# Message volume stats per channel
GET /messages/stats/:channelId
```

## Rate limiting

The scraper is tuned for Discord's undocumented selfbot limits:

- **1 request/second per channel** → 100 messages/request → 100 msg/s per channel
- **5 concurrent channels** per account → ~500 msg/s per account
- Automatic 429 backoff using `retryAfter` from Discord response
- Checkpoints survive restarts — scraping resumes from exact cursor position

## Monitoring

- Grafana: http://localhost:3000 (admin / admin)
- Prometheus: http://localhost:9090
- Scrape targets: ScyllaDB, ClickHouse, Redpanda all auto-scraped
- **Hata Günlüğü**: Dashboard → "Hata Günlüğü" sayfası (sidebar, kısayol: 9)

### Centralized Error Log

All services write structured errors to ClickHouse `senneo.error_log` (MergeTree, 30-day TTL, partitioned by day).

**Categories:** `rate_limit` · `discord_api` · `kafka_producer` · `kafka_consumer` · `scylla_write` · `clickhouse_write` · `dlq_parse` · `checkpoint_persist` · `network` · `auth_login` · `validation` · `proxy` · `unknown`

**API Endpoints:**
```
GET  /errors?limit=50&offset=0&since=24h&category=rate_limit&source=accounts&severity=error&q=timeout
GET  /errors/summary?since=24h
POST /errors   (body: ErrorLogEntry or ErrorLogEntry[])
```

**Example ClickHouse queries:**
```sql
-- Last hour errors by category
SELECT category, count() AS cnt FROM senneo.error_log
WHERE ts >= now() - INTERVAL 1 HOUR GROUP BY category ORDER BY cnt DESC;

-- Rate limit errors for specific channel
SELECT ts, message, detail FROM senneo.error_log
WHERE category = 'rate_limit' AND channel_id = '1234567890' ORDER BY ts DESC LIMIT 20;
```

**Flood control:** Ingester uses sampled writes (max 1 per fingerprint per 10s). API POST truncates `detail` to 4KB and `message` to 2KB to prevent PII/token leakage.

## Scaling

See `ARCHITECTURE_SCALING_PLAN.md` for the full production topology (500K msg/s, 500B+ rows).

### Multi-Instance Scraper

Each instance handles a slice of `accounts.json` using global indices.
`ACCOUNTS_RANGE_END` is **exclusive** (half-open interval `[start, end)`):
50 hesap (global indeks 0–49) için `ACCOUNTS_RANGE_START=0`, `ACCOUNTS_RANGE_END=50`.

```bash
# Instance 0: accounts [0, 50)  → global indices 0–49
ACCOUNTS_RANGE_START=0 ACCOUNTS_RANGE_END=50 node packages/accounts/dist/index.js

# Instance 1: accounts [50, 100) → global indices 50–99
ACCOUNTS_RANGE_START=50 ACCOUNTS_RANGE_END=100 node packages/accounts/dist/index.js
```

**Rules:**
- Ranges are half-open `[start, end)` — end is exclusive, matching JS `Array.slice()`.
- Ranges must not overlap across instances.
- `scrape_targets.account_idx` uses the **global** index from accounts.json, not a local offset.
- If env is unset, all accounts are loaded (backward compatible single-instance mode).
- Hot-reload (`accounts.json` file watch) respects the range.

### 20 Instance × 50 Account Example

```bash
# Generate all 20 instance env files (accounts.json has 1000 entries):
for i in $(seq 0 19); do
  START=$((i * 50))
  END=$(((i + 1) * 50))
  cat > .env.accounts-${i} << EOF
ACCOUNTS_RANGE_START=${START}
ACCOUNTS_RANGE_END=${END}
CONCURRENT_GUILDS=5
FETCH_DELAY_MS=150
RATE_LIMIT_COOLDOWN_MS=10000
ADAPTIVE_MIN_MS=120
KAFKA_BROKERS=localhost:9092
KAFKA_TOPIC=messages
SCYLLA_HOSTS=localhost
SCYLLA_KEYSPACE=senneo
EOF
done

# Start instance N:
env $(cat .env.accounts-0 | xargs) node packages/accounts/dist/index.js
```

### Proxy Setup

Mimari hazırlığı mevcut; **varsayılan doğrudan IP** (VDS egress). Proxy'yi `PROXY_ENABLED=true` ile açarsınız.

1. Copy `proxies.example.json` → `proxies.json`
2. Fill in your SOCKS5/HTTP proxy URLs
3. Set `PROXY_ENABLED=true` (or `=1`) in env
4. Start accounts — each account is deterministically assigned a proxy (`globalIdx % pool.length`)
5. Hot-reload: edit proxies.json while running (new assignments use updated pool)

Without `PROXY_ENABLED=true`, all Discord connections go direct — proxy code is loaded but inactive.
Not: `fetchGuildIds()` şu an her zaman doğrudan bağlantı kullanır; ileride proxy'e bağlanabilir.

### Scraper Parameter Tuning

All timing parameters are configurable via env (see `scraper.ts`):

| Env Variable | Default | Description |
|---|---|---|
| `FETCH_DELAY_MS` | 150 | Base delay between fetch calls per channel |
| `RATE_LIMIT_COOLDOWN_MS` | 10000 | Extra wait after 429 |
| `ADAPTIVE_MIN_MS` | 120 | Minimum adaptive delay |
| `ADAPTIVE_MAX_MS` | 2000 | Maximum adaptive delay |
| `ADAPTIVE_STEP_UP_MS` | 100 | Delay increase on rate limit |
| `ADAPTIVE_STEP_DOWN_MS` | 5 | Delay decrease on success |
| `SCRAPE_BATCH_SIZE` | 100 | Messages per Discord API fetch |
| `SCRAPE_MAX_RETRIES` | 5 | Max retries before giving up on a channel |
| `CONCURRENT_GUILDS` | 15 | Channels scraped simultaneously per account |

### Kafka/Ingester Scaling

| Env Variable | Default | Description |
|---|---|---|
| `KAFKA_PARTITIONS` | 16 | Topic partition count (prod: 256) |
| `KAFKA_REPLICATION_FACTOR` | 1 | Topic RF (prod: 3) |
| `KAFKA_COMPRESSION` | gzip | Compression type (prod: lz4) |

Multiple ingester instances can run with the same consumer group (`senneo-ingester`) — Kafka auto-assigns partitions.

## ScyllaDB bucket strategy

`bucket = Math.floor(ts_ms / 86_400_000)` (1 day per bucket)

Each partition holds at most one day of messages per channel. At 100 msg/s that's 8.6M messages/day — still well within Scylla's partition size limits.
