/* eslint-disable @typescript-eslint/no-explicit-any */
import { RawMessage, sleep } from '@senneo/shared';
import { getCheckpoint, setCheckpoint } from './checkpoint';
import { initChannel, recordBatch, recordRateLimit, recordError, recordComplete } from './stats';
import { emit } from './scrape-event-log';

type DiscordClient  = any;
type DiscordMessage = any;

// Scraper timing parameters — all configurable via env.
// Defaults are the "safe" column from ARCHITECTURE_SCALING_PLAN.md §4.
// Override via env for per-instance tuning (e.g. FETCH_DELAY_MS=80 for aggressive mode).
const BATCH_SIZE             = parseInt(process.env.SCRAPE_BATCH_SIZE          ?? '100',  10);
const FETCH_DELAY_MS         = parseInt(process.env.FETCH_DELAY_MS             ?? '150',  10); // Plan safe=150ms (was 100)
const BASE_RETRY_MS          = parseInt(process.env.SCRAPE_BASE_RETRY_MS       ?? '1000', 10);
const MAX_RETRY_MS           = parseInt(process.env.SCRAPE_MAX_RETRY_MS        ?? '30000',10);
const MAX_RETRIES            = parseInt(process.env.SCRAPE_MAX_RETRIES         ?? '5',    10);
const RATE_LIMIT_COOLDOWN_MS = parseInt(process.env.RATE_LIMIT_COOLDOWN_MS     ?? '10000',10); // Plan safe=10s (was 8s)
const ADAPTIVE_STEP_UP_MS    = parseInt(process.env.ADAPTIVE_STEP_UP_MS        ?? '100',  10);
const ADAPTIVE_STEP_DOWN_MS  = parseInt(process.env.ADAPTIVE_STEP_DOWN_MS      ?? '5',    10);
const ADAPTIVE_MIN_MS        = parseInt(process.env.ADAPTIVE_MIN_MS            ?? '120',  10); // Plan safe=120ms (was 100)
const ADAPTIVE_MAX_MS        = parseInt(process.env.ADAPTIVE_MAX_MS            ?? '2000', 10);

// Time-slicing: Max batches per run before yielding to other channels (RoundRobin-style fair scheduling)
// Default 10 batches = 1000 messages per slice, then re-queue. Set to 0 to disable (continuous run).
const MAX_BATCHES_PER_RUN    = parseInt(process.env.MAX_BATCHES_PER_RUN        ?? '10',   10);

// Rate Limiter: Per-channel and per-account message throughput limits
const MAX_MSG_PER_SEC_CHANNEL = parseInt(process.env.MAX_MSG_PER_SEC_CHANNEL   ?? '60',   10); // 60 msg/s per channel
const MAX_MSG_PER_SEC_ACCOUNT = parseInt(process.env.MAX_MSG_PER_SEC_ACCOUNT   ?? '300',  10); // 300 msg/s per account (5 channels * 60)

const ABORTABLE_WAIT_ENABLED  = (() => {
  const raw = process.env.SCRAPER_ABORTABLE_WAIT_ENABLED;
  if (raw == null) return true;
  return ['true', '1', 'yes', 'on'].includes(raw.toLowerCase());
})();

// ── Token Bucket Rate Limiter ────────────────────────────────────────────────
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  
  constructor(
    private readonly maxTokens: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }
  
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const newTokens = elapsed * this.refillPerSecond;
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }
  
  async consume(count: number, signal?: AbortSignal): Promise<boolean> {
    while (true) {
      if (signal?.aborted) return false;
      
      this.refill();
      
      if (this.tokens >= count) {
        this.tokens -= count;
        return true;
      }
      
      // Calculate wait time to accumulate enough tokens
      const needed = count - this.tokens;
      const waitMs = Math.ceil((needed / this.refillPerSecond) * 1000);
      
      if (!(await waitFor(Math.min(waitMs, 1000), signal))) {
        return false;
      }
    }
  }
}

// Global rate limiters — per-channel and per-account
const _channelBuckets = new Map<string, TokenBucket>();
const _accountBuckets = new Map<string, TokenBucket>();

function getChannelBucket(channelId: string): TokenBucket {
  if (!_channelBuckets.has(channelId)) {
    // Burst capacity must be >= BATCH_SIZE to avoid infinite loop in consume()
    const burst = Math.max(MAX_MSG_PER_SEC_CHANNEL, BATCH_SIZE);
    _channelBuckets.set(channelId, new TokenBucket(burst, MAX_MSG_PER_SEC_CHANNEL));
  }
  return _channelBuckets.get(channelId)!;
}

function getAccountBucket(accountId: string): TokenBucket {
  if (!_accountBuckets.has(accountId)) {
    // Burst capacity must be >= BATCH_SIZE to avoid infinite loop in consume()
    const burst = Math.max(MAX_MSG_PER_SEC_ACCOUNT, BATCH_SIZE);
    _accountBuckets.set(accountId, new TokenBucket(burst, MAX_MSG_PER_SEC_ACCOUNT));
  }
  return _accountBuckets.get(accountId)!;
}

async function waitFor(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (!signal || !ABORTABLE_WAIT_ENABLED) {
    await sleep(ms);
    return !(signal?.aborted ?? false);
  }
  if (signal.aborted) return false;
  return new Promise(resolve => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(!signal.aborted);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function buildBadgeMask(flags: any, author?: any, member?: any): number {
  let mask = 0;
  if (flags != null) {
    if (typeof flags === 'number') mask = flags;
    else if (typeof flags.bitfield === 'number') mask = flags.bitfield;
  }
  // Custom high bits for badges not in public_flags
  // Bit 24: Nitro subscriber (heuristic: animated avatar requires Nitro)
  try { if (author?.avatar && typeof author.avatar === 'string' && author.avatar.startsWith('a_')) mask |= (1 << 24); } catch {}
  // Bit 25: Server Boost (member.premiumSince is set for boosters)
  try { if (member?.premiumSince) mask |= (1 << 25); } catch {}
  return mask;
}

function extractMediaUrls(msg: DiscordMessage): string[] {
  const urls: string[] = [];
  for (const embed of (msg.embeds ?? [])) {
    // gifv = tenor/giphy animated gif
    if (embed.type === 'gifv' && embed.video?.url)   urls.push(embed.video.url);
    if (embed.type === 'gifv' && embed.thumbnail?.url) urls.push(embed.thumbnail.url);
    // image embed
    if (embed.type === 'image' && embed.url)         urls.push(embed.url);
    if (embed.type === 'image' && embed.image?.url)  urls.push(embed.image.url);
    // rich embed with image
    if (embed.image?.url)                            urls.push(embed.image.url);
    if (embed.thumbnail?.url && embed.type !== 'gifv') urls.push(embed.thumbnail.url);
  }
  return [...new Set(urls)]; // deduplicate
}

function detectMediaType(
  attachments: string[],
  mediaUrls:   string[],
  embedTypes:  string[],
  stickerIds:  string[],
): RawMessage['mediaType'] {
  if (stickerIds.length > 0) return 'sticker';

  const allUrls = [...attachments, ...mediaUrls];
  const hasGif  = embedTypes.includes('gifv')
    || allUrls.some(u => /\.(gif)$/i.test(u) || /tenor\.com|giphy\.com/i.test(u));
  const hasImg  = allUrls.some(u => /\.(png|jpg|jpeg|webp)$/i.test(u));
  const hasVid  = allUrls.some(u => /\.(mp4|webm|mov)$/i.test(u)) || embedTypes.includes('video');

  const types = [hasGif && 'gif', hasImg && 'image', hasVid && 'video'].filter(Boolean);
  if (types.length > 1) return 'mixed';
  if (types.length === 1) return types[0] as RawMessage['mediaType'];
  return 'none';
}

function toRawMessage(msg: DiscordMessage, guildId: string): RawMessage {
  const member = msg.member;

  const attachments  = [...(msg.attachments?.values() ?? [])].map((a: any) => a.url);
  const embedTypes   = (msg.embeds ?? []).map((e: any) => e.type ?? 'unknown');
  const mediaUrls    = extractMediaUrls(msg);
  const stickerIds   = [...(msg.stickers?.values() ?? [])].map((s: any) => String(s.id));
  const stickerNames = [...(msg.stickers?.values() ?? [])].map((s: any) => String(s.name));
  const mediaType    = detectMediaType(attachments, mediaUrls, embedTypes, stickerIds);

  // For sticker-only messages, put sticker name in content so it's not empty
  let content = msg.content ?? '';
  if (!content && stickerNames.length > 0) content = `[sticker: ${stickerNames.join(', ')}]`;

  return {
    messageId:           msg.id,
    channelId:           msg.channelId,
    guildId,
    authorId:            msg.author.id,
    authorName:          msg.author.username,
    authorDiscriminator: msg.author.discriminator,
    nick:                member?.nickname ?? null,
    content,
    ts:                  msg.createdAt.toISOString(),
    attachments,
    mediaUrls,
    embedTypes,
    stickerNames,
    stickerIds,
    mediaType,
    badgeMask:           buildBadgeMask(msg.author.flags, msg.author, msg.member),
    roles:               member ? [...member.roles.cache.keys()] : [],
    editedTs:            msg.editedAt?.toISOString() ?? null,
    referencedMessageId: msg.reference?.messageId ?? null,
    tts:                 !!msg.tts,
    authorAvatar:        msg.author.avatar ?? null,
    isBot:               !!msg.author.bot,
    displayName:         msg.author.globalName ?? null,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// RAW HTTP FETCH — Bypasses discord.js REST manager for 5x faster message fetching
// Uses direct HTTP requests to Discord API v9, same as the Go scraper (sky-net-go).
// ══════════════════════════════════════════════════════════════════════════════

const DISCORD_API_BASE = 'https://discord.com/api/v9';

/**
 * Fetch messages via raw HTTP — bypasses discord.js REST manager overhead.
 * This is ~5x faster than channel.messages.fetch() because:
 * 1. No discord.js internal rate limiter queue
 * 2. No full Message object instantiation
 * 3. No Collection/Map wrapping
 * 4. Minimal JSON parsing
 */
async function rawFetchMessages(
  token: string,
  channelId: string,
  limit: number,
  beforeCursor: string | null,
  signal?: AbortSignal,
): Promise<any[]> {
  const url = `${DISCORD_API_BASE}/channels/${channelId}/messages?limit=${limit}${beforeCursor ? `&before=${beforeCursor}` : ''}`;

  const res = await fetch(url, {
    signal,
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After') ?? '5');
    const err: any = new Error(`Rate limited: retry after ${retryAfter}s`);
    err.status = 429;
    err.httpStatus = 429;
    err.retryAfter = retryAfter;
    throw err;
  }

  if (res.status === 403) {
    const err: any = new Error('Forbidden (403)');
    err.status = 403;
    err.httpStatus = 403;
    throw err;
  }

  if (res.status === 404) {
    const err: any = new Error('Not Found (404)');
    err.status = 404;
    err.httpStatus = 404;
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err: any = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    err.httpStatus = res.status;
    throw err;
  }

  return res.json() as Promise<any[]>;
}

/**
 * Convert raw Discord API message object to RawMessage.
 * Raw API format differs from discord.js Message objects:
 * - msg.timestamp instead of msg.createdAt (ISO string vs Date)
 * - msg.edited_timestamp instead of msg.editedAt
 * - msg.author.public_flags instead of msg.author.flags.bitfield
 * - msg.attachments is plain array, not Collection
 * - msg.member.roles is plain array, not Collection
 * - msg.channel_id instead of msg.channelId
 * - msg.message_reference?.message_id instead of msg.reference?.messageId
 */
function rawApiToRawMessage(msg: any, guildId: string): RawMessage {
  const member = msg.member;

  // Attachments — raw API returns plain array
  const attachments = (msg.attachments ?? []).map((a: any) => a.url as string);

  // Embeds — same structure as discord.js
  const embedTypes = (msg.embeds ?? []).map((e: any) => e.type ?? 'unknown');
  const mediaUrls  = extractMediaUrls(msg);

  // Stickers — raw API uses sticker_items or stickers
  const stickerItems = msg.sticker_items ?? msg.stickers ?? [];
  const stickerIds   = stickerItems.map((s: any) => String(s.id ?? s));
  const stickerNames = stickerItems.map((s: any) => String(s.name ?? ''));
  const mediaType    = detectMediaType(attachments, mediaUrls, embedTypes, stickerIds);

  // Content — handle sticker-only messages
  let content = msg.content ?? '';
  if (!content && stickerNames.length > 0) content = `[sticker: ${stickerNames.join(', ')}]`;

  // Badge mask — raw API uses public_flags, member.premium_since
  const publicFlags = msg.author?.public_flags;
  let badgeMask = typeof publicFlags === 'number' ? publicFlags : 0;
  try { if (msg.author?.avatar && typeof msg.author.avatar === 'string' && msg.author.avatar.startsWith('a_')) badgeMask |= (1 << 24); } catch {}
  try { if (member?.premium_since) badgeMask |= (1 << 25); } catch {}

  // Roles — raw API returns plain array of role IDs
  const roles = member?.roles ?? [];

  // Timestamp — raw API uses "timestamp" (ISO string with +00:00), not Date object
  // Normalize to Z-suffix format so downstream consumers (ClickHouse) can parse it
  const rawTs = msg.timestamp ?? new Date(Number((BigInt(msg.id) >> 22n) + 1420070400000n)).toISOString();
  const ts = rawTs.replace(/[+-]\d{2}:\d{2}$/, 'Z');

  // Edited timestamp
  const editedTs = msg.edited_timestamp ?? null;

  return {
    messageId:           msg.id,
    channelId:           msg.channel_id ?? msg.channelId,
    guildId,
    authorId:            msg.author?.id ?? '',
    authorName:          msg.author?.username ?? '',
    authorDiscriminator: msg.author?.discriminator ?? '0',
    nick:                member?.nick ?? member?.nickname ?? null,
    content,
    ts,
    attachments,
    mediaUrls,
    embedTypes,
    stickerNames,
    stickerIds,
    mediaType,
    badgeMask,
    roles,
    editedTs,
    referencedMessageId: msg.message_reference?.message_id ?? msg.reference?.message_id ?? null,
    tts:                 !!msg.tts,
    authorAvatar:        msg.author?.avatar ?? null,
    isBot:               !!msg.author?.bot,
    displayName:         msg.author?.global_name ?? null,
  };
}

function backoffMs(attempt: number): number {
  const cap = Math.min(BASE_RETRY_MS * 2 ** attempt, MAX_RETRY_MS);
  return Math.floor(Math.random() * cap);
}

export interface ScrapeChannelResult {
  kind: 'completed' | 'aborted' | 'error_retryable' | 'error_terminal' | 'noop' | 'yield';
  reason?: string;
  code?: string;
  totalScraped?: number;  // For yield: track progress
}

export interface ScrapeRateLimitEvent {
  accountId?: string;
  guildId: string;
  channelId: string;
  httpStatus: number;
  retryAfterMs: number;
  waitMs: number;
  adaptiveDelayMs: number;
  attempt: number;
}

export interface ScrapeThrottleHooks {
  beforeFetch?: (ctx: { accountId?: string; guildId: string; channelId: string; attempt: number }) => Promise<number | void> | number | void;
  onRateLimit?: (event: ScrapeRateLimitEvent) => Promise<{ waitMs?: number } | void> | { waitMs?: number } | void;
}

function classifyFetchError(err: any, fallbackCode: string, fallbackMessage: string): ScrapeChannelResult {
  if (err?.httpStatus === 403 || err?.status === 403) return { kind: 'error_terminal', code: 'discord_403', reason: 'no permission (403)' };
  if (err?.httpStatus === 404 || err?.status === 404) return { kind: 'error_terminal', code: 'discord_404', reason: 'not found (404)' };
  return { kind: 'error_retryable', code: fallbackCode, reason: fallbackMessage };
}

export async function scrapeChannel(
  client:      DiscordClient,
  guildId:     string,
  channelId:   string,
  onBatch:     (messages: RawMessage[]) => Promise<void>,
  onProgress?: (total: number) => void,
  signal?:     AbortSignal,
  accountId?:  string,
  throttleHooks?: ScrapeThrottleHooks,
  token?:      string,  // Discord bot token for raw HTTP fetching
): Promise<ScrapeChannelResult> {
  initChannel(channelId, guildId, accountId);

  let channel: DiscordMessage;
  try {
    channel = await client.channels.fetch(channelId);
    if (!channel?.isText?.()) {
      const msg = `not a text channel — skipping`;
      console.warn(`[scraper] ${channelId} ${msg}`);
      recordError(channelId, msg);
      return { kind: 'error_terminal', code: 'not_text_channel', reason: msg };
    }
  } catch (err: any) {
    const msg = `cannot fetch channel: ${err?.message}`;
    console.error(`[scraper] ${channelId} ${msg}`);
    recordError(channelId, msg);
    return classifyFetchError(err, 'channel_fetch_failed', msg);
  }

  let cp = getCheckpoint(channelId);

  if (cp?.complete) {
    console.log(`[scraper] ${channelId} already complete (${cp.totalScraped} msgs)`);
    recordComplete(channelId);
    return { kind: 'completed', code: 'checkpoint_complete', reason: 'already complete' };
  }

  if (!cp) {
    let firstBatch: Map<string, DiscordMessage>;
    try {
      firstBatch = await channel.messages.fetch({ limit: 1 });
    } catch (err: any) {
      const msg = `cannot fetch latest msg: ${err?.message}`;
      console.error(`[scraper] ${channelId} ${msg}`);
      recordError(channelId, msg);
      return classifyFetchError(err, 'latest_fetch_failed', msg);
    }
    if (firstBatch.size === 0) {
      console.log(`[scraper] ${channelId} is empty`);
      return { kind: 'noop', code: 'empty_channel', reason: 'channel is empty' };
    }
    const latest = [...firstBatch.values()][0];
    cp = {
      guildId, channelId,
      newestMessageId: latest.id,
      cursorId:        latest.id,
      totalScraped:    0,
      complete:        false,
      lastScrapedAt:   new Date().toISOString(),
    };
    setCheckpoint(cp);
  }

  let cursor           = cp.cursorId;
  let totalScraped     = cp.totalScraped;
  let consecutiveEmpty = 0;
  let adaptiveDelay    = FETCH_DELAY_MS;
  let pendingDelivery: Promise<void> | null = null;
  let exit: ScrapeChannelResult = { kind: 'noop', code: 'stopped', reason: 'scrape loop exited' };

  // Time-slicing: Track batches processed in this run for RoundRobin-style fair scheduling
  let batchesProcessedThisRun = 0;
  const maxBatchesPerRun = MAX_BATCHES_PER_RUN > 0 ? MAX_BATCHES_PER_RUN : Infinity;

  // Use raw HTTP if token is provided (5x faster than discord.js REST manager)
  const useRawHttp = !!token;
  const fetchMode = useRawHttp ? 'raw-http' : 'discord.js';

  console.log(`[scraper] ${channelId} | cursor=${cursor} | scraped=${totalScraped} | delay=${adaptiveDelay}ms | maxBatches=${maxBatchesPerRun === Infinity ? '∞' : maxBatchesPerRun} | mode=${fetchMode}`);
  emit('scrape_start', `${channelId} scrape baslatildi`, { channelId, guildId, detail: `cursor=${cursor} scraped=${totalScraped} mode=${fetchMode}` });

  // ── Raw HTTP fetch result type (plain array, not Map) ──
  type FetchResult = { rawMessages: any[] | null; result?: ScrapeChannelResult };

  const fetchBatchRaw = async (beforeCursor: string | null): Promise<FetchResult> => {
    let rawMessages: any[] | null = null;
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
      try {
        const throttleWaitMs = await throttleHooks?.beforeFetch?.({ accountId, guildId, channelId, attempt: attempt + 1 });
        if ((throttleWaitMs ?? 0) > 0) {
          if (!(await waitFor(throttleWaitMs ?? 0, signal))) {
            return { rawMessages: null, result: { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' } };
          }
        }
        if (signal?.aborted) {
          return { rawMessages: null, result: { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' } };
        }
        // ── RAW HTTP: Direct fetch to Discord API v9 ──
        rawMessages = await rawFetchMessages(token!, channelId, BATCH_SIZE, beforeCursor, signal);
        break;
      } catch (err: unknown) {
        const e = err as any;

        if (e?.httpStatus === 429 || e?.status === 429) {
          const serverWait = Math.max((e?.retryAfter ?? 5) * 1_000, 1_000);
          recordRateLimit(channelId, serverWait);
          adaptiveDelay = Math.min(adaptiveDelay + ADAPTIVE_STEP_UP_MS, ADAPTIVE_MAX_MS);
          const baseWaitMs = serverWait + RATE_LIMIT_COOLDOWN_MS;
          const scopedWait = await throttleHooks?.onRateLimit?.({
            accountId, guildId, channelId,
            httpStatus: 429, retryAfterMs: serverWait,
            waitMs: baseWaitMs, adaptiveDelayMs: adaptiveDelay,
            attempt: attempt + 1,
          });
          const waitMs = Math.max(baseWaitMs, scopedWait?.waitMs ?? 0);
          console.warn(`[scraper] event=rate_limit accountId=${accountId ?? ''} channelId=${channelId} httpStatus=429 retryAfter=${serverWait} waitMs=${waitMs} attempt=${attempt + 1}`);
          emit('rate_limit', 'event=rate_limit', { accountId, channelId, guildId, detail: `retryAfter=${serverWait}` });
          if (!(await waitFor(waitMs, signal))) {
            return { rawMessages: null, result: { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' } };
          }
          continue;
        }

        if (e?.httpStatus === 403 || e?.status === 403) {
          recordError(channelId, 'no permission (403)');
          return { rawMessages: null, result: { kind: 'error_terminal', code: 'discord_403', reason: 'no permission (403)' } };
        }
        if (e?.httpStatus === 404 || e?.status === 404) {
          recordError(channelId, 'not found (404)');
          return { rawMessages: null, result: { kind: 'error_terminal', code: 'discord_404', reason: 'not found (404)' } };
        }

        attempt++;
        const wait = backoffMs(attempt);
        recordError(channelId, `fetch error attempt ${attempt}: ${e?.message ?? e}`);
        if (attempt < MAX_RETRIES && !(await waitFor(wait, signal))) {
          return { rawMessages: null, result: { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' } };
        }
      }
    }

    if (signal?.aborted) return { rawMessages: null, result: { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' } };
    if (!rawMessages) {
      recordError(channelId, `giving up after ${MAX_RETRIES} retries`);
      return { rawMessages: null, result: { kind: 'error_retryable', code: 'max_retries', reason: `giving up after ${MAX_RETRIES} retries` } };
    }
    return { rawMessages };
  };

  // ── Fallback: discord.js fetch (when no token provided) ──
  const fetchBatchLegacy = async (beforeCursor: string | null): Promise<{ messages: Map<string, DiscordMessage> | null; result?: ScrapeChannelResult }> => {
    let messages: Map<string, DiscordMessage> | null = null;
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
      try {
        const throttleWaitMs = await throttleHooks?.beforeFetch?.({ accountId, guildId, channelId, attempt: attempt + 1 });
        if ((throttleWaitMs ?? 0) > 0) {
          if (!(await waitFor(throttleWaitMs ?? 0, signal))) return { messages: null, result: { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' } };
        }
        if (signal?.aborted) return { messages: null, result: { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' } };
        messages = await channel.messages.fetch({ limit: BATCH_SIZE, ...(beforeCursor ? { before: beforeCursor } : {}) });
        break;
      } catch (err: unknown) {
        const e = err as any;
        if (e?.httpStatus === 429 || e?.status === 429) {
          const serverWait = Math.max((e?.retryAfter ?? 5) * 1_000, 1_000);
          recordRateLimit(channelId, serverWait);
          adaptiveDelay = Math.min(adaptiveDelay + ADAPTIVE_STEP_UP_MS, ADAPTIVE_MAX_MS);
          const baseWaitMs = serverWait + RATE_LIMIT_COOLDOWN_MS;
          const scopedWait = await throttleHooks?.onRateLimit?.({ accountId, guildId, channelId, httpStatus: 429, retryAfterMs: serverWait, waitMs: baseWaitMs, adaptiveDelayMs: adaptiveDelay, attempt: attempt + 1 });
          const waitMs = Math.max(baseWaitMs, scopedWait?.waitMs ?? 0);
          console.warn(`[scraper] event=rate_limit accountId=${accountId ?? ''} channelId=${channelId} httpStatus=429 retryAfter=${serverWait} attempt=${attempt + 1}`);
          if (!(await waitFor(waitMs, signal))) return { messages: null, result: { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' } };
          continue;
        }
        if (e?.httpStatus === 403 || e?.status === 403) return { messages: null, result: { kind: 'error_terminal', code: 'discord_403', reason: 'no permission (403)' } };
        if (e?.httpStatus === 404 || e?.status === 404) return { messages: null, result: { kind: 'error_terminal', code: 'discord_404', reason: 'not found (404)' } };
        attempt++;
        const wait = backoffMs(attempt);
        recordError(channelId, `fetch error attempt ${attempt}: ${e?.message ?? e}`);
        if (attempt < MAX_RETRIES && !(await waitFor(wait, signal))) return { messages: null, result: { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' } };
      }
    }
    if (signal?.aborted) return { messages: null, result: { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' } };
    if (!messages) { recordError(channelId, `giving up after ${MAX_RETRIES} retries`); return { messages: null, result: { kind: 'error_retryable', code: 'max_retries', reason: `giving up after ${MAX_RETRIES} retries` } }; }
    return { messages };
  };

  // ── Unified fetch wrapper — dispatches to raw HTTP or discord.js ──
  let pendingRawFetch: Promise<FetchResult> | null = null;

  const doFetch = (beforeCursor: string | null) => {
    if (useRawHttp) return fetchBatchRaw(beforeCursor);
    // Legacy mode: wrap discord.js result into FetchResult shape
    return fetchBatchLegacy(beforeCursor).then(r => ({
      rawMessages: r.messages ? [...r.messages.values()] : null,
      result: r.result,
    } as FetchResult));
  };

  pendingRawFetch = doFetch(cursor);

  while (true) {
    // P2 FIX #5: Check AbortSignal at top of every iteration
    if (signal?.aborted) {
      console.log(`[scraper] ${channelId} aborted — exiting`);
      exit = { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' };
      break;
    }

    const nextFetch = pendingRawFetch ?? doFetch(cursor);
    pendingRawFetch = null;

    if (pendingDelivery) { 
      console.log(`[scraper] ${channelId} awaiting pendingDelivery...`);
      await pendingDelivery; 
      console.log(`[scraper] ${channelId} pendingDelivery resolved`);
      pendingDelivery = null; 
    }

    console.log(`[scraper] ${channelId} awaiting fetch...`);
    const { rawMessages, result } = await nextFetch;
    console.log(`[scraper] ${channelId} fetch resolved`);

    if (result) {
      console.log(`[scraper] ${channelId} exiting with result: ${result.code} - ${result.reason}`);
      exit = result;
      break;
    }

    if (!rawMessages) {
      console.log(`[scraper] ${channelId} no messages returned after retries`);
      exit = { kind: 'error_retryable', code: 'max_retries', reason: `giving up after ${MAX_RETRIES} retries` };
      break;
    }
    
    console.log(`[scraper] ${channelId} fetched ${rawMessages.length} messages`);

    if (rawMessages.length === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 2) {
        console.log(`[scraper] ${channelId} complete! Total: ${totalScraped}`);
        setCheckpoint({ ...cp, cursorId: cursor, totalScraped, complete: true, lastScrapedAt: new Date().toISOString() });
        recordComplete(channelId);
        emit('scrape_end', `${channelId} tamamlandi (${totalScraped.toLocaleString()} mesaj)`, { channelId, guildId, detail: `total=${totalScraped}` });
        exit = { kind: 'completed', code: 'complete', reason: `complete after ${totalScraped} messages` };
        break;
      }
      if (!(await waitFor(adaptiveDelay * 2, signal))) {
        exit = { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' };
        break;
      }
      pendingRawFetch = doFetch(cursor);
      continue;
    }

    // P0 FIX: Reset consecutiveEmpty only when we get actual data
    consecutiveEmpty = 0;

    // Sort by ID ascending (oldest first) — works for both raw API objects and discord.js Messages
    const sorted = rawMessages.sort((a: any, b: any) => Number(BigInt(a.id) - BigInt(b.id)));
    const raw    = useRawHttp
      ? sorted.map((m: any) => rawApiToRawMessage(m, guildId))
      : sorted.map((m: any) => toRawMessage(m, guildId));

    // ── RATE LIMITER: Wait for tokens before processing batch ──
    const channelBucket = getChannelBucket(channelId);
    const accountBucket = accountId ? getAccountBucket(accountId) : null;
    
    // Consume from channel bucket
    const rlStart = Date.now();
    if (!(await channelBucket.consume(raw.length, signal))) {
      exit = { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received during rate limit wait' };
      break;
    }
    
    // Consume from account bucket (if accountId provided)
    if (accountBucket && !(await accountBucket.consume(raw.length, signal))) {
      exit = { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received during rate limit wait' };
      break;
    }
    const rlWait = Date.now() - rlStart;
    if (rlWait > 50) console.log(`[rate-limit] ${channelId} waited ${rlWait}ms for ${raw.length} tokens (ch=${MAX_MSG_PER_SEC_CHANNEL}/s acc=${MAX_MSG_PER_SEC_ACCOUNT}/s)`);
    
    totalScraped += raw.length;
    cursor = sorted[0].id;

    setCheckpoint({ ...cp, cursorId: cursor, totalScraped, complete: false, lastScrapedAt: new Date().toISOString() });
    recordBatch(channelId, raw.length, totalScraped);
    onProgress?.(totalScraped);

    // ── PIPELINE: fire Kafka send without awaiting, fetch next batch immediately ──
    // pendingDelivery holds the previous send — we await it at the TOP of next iteration
    // This means fetch and Kafka write overlap in time = ~2x throughput
    pendingDelivery = onBatch(raw).catch((err: any) => {
      console.error(`[scraper] ${channelId} onBatch error (non-fatal): ${err?.message}`);
    });

    adaptiveDelay = Math.max(adaptiveDelay - ADAPTIVE_STEP_DOWN_MS, ADAPTIVE_MIN_MS);

    // Time-slicing: Increment batch counter
    batchesProcessedThisRun++;

    // Check if we've reached the batch limit for this run (RoundRobin-style fair scheduling)
    if (batchesProcessedThisRun >= maxBatchesPerRun && maxBatchesPerRun !== Infinity) {
      console.log(`[scraper] ${channelId} | yield after ${batchesProcessedThisRun} batches (${totalScraped.toLocaleString()} msgs) - re-queueing for fair scheduling`);
      emit('info', `${channelId} yielding`, { channelId, guildId, detail: `batches=${batchesProcessedThisRun} scraped=${totalScraped}` });
      
      // Flush any pending delivery before yielding
      await (pendingDelivery as Promise<void> | null)?.catch(() => {});
      
      // Return yield result with progress
      exit = { 
        kind: 'yield', 
        code: 'max_batches_reached', 
        reason: `Yielded after ${batchesProcessedThisRun} batches for fair scheduling`,
        totalScraped
      };
      break;
    }

    if (totalScraped % 10_000 === 0 && totalScraped > 0)
      console.log(`[scraper] ${channelId} | total=${totalScraped.toLocaleString()} | delay=${adaptiveDelay}ms | batches=${batchesProcessedThisRun}/${maxBatchesPerRun === Infinity ? '∞' : maxBatchesPerRun}`);

    if (!(await waitFor(adaptiveDelay, signal))) {
      exit = { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' };
      break;
    }
    pendingRawFetch = doFetch(cursor);
  }

  // Drain any pending delivery on exit
  await (pendingDelivery as Promise<void> | null)?.catch(() => {});
  return exit;
}