import React, { useState, useEffect, useCallback } from "react";
import { useDebounce, fmtTs } from "../hooks";
import { api } from "../api";
import { Spinner } from "../components";
import type { ErrorLogEntry, ErrorListResponse, ErrorSummaryResponse } from "../types";

const CATEGORIES = ["rate_limit","discord_api","kafka_producer","kafka_consumer","scylla_write","clickhouse_write","dlq_parse","checkpoint_persist","network","auth_login","validation","proxy","unknown"] as const;
const SOURCES    = ["accounts","ingester","api","bot","other"] as const;
const SEVERITIES = ["warn","error","critical"] as const;
const PRESETS    = [{ label: "1s", value: "1h" },{ label: "24s", value: "24h" },{ label: "7g", value: "7d" },{ label: "30g", value: "30d" }] as const;

const SEV_COLOR: Record<string, string> = { warn: "var(--yellow)", error: "var(--red)", critical: "#ff2d55" };
const CAT_COLOR: Record<string, string> = { rate_limit: "var(--orange)", discord_api: "var(--purple)", scylla_write: "var(--red)", clickhouse_write: "var(--cyan)", dlq_parse: "var(--yellow)", network: "var(--t3)", auth_login: "var(--red)", kafka_producer: "var(--blue)", kafka_consumer: "var(--blue)" };

function Chip({ label, color, active, onClick }: { label: string; color?: string; active?: boolean; onClick?: () => void }) {
  return (
    <span onClick={onClick} style={{
      display: "inline-flex", alignItems: "center", padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 600,
      cursor: onClick ? "pointer" : "default", transition: "all .1s",
      color: active ? "#fff" : (color ?? "var(--t3)"),
      background: active ? (color ?? "var(--t3)") : `color-mix(in srgb, ${color ?? "var(--t3)"} 10%, transparent)`,
      border: `1px solid color-mix(in srgb, ${color ?? "var(--t3)"} ${active ? "60" : "20"}%, transparent)`,
    }}>{label}</span>
  );
}

export function ErrorLog() {
  const [errors, setErrors]     = useState<ErrorLogEntry[]>([]);
  const [total, setTotal]       = useState(0);
  const [loading, setLoading]   = useState(true);
  const [summary, setSummary]   = useState<ErrorSummaryResponse | null>(null);
  const [selected, setSelected] = useState<ErrorLogEntry | null>(null);

  // Filters
  const [since, setSince]       = useState("24h");
  const [category, setCategory] = useState("");
  const [source, setSource]     = useState("");
  const [severity, setSeverity] = useState("");
  const [searchRaw, setSearchRaw] = useState("");
  const searchQ = useDebounce(searchRaw, 300);
  const [page, setPage]         = useState(0);
  const PAGE_SIZE = 50;

  const fetchErrors = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.errors.list({
        limit: PAGE_SIZE, offset: page * PAGE_SIZE,
        since: since || undefined,
        category: category || undefined,
        source: source || undefined,
        severity: severity || undefined,
        q: searchQ || undefined,
      }) as ErrorListResponse;
      setErrors(res.errors ?? []);
      setTotal(res.total ?? 0);
    } catch { /* keep stale */ }
    setLoading(false);
  }, [since, category, source, severity, searchQ, page]);

  const fetchSummary = useCallback(async () => {
    try { setSummary(await api.errors.summary(since) as ErrorSummaryResponse); } catch {}
  }, [since]);

  useEffect(() => { fetchErrors(); }, [fetchErrors]);
  useEffect(() => { fetchSummary(); }, [fetchSummary]);
  useEffect(() => { const id = setInterval(fetchErrors, 5000); return () => clearInterval(id); }, [fetchErrors]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="page-enter">
      {/* Summary chips */}
      {summary && (
        <div style={{ display: "flex", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
          {/* By severity */}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "var(--t4)", fontWeight: 700, textTransform: "uppercase" }}>Onem</span>
            {(summary.bySeverity ?? []).map((s: any) => (
              <Chip key={s.severity} label={`${s.severity}: ${s.cnt}`} color={SEV_COLOR[s.severity]} active={severity === s.severity}
                onClick={() => { setSeverity(v => v === s.severity ? "" : s.severity); setPage(0); }} />
            ))}
          </div>
          {/* By source */}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "var(--t4)", fontWeight: 700, textTransform: "uppercase" }}>Kaynak</span>
            {(summary.bySource ?? []).map((s: any) => (
              <Chip key={s.source} label={`${s.source}: ${s.cnt}`} active={source === s.source}
                onClick={() => { setSource(v => v === s.source ? "" : s.source); setPage(0); }} />
            ))}
          </div>
          {/* By category (top 5) */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: "var(--t4)", fontWeight: 700, textTransform: "uppercase" }}>Kategori</span>
            {(summary.byCategory ?? []).slice(0, 6).map((s: any) => (
              <Chip key={s.category} label={`${s.category}: ${s.cnt}`} color={CAT_COLOR[s.category]} active={category === s.category}
                onClick={() => { setCategory(v => v === s.category ? "" : s.category); setPage(0); }} />
            ))}
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        <input className="input input-sm" type="search" placeholder="Hata mesajinda ara..." value={searchRaw}
          onChange={e => { setSearchRaw(e.target.value); setPage(0); }} style={{ flex: 1, minWidth: 150, maxWidth: 280 }} />

        <div style={{ display: "flex", gap: 4 }}>
          {PRESETS.map(p => (
            <button key={p.value} className={`btn btn-xs ${since === p.value ? "btn-primary" : "btn-secondary"}`}
              onClick={() => { setSince(p.value); setPage(0); }}>{p.label}</button>
          ))}
        </div>

        <select className="input input-sm" value={category} onChange={e => { setCategory(e.target.value); setPage(0); }}
          style={{ width: 130 }}>
          <option value="">Tum Kategoriler</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        <select className="input input-sm" value={source} onChange={e => { setSource(e.target.value); setPage(0); }}
          style={{ width: 110 }}>
          <option value="">Tum Kaynaklar</option>
          {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>

        <select className="input input-sm" value={severity} onChange={e => { setSeverity(e.target.value); setPage(0); }}
          style={{ width: 100 }}>
          <option value="">Tum Onem</option>
          {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>

        <span style={{ fontSize: 10, color: "var(--t4)", marginLeft: "auto" }}>{total} hata</span>
      </div>

      {/* Error table + detail panel */}
      <div style={{ display: "flex", gap: 12, minHeight: 300 }}>
        {/* Table */}
        <div className="panel" style={{ flex: 1, overflow: "hidden" }}>
          {loading && errors.length === 0 ? (
            <div className="empty" style={{ height: 200 }}><Spinner /></div>
          ) : errors.length === 0 ? (
            <div className="empty" style={{ height: 200 }}>Bu filtrede hata yok</div>
          ) : (
            <div className="tbl-wrap" style={{ maxHeight: 500, overflowY: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 130 }}>Zaman</th>
                    <th style={{ width: 60 }}>Onem</th>
                    <th style={{ width: 120 }}>Kategori</th>
                    <th style={{ width: 80 }}>Kaynak</th>
                    <th>Mesaj</th>
                  </tr>
                </thead>
                <tbody>
                  {errors.map((e, i) => (
                    <tr key={`${e.ts}-${i}`} onClick={() => setSelected(e)}
                      style={{ cursor: "pointer", background: selected === e ? "rgba(88,101,242,.08)" : undefined }}>
                      <td style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--t3)", whiteSpace: "nowrap" }}>{fmtTs(e.ts)}</td>
                      <td><span style={{ color: SEV_COLOR[e.severity] ?? "var(--t3)", fontWeight: 600, fontSize: 10 }}>{e.severity}</span></td>
                      <td><span style={{ color: CAT_COLOR[e.category] ?? "var(--t3)", fontSize: 10 }}>{e.category}</span></td>
                      <td style={{ fontSize: 10, color: "var(--t2)" }}>{e.source}</td>
                      <td style={{ fontSize: 11, color: "var(--t1)", maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: "flex", gap: 6, padding: "8px 12px", borderTop: "1px solid var(--b0)", alignItems: "center", justifyContent: "center" }}>
              <button className="btn btn-xs btn-secondary" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Onceki</button>
              <span style={{ fontSize: 10, color: "var(--t3)" }}>{page + 1} / {totalPages}</span>
              <button className="btn btn-xs btn-secondary" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Sonraki</button>
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selected && (
          <div className="panel" style={{ width: 340, flexShrink: 0, overflow: "auto", maxHeight: 550 }}>
            <div style={{ padding: 14, borderBottom: "1px solid var(--b0)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: SEV_COLOR[selected.severity] ?? "var(--t1)" }}>{selected.severity.toUpperCase()}</span>
                <button className="btn btn-xs btn-secondary" onClick={() => setSelected(null)}>Kapat</button>
              </div>
              <div style={{ fontSize: 10, color: "var(--t3)", fontFamily: "var(--mono)", marginBottom: 6 }}>{fmtTs(selected.ts)}</div>
              <Chip label={selected.category} color={CAT_COLOR[selected.category]} />
              <span style={{ marginLeft: 6 }}><Chip label={selected.source} /></span>
            </div>
            <div style={{ padding: 14 }}>
              <div style={{ fontSize: 12, color: "var(--t1)", marginBottom: 10, lineHeight: 1.5 }}>{selected.message}</div>

              {selected.detail && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 9, color: "var(--t4)", fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Detay</div>
                  <pre style={{ fontSize: 10, color: "var(--t2)", background: "rgba(0,0,0,.15)", padding: 8, borderRadius: 6, whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 200, overflowY: "auto" }}>{selected.detail}</pre>
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 12px", fontSize: 10 }}>
                {selected.channel_id && selected.channel_id !== "" && (
                  <><span style={{ color: "var(--t4)" }}>Kanal</span><span className="mono" style={{ color: "var(--t2)" }}>{selected.channel_id}</span></>
                )}
                {selected.guild_id && selected.guild_id !== "" && (
                  <><span style={{ color: "var(--t4)" }}>Guild</span><span className="mono" style={{ color: "var(--t2)" }}>{selected.guild_id}</span></>
                )}
                {(selected.account_id || selected.account_idx != null) && (
                  <><span style={{ color: "var(--t4)" }}>Hesap</span><span className="mono" style={{ color: "var(--blue)" }}>{selected.account_id || selected.account_idx}</span></>
                )}
                {selected.error_code && selected.error_code !== "" && (
                  <><span style={{ color: "var(--t4)" }}>Kod</span><span style={{ color: "var(--red)" }}>{selected.error_code}</span></>
                )}
                {selected.kafka_topic && selected.kafka_topic !== "" && (
                  <><span style={{ color: "var(--t4)" }}>Topic</span><span className="mono" style={{ color: "var(--t2)" }}>{selected.kafka_topic}</span></>
                )}
                {selected.fingerprint && selected.fingerprint !== "" && (
                  <><span style={{ color: "var(--t4)" }}>Fingerprint</span><span className="mono" style={{ color: "var(--t2)" }}>{selected.fingerprint}</span></>
                )}
                {selected.count > 1 && (
                  <><span style={{ color: "var(--t4)" }}>Tekrar</span><span style={{ color: "var(--orange)", fontWeight: 700 }}>{selected.count}x</span></>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
