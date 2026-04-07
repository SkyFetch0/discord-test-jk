# Scraper Event Log — Design & API

## Architecture

```
accounts process                    API server              Dashboard
┌──────────────┐                ┌──────────────┐       ┌──────────────┐
│ scrape-event- │  file (1s)    │  GET /live/  │  HTTP  │  LogDrawer   │
│ log.ts ring   │──────────────►│  scraper-log │◄──────│  (poll 2s)   │
│ buffer (2000) │ scraper_      │  (mtime      │       │  max 500     │
│               │ events.json   │   cached)    │       │  client-side │
└──────────────┘                └──────────────┘       └──────────────┘
```

### Bounded at every layer

| Layer | Limit | Why |
|-------|-------|-----|
| Ring buffer (accounts) | 2000 events | Fixed memory, O(1) append |
| File flush | Last 500 events, every 1s | Bounded disk I/O |
| API response | max 500 per request | HTTP payload limit |
| Dashboard client | 500 events in state | DOM/memory limit |
| Poll interval | 2 seconds | No hot loop |

## Event Schema

```typescript
interface ScrapeEvent {
  id: number;           // Monotonic sequence (ring buffer internal)
  ts: string;           // ISO 8601 timestamp
  type: ScrapeEventType;
  accountIdx?: number;  // Which Discord account (0-based)
  accountName?: string; // Username (never token)
  channelId?: string;   // Discord channel snowflake
  guildId?: string;     // Discord guild snowflake
  message: string;      // Human-readable one-liner
  detail?: string;      // Optional extra (error msg, count, etc.)
}

type ScrapeEventType =
  | 'enqueue'        // Channel added to account queue
  | 'dequeue'        // Channel removed from queue
  | 'scrape_start'   // scrapeChannel() begins
  | 'scrape_end'     // Channel completed (complete=true)
  | 'scrape_error'   // Error during scrape (403, 404, retry exhausted)
  | 'rate_limit'     // Discord rate limit hit
  | 'batch'          // Batch sent to Kafka (logged every N-th only)
  | 'account_login'  // Account logged in
  | 'account_error'  // Account login failed
  | 'target_change'  // Target list changed
  | 'info';          // Generic info
```

## Example Events (JSON lines)

```json
{"id":1,"ts":"2026-03-22T00:15:00.000Z","type":"info","message":"Event log started","detail":"capacity=2000"}
{"id":2,"ts":"2026-03-22T00:15:00.100Z","type":"enqueue","accountIdx":0,"channelId":"1234567890","guildId":"9876543210","message":"1234567890 → Hesap #0"}
{"id":3,"ts":"2026-03-22T00:15:01.200Z","type":"scrape_start","channelId":"1234567890","guildId":"9876543210","message":"1234567890 scrape baslatildi","detail":"cursor=1234567890 scraped=0"}
{"id":4,"ts":"2026-03-22T00:15:05.500Z","type":"rate_limit","channelId":"1234567890","guildId":"9876543210","message":"1234567890 rate-limit 5000ms","detail":"wait=5000ms delay=200ms"}
{"id":5,"ts":"2026-03-22T00:16:30.000Z","type":"scrape_end","channelId":"1234567890","guildId":"9876543210","message":"1234567890 tamamlandi (45.230 mesaj)","detail":"total=45230"}
{"id":6,"ts":"2026-03-22T00:16:30.100Z","type":"scrape_error","channelId":"5555555555","guildId":"9876543210","message":"5555555555 403","detail":"no permission"}
```

## API Endpoint

### `GET /live/scraper-log`

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `since` | number | 0 | Cursor: only return events with id > since |
| `limit` | number | 100 | Max events to return (capped at 500) |
| `type` | string | — | Filter by event type (e.g. `scrape_end`) |

### Response

```json
{
  "events": [ ... ],
  "cursor": 42,
  "stats": {
    "total": 1523,
    "bufferSize": 1523,
    "maxSize": 2000,
    "oldestId": 1,
    "newestId": 1523
  }
}
```

### Cursor-based pagination

```
1. First request:  GET /live/scraper-log?limit=100          → cursor=100
2. Next poll:      GET /live/scraper-log?since=100&limit=100 → cursor=142
3. Next poll:      GET /live/scraper-log?since=142&limit=100 → cursor=142 (no new)
```

## Rate Limit Policy

- **Ring buffer capacity:** 2000 events (env: `SCRAPE_LOG_MAX`)
- **File flush:** Every 1 second, last 500 events only
- **API:** Mtime-cached file read (no re-parse if unchanged)
- **Dashboard:** Polls every 2s, keeps max 500 events client-side
- **No SSE/WebSocket:** Avoids backpressure issues with slow clients

## Security Notes

- **Tokens are NEVER logged** — only `accountIdx` and optionally `accountName`
- **No message content** in events — only metadata (channel ID, guild ID, counts)
- **Log file location:** `senneo/scraper_events.json` (working directory)
- Consider restricting `/live/scraper-log` to localhost or authenticated users in production

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| OOM from unbounded events | Ring buffer with fixed capacity (2000) |
| Disk fill from log file | Only last 500 events written, single file overwritten |
| CPU from serialization | Flush every 1s (not per event), async writeFile |
| Slow client backpressure | HTTP polling (not SSE), client-side limit |
| Log injection | Structured events with typed fields, no user content |
| 1000 accounts × many channels | O(1) emit, bounded buffer, file size ~50-100KB max |
