import { ChannelCheckpoint } from '@senneo/shared';
import { getDb } from './db';

const KEYSPACE = process.env.SCYLLA_KEYSPACE ?? 'senneo';

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  return ['true', '1', 'yes', 'on'].includes(raw.toLowerCase());
}

function envPositiveInt(name: string, defaultValue: number): number {
  const parsed = parseInt(process.env[name] ?? `${defaultValue}`, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

const _store: Record<string, ChannelCheckpoint> = {};
let _dirty: Set<string> = new Set();
let _timer: ReturnType<typeof setInterval> | null = null;
let _flushing = false;
// Max consecutive failures per channel before giving up
const _failCount: Record<string, number> = {};
const MAX_FAIL = 5;
const BOUNDED_FLUSH_ENABLED = envFlag('SCRAPER_BOUNDED_CHECKPOINT_FLUSH_ENABLED', true);
const FLUSH_CONCURRENCY = envPositiveInt('SCRAPER_CHECKPOINT_FLUSH_CONCURRENCY', 16);

async function runWithConcurrency(ids: string[], concurrency: number, worker: (id: string) => Promise<void>): Promise<void> {
  let index = 0;
  const width = Math.max(1, Math.min(concurrency, ids.length || 1));
  await Promise.all(Array.from({ length: width }, async () => {
    while (true) {
      const id = ids[index++];
      if (id == null) return;
      await worker(id);
    }
  }));
}

export async function loadCheckpoints(): Promise<void> {
  const db = await getDb();
  const result = await db.execute(`SELECT * FROM ${KEYSPACE}.scrape_checkpoints`);
  for (const row of result.rows) {
    _store[row['channel_id']] = {
      channelId:       row['channel_id'],
      guildId:         row['guild_id']          ?? '',
      newestMessageId: row['newest_message_id']  ?? '',
      cursorId:        row['cursor_id']          ?? null,
      totalScraped:    Number(row['total_scraped'] ?? 0),
      complete:        row['complete']            ?? false,
      lastScrapedAt:   row['last_scraped_at']?.toISOString() ?? new Date().toISOString(),
    };
  }
  console.log(`[checkpoint] ${Object.keys(_store).length} checkpoint yüklendi (ScyllaDB)`);
  if (!_timer) _timer = setInterval(() => { flush().catch(() => {}); }, 3_000);
}

export function getCheckpoint(channelId: string): ChannelCheckpoint | null {
  return _store[channelId] ?? null;
}

export function getAllCheckpoints(): Readonly<Record<string, ChannelCheckpoint>> {
  return _store;
}

export function setCheckpoint(cp: ChannelCheckpoint): void {
  _store[cp.channelId] = cp;
  _dirty.add(cp.channelId);
}

export function clearCheckpoint(channelId: string): void {
  delete _store[channelId];
  _dirty.add(channelId);
}

async function persistCheckpoint(id: string, dbClient?: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  const db = dbClient ?? await getDb();
  const cp = _store[id];
  if (!cp) {
    await db.execute(
      `DELETE FROM ${KEYSPACE}.scrape_checkpoints WHERE channel_id = ?`, [id]
    );
    return;
  }
  await db.execute(
    `INSERT INTO ${KEYSPACE}.scrape_checkpoints
     (channel_id, guild_id, newest_message_id, cursor_id, total_scraped, complete, last_scraped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [cp.channelId, cp.guildId, cp.newestMessageId,
     cp.cursorId ?? '', cp.totalScraped, cp.complete,
     new Date(cp.lastScrapedAt)]
  );
}

export async function flush(): Promise<void> {
  if (_dirty.size === 0 || _flushing) return;
  _flushing = true;

  // Snapshot dirty set — don't hold lock during async ops
  const ids = [..._dirty];
  _dirty = new Set();

  const failed: string[] = [];

  try {
    const db = await getDb();
    const concurrency = BOUNDED_FLUSH_ENABLED
      ? Math.min(FLUSH_CONCURRENCY, Math.max(ids.length, 1))
      : Math.max(ids.length, 1);
    await runWithConcurrency(ids, concurrency, async id => {
      try {
        await persistCheckpoint(id, db);
        // Clear fail count on success
        delete _failCount[id];
      } catch (err) {
        _failCount[id] = (_failCount[id] ?? 0) + 1;
        if (_failCount[id] <= MAX_FAIL) {
          // Retry later — re-add to dirty
          failed.push(id);
        } else {
          // Give up after MAX_FAIL — prevents unbounded memory leak
          console.error(`[checkpoint] Giving up on ${id} after ${MAX_FAIL} failures`);
          delete _failCount[id];
        }
      }
    });
  } catch (err) {
    // DB completely unavailable — re-queue all
    failed.push(...ids.filter(id => !failed.includes(id)));
    console.error('[checkpoint] Flush DB error:', err);
  } finally {
    // Re-add failed IDs to dirty
    failed.forEach(id => _dirty.add(id));
    _flushing = false;
  }
}

export async function flushCheckpoint(channelId: string): Promise<boolean> {
  while (_flushing) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  _flushing = true;
  try {
    const db = await getDb();
    await persistCheckpoint(channelId, db);
    _dirty.delete(channelId);
    delete _failCount[channelId];
    return true;
  } catch (err) {
    _failCount[channelId] = (_failCount[channelId] ?? 0) + 1;
    if (_failCount[channelId] <= MAX_FAIL) {
      _dirty.add(channelId);
    } else {
      console.error(`[checkpoint] Giving up on ${channelId} after ${MAX_FAIL} failures`);
      delete _failCount[channelId];
    }
    console.error(`[checkpoint] Single flush error for ${channelId}:`, err);
    return false;
  } finally {
    _flushing = false;
  }
}

// P0 FIX: Use SIGINT/SIGTERM for graceful flush, NOT 'exit'
// 'exit' is synchronous and cannot run async code reliably
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[checkpoint] ${signal} received — flushing checkpoints...`);
  if (_timer) clearInterval(_timer);
  await flush();
  console.log(`[checkpoint] Flush done (${Object.keys(_store).length} checkpoints)`);
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT').finally(() => process.exit(0)));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM').finally(() => process.exit(0)));
// 'exit' cannot do async — only clear timer
process.on('exit', () => { if (_timer) clearInterval(_timer); });