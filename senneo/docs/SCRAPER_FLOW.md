# Scraper Flow & Phase Semantics

## Architecture Overview

```
Discord API ──► accounts/scraper.ts ──► Kafka ──► ingester ──► Scylla + ClickHouse
                     │                                              │
                checkpoint.ts ◄──────── scrape_checkpoints ─────────┘
                stats.ts      ◄──────── scrape_stats
                                              │
                              API /live ◄─────┘──► Dashboard SSE + REST
```

## 1. Queue System (`packages/accounts/src/index.ts`)

### How channels are enqueued

- On startup, `syncTargets()` reads `scrape_targets` from Scylla
- Each target channel is assigned to a Discord account via `pickAccount(guildId)`
  - Round-robin across `activeIdxs` array
  - Each account has its own `PQueue` with `concurrency = CONCURRENT_CHNL` (typically 1-2)
- `enqueueChannel(target, accIdx)` adds a job to that account's queue
- Jobs call `scrapeChannel()` from `scraper.ts`

### Target polling

- Every 2 seconds, a poll timer checks `scrape_targets` for changes
- New targets are enqueued; removed targets are aborted via `AbortController`
- `accounts.json` is also watched for hot-reload of Discord accounts

### Account assignment

- `account_idx` is stored in `scrape_targets` and `scrape_stats`
- Dashboard can filter by `account_idx` via `/live/channels?accountIdx=N`

## 2. Scraping a Channel (`packages/accounts/src/scraper.ts`)

### Initial setup (lines 133-165)

1. If checkpoint exists with `complete: true` → skip, return immediately
2. If no checkpoint → fetch latest message (limit: 1), set `newestMessageId = cursorId = latestMsg.id`
3. Cursor starts at the NEWEST message and moves BACKWARDS

### Main loop (lines 175-255)

```
while (true):
  1. Check AbortSignal
  2. Await any pending Kafka delivery from previous iteration
  3. Fetch batch: channel.messages.fetch({ limit: BATCH_SIZE, before: cursor })
  4. If fetch fails → retry with backoff (MAX_RETRIES), handle 403/404/429
  5. If messages.size === 0:
     - consecutiveEmpty++
     - If consecutiveEmpty >= 2 → set complete: true, break
     - Otherwise sleep and continue
  6. If messages.size > 0:
     - consecutiveEmpty = 0  ← reset only here (P0 fix)
     - Sort ascending, cursor = oldest message ID
     - Save checkpoint (complete: false)
     - Fire Kafka send (pipelined, awaited next iteration)
     - Adaptive delay adjustment
```

### Completion condition

**Single source of truth:** `scrape_checkpoints.complete = true`

Set when **two consecutive empty batches** are received from Discord API.
This means the cursor has gone past the oldest message in the channel.

**Important:** `consecutiveEmpty` is reset ONLY when a non-empty batch is received
(line ~234), NOT on every successful fetch. This was a P0 bug fix — the previous
code reset it inside the fetch try/catch, making it impossible to reach 2.

## 3. Checkpoint & Stats (`checkpoint.ts`, `stats.ts`)

### Checkpoint flush

- In-memory `_store` map, dirty set tracked
- Flushed to `scrape_checkpoints` every 3 seconds
- On SIGINT/SIGTERM, graceful flush before exit
- Fields: `channel_id, guild_id, newest_message_id, cursor_id, total_scraped, complete, last_scraped_at`

### Stats flush

- In-memory rolling window for `msgs_per_sec` calculation
- Flushed to `scrape_stats` every 5 seconds
- Fields: `channel_id, guild_id, total_scraped, msgs_per_sec, rate_limit_hits, errors, last_updated, complete, account_idx`
- `complete` in stats may lag behind checkpoint (stats flush interval is longer)

## 4. API Phase Computation (`packages/api/src/routes/live.ts`)

### Data sources merged in `buildStats()`

| Source | Table | Key fields |
|--------|-------|------------|
| Stats | `scrape_stats` | `total_scraped`, `msgs_per_sec`, `complete`, `errors`, `account_idx` |
| Targets | `scrape_targets` | `channel_id`, `guild_id`, `label`, `account_idx` |
| Checkpoints | `scrape_checkpoints` | `total_scraped`, `complete`, `newest_message_id`, `cursor_id` |

### `complete` merging

```typescript
mergedComplete = stats.complete || checkpoint.complete
```

Checkpoint is the authoritative source. Stats may have stale `complete=false`.

### `totalScraped` merging

```typescript
ts = Math.max(statsTotal, checkpoint.totalScraped)
```

Ensures completed channels show their real count even if stats table has stale/zero value.

### `calcProgress` (snowflake-based)

```
progress = (newestMs - cursorMs) / (newestMs - channelCreationMs) * 100
```

- Capped at 99% — only `complete: true` gives 100%
- Uses Discord snowflake timestamps (ms since epoch = (id >> 22) + 1420070400000)

### `computeScrapePhase` — Priority Order

```
1. complete = true        → 'done'    (single source of truth)
2. msgsPerSec > 0         → 'active'  (currently pulling messages)
3. errors.length > 0      → 'error'   (has errors, not active, not complete)
4. totalScraped=0, prog=0 → 'queued'  (never started)
5. otherwise              → 'idle'    (has data but not currently active)
```

**Critical:** `active` is checked BEFORE `error`. A channel that is actively scraping
with old stale error records should show as "Aktif", not "Hata".

## 5. Dashboard (`scrapePhase.ts`, `Scraper.tsx`)

### Client-side fallback

`deriveScrapePhase(c)` mirrors the server-side priority exactly:
1. If `c.scrapePhase` exists (from API) → use it directly
2. Otherwise apply the same 5-step priority

### Filter labels

| Phase | Turkish label | Meaning |
|-------|---------------|---------|
| `done` | Bitti | Checkpoint says complete |
| `active` | Aktif | msg/s > 0 right now |
| `error` | Hata | Has errors, not active, not complete |
| `queued` | Sirada | Never started (0 scraped, 0 progress) |
| `idle` | Beklemede | Has data/progress but not currently active |

### Common confusion: "Beklemede" (idle)

A channel shows as `idle` when:
- It has been scraped (totalScraped > 0 or progress > 0)
- But is not currently active (msgsPerSec = 0)
- And is not complete

This happens in **round-robin**: with many channels and few accounts,
channels take turns. While waiting for their turn, they show as `idle`.

**This is NOT a bug** — it's expected behavior with concurrent channel limits.

## 6. Known Edge Cases

| Scenario | Behavior | Phase |
|----------|----------|-------|
| Channel empty from start | Two empty batches → complete | done |
| Channel with 1 message | Fetch 1 msg, then 2 empty → complete | done |
| Rate limited mid-scrape | Adaptive delay increases, continues | active→idle→active |
| Account disconnected | AbortSignal fired, loop exits | idle (until re-queued) |
| Progress 99%, not complete | Cursor near channel creation, waiting for empty batch | idle |
| Stats says complete, checkpoint doesn't | mergedComplete uses OR → done | done |
| Both stats and checkpoint say incomplete | Phase based on msgsPerSec/errors/totalScraped | varies |

## 7. Regression Test Checklist

### Completion
- [ ] Start scraper on an empty channel → should reach `done` within ~10s
- [ ] Start scraper on a channel with 100 messages → should reach `done`
- [ ] Check `scrape_checkpoints WHERE complete = true` matches dashboard "Bitti" count
- [ ] Progress shows 100% for completed channels, never 99%

### Phase transitions
- [ ] New target added → shows as "Sirada" (queued)
- [ ] Scraping starts → shows as "Aktif" (active) with msg/s > 0
- [ ] Round-robin pause → shows as "Beklemede" (idle), NOT "Hata"
- [ ] Channel with old errors but actively scraping → shows "Aktif", NOT "Hata"
- [ ] Completed channel → shows "Bitti" regardless of stale error records

### Stat cards (Accounts page)
- [ ] Numbers don't flicker/bounce on page re-render
- [ ] Count-up animation smooth from previous→new value

### Undo
- [ ] Remove channel → toast with "Geri Al" button appears
- [ ] Click "Geri Al" within 30s → channel re-added, success toast
- [ ] Wait 30s → "Geri Al" button no longer functional (silent no-op)

## 8. Scale Operations Guide

### Kafka Partition Expansion

Current default: **16 partitions** (env: `KAFKA_PARTITIONS`, set in `producer.ts`).

**When to expand:** If consumer lag grows consistently under sustained load.

**How to expand (existing topic):**
```bash
rpk topic alter-config messages --set partition-count=32
# or via Redpanda console / kafka-topics.sh
```

**Note:** Expanding partitions does NOT require ingester restart. KafkaJS rebalances automatically. However, message ordering is only guaranteed within a partition — key=channelId ensures per-channel ordering is preserved regardless of partition count.

**Sizing rule of thumb:**
- 1 ingester instance can handle ~4 partitions efficiently
- For 500k msg/s target: 32+ partitions with 8+ ingester instances
- For dev/single-node: 4-16 is fine

### Scylla: Hourly Bucket Migration

Current: `messages_by_channel_bucket` uses **daily** buckets (`dateToBucket = ts / 86_400_000`).

**When to switch to hourly:** If any single partition exceeds ~100MB (check via `nodetool tablehistograms`).

**How to switch:**
1. Change `dateToBucket` in `shared/src/index.ts` from `/ 86_400_000` to `/ 3_600_000`
2. New data goes to hourly buckets automatically
3. Old daily-bucket data remains readable (different bucket values, same schema)
4. No migration needed — both coexist in the same table

**Query impact:** API `messages/channel/:id` already iterates buckets in a while loop — it handles any bucket size automatically.

### ClickHouse: Identity Log Retention

`user_identity_log` has **TTL 365 days** (`TTL toDateTime(observed_ts) + INTERVAL 365 DAY`).

- CH drops expired partitions automatically during merges
- Partition = `toYYYYMM(observed_ts)` → monthly granularity for TTL drops
- No manual cleanup needed
- To change: `ALTER TABLE senneo.user_identity_log MODIFY TTL toDateTime(observed_ts) + INTERVAL N DAY`

### ClickHouse: Identity Log Dedup on Restart

On ingester restart, the LRU identity cache is empty → first batch writes all observations unconditionally → creates duplicate rows for unchanged values.

**This is acceptable because:**
- Append-only table — duplicates don't corrupt
- Queries use `ORDER BY observed_ts DESC LIMIT N` — duplicates appear as consecutive identical entries
- For exact dedup: `SELECT ... LIMIT 1 BY author_id, field, value` at query time

**For multi-instance ingesters:** Same user rarely processed by two instances (key=channelId routing). Overlap is ~5-10% worst case.

## 9. Field Naming Reference

| Code field | CH column | Scylla column | Discord source | Meaning |
|-----------|-----------|---------------|----------------|---------|
| `authorName` | `author_name` | `author_name` | `msg.author.username` | **Global username** (e.g. "alice") |
| `displayName` | `display_name` | `display_name` | `msg.author.globalName` | **Display name** (e.g. "Alice Smith") |
| `nick` | `nick` | `nick` | `msg.member.nickname` | **Guild nickname** (per-server) |
| `authorAvatar` | `author_avatar` | `author_avatar` | `msg.author.avatar` | Avatar hash (CDN: `/avatars/{id}/{hash}.png`) |
| `isBot` | `is_bot` | `is_bot` | `msg.author.bot` | Bot/webhook flag (0=human, 1=bot) |
| `badgeMask` | `badge_mask` | `badge_mask` | `msg.author.flags` | User badge bitfield |

**Critical distinction:**
- `author_name` ≠ `display_name` ≠ `nick`
- `author_name` = immutable-ish global username
- `display_name` = user-chosen display name (can be null/empty for legacy users)
- `nick` = server-specific nickname (guild-scoped, can be null)
