/**
 * Bounded ring-buffer event log for scraper events.
 * - Fixed capacity (default 2000) — no OOM risk at 1000 accounts × many channels.
 * - Async file flush every 1s to shared JSON file for API to read.
 * - No sync I/O on hot path — emit() is O(1) memory write only.
 */
import fs from 'fs';
import path from 'path';

export type ScrapeEventType =
  | 'enqueue'       // channel added to account queue
  | 'dequeue'       // channel removed from queue
  | 'scrape_start'  // scrapeChannel() begins
  | 'scrape_end'    // scrapeChannel() completed (complete=true)
  | 'scrape_error'  // non-fatal error during scrape
  | 'rate_limit'    // Discord rate limit hit
  | 'batch'         // batch sent to Kafka (only logged every N-th)
  | 'account_login' // account logged in
  | 'account_error' // account login failed
  | 'target_change' // target list changed (added/removed count)
  | 'info';         // generic info

export interface ScrapeEvent {
  id: number;
  ts: string;           // ISO 8601
  type: ScrapeEventType;
  accountId?: string;
  accountIdx?: number | string;
  accountName?: string;
  channelId?: string;
  guildId?: string;
  message: string;       // human-readable one-liner
  detail?: string;       // optional extra (error message, count, etc.)
}

const MAX_EVENTS = parseInt(process.env.SCRAPE_LOG_MAX ?? '2000', 10);
const FLUSH_INTERVAL_MS = 1_000;
const LOG_FILE = path.resolve(process.cwd(), 'scraper_events.json');

let _seq = 0;
const _buffer: ScrapeEvent[] = [];
let _flushTimer: ReturnType<typeof setInterval> | null = null;
let _flushing = false;

/** O(1) — append event to ring buffer. No I/O. */
export function emit(
  type: ScrapeEventType,
  message: string,
  opts?: { accountId?: string; accountIdx?: number | string; accountName?: string; channelId?: string; guildId?: string; detail?: string },
): void {
  const event: ScrapeEvent = {
    id: ++_seq,
    ts: new Date().toISOString(),
    type,
    message,
    ...opts,
  };
  _buffer.push(event);
  // Ring buffer: drop oldest when over capacity
  if (_buffer.length > MAX_EVENTS) {
    _buffer.splice(0, _buffer.length - MAX_EVENTS);
  }
}

/** Get events with cursor-based pagination. */
export function getEvents(opts?: { since?: number; limit?: number }): { events: ScrapeEvent[]; cursor: number } {
  const since = opts?.since ?? 0;
  const limit = Math.min(opts?.limit ?? 100, 500);
  const filtered = since > 0 ? _buffer.filter(e => e.id > since) : _buffer;
  const page = filtered.slice(-limit); // newest N
  const cursor = page.length > 0 ? page[page.length - 1].id : since;
  return { events: page, cursor };
}

/** Get total event count and buffer stats. */
export function getStats(): { total: number; bufferSize: number; maxSize: number; oldestId: number; newestId: number } {
  return {
    total: _seq,
    bufferSize: _buffer.length,
    maxSize: MAX_EVENTS,
    oldestId: _buffer[0]?.id ?? 0,
    newestId: _buffer[_buffer.length - 1]?.id ?? 0,
  };
}

/** Async flush to disk — called by timer, never blocks hot path. */
async function flushToDisk(): Promise<void> {
  if (_flushing || _buffer.length === 0) return;
  _flushing = true;
  try {
    const snapshot = { events: _buffer.slice(-500), stats: getStats(), flushedAt: new Date().toISOString() };
    await fs.promises.writeFile(LOG_FILE, JSON.stringify(snapshot), 'utf-8');
  } catch { /* best-effort */ }
  finally { _flushing = false; }
}

/** Start the background flush timer. */
export function startEventLog(): void {
  if (_flushTimer) return;
  _flushTimer = setInterval(flushToDisk, FLUSH_INTERVAL_MS);
  emit('info', 'Event log started', { detail: `capacity=${MAX_EVENTS}` });
}

/** Stop and final flush. */
export async function stopEventLog(): Promise<void> {
  if (_flushTimer) clearInterval(_flushTimer);
  _flushTimer = null;
  await flushToDisk();
}
