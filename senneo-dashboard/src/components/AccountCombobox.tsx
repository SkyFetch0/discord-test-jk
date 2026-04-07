import React, { useState, useRef, useEffect, useMemo } from "react";

interface Props {
  options: [string, string][]; // [accountId, username]
  value: string | null;
  onChange: (id: string | null) => void;
}

export function AccountCombobox({ options, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Focus search input when opening
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const filtered = useMemo(() => {
    if (!search.trim()) return options;
    const q = search.toLowerCase();
    return options.filter(
      ([idx, name]) =>
        String(idx).includes(q) || name.toLowerCase().includes(q)
    );
  }, [options, search]);

  const selectedLabel = value != null
    ? options.find(([i]) => i === value)?.[1] ?? value
    : "Tum hesaplar";

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      {/* Trigger button */}
      <button
        type="button"
        className="btn btn-sm btn-secondary"
        onClick={() => { setOpen((o) => !o); setSearch(""); }}
        style={{ minWidth: 130, fontSize: 11, textAlign: "left", gap: 4 }}
      >
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selectedLabel}
        </span>
        <span style={{ opacity: 0.5, fontSize: 9, flexShrink: 0 }}>{open ? "\u25B2" : "\u25BC"}</span>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: 200,
            maxWidth: 280,
            background: "var(--bg-3)",
            border: "1px solid var(--gb1)",
            borderRadius: "var(--r-md)",
            boxShadow: "var(--sh-3)",
            zIndex: 200,
            overflow: "hidden",
            animation: "slideDown .12s ease both",
          }}
        >
          {/* Search input */}
          {options.length > 5 && (
            <div style={{ padding: "8px 8px 4px" }}>
              <input
                ref={inputRef}
                type="text"
                placeholder="Hesap ara..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
                style={{
                  width: "100%",
                  padding: "6px 10px",
                  fontSize: 12,
                  background: "var(--bg-input)",
                  border: "1px solid var(--b1)",
                  borderRadius: "var(--r-sm)",
                  color: "var(--t1)",
                  outline: "none",
                }}
              />
            </div>
          )}

          {/* Options list */}
          <div style={{ maxHeight: 220, overflowY: "auto", padding: "4px 0" }}>
            {/* "All accounts" option */}
            <div
              onClick={() => { onChange(null); setOpen(false); }}
              style={{
                padding: "7px 12px",
                fontSize: 12,
                cursor: "pointer",
                color: value === null ? "var(--blurple)" : "var(--t2)",
                fontWeight: value === null ? 700 : 400,
                background: value === null ? "var(--blurple-d2)" : "transparent",
                transition: "background .08s",
              }}
              onMouseEnter={(e) => { if (value !== null) e.currentTarget.style.background = "var(--g1)"; }}
              onMouseLeave={(e) => { if (value !== null) e.currentTarget.style.background = "transparent"; }}
            >
              Tum hesaplar
            </div>

            {filtered.length === 0 ? (
              <div style={{ padding: "12px", fontSize: 11, color: "var(--t4)", textAlign: "center" }}>
                Sonuc yok
              </div>
            ) : (
              filtered.map(([id, name]) => {
                const selected = value === id;
                return (
                  <div
                    key={id}
                    onClick={() => { onChange(id); setOpen(false); }}
                    style={{
                      padding: "7px 12px",
                      fontSize: 12,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      color: selected ? "var(--blurple)" : "var(--t2)",
                      fontWeight: selected ? 700 : 400,
                      background: selected ? "var(--blurple-d2)" : "transparent",
                      transition: "background .08s",
                    }}
                    onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "var(--g1)"; }}
                    onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {name || id}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
