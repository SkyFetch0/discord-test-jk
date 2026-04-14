"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.emit = emit;
exports.getEvents = getEvents;
exports.getStats = getStats;
exports.startEventLog = startEventLog;
exports.stopEventLog = stopEventLog;
/**
 * Bounded ring-buffer event log for scraper events.
 * - Fixed capacity (default 2000) — no OOM risk at 1000 accounts × many channels.
 * - Async file flush every 1s to shared JSON file for API to read.
 * - No sync I/O on hot path — emit() is O(1) memory write only.
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const MAX_EVENTS = parseInt(process.env.SCRAPE_LOG_MAX ?? '2000', 10);
const FLUSH_INTERVAL_MS = 1_000;
const LOG_FILE = path_1.default.resolve(process.cwd(), 'scraper_events.json');
let _seq = 0;
const _buffer = [];
let _flushTimer = null;
let _flushing = false;
/** O(1) — append event to ring buffer. No I/O. */
function emit(type, message, opts) {
    const event = {
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
function getEvents(opts) {
    const since = opts?.since ?? 0;
    const limit = Math.min(opts?.limit ?? 100, 500);
    const filtered = since > 0 ? _buffer.filter(e => e.id > since) : _buffer;
    const page = filtered.slice(-limit); // newest N
    const cursor = page.length > 0 ? page[page.length - 1].id : since;
    return { events: page, cursor };
}
/** Get total event count and buffer stats. */
function getStats() {
    return {
        total: _seq,
        bufferSize: _buffer.length,
        maxSize: MAX_EVENTS,
        oldestId: _buffer[0]?.id ?? 0,
        newestId: _buffer[_buffer.length - 1]?.id ?? 0,
    };
}
/** Async flush to disk — called by timer, never blocks hot path. */
async function flushToDisk() {
    if (_flushing || _buffer.length === 0)
        return;
    _flushing = true;
    try {
        const snapshot = { events: _buffer.slice(-500), stats: getStats(), flushedAt: new Date().toISOString() };
        await fs_1.default.promises.writeFile(LOG_FILE, JSON.stringify(snapshot), 'utf-8');
    }
    catch { /* best-effort */ }
    finally {
        _flushing = false;
    }
}
/** Start the background flush timer. */
function startEventLog() {
    if (_flushTimer)
        return;
    _flushTimer = setInterval(flushToDisk, FLUSH_INTERVAL_MS);
    emit('info', 'Event log started', { detail: `capacity=${MAX_EVENTS}` });
}
/** Stop and final flush. */
async function stopEventLog() {
    if (_flushTimer)
        clearInterval(_flushTimer);
    _flushTimer = null;
    await flushToDisk();
}
//# sourceMappingURL=scrape-event-log.js.map