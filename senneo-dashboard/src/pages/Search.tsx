import React, { useState, useMemo, useCallback, useRef } from "react";
import { api, exportCSV } from "../api";
import { Spinner } from "../components";
import { Icon } from "../icons";
import { MessageRow } from "../components/MessageRow";
import { ThreadDrawer } from "../components/ThreadDrawer";
import type { Message, SearchMatchMode, SearchSort } from "../types";

/* ── Saved filters (localStorage) ── */
interface SavedFilter { id: string; label: string; q: string; guildId?: string; channelId?: string; authorId?: string; from?: string; to?: string; match?: SearchMatchMode }
const LS_KEY = "senneo_saved_filters";
function loadSaved(): SavedFilter[] { try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]"); } catch { return []; } }
function saveSaved(f: SavedFilter[]) { localStorage.setItem(LS_KEY, JSON.stringify(f)); }

export function Search() {
  const [q, setQ]             = useState("");
  const [limit, setLimit]     = useState(50);
  const [results, setResults] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [sortBy, setSortBy]   = useState<SearchSort>("newest");
  const [matchMode, setMatchMode] = useState<SearchMatchMode>("substring");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // F1: Advanced filters
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [guildId, setGuildId]     = useState("");
  const [channelId, setChannelId] = useState("");
  const [authorId, setAuthorId]   = useState("");
  const [dateFrom, setDateFrom]   = useState("");
  const [dateTo, setDateTo]       = useState("");

  // F1: Saved filters
  const [saved, setSaved] = useState<SavedFilter[]>(loadSaved);

  // F7: Thread drawer
  const [threadMsgId, setThreadMsgId] = useState<string | null>(null);

  const hasAdvanced = !!(guildId || channelId || authorId || dateFrom || dateTo);

  const doSearch = useCallback(async () => {
    const trimmed = q.trim();
    if (!trimmed && !hasAdvanced) return;
    setLoading(true);
    setSearched(true);
    try {
      const r = (await api.messages.search({
        q: trimmed || undefined as any,
        limit,
        sort: sortBy,
        match: matchMode,
        guildId: guildId || undefined,
        channelId: channelId || undefined,
        authorId: authorId || undefined,
        from: dateFrom || undefined,
        to: dateTo || undefined,
      })) as { messages: Message[]; count: number };
      setResults(r.messages ?? []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [q, limit, sortBy, matchMode, guildId, channelId, authorId, dateFrom, dateTo, hasAdvanced]);

  const clearFilters = () => { setGuildId(""); setChannelId(""); setAuthorId(""); setDateFrom(""); setDateTo(""); };

  const saveCurrentFilter = () => {
    const label = prompt("Filtre adı:");
    if (!label) return;
    const f: SavedFilter = { id: Date.now().toString(36), label, q, guildId, channelId, authorId, from: dateFrom, to: dateTo, match: matchMode };
    const next = [...saved, f];
    setSaved(next);
    saveSaved(next);
  };

  const applySaved = (f: SavedFilter) => {
    setQ(f.q); setGuildId(f.guildId ?? ""); setChannelId(f.channelId ?? ""); setAuthorId(f.authorId ?? "");
    setDateFrom(f.from ?? ""); setDateTo(f.to ?? ""); setMatchMode(f.match ?? "substring");
    setFiltersOpen(true);
  };

  const removeSaved = (id: string) => {
    const next = saved.filter(s => s.id !== id);
    setSaved(next);
    saveSaved(next);
  };

  const uniqueChannels = useMemo(() => [...new Set(results.map(r => r.channel_id))], [results]);
  const uniqueAuthors  = useMemo(() => [...new Set(results.map(r => r.author_id))], [results]);

  return (
    <div className="page-enter">
      {/* ── Search bar ── */}
      <div style={{ marginBottom: 16, animation: "slideUp .22s cubic-bezier(0.16,1,0.3,1) both" }}>
        <div className={`search-bar-v2${focused ? " focused" : ""}`}>
          <Icon name="search" size={18} style={{ opacity: 0.35, flexShrink: 0 }} />
          <input
            ref={inputRef}
            placeholder={"Mesaj içeriğinde ara…"}
            aria-label="Mesaj ara"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === "Enter" && doSearch()}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            autoFocus
          />
          <select
            className="input"
            value={limit}
            onChange={e => setLimit(Number(e.target.value))}
            style={{ width: 100, background: "var(--bg-input)", flexShrink: 0, fontSize: 13 }}
          >
            <option value={20}>20 sonuç</option>
            <option value={50}>50 sonuç</option>
            <option value={100}>100 sonuç</option>
            <option value={200}>200 sonuç</option>
          </select>
          <button
            className="btn btn-primary"
            onClick={doSearch}
            disabled={loading || (!q.trim() && !hasAdvanced)}
            style={{ borderRadius: "var(--r-lg)", padding: "9px 20px", flexShrink: 0 }}
          >
            {loading ? <Spinner /> : "Ara"}
          </button>
        </div>

        {q && !searched && (
          <div style={{ fontSize: 11, color: "var(--t4)", marginTop: 6, textAlign: "right" }}>
            Enter ile ara
          </div>
        )}
      </div>

      {/* ── Filter controls row ── */}
      <div className="search-filters-v2">
        <label
          className={`search-toggle${matchMode === "whole" ? " active" : ""}`}
          title={"Açık: sadece tam kelime eşleşir (selam ≠ selamm). Kapalı: içinde geçen her eşleşme."}
          aria-label="Tam kelime eşleşmesi"
        >
          <span className="toggle-track" role="switch" aria-checked={matchMode === "whole"}>
            <span className="toggle-thumb" />
          </span>
          <input
            type="checkbox"
            checked={matchMode === "whole"}
            onChange={e => setMatchMode(e.target.checked ? "whole" : "substring")}
            style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
          />
          Tam kelime
        </label>

        <div className="segmented-control">
          {(["newest", "oldest"] as const).map(s => (
            <button key={s} className={`segmented-btn${sortBy === s ? " active" : ""}`} onClick={() => setSortBy(s)}>
              {s === "newest" ? "↓ Yeni" : "↑ Eski"}
            </button>
          ))}
        </div>

        {/* F1: Advanced filter toggle */}
        <button
          className={`btn btn-sm ${filtersOpen ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setFiltersOpen(v => !v)}
          style={{ gap: 4 }}
        >
          <Icon name="filter" size={13} />
          Filtreler
          {hasAdvanced && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--orange)", flexShrink: 0 }} />}
        </button>

        {searched && results.length > 0 && (
          <>
            <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--t3)", fontWeight: 600 }}>
              {results.length} sonuç
            </span>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => exportCSV(results as unknown as Record<string, unknown>[], `search-${q}`)}
            >
              CSV
            </button>
          </>
        )}
      </div>

      {/* ── F1: Advanced filter panel ── */}
      {filtersOpen && (
        <div className="panel" style={{ marginBottom: 16, animation: "slideUp .15s ease both" }}>
          <div className="panel-head">
            <span className="panel-title">Gelişmiş Filtreler</span>
            <div style={{ display: "flex", gap: 6 }}>
              {hasAdvanced && (
                <button className="btn btn-ghost btn-xs" onClick={clearFilters}>Temizle</button>
              )}
              <button className="btn btn-secondary btn-xs" onClick={saveCurrentFilter} title="Mevcut filtreleri kaydet">
                Kaydet
              </button>
            </div>
          </div>
          <div style={{ padding: "12px 16px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <div>
              <label style={{ fontSize: 10, fontWeight: 700, color: "var(--t4)", textTransform: "uppercase", letterSpacing: ".6px", display: "block", marginBottom: 4 }}>
                Başlangıç tarihi
              </label>
              <input
                type="datetime-local"
                className="input input-sm"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
              />
            </div>
            <div>
              <label style={{ fontSize: 10, fontWeight: 700, color: "var(--t4)", textTransform: "uppercase", letterSpacing: ".6px", display: "block", marginBottom: 4 }}>
                Bitiş tarihi
              </label>
              <input
                type="datetime-local"
                className="input input-sm"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
              />
            </div>
            <div>
              <label style={{ fontSize: 10, fontWeight: 700, color: "var(--t4)", textTransform: "uppercase", letterSpacing: ".6px", display: "block", marginBottom: 4 }}>
                Yazar ID
              </label>
              <input
                className="input input-sm"
                placeholder="Snowflake ID"
                value={authorId}
                onChange={e => setAuthorId(e.target.value)}
              />
            </div>
            <div>
              <label style={{ fontSize: 10, fontWeight: 700, color: "var(--t4)", textTransform: "uppercase", letterSpacing: ".6px", display: "block", marginBottom: 4 }}>
                Guild ID
              </label>
              <input
                className="input input-sm"
                placeholder="Snowflake ID"
                value={guildId}
                onChange={e => setGuildId(e.target.value)}
              />
            </div>
            <div>
              <label style={{ fontSize: 10, fontWeight: 700, color: "var(--t4)", textTransform: "uppercase", letterSpacing: ".6px", display: "block", marginBottom: 4 }}>
                Kanal ID
              </label>
              <input
                className="input input-sm"
                placeholder="Snowflake ID"
                value={channelId}
                onChange={e => setChannelId(e.target.value)}
              />
            </div>
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <span style={{ fontSize: 10, color: "var(--t4)", lineHeight: 1.4 }}>
                Tarih: Europe/Istanbul (TRT)
              </span>
            </div>
          </div>

          {/* Saved filters */}
          {saved.length > 0 && (
            <div style={{ padding: "8px 16px", borderTop: "1px solid var(--b0)", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--t4)", textTransform: "uppercase", letterSpacing: ".6px" }}>Kayıtlı:</span>
              {saved.map(f => (
                <span key={f.id} className="chip" style={{ cursor: "pointer", gap: 4 }} onClick={() => applySaved(f)}>
                  {f.label}
                  <span
                    style={{ color: "var(--t4)", cursor: "pointer", marginLeft: 2, fontSize: 10 }}
                    onClick={e => { e.stopPropagation(); removeSaved(f.id); }}
                    title="Sil"
                  >×</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Empty state ── */}
      {!searched && (
        <div className="panel" style={{ animation: "slideUp .25s ease .08s both" }}>
          <div className="search-empty-state">
            <svg viewBox="0 0 48 48" fill="none" style={{ width: 56, height: 56, opacity: 0.18, margin: "0 auto 16px" }}>
              <circle cx="22" cy="22" r="14" stroke="currentColor" strokeWidth="2.5"/>
              <path d="M32 32l10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
            </svg>
            <div className="search-empty-title">Mesajlarda arama yap</div>
            <div className="search-empty-sub">
              Kelime veya ifade girerek mesajlar içinde anında arama yapın.
              <br />
              <strong>Tam kelime</strong> açıkken sadece bağımsız kelimeler eşleşir.
              <br />
              <strong>Filtreler</strong> ile tarih aralığı, guild, kanal veya yazar bazlı daraltma yapabilirsiniz.
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 20, flexWrap: "wrap", justifyContent: "center" }}>
              {["lounge", "genel", "bot", "merhaba", "satılık"].map(s => (
                <button
                  key={s}
                  className="filter-chip"
                  onClick={() => { setQ(s); setTimeout(() => inputRef.current?.focus(), 0); }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Loading ── */}
      {loading && (
        <div className="panel">
          <div className="empty" style={{ height: 200 }}>
            <div style={{ textAlign: "center" }}>
              <Spinner />
              <div style={{ marginTop: 12, color: "var(--t4)", fontSize: 13 }}>Aranıyor…</div>
            </div>
          </div>
        </div>
      )}

      {/* ── No results ── */}
      {searched && !loading && results.length === 0 && (
        <div className="panel">
          <div className="search-empty-state">
            <div style={{ fontSize: 40, opacity: 0.15, marginBottom: 12 }}>∅</div>
            <div className="search-empty-title">Sonuç bulunamadı</div>
            <div className="search-empty-sub">
              &ldquo;{q}&rdquo; için eşleşen mesaj yok
              {matchMode === "whole" && (
                <span style={{ display: "block", marginTop: 8, color: "var(--orange)", fontSize: 12 }}>
                  Tam kelime modu açık — kapatarak daha geniş sonuç alabilirsiniz.
                </span>
              )}
              {hasAdvanced && (
                <span style={{ display: "block", marginTop: 6, fontSize: 12 }}>
                  Gelişmiş filtreler aktif — <button className="btn btn-ghost btn-xs" onClick={clearFilters} style={{ display: "inline" }}>temizle</button>
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Results ── */}
      {searched && !loading && results.length > 0 && (
        <div className="panel search-result-v2" style={{ animation: "slideUp .2s cubic-bezier(0.16,1,0.3,1) both" }}>
          <div className="search-stats-bar">
            <span className="chip">{uniqueChannels.length} kanal</span>
            <span className="chip">{uniqueAuthors.length} kullanıcı</span>
            <span className="chip chip-blue">&ldquo;{q}&rdquo;</span>
            {matchMode === "whole" && <span className="chip chip-green">tam kelime</span>}
            {hasAdvanced && <span className="chip chip-warn">filtreli</span>}
          </div>

          <div style={{ maxHeight: "calc(100vh - 380px)", overflowY: "auto" }}>
            {results.map((m, i) => (
              <MessageRow
                key={m.message_id}
                msg={m}
                keyword={q}
                showMedia={false}
                animate
                animDelay={Math.min(i * 18, 300)}
                onViewThread={setThreadMsgId}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Footer ── */}
      <div style={{ fontSize: 11, color: "var(--t4)", marginTop: 12 }}>
        {"Tarih: Europe/Istanbul (TRT) · "}
        {matchMode === "whole"
          ? "Tam kelime: ClickHouse match() + \\b regex (re2)"
          : "Alt dize: positionCaseInsensitive (hızlı)"}
      </div>

      {/* F7: Thread drawer */}
      <ThreadDrawer
        messageId={threadMsgId ?? ""}
        open={!!threadMsgId}
        onClose={() => setThreadMsgId(null)}
      />
    </div>
  );
}