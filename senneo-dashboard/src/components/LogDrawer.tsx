import React, { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../api";
import { fmtTs } from "../hooks";

interface ScrapeEvent {
  id: number;
  ts: string;
  type: string;
  accountId?: string;
  accountIdx?: number | string;
  accountName?: string;
  channelId?: string;
  guildId?: string;
  message: string;
  detail?: string;
}

interface LogResponse {
  events: ScrapeEvent[];
  cursor: number;
  stats: { total: number; bufferSize: number; maxSize: number } | null;
}

const TYPE_COLORS: Record<string, string> = {
  enqueue: "var(--blue)",
  dequeue: "var(--orange)",
  scrape_start: "var(--green)",
  scrape_end: "var(--green)",
  scrape_error: "var(--red)",
  rate_limit: "var(--yellow)",
  batch: "var(--t3)",
  account_login: "var(--purple)",
  account_error: "var(--red)",
  target_change: "var(--cyan)",
  info: "var(--t3)",
};

const TYPE_ICONS: Record<string, string> = {
  enqueue: "\u25B6",
  dequeue: "\u25A0",
  scrape_start: "\u25CF",
  scrape_end: "\u2713",
  scrape_error: "\u2717",
  rate_limit: "\u26A0",
  batch: "\u2022",
  account_login: "\u2605",
  account_error: "!",
  target_change: "\u21C4",
  info: "i",
};

const MAX_CLIENT_EVENTS = 500;
const POLL_MS = 2000;

function EventRow({ e }: { e: ScrapeEvent }) {
  const color = TYPE_COLORS[e.type] ?? "var(--t3)";
  const accountLabel = e.accountName || e.accountId || (e.accountIdx != null ? `#${e.accountIdx}` : null);
  const metaChipStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "2px 8px",
    borderRadius: 999,
    fontSize: 10,
    fontWeight: 600,
    color: "var(--cyan)",
    background: "rgba(34,211,238,.08)",
    border: "1px solid rgba(34,211,238,.18)",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
  return (
    <div style={{
      padding: "10px 12px",
      borderBottom: "1px solid var(--b0)",
      display: "flex",
      flexDirection: "column",
      gap: 8,
      background: "rgba(255,255,255,.01)",
    }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0, fontFamily: "var(--mono)" }}>
        <span style={{ color: "var(--t4)", fontSize: 10 }}>{fmtTs(e.ts)}</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 8px", borderRadius: 999, fontSize: 10, fontWeight: 700, color, background: `color-mix(in srgb, ${color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 22%, transparent)` }}>
          <span style={{ minWidth: 12, textAlign: "center" }}>{TYPE_ICONS[e.type] ?? "\u2022"}</span>
          {e.type}
        </span>
        {accountLabel ? <span style={{ ...metaChipStyle, color: "var(--blurple)", background: "rgba(88,101,242,.08)", border: "1px solid rgba(88,101,242,.18)" }}>{accountLabel}</span> : null}
        {e.channelId ? <span style={metaChipStyle}>{e.channelId}</span> : null}
        {e.guildId ? <span style={{ ...metaChipStyle, color: "var(--t4)", background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.08)" }}>{e.guildId}</span> : null}
      </div>
      <div style={{ color: "var(--t2)", fontSize: 12, lineHeight: 1.65, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {e.message}
      </div>
      {e.detail ? (
        <div style={{ color: "var(--t4)", fontSize: 10, lineHeight: 1.55, fontFamily: "var(--mono)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {e.detail}
        </div>
      ) : null}
    </div>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function LogDrawer({ open, onClose }: Props) {
  const [events, setEvents] = useState<ScrapeEvent[]>([]);
  const [stats, setStats] = useState<LogResponse["stats"]>(null);
  const [typeFilter, setTypeFilter] = useState<string>("");
  const cursorRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const fetchLog = useCallback(async () => {
    try {
      const res = (await api.live.scraperLog({
        since: cursorRef.current,
        limit: 200,
        type: typeFilter || undefined,
      })) as LogResponse;
      if (res.events.length > 0) {
        setEvents(prev => {
          const merged = [...prev, ...res.events];
          return merged.length > MAX_CLIENT_EVENTS ? merged.slice(-MAX_CLIENT_EVENTS) : merged;
        });
        cursorRef.current = res.cursor;
      }
      setStats(res.stats);
    } catch { /* ignore */ }
  }, [typeFilter]);

  // Reset on filter change
  useEffect(() => {
    setEvents([]);
    cursorRef.current = 0;
  }, [typeFilter]);

  // Poll when open
  useEffect(() => {
    if (!open) return;
    fetchLog();
    const id = setInterval(fetchLog, POLL_MS);
    return () => clearInterval(id);
  }, [open, fetchLog]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [events, autoScroll]);

  if (!open) return null;

  const types = ["", "enqueue", "dequeue", "scrape_start", "scrape_end", "scrape_error", "rate_limit", "info"];

  return (
    <div style={{
      marginBottom: 12,
      background: "var(--bg-2)",
      border: "1px solid var(--gb1)",
      borderRadius: "var(--r-xl)",
      boxShadow: "var(--sh-float)",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      animation: "slideUp .16s ease both",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "12px 16px", borderBottom: "1px solid var(--b0)",
        background: "rgba(255,255,255,.02)",
        flexShrink: 0,
        flexWrap: "wrap",
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--t1)", flex: 1 }}>
          Scraper Olay Logu
        </span>
        {stats && (
          <span style={{ fontSize: 10, color: "var(--t4)", fontFamily: "var(--mono)" }}>
            {stats.bufferSize}/{stats.maxSize} | toplam {stats.total}
          </span>
        )}
        <button className="btn btn-ghost btn-xs" onClick={() => { setEvents([]); cursorRef.current = 0; }}>
          Temizle
        </button>
        <button className="btn btn-ghost btn-xs" onClick={onClose}>
          Gizle
        </button>
      </div>

      <div style={{
        display: "flex", gap: 6, padding: "8px 12px", flexWrap: "wrap",
        borderBottom: "1px solid var(--b0)", flexShrink: 0,
        background: "rgba(255,255,255,.015)",
      }}>
        {types.map(t => (
          <button
            key={t}
            className={`btn btn-xs ${typeFilter === t ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setTypeFilter(t)}
            style={{ fontSize: 10 }}
          >
            {t || "Hepsi"}
          </button>
        ))}
        <label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--t3)", cursor: "pointer" }}>
          <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} style={{ width: 12, height: 12 }} />
          Otomatik kaydir
        </label>
      </div>

      <div style={{ height: 320, overflowY: "auto", overflowX: "hidden" }}>
        {events.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--t4)", fontSize: 12 }}>
            {typeFilter ? `"${typeFilter}" turunde olay yok` : "Olay bekleniyor..."}
          </div>
        ) : (
          events.map(e => <EventRow key={e.id} e={e} />)
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{
        padding: "6px 12px", borderTop: "1px solid var(--b0)",
        fontSize: 10, color: "var(--t4)", flexShrink: 0,
        display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8,
      }}>
        <span>{events.length} olay goruntuluyor (maks {MAX_CLIENT_EVENTS})</span>
        <span>Guncelleme: {POLL_MS / 1000}s aralikla</span>
      </div>
    </div>
  );
}
