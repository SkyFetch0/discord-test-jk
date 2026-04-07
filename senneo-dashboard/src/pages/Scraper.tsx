import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useSSE, useCountUp, useDebounce, fmt, avatarColor } from "../hooks";
import { ProgressBar, Spinner } from "../components";
import { api, exportCSV } from "../api";
import { LogDrawer } from "../components/LogDrawer";
import { AccountCombobox } from "../components/AccountCombobox";
import { PauseReasonModal } from "../components/PauseReasonModal";
import { Icon } from "../icons";
import type { IconName } from "../icons";
import type { ChannelStats, ChannelPage, PauseSource, SchedulerState, ScrapePhase } from "../types";

/* ── Account name cache ── */
const _acc = new Map<string, string>();
function useAccNames() {
  const [ok, setOk] = useState(_acc.size > 0);
  useEffect(() => { if (ok) return; (api.accounts.list() as Promise<any>).then((r: any) => { for (const a of (r?.accounts ?? r ?? [])) { const id = a.user?.id ?? a.accountId ?? String(a.idx); const n = a.user?.username ?? a.username; if (id && n) _acc.set(id, n); } setOk(true); }).catch(() => setOk(true)); }, [ok]);
  return useMemo(() => [..._acc.entries()].sort((a, b) => a[0].localeCompare(b[0])), [ok]);
}

/* ── Guild icon with nextPow2 CDN size ── */
function nextPow2(n: number): number {
  const sizes = [16, 32, 64, 128, 256, 512];
  return sizes.find(s => s >= n) ?? 512;
}
function GuildIcon({ guildId, guildIcon, guildName, size = 34 }: { guildId: string; guildIcon?: string | null; guildName: string; size?: number }) {
  const [failed, setFailed] = React.useState(false);
  const ext = guildIcon?.startsWith('a_') ? 'gif' : 'png';
  const cdnSize = nextPow2(size * 2);
  const url = guildIcon && !failed ? `https://cdn.discordapp.com/icons/${guildId}/${guildIcon}.${ext}?size=${cdnSize}` : null;
  const color = avatarColor(guildId);
  const radius = 9;
  if (url) return <img src={url} alt="" style={{ width: size, height: size, borderRadius: radius, flexShrink: 0, objectFit: 'cover' }} onError={() => setFailed(true)} />;
  return (
    <div style={{ width: size, height: size, borderRadius: radius, background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.41, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
      {guildName[0]?.toUpperCase() || '?'}
    </div>
  );
}

/* ── Phase config ── */
type Filter = "all" | ScrapePhase;
type SchedulerFilter = "all" | SchedulerState;
const PHASES: { key: Filter; label: string; color: string }[] = [
  { key: "all",    label: "Tumu",      color: "var(--t2)" },
  { key: "active", label: "Aktif",     color: "var(--orange)" },
  { key: "idle",   label: "Beklemede", color: "var(--cyan)" },
  { key: "queued", label: "Sirada",    color: "var(--yellow)" },
  { key: "done",   label: "Bitti",     color: "var(--green)" },
  { key: "error",  label: "Hata",      color: "var(--red)" },
];
const SCHEDULER_FILTERS: Array<{ key: SchedulerFilter; label: string }> = [
  { key: "all", label: "Tüm runtime" },
  { key: "running", label: "Çalışıyor" },
  { key: "queued", label: "Sırada" },
  { key: "paused", label: "Durdu" },
  { key: "completed", label: "Tamamlandı" },
  { key: "error_retryable", label: "Tekrar Dene" },
  { key: "error_terminal", label: "Kalıcı Hata" },
];

function PhaseChip({ phase }: { phase: string }) {
  const p = PHASES.find(x => x.key === phase) ?? { label: phase, color: "var(--t3)" };
  return <span style={{ display: "inline-flex", padding: "2px 7px", borderRadius: 5, fontSize: 10, fontWeight: 600, color: p.color, background: `color-mix(in srgb, ${p.color} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${p.color} 20%, transparent)` }}>{p.label}</span>;
}

function runtimeChipStyle(color: string): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "2px 7px",
    borderRadius: 999,
    fontSize: 10,
    fontWeight: 600,
    color,
    background: `color-mix(in srgb, ${color} 12%, transparent)`,
    border: `1px solid color-mix(in srgb, ${color} 26%, transparent)`,
  };
}

function schedulerMeta(state: SchedulerState | null | undefined): { label: string; color: string } {
  switch (state) {
    case "running":
      return { label: "Çalışıyor", color: "var(--orange)" };
    case "queued":
      return { label: "Sırada", color: "var(--yellow)" };
    case "paused":
      return { label: "Durdu", color: "var(--orange)" };
    case "completed":
      return { label: "Tamamlandı", color: "var(--green)" };
    case "error_retryable":
      return { label: "Tekrar Dene", color: "var(--red)" };
    case "error_terminal":
      return { label: "Kalıcı Hata", color: "var(--red)" };
    default:
      return { label: "Durum Yok", color: "var(--t4)" };
  }
}

function pauseSourceText(source: PauseSource | null | undefined): string {
  switch (source) {
    case "account":
      return "Hesap";
    case "channel":
      return "Kanal";
    case "both":
      return "Hesap + Kanal";
    default:
      return "Bekleme";
  }
}

function targetDisplayName(channel: ChannelStats): string {
  return channel.channelName || channel.channelLabel || channel.channelId;
}

function channelPriority(channel: ChannelStats): number {
  if (channel.pauseAcknowledged || channel.schedulerState === "paused") return 0;
  if (channel.pauseRequested) return 1;
  switch (channel.schedulerState) {
    case "running":
      return 2;
    case "queued":
      return 3;
    case "error_retryable":
    case "error_terminal":
      return 4;
    case "completed":
      return 5;
    default:
      return 6;
  }
}

/* ── S1: ETA helper ── */
function computeGuildEta(channels: ChannelStats[]): number | null {
  let remaining = 0;
  let activeMps = 0;
  let hasEstimate = false;
  for (const c of channels) {
    if (!c.complete && (c.progress ?? 0) > 0.02) {
      const est = c.totalScraped / c.progress!;
      remaining += Math.max(0, est - c.totalScraped);
      hasEstimate = true;
    }
    if (c.msgsPerSec > 0) activeMps += c.msgsPerSec;
  }
  if (!hasEstimate || activeMps <= 0 || remaining <= 0) return null;
  return Math.round(remaining / activeMps);
}

function fmtEta(sec: number): string {
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}dk`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}sa`;
  return `${Math.round(sec / 86400)}g`;
}

function compareChannels(a: ChannelStats, b: ChannelStats): number {
  const priorityDiff = channelPriority(a) - channelPriority(b);
  if (priorityDiff !== 0) return priorityDiff;
  return targetDisplayName(a).localeCompare(targetDisplayName(b));
}

/* ── Channel row inside guild ── */
function ChanRow({ c, actionId, onPause, onResume }: { c: ChannelStats; actionId: string | null; onPause: (channel: ChannelStats) => void; onResume: (channel: ChannelStats) => void; }) {
  const accName = c.accountId ? _acc.get(c.accountId) : null;
  const runtime = schedulerMeta(c.schedulerState);
  const busy = actionId === c.channelId;
  return (
    <tr>
      <td><div><div style={{ fontWeight: 600, fontSize: 12, color: "var(--t1)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{targetDisplayName(c)}</div><div style={{ fontSize: 9, color: "var(--t5)", fontFamily: "var(--mono)" }}>{c.channelId}</div>{c.pauseReason ? <div style={{ fontSize: 9, color: "var(--t4)", marginTop: 4, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.pauseReason}</div> : null}</div></td>
      <td>{c.accountId ? <div><div style={{ fontSize: 11, color: "var(--t2)" }}>{accName || c.accountId}</div></div> : <span style={{ color: "var(--t5)" }}>-</span>}</td>
      <td className="num" style={{ color: c.totalScraped > 0 ? "var(--t1)" : "var(--t5)", fontWeight: c.totalScraped > 0 ? 600 : 400 }}>{c.totalScraped > 0 ? fmt(c.totalScraped) : "-"}</td>
      <td>{c.msgsPerSec > 0 ? <span style={{ color: "var(--orange)", fontWeight: 700, fontFamily: "var(--mono)", fontSize: 11 }}>{c.msgsPerSec}/s</span> : <span style={{ color: "var(--t5)" }}>-</span>}</td>
      <td style={{ minWidth: 80 }}><ProgressBar value={c.progress ?? 0} complete={c.complete} /></td>
      <td>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <PhaseChip phase={c.scrapePhase ?? "queued"} />
          <span style={runtimeChipStyle(runtime.color)}>{runtime.label}</span>
          {c.pauseRequested ? <span style={runtimeChipStyle(c.pauseAcknowledged ? "var(--orange)" : "var(--yellow)")}>{c.pauseAcknowledged ? `${pauseSourceText(c.requestedPauseSource)} durdu` : `${pauseSourceText(c.requestedPauseSource)} duruyor`}</span> : null}
        </div>
      </td>
      <td style={{ textAlign: "right" }}>
        {c.channelPauseRequested ? (
          <button className="btn btn-primary btn-xs" onClick={() => onResume(c)} disabled={busy}>{busy ? <Spinner /> : "Devam"}</button>
        ) : c.pauseRequested ? (
          <button className="btn btn-secondary btn-xs" disabled title="Kanal hesap düzeyi duraklatmadan etkileniyor">{pauseSourceText(c.requestedPauseSource)}</button>
        ) : (
          <button className="btn btn-secondary btn-xs" onClick={() => onPause(c)} disabled={busy}>{busy ? <Spinner /> : "Duraklat"}</button>
        )}
      </td>
    </tr>
  );
}

/* ── Compact guild row (collapsed by default) ── */
const MAX_VISIBLE_GUILDS = 100;

function GuildRow({ guildId, guildName, guildIcon, channels, filter, actionId, onPause, onResume }: {
  guildId: string; guildName: string; guildIcon?: string | null; channels: ChannelStats[]; filter: Filter; actionId: string | null; onPause: (channel: ChannelStats) => void; onResume: (channel: ChannelStats) => void;
}) {
  const [open, setOpen] = useState(false);
  const color = avatarColor(guildId);
  const filtered = filter === "all" ? channels : channels.filter(c => (c.scrapePhase ?? "queued") === filter);

  const total    = channels.length;
  const totalMsg = channels.reduce((s, c) => s + c.totalScraped, 0);
  const avgMsg   = total > 0 ? Math.round(totalMsg / total) : 0;
  const totalMps = channels.reduce((s, c) => s + c.msgsPerSec, 0);
  const avgProg  = Math.round(channels.reduce((s, c) => s + (c.progress ?? 0), 0) / Math.max(total, 1));
  const allDone  = total > 0 && channels.every(c => c.scrapePhase === "done");
  // S1 — ETA per guild
  const etaSec   = allDone ? null : computeGuildEta(channels);

  // Phase counts
  const pCounts: Record<string, number> = {};
  for (const c of channels) pCounts[c.scrapePhase ?? "queued"] = (pCounts[c.scrapePhase ?? "queued"] ?? 0) + 1;
  const pauseCount = channels.filter(c => c.pauseRequested).length;

  // Unique accounts
  const accIds = [...new Set(channels.map(c => c.accountId).filter((x): x is string => !!x))].sort();

  const S = { dot: (c: string) => ({ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: c, flexShrink: 0 } as const) };

  return (
    <div style={{ borderBottom: "1px solid var(--b0)" }}>
      {/* Header */}
      <div onClick={() => setOpen(v => !v)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", cursor: "pointer", transition: "background .08s" }}
        onMouseEnter={e => (e.currentTarget.style.background = "var(--g0)")} onMouseLeave={e => (e.currentTarget.style.background = "")}>

        {/* Guild icon */}
        <GuildIcon guildId={guildId} guildIcon={guildIcon} guildName={guildName} size={34} />

        {/* Left: name + meta */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Row 1: name + accounts */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 280 }}>{guildName}</span>
            {accIds.slice(0, 3).map(id => {
              const n = _acc.get(id);
              return <span key={id} style={{ fontSize: 9, color: "var(--blurple)", background: "rgba(88,101,242,.1)", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>{n || id}</span>;
            })}
            {accIds.length > 3 && <span style={{ fontSize: 9, color: "var(--t4)" }}>+{accIds.length - 3}</span>}
          </div>
          {/* Row 2: phase dots + channel count */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10 }}>
            {(pCounts.active ?? 0) > 0 && <span style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--orange)" }}><span style={S.dot("var(--orange)")} />{pCounts.active} aktif</span>}
            {(pCounts.idle ?? 0) > 0 && <span style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--cyan)" }}><span style={S.dot("var(--cyan)")} />{pCounts.idle} bkl</span>}
            {(pCounts.queued ?? 0) > 0 && <span style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--yellow)" }}><span style={S.dot("var(--yellow)")} />{pCounts.queued} sira</span>}
            {(pCounts.done ?? 0) > 0 && <span style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--green)" }}><span style={S.dot("var(--green)")} />{pCounts.done} bitti</span>}
            {(pCounts.error ?? 0) > 0 && <span style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--red)" }}><span style={S.dot("var(--red)")} />{pCounts.error} hata</span>}
            {pauseCount > 0 && <span style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--orange)" }}><span style={S.dot("var(--orange)")} />{pauseCount} duraklatma</span>}
            <span style={{ color: "var(--t4)", marginLeft: 2 }}>{total} kanal</span>
          </div>
        </div>

        {/* Right: throughput + S1 ETA */}
        {(totalMps > 0 || etaSec != null) && (
          <div style={{ textAlign: "right", flexShrink: 0, minWidth: 66 }}>
            {totalMps > 0 && <div style={{ fontSize: 12, fontWeight: 700, color: "var(--orange)", fontFamily: "var(--mono)" }}>{totalMps}/s</div>}
            {etaSec != null && (
              <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: totalMps > 0 ? 1 : 0, display: 'flex', alignItems: 'center', gap: 3, justifyContent: 'flex-end' }}
                title={`Tahmini kalan süre: ${fmtEta(etaSec)} (${etaSec} saniye)`}>
                <span style={{ opacity: .5, fontSize: 9 }}>&#9201;</span>
                {fmtEta(etaSec)}
              </div>
            )}
          </div>
        )}

        {/* Right: total messages */}
        <div style={{ textAlign: "right", flexShrink: 0, minWidth: 75 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--blue)", fontVariantNumeric: "tabular-nums", letterSpacing: "-.5px" }}>{fmt(totalMsg)}</div>
          <div style={{ fontSize: 9, color: "var(--t5)" }}>ort {fmt(avgMsg)}/ch</div>
        </div>

        {/* Progress */}
        <div style={{ width: 60, flexShrink: 0 }}>
          <ProgressBar value={avgProg} complete={allDone} />
        </div>

        {/* Chevron */}
        <span style={{ fontSize: 9, color: "var(--t4)", transition: "transform .15s", transform: open ? "rotate(180deg)" : "", flexShrink: 0 }}>&#9660;</span>
      </div>

      {/* Expanded */}
      {open && (
        <div style={{ padding: "0 16px 10px", background: "rgba(0,0,0,.08)", animation: "slideUp .12s ease both" }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 10, textAlign: "center", fontSize: 11, color: "var(--t4)" }}>Bu filtrede kanal yok</div>
          ) : (
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Kanal</th><th>Hesap</th><th className="num">Toplam</th><th>Hiz</th><th>Ilerleme</th><th>Durum</th><th /></tr></thead>
                <tbody>{filtered.map(c => <ChanRow key={c.channelId} c={c} actionId={actionId} onPause={onPause} onResume={onResume} />)}</tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══ SCRAPER PAGE ═══════════════════════════════════ */
export function Scraper() {
  const { summary } = useSSE();
  const accOptions = useAccNames();
  const [filter, setFilter] = useState<Filter>("all");
  const [schedulerFilter, setSchedulerFilter] = useState<SchedulerFilter>("all");
  const [accountFilter, setAccountFilter] = useState<string | null>(null);
  const [searchRaw, setSearchRaw] = useState("");
  const searchQ = useDebounce(searchRaw, 250);
  const [logOpen, setLogOpen] = useState(false);
  const [channels, setChannels] = useState<ChannelStats[]>([]);
  const [pauseTarget, setPauseTarget] = useState<ChannelStats | null>(null);
  const [channelActionId, setChannelActionId] = useState<string | null>(null);

  const fetchChannels = useCallback(async () => {
    try {
      const res = await api.live.channels({ limit: 200, phase: filter !== "all" ? filter : undefined, schedulerState: schedulerFilter !== "all" ? schedulerFilter : undefined, q: searchQ || undefined, sort: "+guildName", ...(accountFilter ? { accountId: accountFilter } : {}) }) as ChannelPage;
      setChannels(res.channels ?? []);
    } catch {}
  }, [filter, schedulerFilter, searchQ, accountFilter]);

  useEffect(() => { fetchChannels(); }, [fetchChannels]);
  useEffect(() => { const id = setInterval(fetchChannels, 2000); return () => clearInterval(id); }, [fetchChannels]);

  const pc = summary?.phaseCounts ?? {};
  const sc = summary?.schedulerCounts ?? {};
  const totalScraped = useCountUp(Number(summary?.totalScraped ?? 0));

  async function pauseChannel(reason: string) {
    if (!pauseTarget) return;
    setChannelActionId(pauseTarget.channelId);
    try {
      await api.accounts.pauseTarget(pauseTarget.channelId, reason || undefined);
      setPauseTarget(null);
      await fetchChannels();
    } catch {
    } finally {
      setChannelActionId(null);
    }
  }

  async function resumeChannel(channel: ChannelStats) {
    setChannelActionId(channel.channelId);
    try {
      await api.accounts.resumeTarget(channel.channelId);
      await fetchChannels();
    } catch {
    } finally {
      setChannelActionId(null);
    }
  }

  const guilds = useMemo(() => {
    const m = new Map<string, { name: string; icon: string | null; channels: ChannelStats[] }>();
    for (const c of channels) {
      const gid = c.guildId || "?";
      if (!m.has(gid)) m.set(gid, { name: c.guildName || gid, icon: c.guildIcon ?? null, channels: [] });
      const g = m.get(gid)!;
      g.channels.push(c);
      if (c.guildName && g.name === gid) g.name = c.guildName;
      if (c.guildIcon && !g.icon) g.icon = c.guildIcon;
    }
    for (const guild of m.values()) guild.channels.sort(compareChannels);
    return m;
  }, [channels]);

  const pausedChannels = useMemo(
    () => channels.filter(channel => channel.pauseRequested || channel.schedulerState === "paused").sort(compareChannels),
    [channels],
  );
  const visibleGuilds = useMemo(() => [...guilds.entries()].sort((a, b) => {
    const pauseDiff = b[1].channels.filter(channel => channel.pauseRequested || channel.schedulerState === "paused").length - a[1].channels.filter(channel => channel.pauseRequested || channel.schedulerState === "paused").length;
    if (pauseDiff !== 0) return pauseDiff;
    const runningDiff = b[1].channels.filter(channel => channel.schedulerState === "running").length - a[1].channels.filter(channel => channel.schedulerState === "running").length;
    if (runningDiff !== 0) return runningDiff;
    return a[1].name.localeCompare(b[1].name);
  }).slice(0, MAX_VISIBLE_GUILDS), [guilds]);
  const hiddenCount = Math.max(0, guilds.size - MAX_VISIBLE_GUILDS);

  if (!summary) return <div className="page-enter"><div className="empty" style={{ height: 200 }}><Spinner /><span style={{ color: "var(--t4)" }}>SSE baglaniyor...</span></div></div>;

  return (
    <div className="page-enter">
      {/* Stat cards */}
      <div className="stat-grid stat-grid-4" style={{ marginBottom: 12 }}>
        {([
          { label: "Toplam Mesaj", value: totalScraped, color: "var(--blurple)", icon: "message-square" as IconName },
          { label: "Tamamlanan",   value: Number(pc.done ?? 0), color: "var(--green)", icon: "check-circle" as IconName },
          { label: "Çalışan",      value: Number(sc.running ?? pc.active ?? 0), color: "var(--orange)", icon: "activity" as IconName },
          { label: "Duraklatılan", value: Number(sc.paused ?? summary?.pauseAcknowledgedCount ?? 0), color: "var(--yellow)", icon: "clock-lucide" as IconName },
        ]).map((s, i) => (
          <div key={s.label} className="stat-card" style={{ "--accent-color": s.color, animation: `slideUp .2s ease ${i*35}ms both` } as React.CSSProperties}>
            <div className="stat-card-icon"><Icon name={s.icon} size={22} /></div>
            <div className="stat-label">{s.label}</div>
            <div className="stat-value" style={{ color: s.color }}>{s.value.toLocaleString("tr-TR")}</div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input className="input input-sm" type="search" placeholder="Ara..." value={searchRaw}
          onChange={e => setSearchRaw(e.target.value)} style={{ flex: 1, minWidth: 150, maxWidth: 300 }} />
        {accOptions.length > 0 && <AccountCombobox options={accOptions} value={accountFilter} onChange={setAccountFilter} />}
        <select className="input input-sm" value={schedulerFilter} onChange={e => setSchedulerFilter(e.target.value as SchedulerFilter)} style={{ minWidth: 150 }}>
          {SCHEDULER_FILTERS.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
        </select>
        <button className={`btn btn-sm ${logOpen ? "btn-primary" : "btn-secondary"}`} onClick={() => setLogOpen(v => !v)}>
          {logOpen ? "Logu Gizle" : "Canlı Log"}
        </button>
      </div>

      {/* Phase filters */}
      <div style={{ display: "flex", gap: 5, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        {PHASES.map(p => (
          <button key={p.key} className={`btn btn-xs ${filter === p.key ? "btn-primary" : "btn-secondary"}`} onClick={() => setFilter(p.key)}>
            {p.label}{p.key !== "all" && <span style={{ opacity: .6, marginLeft: 3 }}>({pc[p.key] ?? 0})</span>}
          </button>
        ))}
        {summary?.pauseRequestedCount ? <span style={runtimeChipStyle("var(--yellow)")}>{summary.pauseRequestedCount} pause isteği</span> : null}
        {summary?.pauseAcknowledgedCount ? <span style={runtimeChipStyle("var(--orange)")}>{summary.pauseAcknowledgedCount} durmuş kanal</span> : null}
        <span className="chip" style={{ marginLeft: "auto", fontSize: 10 }}>{channels.length}/{summary.totalChannels ?? 0} kanal &middot; {guilds.size} guild</span>
        <button className="btn btn-xs btn-secondary" onClick={() => exportCSV(channels as unknown as Record<string, unknown>[], "scraper")}>CSV</button>
      </div>

      <LogDrawer open={logOpen} onClose={() => setLogOpen(false)} />

      {pausedChannels.length > 0 && (
        <div className="panel" style={{ marginBottom: 12, overflow: "hidden" }}>
          <div className="panel-head" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="panel-title">Duraklatılmış Kanallar</span>
            <span className="chip" style={{ fontSize: 10 }}>{pausedChannels.length} kanal</span>
            <span style={{ fontSize: 11, color: "var(--t4)" }}>Filtre yok, duraklatılanlar burada direkt görünüyor.</span>
          </div>
          <div style={{ padding: "12px 16px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
            {pausedChannels.slice(0, 12).map(channel => {
              const runtime = schedulerMeta(channel.schedulerState);
              const accName = channel.accountId ? (_acc.get(channel.accountId) || channel.accountId) : null;
              return (
                <div key={channel.channelId} style={{ border: "1px solid var(--b0)", borderRadius: 14, background: "rgba(255,159,10,.05)", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{targetDisplayName(channel)}</div>
                      <div style={{ fontSize: 10, color: "var(--t4)", marginTop: 4, fontFamily: "var(--mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {channel.guildName || channel.guildId || "-"} · {channel.channelId}
                      </div>
                    </div>
                    {channel.channelPauseRequested ? (
                      <button className="btn btn-primary btn-xs" onClick={() => { void resumeChannel(channel); }} disabled={channelActionId === channel.channelId}>
                        {channelActionId === channel.channelId ? <Spinner /> : "Devam"}
                      </button>
                    ) : (
                      <button className="btn btn-secondary btn-xs" disabled title="Kanal hesap düzeyi duraklatmadan etkileniyor">
                        {pauseSourceText(channel.requestedPauseSource)}
                      </button>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <span style={runtimeChipStyle(runtime.color)}>{runtime.label}</span>
                    {channel.pauseRequested ? <span style={runtimeChipStyle(channel.pauseAcknowledged ? "var(--orange)" : "var(--yellow)")}>{channel.pauseAcknowledged ? `${pauseSourceText(channel.requestedPauseSource)} durdu` : `${pauseSourceText(channel.requestedPauseSource)} duruyor`}</span> : null}
                    {accName ? <span className="chip" style={{ fontSize: 10 }}>{accName}</span> : null}
                  </div>
                  {channel.pauseReason ? <div style={{ fontSize: 11, color: "var(--t4)", lineHeight: 1.55 }}>{channel.pauseReason}</div> : null}
                </div>
              );
            })}
          </div>
          {pausedChannels.length > 12 ? (
            <div style={{ padding: "0 16px 12px", fontSize: 11, color: "var(--t4)" }}>
              İlk 12 kanal gösteriliyor. Tam liste aşağıda guild bazında devam ediyor.
            </div>
          ) : null}
        </div>
      )}

      {/* Guild list */}
      <div className="panel" style={{ overflow: "hidden" }}>
        {visibleGuilds.length === 0 ? (
          <div className="empty" style={{ height: 120 }}>Kanal verisi bekleniyor...</div>
        ) : (
          visibleGuilds.map(([gid, { name, icon, channels: chs }]) => (
            <GuildRow key={gid} guildId={gid} guildName={name} guildIcon={icon} channels={chs} filter={filter} actionId={channelActionId} onPause={setPauseTarget} onResume={channel => { void resumeChannel(channel); }} />
          ))
        )}
        {hiddenCount > 0 && (
          <div style={{ padding: "10px 16px", fontSize: 11, color: "var(--t4)", textAlign: "center", borderTop: "1px solid var(--b0)" }}>
            +{hiddenCount} guild gizlendi. Aramayi daralt veya filtre kullan.
          </div>
        )}
      </div>

      {pauseTarget && (
        <PauseReasonModal
          title="Kanalı Duraklat"
          message={`${targetDisplayName(pauseTarget)} için scrape kuyruğu durdurulacak ve son checkpoint güvenli şekilde korunacak.`}
          confirmLabel="Duraklat"
          submitting={channelActionId === pauseTarget.channelId}
          initialReason={pauseTarget.pauseReason ?? ""}
          onConfirm={pauseChannel}
          onCancel={() => { if (channelActionId === null) setPauseTarget(null); }}
        />
      )}
    </div>
  );
}
