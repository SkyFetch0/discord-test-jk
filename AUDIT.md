# Senneo Architecture Audit — Risk Summary & Prioritized Backlog

**Date:** 2026-03-21  
**Scope:** senneo (backend monorepo) + senneo-dashboard (Vite/React)  
**Target:** 500B+ records, ~500K concurrent processing capacity  

---

## EXECUTIVE RISK SUMMARY

| # | Risk | Severity | Component | Data Loss? |
|---|------|----------|-----------|------------|
| 1 | Offset committed before durable write | **CRITICAL** | ingester | YES |
| 2 | Scylla write silently dropped after 5s timeout | **CRITICAL** | ingester | YES |
| 3 | Both Scylla+CH write errors swallowed — flush always "succeeds" | **CRITICAL** | ingester | YES |
| 4 | Plaintext Discord tokens in repo (accounts.json) | **CRITICAL** | security | — |
| 5 | Scylla UNLOGGED batch spans multiple partitions (100 rows) | HIGH | ingester/scylla | PERF |
| 6 | Scylla RF=1 + SimpleStrategy — zero fault tolerance | HIGH | infra | YES |
| 7 | CH `wait_for_async_insert=0` — fire-and-forget | HIGH | ingester/ch | YES |
| 8 | Full-table-scan CH queries in API (500B rows = OOM/timeout) | HIGH | api | — |
| 9 | Only 4 Kafka partitions — ingester can't scale horizontally | HIGH | kafka | — |
| 10 | No Prometheus metrics from ingester/API; no alerting rules | HIGH | monitoring | — |
| 11 | API db router: arbitrary SQL/CQL without authentication | MEDIUM | api/security | — |
| 12 | SSE reconnect storm (fixed 3s, no backoff) | MEDIUM | dashboard | — |
| 13 | Dashboard exports/tables have no row limits | MEDIUM | dashboard | — |
| 14 | Producer idempotent=false + acks=1 | MEDIUM | accounts | DUP |
| 15 | Scylla partition hotspot on popular channels (day bucket) | MEDIUM | schema | PERF |
| 16 | API reads at localOne vs ingester writes at localQuorum | LOW | consistency | — |
| 17 | accounts.json hot-reload race on shared mutable state | LOW | accounts | — |

---

## P0 — MUST FIX BEFORE ANY SCALE-UP (data loss / security)

### P0-1: Ingester offset-commit-before-durable-write ⬅ #1 root cause

**Files:** `packages/ingester/src/index.ts`

**Problem:**
```
Line 147: eachBatchAutoResolve: true    ← auto-resolves every offset
Line 184: resolveOffset(kafkaMsg.offset) ← also manually resolves before flush
Line 77-80: Promise.race on Scylla with 5s timeout ← write can be abandoned
Line 65-73: .catch() swallows errors   ← flushBatch never throws
```

The current flow:
1. Parse message → `resolveOffset()` immediately (line 184)
2. When batch full → `flushBatch()` fires Scylla+CH in parallel
3. Scylla gets a 5s `Promise.race` — if slow, write is ABANDONED
4. Both `.catch()` handlers swallow errors — flush always "succeeds"
5. `commitOffsetsIfNecessary()` (line 189) commits the resolved offsets
6. **Result:** Kafka thinks messages are consumed, but they were never written

**Patch plan — commit-after-durable-write semantics:**

```typescript
// index.ts — CHANGES NEEDED:

// 1. Disable auto-resolve
eachBatchAutoResolve: false,   // was: true

// 2. Remove per-message resolveOffset (line 184) — move to after flush

// 3. flushBatch MUST throw on failure (remove .catch swallowing)
// 4. Remove Promise.race timeout on Scylla — use socket timeout instead
// 5. Only resolveOffset + commitOffsetsIfNecessary AFTER successful flush

// New eachBatch flow:
for (const kafkaMsg of batch.messages) {
  // parse... push to messages[]
  // DO NOT resolveOffset here
  
  if (messages.length >= BATCH_FLUSH_SIZE) {
    await flushBatch(scylla, clickhouse, messages.splice(0, BATCH_FLUSH_SIZE));
    // Only now resolve the last offset in this sub-batch
    resolveOffset(kafkaMsg.offset);
    await heartbeat();
    await commitOffsetsIfNecessary();
  }
}
// flush remainder, then resolve final offset
```

**KPI:** `ingester_flush_errors_total` must be 0 during normal operation. Any non-zero = alert.

---

### P0-2: flushBatch must propagate write failures ⬅ #2, #3

**File:** `packages/ingester/src/index.ts` lines 55-90

**Problem:** Both Scylla and CH writes are wrapped in `.catch()` that only increments counters. The function NEVER throws. Combined with P0-1, this guarantees silent data loss.

**Patch plan:**

```typescript
async function flushBatch(
  scylla: CassandraClient, clickhouse: ClickHouseClient, messages: RawMessage[]
): Promise<void> {
  const start = Date.now();

  // Run both writes in parallel, but AWAIT both fully
  const [scyllaResult, chResult] = await Promise.allSettled([
    scyllaWrite(scylla, messages),
    clickhouseWrite(clickhouse, messages),
  ]);

  // If Scylla fails, throw — caller must NOT commit offset
  if (scyllaResult.status === 'rejected') {
    metrics.scyllaErrors++;
    console.error('[ingester] ScyllaDB write error:', scyllaResult.reason);
    throw scyllaResult.reason; // propagate!
  }

  // CH failure is less critical (analytics) but still log
  if (chResult.status === 'rejected') {
    metrics.chErrors++;
    console.error('[ingester] ClickHouse write error:', chResult.reason);
    // Don't throw — Scylla is source of truth, CH can catch up
  }

  metrics.msgsProcessed += messages.length;
  metrics.batchesFlushed++;
  // ... timing log
}
```

**KPI:** p99 flush duration < 2s; `scyllaErrors` counter exposed via Prometheus.

---

### P0-3: Scylla cross-partition UNLOGGED batch ⬅ #5

**File:** `packages/ingester/src/scylla.ts`

**Problem:** `writeChunk()` batches up to 100 rows into a single `client.batch()` call. Messages from different channels go to different partitions. Cross-partition UNLOGGED batches are anti-patterns in Scylla — they increase coordinator memory pressure and latency.

**Patch plan:** Replace batch with individual prepared statement executions using `concurrency` control:

```typescript
// Option A: Single-partition batches (group by partition key first)
// Option B: Individual prepared INSERT with concurrency limiter

// Recommended: Option B (simpler, Scylla handles individual writes efficiently)
async function writeChunk(client: CassandraClient, chunk: RawMessage[]): Promise<void> {
  const queries = chunk.flatMap(m => buildInsertQueries(m)); // same queries as now
  // Execute all with prepare:true, max 32 concurrent
  await Promise.all(queries.map(q => 
    client.execute(q.query, q.params, { prepare: true })
  ));
}
```

Alternatively, group by `(channel_id, bucket)` partition key and batch only within same partition.

---

### P0-4: Plaintext tokens in repository ⬅ #4

**File:** `senneo/accounts.json`

**Problem:** 3 Discord tokens stored in plaintext, file tracked by git.

**Patch plan:**
1. Add `accounts.json` to `.gitignore`
2. Rotate all 3 tokens immediately (they're compromised if repo is shared)
3. Move to environment variable `ACCOUNTS_JSON_PATH` or use `dotenv` with `.env` file
4. For prod: use Docker secrets or Vault

---

## P1 — HIGH PRIORITY (performance / reliability at scale)

### P1-1: ClickHouse fire-and-forget inserts ⬅ #7

**File:** `packages/ingester/src/clickhouse.ts` line 18

**Change:** `wait_for_async_insert: 1` (was `0`)

This makes CH acknowledge only after the async buffer is flushed to disk. Slight latency increase (~500ms per batch) but guarantees durability. Combined with P0-2 (CH failure doesn't block offset commit), this is safe.

---

### P1-2: API full-table-scan queries ⬅ #8

**Files:** `packages/api/src/routes/messages.ts`, `packages/api/src/routes/db.ts`, `packages/api/src/routes/live.ts`

**Problem queries (will timeout/OOM at 500B rows):**
- `GET /messages/count` → `count()` full table scan
- `GET /db/ch/analytics/topusers` → `GROUP BY` full scan
- `GET /db/ch/analytics/topchannels` → `GROUP BY` full scan
- `GET /db/ch/analytics/hourly` → full scan
- `GET /live/summary` → `count()` + `uniq()` full scan

**Patch plan:**
1. `/messages/count` and `/live/summary`: Use a pre-aggregated summary table (1 row, updated by MV or periodic job), not real-time scan
2. `topusers` / `topchannels`: Add mandatory time window (`WHERE ts >= now() - INTERVAL 30 DAY`)
3. `hourly`: Add time window constraint
4. All CH queries: Add `SETTINGS max_execution_time = 10, max_rows_to_read = 100000000` as safety net
5. Add Express middleware for per-route timeout (10s for analytics, 30s for search)

---

### P1-3: Kafka partition count ⬅ #9

**File:** `packages/accounts/src/producer.ts` line 53

**Change:** Increase from 4 to 32+ partitions for the `messages` topic. This allows:
- Multiple ingester instances (horizontal scaling)
- Better parallelism within single consumer via `eachBatch`
- Key = `channelId` ensures ordering per channel

**Note:** Requires topic recreation or partition expansion via `rpk topic alter-config`.

---

### P1-4: Prometheus metrics from ingester/API ⬅ #10

**Files:** `packages/ingester/src/index.ts`, `packages/api/src/index.ts`, `senneo/prometheus.yml`

**Current state:** Ingester writes metrics to a JSON file. API has no metrics. Prometheus only scrapes infra services.

**Patch plan:**
1. Add `prom-client` dependency to ingester and API
2. Expose `/metrics` HTTP endpoint on both (ingester on port 9091, API on :4000/metrics)
3. Register histograms:
   - `ingester_flush_duration_seconds` (histogram, labels: status)
   - `ingester_messages_processed_total` (counter)
   - `ingester_write_errors_total` (counter, labels: store=scylla|clickhouse)
   - `ingester_consumer_lag` (gauge)
   - `api_request_duration_seconds` (histogram, labels: route, status)
4. Add scrape targets to `prometheus.yml`
5. Create Grafana dashboard + alerting rules:
   - Alert: `ingester_consumer_lag > 10000` for 5 min
   - Alert: `ingester_write_errors_total` increase > 0 for 1 min
   - Alert: `scylla_storage_proxy_coordinator_write_timeouts` > 0

---

### P1-5: Scylla RF=1 + SimpleStrategy ⬅ #6

**File:** `packages/ingester/src/scylla.ts` (schema init)

**Current:** `SimpleStrategy, RF=1` — zero redundancy.

**Prod plan:**
- Switch to `NetworkTopologyStrategy` with RF=3
- Requires 3+ Scylla nodes
- docker-compose stays RF=1 (dev)
- Prod keyspace creation via migration script, not app init

---

## P2 — MEDIUM PRIORITY (reliability / UX / hardening)

### P2-1: API db router allows arbitrary queries without auth ⬅ #11

**File:** `packages/api/src/routes/db.ts`

- Add authentication middleware (API key or JWT)
- In prod: disable `/db/ch/query` and `/db/scylla/query` entirely or restrict to read-only
- Add query size limits

### P2-2: SSE reconnection backoff ⬅ #12

**File:** `senneo-dashboard/src/hooks.ts` line 13

```typescript
// Current: fixed 3s retry
es.onerror = () => { setConnected(false); es.close(); retry = setTimeout(connect, 3000); };

// Fix: exponential backoff with jitter, cap at 30s
let retryDelay = 1000;
es.onerror = () => {
  setConnected(false); es.close();
  retry = setTimeout(connect, retryDelay + Math.random() * 1000);
  retryDelay = Math.min(retryDelay * 2, 30000);
};
es.onopen = () => { setConnected(true); retryDelay = 1000; }; // reset on success
```

### P2-3: Dashboard export/table limits ⬅ #13

**File:** `senneo-dashboard/src/api.ts`

- `exportCSV`: Add max rows parameter (default 10,000), warn user if truncated
- `DataTable`: Add virtual scrolling (react-window) for tables > 100 rows

### P2-4: Kafka producer idempotent mode ⬅ #14

**File:** `packages/accounts/src/producer.ts`

```typescript
// Change to:
idempotent: true,
maxInFlightRequests: 1,  // required for idempotent
acks: -1,                // all replicas
```

### P2-5: Scylla partition hotspot mitigation ⬅ #15

**File:** `packages/ingester/src/scylla.ts` schema

For channels with millions of msgs/day, `(channel_id, bucket)` where bucket=day creates large partitions.

**Options:**
- Use hourly buckets: `dateToBucket = ts / 3_600_000`
- Or add sub-bucket: `(channel_id, bucket, sub)` where sub = `message_id % 8`

Impact: Requires migration of existing data. Do after measuring actual partition sizes.

### P2-6: API consistency level alignment ⬅ #16

**File:** `packages/api/src/index.ts` line (queryOptions)

API uses `localOne`, ingester uses `localQuorum`. When RF>1, reads might be stale. Change API to `localQuorum` for consistency.

### P2-7: accounts.json hot-reload race conditions ⬅ #17

**File:** `packages/accounts/src/index.ts`

The `fs.watchFile` callback modifies `clients`, `queues`, `activeIdxs` concurrently with the main scrape loop. Add a mutex/semaphore (e.g., `async-mutex` or a simple `_reloading` flag) to serialize access.

---

## MEASURABLE KPIs

| KPI | Target | How to measure |
|-----|--------|----------------|
| p99 flush duration | < 2 seconds | `ingester_flush_duration_seconds` histogram |
| Consumer lag | < 5,000 messages | `ingester_consumer_lag` gauge / Redpanda metrics |
| CH insert error rate | 0% sustained | `ingester_write_errors_total{store="clickhouse"}` |
| Scylla write timeout rate | < 0.01% | `scylla_storage_proxy_coordinator_write_timeouts` |
| Scylla p99 write latency | < 10ms | `scylla_storage_proxy_coordinator_write_latency` |
| API p99 response time | < 500ms (reads), < 5s (analytics) | `api_request_duration_seconds` |
| SSE reconnection rate | < 1/min per client | Client-side counter |
| Messages processed/sec | > 10,000 sustained | `ingester_messages_processed_total` rate |
| Batch success rate | > 99.9% | `(batchesFlushed - scyllaErrors) / batchesFlushed` |

---

## IMPLEMENTATION ORDER

```
Week 1 (P0 — stop the bleeding):
  ├── P0-1: Fix offset commit semantics (ingester/index.ts)
  ├── P0-2: Fix flushBatch error propagation (ingester/index.ts)
  ├── P0-3: Fix cross-partition batches (ingester/scylla.ts)
  └── P0-4: Secure tokens (accounts.json → .gitignore + rotate)

Week 2 (P1 — measure & harden):
  ├── P1-1: CH wait_for_async_insert=1 (ingester/clickhouse.ts)
  ├── P1-2: API query timeouts + time bounds (api/routes/*.ts)
  ├── P1-4: Prometheus metrics endpoint (ingester + api)
  └── P1-4: Grafana dashboards + alert rules

Week 3 (P1 continued + P2 start):
  ├── P1-3: Expand Kafka partitions (operational task)
  ├── P1-5: Prod Scylla config (RF=3, NetworkTopologyStrategy)
  ├── P2-1: API auth middleware
  └── P2-2: SSE backoff (dashboard/hooks.ts)

Week 4 (P2 — polish):
  ├── P2-3: Dashboard export limits + virtual scrolling
  ├── P2-4: Kafka producer idempotent mode
  ├── P2-5: Evaluate partition hotspots (measure first)
  └── P2-6 + P2-7: Consistency + race condition fixes
```

---

## DOCKER-COMPOSE: DEV vs PROD SEPARATION

Current `docker-compose.yml` has dev settings (`--smp 1`, `--memory 1G`).

**Recommendation:**
- Keep current file as `docker-compose.yml` (dev)
- Create `docker-compose.prod.yml` override:
  - Scylla: remove `--smp 1 --memory 1G --overprovisioned`, add `--cpuset`, RAID/NVMe volumes
  - Redpanda: `--smp 4 --memory 8G`, persistent volumes with proper FS
  - ClickHouse: Add `max_server_memory_usage_ratio`, `max_concurrent_queries`
  - All: proper resource limits, restart policies, log drivers
