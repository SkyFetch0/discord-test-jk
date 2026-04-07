import React, { useState, useEffect, useRef } from "react";
import type { Page } from "./types";

interface CmdItem { id: Page; label: string; shortcut: string }

const ITEMS: CmdItem[] = [
  { id: "overview",   label: "Overview",            shortcut: "1" },
  { id: "scraper",    label: "Scraper",             shortcut: "2" },
  { id: "accounts",   label: "Hesaplar & Kanallar", shortcut: "3" },
  { id: "livefeed",   label: "Canli Mesajlar",      shortcut: "4" },
  { id: "analytics",  label: "Analitik",            shortcut: "5" },
  { id: "users",      label: "Kullanici Profilleri", shortcut: "6" },
  { id: "search",     label: "Mesaj Ara",           shortcut: "K" },
  { id: "clickhouse", label: "ClickHouse",          shortcut: "7" },
  { id: "scylla",     label: "ScyllaDB",            shortcut: "8" },
  { id: "errors",     label: "Hata Kayitlari",      shortcut: "9" },
  { id: "guilds",     label: "Sunucu Yonetimi",     shortcut: "0" },
  { id: "user-mgmt",  label: "Kullanici Yonetimi",  shortcut: "" },
];

export function CommandPalette({ onClose, onPage }: { onClose: () => void; onPage: (p: Page) => void }) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = query
    ? ITEMS.filter(i => i.label.toLowerCase().includes(query.toLowerCase()))
    : ITEMS;

  function go(id: Page) { onPage(id); onClose(); }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSel(s => Math.min(s + 1, filtered.length - 1)); }
    if (e.key === "ArrowUp")   { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
    if (e.key === "Enter" && filtered[sel]) { e.preventDefault(); go(filtered[sel].id); }
  }

  return (
    <div className="cp-overlay" onClick={onClose}>
      <div className="cp-box" onClick={e => e.stopPropagation()}>
        {/* Search input */}
        <div className="cp-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input
            ref={inputRef}
            className="cp-input"
            placeholder="Sayfa ara..."
            value={query}
            onChange={e => { setQuery(e.target.value); setSel(0); }}
            onKeyDown={onKey}
          />
        </div>

        {/* Results */}
        <div className="cp-results">
          {filtered.length === 0 ? (
            <div className="cp-empty">Sonuc yok</div>
          ) : (
            filtered.map((item, i) => (
              <div
                key={item.id}
                className={`cp-item${sel === i ? " cp-selected" : ""}`}
                onClick={() => go(item.id)}
                onMouseEnter={() => setSel(i)}
              >
                <span className="cp-label">{item.label}</span>
                {item.shortcut && <kbd className="cp-kbd">{item.shortcut}</kbd>}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="cp-footer">
          <span><kbd>↑↓</kbd> Gezin</span>
          <span><kbd>↵</kbd> Ac</span>
          <span><kbd>Esc</kbd> Kapat</span>
        </div>
      </div>
    </div>
  );
}
