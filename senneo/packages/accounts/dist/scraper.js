"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scrapeChannel = scrapeChannel;
/* eslint-disable @typescript-eslint/no-explicit-any */
const shared_1 = require("@senneo/shared");
const checkpoint_1 = require("./checkpoint");
const stats_1 = require("./stats");
const scrape_event_log_1 = require("./scrape-event-log");
// Scraper timing parameters — all configurable via env.
// Defaults are the "safe" column from ARCHITECTURE_SCALING_PLAN.md §4.
// Override via env for per-instance tuning (e.g. FETCH_DELAY_MS=80 for aggressive mode).
const BATCH_SIZE = parseInt(process.env.SCRAPE_BATCH_SIZE ?? '100', 10);
const FETCH_DELAY_MS = parseInt(process.env.FETCH_DELAY_MS ?? '150', 10); // Plan safe=150ms (was 100)
const BASE_RETRY_MS = parseInt(process.env.SCRAPE_BASE_RETRY_MS ?? '1000', 10);
const MAX_RETRY_MS = parseInt(process.env.SCRAPE_MAX_RETRY_MS ?? '30000', 10);
const MAX_RETRIES = parseInt(process.env.SCRAPE_MAX_RETRIES ?? '5', 10);
const RATE_LIMIT_COOLDOWN_MS = parseInt(process.env.RATE_LIMIT_COOLDOWN_MS ?? '10000', 10); // Plan safe=10s (was 8s)
const ADAPTIVE_STEP_UP_MS = parseInt(process.env.ADAPTIVE_STEP_UP_MS ?? '100', 10);
const ADAPTIVE_STEP_DOWN_MS = parseInt(process.env.ADAPTIVE_STEP_DOWN_MS ?? '5', 10);
const ADAPTIVE_MIN_MS = parseInt(process.env.ADAPTIVE_MIN_MS ?? '120', 10); // Plan safe=120ms (was 100)
const ADAPTIVE_MAX_MS = parseInt(process.env.ADAPTIVE_MAX_MS ?? '2000', 10);
const ABORTABLE_WAIT_ENABLED = (() => {
    const raw = process.env.SCRAPER_ABORTABLE_WAIT_ENABLED;
    if (raw == null)
        return true;
    return ['true', '1', 'yes', 'on'].includes(raw.toLowerCase());
})();
async function waitFor(ms, signal) {
    if (!signal || !ABORTABLE_WAIT_ENABLED) {
        await (0, shared_1.sleep)(ms);
        return !(signal?.aborted ?? false);
    }
    if (signal.aborted)
        return false;
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
function buildBadgeMask(flags, author, member) {
    let mask = 0;
    if (flags != null) {
        if (typeof flags === 'number')
            mask = flags;
        else if (typeof flags.bitfield === 'number')
            mask = flags.bitfield;
    }
    // Custom high bits for badges not in public_flags
    // Bit 24: Nitro subscriber (heuristic: animated avatar requires Nitro)
    try {
        if (author?.avatar && typeof author.avatar === 'string' && author.avatar.startsWith('a_'))
            mask |= (1 << 24);
    }
    catch { }
    // Bit 25: Server Boost (member.premiumSince is set for boosters)
    try {
        if (member?.premiumSince)
            mask |= (1 << 25);
    }
    catch { }
    return mask;
}
function extractMediaUrls(msg) {
    const urls = [];
    for (const embed of (msg.embeds ?? [])) {
        // gifv = tenor/giphy animated gif
        if (embed.type === 'gifv' && embed.video?.url)
            urls.push(embed.video.url);
        if (embed.type === 'gifv' && embed.thumbnail?.url)
            urls.push(embed.thumbnail.url);
        // image embed
        if (embed.type === 'image' && embed.url)
            urls.push(embed.url);
        if (embed.type === 'image' && embed.image?.url)
            urls.push(embed.image.url);
        // rich embed with image
        if (embed.image?.url)
            urls.push(embed.image.url);
        if (embed.thumbnail?.url && embed.type !== 'gifv')
            urls.push(embed.thumbnail.url);
    }
    return [...new Set(urls)]; // deduplicate
}
function detectMediaType(attachments, mediaUrls, embedTypes, stickerIds) {
    if (stickerIds.length > 0)
        return 'sticker';
    const allUrls = [...attachments, ...mediaUrls];
    const hasGif = embedTypes.includes('gifv')
        || allUrls.some(u => /\.(gif)$/i.test(u) || /tenor\.com|giphy\.com/i.test(u));
    const hasImg = allUrls.some(u => /\.(png|jpg|jpeg|webp)$/i.test(u));
    const hasVid = allUrls.some(u => /\.(mp4|webm|mov)$/i.test(u)) || embedTypes.includes('video');
    const types = [hasGif && 'gif', hasImg && 'image', hasVid && 'video'].filter(Boolean);
    if (types.length > 1)
        return 'mixed';
    if (types.length === 1)
        return types[0];
    return 'none';
}
function toRawMessage(msg, guildId) {
    const member = msg.member;
    const attachments = [...(msg.attachments?.values() ?? [])].map((a) => a.url);
    const embedTypes = (msg.embeds ?? []).map((e) => e.type ?? 'unknown');
    const mediaUrls = extractMediaUrls(msg);
    const stickerIds = [...(msg.stickers?.values() ?? [])].map((s) => String(s.id));
    const stickerNames = [...(msg.stickers?.values() ?? [])].map((s) => String(s.name));
    const mediaType = detectMediaType(attachments, mediaUrls, embedTypes, stickerIds);
    // For sticker-only messages, put sticker name in content so it's not empty
    let content = msg.content ?? '';
    if (!content && stickerNames.length > 0)
        content = `[sticker: ${stickerNames.join(', ')}]`;
    return {
        messageId: msg.id,
        channelId: msg.channelId,
        guildId,
        authorId: msg.author.id,
        authorName: msg.author.username,
        authorDiscriminator: msg.author.discriminator,
        nick: member?.nickname ?? null,
        content,
        ts: msg.createdAt.toISOString(),
        attachments,
        mediaUrls,
        embedTypes,
        stickerNames,
        stickerIds,
        mediaType,
        badgeMask: buildBadgeMask(msg.author.flags, msg.author, msg.member),
        roles: member ? [...member.roles.cache.keys()] : [],
        editedTs: msg.editedAt?.toISOString() ?? null,
        referencedMessageId: msg.reference?.messageId ?? null,
        tts: !!msg.tts,
        authorAvatar: msg.author.avatar ?? null,
        isBot: !!msg.author.bot,
        displayName: msg.author.globalName ?? null,
    };
}
function backoffMs(attempt) {
    const cap = Math.min(BASE_RETRY_MS * 2 ** attempt, MAX_RETRY_MS);
    return Math.floor(Math.random() * cap);
}
function classifyFetchError(err, fallbackCode, fallbackMessage) {
    if (err?.httpStatus === 403 || err?.status === 403)
        return { kind: 'error_terminal', code: 'discord_403', reason: 'no permission (403)' };
    if (err?.httpStatus === 404 || err?.status === 404)
        return { kind: 'error_terminal', code: 'discord_404', reason: 'not found (404)' };
    return { kind: 'error_retryable', code: fallbackCode, reason: fallbackMessage };
}
async function scrapeChannel(client, guildId, channelId, onBatch, onProgress, signal, accountId, throttleHooks) {
    (0, stats_1.initChannel)(channelId, guildId, accountId);
    let channel;
    try {
        channel = await client.channels.fetch(channelId);
        if (!channel?.isText?.()) {
            const msg = `not a text channel — skipping`;
            console.warn(`[scraper] ${channelId} ${msg}`);
            (0, stats_1.recordError)(channelId, msg);
            return { kind: 'error_terminal', code: 'not_text_channel', reason: msg };
        }
    }
    catch (err) {
        const msg = `cannot fetch channel: ${err?.message}`;
        console.error(`[scraper] ${channelId} ${msg}`);
        (0, stats_1.recordError)(channelId, msg);
        return classifyFetchError(err, 'channel_fetch_failed', msg);
    }
    let cp = (0, checkpoint_1.getCheckpoint)(channelId);
    if (cp?.complete) {
        console.log(`[scraper] ${channelId} already complete (${cp.totalScraped} msgs)`);
        (0, stats_1.recordComplete)(channelId);
        return { kind: 'completed', code: 'checkpoint_complete', reason: 'already complete' };
    }
    if (!cp) {
        let firstBatch;
        try {
            firstBatch = await channel.messages.fetch({ limit: 1 });
        }
        catch (err) {
            const msg = `cannot fetch latest msg: ${err?.message}`;
            console.error(`[scraper] ${channelId} ${msg}`);
            (0, stats_1.recordError)(channelId, msg);
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
            cursorId: latest.id,
            totalScraped: 0,
            complete: false,
            lastScrapedAt: new Date().toISOString(),
        };
        (0, checkpoint_1.setCheckpoint)(cp);
    }
    let cursor = cp.cursorId;
    let totalScraped = cp.totalScraped;
    let consecutiveEmpty = 0;
    let adaptiveDelay = FETCH_DELAY_MS;
    let pendingDelivery = null;
    let pendingFetch = null;
    let exit = { kind: 'noop', code: 'stopped', reason: 'scrape loop exited' };
    console.log(`[scraper] ${channelId} | cursor=${cursor} | scraped=${totalScraped} | delay=${adaptiveDelay}ms`);
    (0, scrape_event_log_1.emit)('scrape_start', `${channelId} scrape baslatildi`, { channelId, guildId, detail: `cursor=${cursor} scraped=${totalScraped}` });
    const fetchBatch = async (beforeCursor) => {
        let messages = null;
        let attempt = 0;
        while (attempt < MAX_RETRIES) {
            try {
                const throttleWaitMs = await throttleHooks?.beforeFetch?.({ accountId, guildId, channelId, attempt: attempt + 1 });
                if ((throttleWaitMs ?? 0) > 0) {
                    if (!(await waitFor(throttleWaitMs ?? 0, signal))) {
                        return { messages: null, result: { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' } };
                    }
                }
                if (signal?.aborted) {
                    return { messages: null, result: { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' } };
                }
                messages = await channel.messages.fetch({
                    limit: BATCH_SIZE,
                    ...(beforeCursor ? { before: beforeCursor } : {}),
                });
                break;
            }
            catch (err) {
                const e = err;
                if (e?.httpStatus === 429 || e?.status === 429) {
                    const serverWait = Math.max((e?.retryAfter ?? 5) * 1_000, 1_000);
                    (0, stats_1.recordRateLimit)(channelId, serverWait);
                    adaptiveDelay = Math.min(adaptiveDelay + ADAPTIVE_STEP_UP_MS, ADAPTIVE_MAX_MS);
                    const baseWaitMs = serverWait + RATE_LIMIT_COOLDOWN_MS;
                    const scopedWait = await throttleHooks?.onRateLimit?.({
                        accountId,
                        guildId,
                        channelId,
                        httpStatus: 429,
                        retryAfterMs: serverWait,
                        waitMs: baseWaitMs,
                        adaptiveDelayMs: adaptiveDelay,
                        attempt: attempt + 1,
                    });
                    const waitMs = Math.max(baseWaitMs, scopedWait?.waitMs ?? 0);
                    const detail = `event=rate_limit accountId=${accountId ?? ''} channelId=${channelId} guildId=${guildId} httpStatus=429 retryAfter=${serverWait} waitMs=${waitMs} adaptiveDelay=${adaptiveDelay} attempt=${attempt + 1}`;
                    console.warn(`[scraper] ${detail}`);
                    (0, scrape_event_log_1.emit)('rate_limit', 'event=rate_limit', { accountId, channelId, guildId, detail });
                    if (!(await waitFor(waitMs, signal))) {
                        return { messages: null, result: { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' } };
                    }
                    continue;
                }
                if (e?.httpStatus === 403 || e?.status === 403) {
                    (0, stats_1.recordError)(channelId, 'no permission (403)');
                    (0, scrape_event_log_1.emit)('scrape_error', `${channelId} 403`, { channelId, guildId, detail: 'no permission' });
                    return { messages: null, result: { kind: 'error_terminal', code: 'discord_403', reason: 'no permission (403)' } };
                }
                if (e?.httpStatus === 404 || e?.status === 404) {
                    (0, stats_1.recordError)(channelId, 'not found (404)');
                    (0, scrape_event_log_1.emit)('scrape_error', `${channelId} 404`, { channelId, guildId, detail: 'not found' });
                    return { messages: null, result: { kind: 'error_terminal', code: 'discord_404', reason: 'not found (404)' } };
                }
                attempt++;
                const wait = backoffMs(attempt);
                (0, stats_1.recordError)(channelId, `fetch error attempt ${attempt}: ${e?.message ?? e}`);
                if (attempt < MAX_RETRIES && !(await waitFor(wait, signal))) {
                    return { messages: null, result: { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' } };
                }
            }
        }
        if (signal?.aborted) {
            return { messages: null, result: { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' } };
        }
        if (!messages) {
            (0, stats_1.recordError)(channelId, `giving up after ${MAX_RETRIES} retries`);
            return { messages: null, result: { kind: 'error_retryable', code: 'max_retries', reason: `giving up after ${MAX_RETRIES} retries` } };
        }
        return { messages };
    };
    pendingFetch = fetchBatch(cursor);
    while (true) {
        // P2 FIX #5: Check AbortSignal at top of every iteration
        if (signal?.aborted) {
            console.log(`[scraper] ${channelId} aborted — exiting`);
            exit = { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' };
            break;
        }
        const nextFetch = pendingFetch ?? fetchBatch(cursor);
        pendingFetch = null;
        if (pendingDelivery) {
            await pendingDelivery;
            pendingDelivery = null;
        }
        const { messages, result } = await nextFetch;
        if (result) {
            exit = result;
            break;
        }
        if (!messages) {
            exit = { kind: 'error_retryable', code: 'max_retries', reason: `giving up after ${MAX_RETRIES} retries` };
            break;
        }
        if (messages.size === 0) {
            consecutiveEmpty++;
            if (consecutiveEmpty >= 2) {
                console.log(`[scraper] ${channelId} complete! Total: ${totalScraped}`);
                (0, checkpoint_1.setCheckpoint)({ ...cp, cursorId: cursor, totalScraped, complete: true, lastScrapedAt: new Date().toISOString() });
                (0, stats_1.recordComplete)(channelId);
                (0, scrape_event_log_1.emit)('scrape_end', `${channelId} tamamlandi (${totalScraped.toLocaleString()} mesaj)`, { channelId, guildId, detail: `total=${totalScraped}` });
                exit = { kind: 'completed', code: 'complete', reason: `complete after ${totalScraped} messages` };
                break;
            }
            if (!(await waitFor(adaptiveDelay * 2, signal))) {
                exit = { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' };
                break;
            }
            pendingFetch = fetchBatch(cursor);
            continue;
        }
        // P0 FIX: Reset consecutiveEmpty only when we get actual data
        consecutiveEmpty = 0;
        const sorted = [...messages.values()].sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)));
        const raw = sorted.map((m) => toRawMessage(m, guildId));
        totalScraped += raw.length;
        cursor = sorted[0].id;
        (0, checkpoint_1.setCheckpoint)({ ...cp, cursorId: cursor, totalScraped, complete: false, lastScrapedAt: new Date().toISOString() });
        (0, stats_1.recordBatch)(channelId, raw.length, totalScraped);
        onProgress?.(totalScraped);
        // ── PIPELINE: fire Kafka send without awaiting, fetch next batch immediately ──
        // pendingDelivery holds the previous send — we await it at the TOP of next iteration
        // This means fetch and Kafka write overlap in time = ~2x throughput
        pendingDelivery = onBatch(raw).catch((err) => {
            console.error(`[scraper] ${channelId} onBatch error (non-fatal): ${err?.message}`);
        });
        adaptiveDelay = Math.max(adaptiveDelay - ADAPTIVE_STEP_DOWN_MS, ADAPTIVE_MIN_MS);
        if (totalScraped % 10_000 === 0 && totalScraped > 0)
            console.log(`[scraper] ${channelId} | total=${totalScraped.toLocaleString()} | delay=${adaptiveDelay}ms`);
        if (!(await waitFor(adaptiveDelay, signal))) {
            exit = { kind: 'aborted', code: 'abort_signal', reason: 'abort signal received' };
            break;
        }
        pendingFetch = fetchBatch(cursor);
    }
    // Drain any pending delivery on exit
    await pendingDelivery?.catch(() => { });
    return exit;
}
//# sourceMappingURL=scraper.js.map