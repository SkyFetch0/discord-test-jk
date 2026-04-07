import React, { useState, useEffect, useCallback, useMemo } from "react";
import { api } from "../api";
import { useInterval, useDebounce, useCountUp, fmt, fmtTs, avatarColor, addToast, discordIconUrl } from "../hooks";
import { Spinner, Empty } from "../components";
import type {
  GuildStatsResponse, InvitePoolEntry, InviteListResponse, InvitePoolJob,
  JoinCategory, CategoryGuildsResponse, CategoryGuildEntry, AccountListEntry,
  ArchivedAccount, ArchivedGuild, ArchivedChannel, ArchivedDetailResponse, FailedAccount,
} from "../types";

/* ════════════════════════════════════════════════════════════════════════════
   SHARED MICRO-COMPONENTS
   ════════════════════════════════════════════════════════════════════════════ */

function Stat({ label, value, color, delay = 0 }: { label: string; value: number; color: string; delay?: number }) {
  const v = useCountUp(value);
  return (
    <div className="stat-card" style={{ "--accent-color": color, animation: `slideUp .2s ease ${delay}ms both` } as React.CSSProperties}>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color }}>{v.toLocaleString("tr-TR")}</div>
    </div>
  );
}

const SC: Record<string, string> = {
  to_join: "var(--green)", already_in: "var(--blue)", invalid: "var(--red)",
  expired: "var(--orange)", pending: "var(--yellow)", resolving: "var(--cyan)",
};
const STATUS_LABEL: Record<string, string> = { to_join: "Katilacak", already_in: "Uye", invalid: "Gecersiz", expired: "Suresi Doldu" };

function StatusChip({ status }: { status: string }) {
  const c = SC[status] ?? "var(--t3)";
  return <span style={{ display: "inline-flex", padding: "2px 7px", borderRadius: 5, fontSize: 9, fontWeight: 700, letterSpacing: ".3px",
    color: c, background: `color-mix(in srgb, ${c} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 20%, transparent)`,
  }}>{STATUS_LABEL[status] ?? status}</span>;
}

function nextPow2(n: number): number {
  const sizes = [16, 32, 64, 128, 256, 512];
  return sizes.find(s => s >= n) ?? 512;
}
function GuildIcon({ guildId, guildIcon, guildName, size = 28 }: { guildId: string; guildIcon?: string | null; guildName: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const ext = guildIcon?.startsWith("a_") ? "gif" : "png";
  const cdnSize = nextPow2(size * 2);
  const url = guildIcon && !failed ? `https://cdn.discordapp.com/icons/${guildId}/${guildIcon}.${ext}?size=${cdnSize}` : null;
  const color = avatarColor(guildId);
  const radius = size > 30 ? 10 : 7;
  if (url) return <img src={url} alt="" style={{ width: size, height: size, borderRadius: radius, flexShrink: 0, objectFit: "cover" }} onError={() => setFailed(true)} />;
  return <div style={{ width: size, height: size, borderRadius: radius, background: color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.4, fontWeight: 700, color: "#fff", flexShrink: 0 }}>{(guildName[0] ?? "?").toUpperCase()}</div>;
}

function InviteLink({ code }: { code: string }) {
  return (
    <a href={`https://discord.gg/${code}`} target="_blank" rel="noopener noreferrer"
      style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--blue)", textDecoration: "none", opacity: 0.8 }}
      onMouseEnter={e => { e.currentTarget.style.textDecoration = "underline"; e.currentTarget.style.opacity = "1"; }}
      onMouseLeave={e => { e.currentTarget.style.textDecoration = "none"; e.currentTarget.style.opacity = "0.8"; }}>
      {code}
    </a>
  );
}

function AccBadge({ label, color }: { label?: string | null; color?: string }) {
  if (!label) return null;
  const c = color ?? "var(--blurple)";
  return (
    <span style={{ fontSize: 9, padding: "2px 8px", borderRadius: 10, fontWeight: 600,
      color: c, background: `color-mix(in srgb, ${c} 8%, transparent)`,
      border: `1px solid color-mix(in srgb, ${c} 15%, transparent)`,
      whiteSpace: "nowrap", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", display: "inline-block",
    }}>{label}</span>
  );
}

function Pill({ label, count, active, color, onClick }: { label: string; count?: number; active: boolean; color: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 12px", borderRadius: 20, fontSize: 11, fontWeight: 600,
      border: active ? `1.5px solid ${color}` : "1.5px solid var(--b1)", cursor: "pointer",
      color: active ? "#fff" : "var(--t3)",
      background: active ? `color-mix(in srgb, ${color} 85%, black)` : "transparent",
      transition: "all .15s ease",
    }}>
      {label}
      {count != null && count > 0 && <span style={{ fontSize: 9, opacity: active ? 0.8 : 0.5, fontFamily: "var(--mono)" }}>{fmt(count)}</span>}
    </button>
  );
}

function ProgressBanner({ label, current, total, color = "var(--blurple)" }: { label: string; current: number; total: number; color?: string }) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  return (
    <div style={{ marginBottom: 12, padding: "10px 16px", borderRadius: 10, border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
      background: `color-mix(in srgb, ${color} 5%, transparent)` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <Spinner />
        <span style={{ fontSize: 12, fontWeight: 600, color }}>{label}</span>
        <span style={{ fontSize: 11, color: "var(--t3)", fontFamily: "var(--mono)", marginLeft: "auto" }}>{pct}%</span>
      </div>
      <div style={{ height: 4, background: "var(--g1)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 2, transition: "width .3s" }} />
      </div>
      <div style={{ fontSize: 10, color: "var(--t4)", fontFamily: "var(--mono)", marginTop: 4 }}>{current} / {total}</div>
    </div>
  );
}

function DropMenu({ trigger, children }: { trigger: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button className="btn btn-secondary btn-sm" onClick={() => setOpen(!open)}
        style={{ display: "flex", alignItems: "center", gap: 5 }}>
        {trigger} <span style={{ fontSize: 8, opacity: 0.5 }}>{open ? "\u25B2" : "\u25BC"}</span>
      </button>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 999 }} onClick={() => setOpen(false)} />
          <div style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 1000,
            background: "var(--bg1, #1a1b1e)", border: "1px solid var(--b1)", borderRadius: 10,
            padding: 6, minWidth: 240, boxShadow: "0 12px 40px rgba(0,0,0,.6)",
            backdropFilter: "blur(20px)",
          }} onClick={() => setOpen(false)}>{children}</div>
        </>
      )}
    </div>
  );
}
function MenuItem({ label, desc, onClick, danger }: { label: string; desc?: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} style={{
      display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: "none", borderRadius: 8,
      background: "transparent", cursor: "pointer", color: danger ? "var(--red)" : "var(--t1)", fontSize: 12,
      transition: "background .1s",
    }}
      onMouseEnter={e => e.currentTarget.style.background = "var(--g0)"}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
      <div style={{ fontWeight: 600 }}>{label}</div>
      {desc && <div style={{ fontSize: 10, color: danger ? "color-mix(in srgb, var(--red) 60%, var(--t4))" : "var(--t4)", marginTop: 2 }}>{desc}</div>}
    </button>
  );
}

function Pager({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4, padding: "10px 0" }}>
      <button className="btn btn-secondary btn-xs" disabled={page <= 0} onClick={() => onChange(page - 1)}
        style={{ fontSize: 11, padding: "3px 10px" }}>&laquo; Onceki</button>
      <span style={{ fontSize: 11, color: "var(--t3)", fontFamily: "var(--mono)", padding: "0 8px" }}>
        {page + 1} / {totalPages}
      </span>
      <button className="btn btn-secondary btn-xs" disabled={page >= totalPages - 1} onClick={() => onChange(page + 1)}
        style={{ fontSize: 11, padding: "3px 10px" }}>Sonraki &raquo;</button>
    </div>
  );
}

function MemberBadge({ isMember }: { isMember: boolean }) {
  const c = isMember ? "var(--green)" : "var(--red)";
  return <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 10, fontWeight: 600,
    color: c, background: `color-mix(in srgb, ${c} 10%, transparent)`,
  }}>{isMember ? "Uye" : "Degil"}</span>;
}

const PAGE_SIZE = 50;

/* ════════════════════════════════════════════════════════════════════════════
   TAB 1 — INVITE POOL (paginated, 100K scale)
   ════════════════════════════════════════════════════════════════════════════ */
function InvitePoolTab() {
  const [showAdd, setShowAdd] = useState(false);
  const [codes, setCodes] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [activeJob, setActiveJob] = useState<InvitePoolJob | null>(null);
  const [fullCheckJob, setFullCheckJob] = useState<InvitePoolJob | null>(null);

  const [statusFilter, setStatusFilter] = useState("");
  const [accountFilter, setAccountFilter] = useState("");
  const [searchRaw, setSearchRaw] = useState("");
  const searchQ = useDebounce(searchRaw, 400);
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(0);

  const [invites, setInvites] = useState<InvitePoolEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<AccountListEntry[]>([]);

  useEffect(() => { api.guilds.accountList().then((r) => setAccounts(r?.accounts ?? [])).catch(() => {}); }, []);

  // Recover running jobs on mount (e.g. after tab navigation)
  useEffect(() => {
    api.guilds.invites.activeJob().then((j: any) => {
      if (j && j.status === 'running') setActiveJob(j as InvitePoolJob);
    }).catch(() => {});
  }, []);

  // Reset page on filter change
  useEffect(() => { setPage(0); }, [statusFilter, searchQ, accountFilter, sort]);

  const fetchInvites = useCallback(async () => {
    try {
      const r = await api.guilds.invites.list({
        limit: PAGE_SIZE, offset: page * PAGE_SIZE,
        status: statusFilter || undefined, q: searchQ || undefined,
        ...(accountFilter ? (/^\d{17,20}$/.test(accountFilter)
          ? { accountId: accountFilter }
          : { accountIdx: accountFilter }) : {}),
        sort,
      }) as InviteListResponse;
      setInvites(r.invites ?? []);
      setTotal(r.total ?? 0);
      if (r.statusCounts) setStatusCounts(r.statusCounts);
    } catch {} finally { setLoading(false); }
  }, [statusFilter, searchQ, accountFilter, sort, page]);

  useEffect(() => { setLoading(true); fetchInvites(); }, [fetchInvites]);
  useInterval(fetchInvites, 6000, false);

  // Job polling
  useEffect(() => {
    if (!activeJob || activeJob.status !== "running") return;
    const id = setInterval(async () => {
      try {
        const j = await api.guilds.invites.jobStatus(activeJob.jobId) as InvitePoolJob;
        setActiveJob(j);
        if (j.status !== "running") { fetchInvites(); clearInterval(id);
          addToast({ type: "success", title: "Tamamlandi", msg: `${j.toJoin} katilacak | ${j.alreadyIn} zaten var | ${j.invalid} gecersiz` }); }
      } catch {}
    }, 1500);
    return () => clearInterval(id);
  }, [activeJob, fetchInvites]);

  useEffect(() => {
    if (!fullCheckJob || fullCheckJob.status !== "running") return;
    const id = setInterval(async () => {
      try {
        const j = await api.guilds.invites.jobStatus(fullCheckJob.jobId) as InvitePoolJob;
        setFullCheckJob(j);
        if (j.status !== "running") { fetchInvites(); clearInterval(id);
          addToast({ type: "success", title: "Genel Kontrol Bitti", msg: `${j.processed} kontrol | ${j.toJoin} katilacak | ${j.alreadyIn} zaten var` }); }
      } catch {}
    }, 1500);
    return () => clearInterval(id);
  }, [fullCheckJob, fetchInvites]);

  const selectedFileNames = useMemo(() => selectedFiles.map(file => file.name), [selectedFiles]);

  function resetBatchInputs() {
    setCodes("");
    setSelectedFiles([]);
    setFileInputKey(v => v + 1);
    setShowAdd(false);
  }

  async function readFileEntries(files: File[]): Promise<Array<{ code: string; sourceName: string | null }>> {
    const entries = await Promise.all(files.map(async file => {
      const text = await file.text();
      const sourceName = file.name.trim() || null;
      return text.split(/[\n,]+/).map(s => s.trim()).filter(Boolean).map(code => ({ code, sourceName }));
    }));
    return entries.flat();
  }

  async function submitBatch() {
    const manualEntries = codes.split(/[\n,]+/).map(s => s.trim()).filter(Boolean).map(code => ({ code, sourceName: null }));
    const fileEntries = selectedFiles.length > 0 ? await readFileEntries(selectedFiles) : [];
    const entries = [...manualEntries, ...fileEntries];
    if (!entries.length) return;
    setSubmitting(true);
    try {
      const r = await api.guilds.invites.addBatch(entries) as { jobId: string; totalCodes: number };
      setActiveJob({ jobId: r.jobId, totalCodes: r.totalCodes, processed: 0, alreadyIn: 0, toJoin: 0, invalid: 0, status: "running" });
      resetBatchInputs();
    } catch (e) { addToast({ type: "error", title: "Hata", msg: (e as Error).message }); }
    finally { setSubmitting(false); }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const codeCount = codes.split(/[\n,]+/).filter(s => s.trim()).length;
  const allCount = (statusCounts["to_join"] ?? 0) + (statusCounts["already_in"] ?? 0);

  return (
    <div>
      {/* Progress banners */}
      {activeJob?.status === "running" && <ProgressBanner label="Davetler isleniyor..." current={activeJob.processed} total={activeJob.totalCodes} />}
      {fullCheckJob?.status === "running" && <ProgressBanner label="Genel kontrol..." current={fullCheckJob.processed} total={fullCheckJob.totalCodes} color="var(--orange)" />}

      {/* Toolbar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        <input className="input input-sm" type="search" placeholder="Sunucu, kod, ID veya txt adi ara..." value={searchRaw}
          onChange={e => setSearchRaw(e.target.value)} style={{ width: 260 }} />

        <select className="input input-sm" value={accountFilter} onChange={e => setAccountFilter(e.target.value)} style={{ width: 200 }}>
          <option value="">Tum Hesaplar</option>
          {accounts.map(a => <option key={a.accountId || a.idx} value={a.accountId || String(a.idx)}>{a.label || a.username} ({a.assignedCount}/{a.maxGuilds})</option>)}
        </select>

        <select className="input input-sm" value={sort} onChange={e => setSort(e.target.value)} style={{ width: 120 }}>
          <option value="newest">En Yeni</option>
          <option value="name">Ada Gore</option>
          <option value="members">Uye Sayisi</option>
        </select>

        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(!showAdd)}>
            {showAdd ? "Kapat" : "+ Davet Ekle"}
          </button>
          <DropMenu trigger="Islemler">
            <MenuItem label="Uyelik Kontrol" desc="Tum hesaplarin sunucu durumunu dogrula" onClick={async () => {
              try { const r = await (api.guilds.invites as any).verify() as any;
                addToast({ type: "success", title: "Kontrol bitti", msg: `${r.verified} kontrol | ${r.nowJoined} katilim | ${r.leftGuild ?? 0} ayrilma` }); fetchInvites();
              } catch (e) { addToast({ type: "error", title: "Hata", msg: (e as Error).message }); }
            }} />
            <MenuItem label="Genel Kontrol" desc="Tum davet kodlarini Discord API ile dogrula" onClick={async () => {
              try { const r = await (api.guilds.invites as any).fullCheck() as { jobId: string };
                setFullCheckJob({ jobId: r.jobId, totalCodes: 0, processed: 0, alreadyIn: 0, toJoin: 0, invalid: 0, status: "running" });
              } catch (e) { addToast({ type: "error", title: "Hata", msg: (e as Error).message }); }
            }} />
            <MenuItem label="Mevcut Sunuculari Aktar" desc="Hesaplardaki tum sunuculari iceri aktar" onClick={async () => {
              try { const r = await (api.guilds as any).importExisting() as any;
                addToast({ type: "success", title: "Import", msg: `${r.imported} eklendi, ${r.skipped} mevcut${r.reowned ? `, ${r.reowned} sahip duzeltildi` : ''}${r.reassigned ? `, ${r.reassigned} bekleyen atandi` : ''}, ${r.categorized} kategorize` }); fetchInvites();
              } catch (e) { addToast({ type: "error", title: "Hata", msg: (e as Error).message }); }
            }} />
            <MenuItem label="Bekleyenleri Ata" desc="Hesap bekleyen sunuculari musait hesaplara ata" onClick={async () => {
              try { const r = await (api.guilds as any).reassignWaiting() as any;
                addToast({ type: "success", title: "Atama", msg: `${r.reassigned} bekleyen sunucu hesaplara atandi` }); fetchInvites();
              } catch (e) { addToast({ type: "error", title: "Hata", msg: (e as Error).message }); }
            }} />
            <div style={{ height: 1, background: "var(--b1)", margin: "4px 10px" }} />
            <MenuItem label="Zaten Uye Olanlari Temizle" desc="already_in durumdaki tum kayitlari kaldir" danger onClick={async () => {
              try { const r = await api.guilds.invites.cleanup() as { removed: number };
                addToast({ type: "success", title: "Temizlendi", msg: `${r.removed} kayit silindi` }); fetchInvites();
              } catch (e) { addToast({ type: "error", title: "Hata", msg: (e as Error).message }); }
            }} />
          </DropMenu>
        </div>
      </div>

      {/* Add panel (collapsible) */}
      {showAdd && (
        <div className="panel" style={{ marginBottom: 14, animation: "slideUp .15s ease" }}>
          <div style={{ padding: "14px 16px" }}>
            <textarea className="input" value={codes} onChange={e => setCodes(e.target.value)}
              placeholder="discord.gg/abc123&#10;discord.gg/xyz789&#10;...her satira bir davet kodu"
              rows={4} style={{ resize: "vertical", fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.7 }} />
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              <input key={fileInputKey} className="input" type="file" accept=".txt,text/plain" multiple onChange={e => setSelectedFiles(Array.from(e.target.files ?? []))} />
              {selectedFiles.length > 0 ? (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {selectedFiles.map(file => (
                    <span key={`${file.name}-${file.size}-${file.lastModified}`} style={{ fontSize: 10, color: "var(--t3)", background: "var(--g0)", border: "1px solid var(--b1)", padding: "4px 8px", borderRadius: 999, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {file.name}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
              <button className="btn btn-primary btn-sm" onClick={submitBatch} disabled={submitting || (!codes.trim() && selectedFiles.length === 0)}>
                {submitting ? <Spinner /> : "Havuza Ekle"}
              </button>
              {codeCount > 0 && <span style={{ fontSize: 11, color: "var(--t3)", fontFamily: "var(--mono)", background: "var(--g0)", padding: "3px 10px", borderRadius: 12 }}>{codeCount} kod</span>}
              {selectedFileNames.length > 0 && <span style={{ fontSize: 11, color: "var(--t3)", fontFamily: "var(--mono)", background: "var(--g0)", padding: "3px 10px", borderRadius: 12 }}>{selectedFileNames.length} txt</span>}
              <button className="btn btn-secondary btn-sm" onClick={resetBatchInputs} style={{ marginLeft: "auto" }}>Iptal</button>
            </div>
          </div>
        </div>
      )}

      {/* Filter pills */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        <Pill label="Tumu" count={allCount} active={!statusFilter} color="var(--blurple)" onClick={() => setStatusFilter("")} />
        <Pill label="Katilacak" count={statusCounts["to_join"]} active={statusFilter === "to_join"} color="var(--green)" onClick={() => setStatusFilter(statusFilter === "to_join" ? "" : "to_join")} />
        <Pill label="Zaten Uye" count={statusCounts["already_in"]} active={statusFilter === "already_in"} color="var(--blue)" onClick={() => setStatusFilter(statusFilter === "already_in" ? "" : "already_in")} />
        {(statusCounts["waiting"] ?? 0) > 0 && <Pill label="Bekliyor" count={statusCounts["waiting"]} active={statusFilter === "waiting"} color="var(--yellow, #f5a623)" onClick={() => setStatusFilter(statusFilter === "waiting" ? "" : "waiting")} />}

        {(statusCounts["waiting"] ?? 0) > 0 && (
          <button className="btn btn-sm" style={{ background: "var(--green)", color: "#fff", fontWeight: 600, fontSize: 11, padding: "4px 12px", borderRadius: 8, border: "none", cursor: "pointer" }}
            onClick={async () => {
              try {
                const r = await (api.guilds as any).reassignWaiting() as any;
                addToast({ type: "success", title: "Atama", msg: `${r.reassigned} bekleyen sunucu hesaplara atandi` });
                fetchInvites();
              } catch (e) { addToast({ type: "error", title: "Hata", msg: (e as Error).message }); }
            }}>Bekleyenleri Ata</button>
        )}

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, color: "var(--t4)" }}>{fmt(total)} sonuc</span>
          {totalPages > 1 && <span style={{ fontSize: 10, color: "var(--t5)" }}>Sayfa {page + 1}/{totalPages}</span>}
        </div>
      </div>

      {/* Guild list */}
      <div className="panel" style={{ overflow: "hidden", borderRadius: 12 }}>
        {loading && invites.length === 0 ? <div className="empty" style={{ height: 140 }}><Spinner /></div> : invites.length === 0 ? (
          <Empty text={searchRaw || statusFilter || accountFilter ? "Filtre sonucu bos" : "Davet havuzu bos — yukaridaki + butonuyla ekleyin"} />
        ) : (
          <>
            <div style={{ maxHeight: 520, overflowY: "auto" }}>
              {invites.map((inv, i) => (
                <div key={inv.inviteCode} style={{
                  display: "flex", alignItems: "center", gap: 12, padding: "10px 16px",
                  borderBottom: i < invites.length - 1 ? "1px solid var(--b0)" : "none",
                  transition: "background .1s",
                }}
                  onMouseEnter={e => e.currentTarget.style.background = "var(--g0)"}
                  onMouseLeave={e => e.currentTarget.style.background = ""}>

                  <GuildIcon guildId={inv.guildId ?? ""} guildIcon={inv.guildIcon} guildName={inv.guildName ?? "?"} size={38} />

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {inv.guildName ?? "Bilinmeyen"}
                      </span>
                      <StatusChip status={inv.status} />
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      {inv.memberCount > 0 && <span style={{ fontSize: 10, color: "var(--t4)" }}>{fmt(inv.memberCount)} uye</span>}
                      {inv.inviteCode && !inv.inviteCode.startsWith("existing_") && <InviteLink code={inv.inviteCode} />}
                      {inv.guildId && <span style={{ fontSize: 9, color: "var(--t5)", fontFamily: "var(--mono)" }}>{inv.guildId}</span>}
                    </div>
                    {inv.sourceName ? (
                      <div style={{ marginTop: 6, fontSize: 10, color: "var(--t4)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        {inv.sourceName}
                      </div>
                    ) : null}
                  </div>

                  <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
                    {inv.status === "already_in" && inv.ownerAccountId != null ? (
                      <AccBadge label={inv.ownerAccountName} color="var(--green)" />
                    ) : inv.status === "to_join" && inv.assignedAccountId != null ? (
                      <AccBadge label={inv.assignedAccountName ?? inv.assignedAccountId} color="var(--orange)" />
                    ) : null}

                    <button className="btn btn-danger btn-icon btn-xs" style={{ opacity: 0.4, transition: "opacity .15s" }}
                      onMouseEnter={e => e.currentTarget.style.opacity = "1"}
                      onMouseLeave={e => e.currentTarget.style.opacity = "0.4"}
                      onClick={async () => { await api.guilds.invites.remove(inv.inviteCode); fetchInvites(); }}>x</button>
                  </div>
                </div>
              ))}
            </div>
            <Pager page={page} totalPages={totalPages} onChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   TAB 2 — CATEGORIES (per-account, paginated)
   ════════════════════════════════════════════════════════════════════════════ */
function CategoriesTab() {
  const [cats, setCats] = useState<JoinCategory[]>([]);
  const [totalCats, setTotalCats] = useState(0);
  const [loading, setLoading] = useState(true);
  const [catSearchRaw, setCatSearchRaw] = useState("");
  const catSearchQ = useDebounce(catSearchRaw, 300);
  const [catPage, setCatPage] = useState(0);
  const [selectedCat, setSelectedCat] = useState<string | null>(null);

  const [catGuilds, setCatGuilds] = useState<CategoryGuildEntry[]>([]);
  const [catGuildsTotal, setCatGuildsTotal] = useState(0);
  const [catLoading, setCatLoading] = useState(false);
  const [guildSearchRaw, setGuildSearchRaw] = useState("");
  const guildSearchQ = useDebounce(guildSearchRaw, 300);
  const [memberFilter, setMemberFilter] = useState("");

  useEffect(() => { setCatPage(0); }, [catSearchQ]);

  const fetchCats = useCallback(async () => {
    try {
      const r = await api.guilds.categories.list({ limit: PAGE_SIZE, offset: catPage * PAGE_SIZE, q: catSearchQ || undefined }) as { categories: JoinCategory[]; total: number };
      setCats(r.categories ?? []); setTotalCats(r.total ?? 0);
    } catch {} finally { setLoading(false); }
  }, [catSearchQ, catPage]);

  const fetchCatGuilds = useCallback(async (catId: string) => {
    setCatLoading(true);
    try {
      const r = await api.guilds.categories.guilds(catId, { q: guildSearchQ || undefined, membership: memberFilter || undefined, limit: 200 }) as CategoryGuildsResponse;
      setCatGuilds(r.guilds ?? []); setCatGuildsTotal(r.total ?? 0);
    } catch {} finally { setCatLoading(false); }
  }, [guildSearchQ, memberFilter]);

  useEffect(() => { fetchCats(); }, [fetchCats]);
  useEffect(() => { if (selectedCat) fetchCatGuilds(selectedCat); }, [selectedCat, fetchCatGuilds]);

  async function removeGuild(guildId: string) {
    if (!selectedCat) return;
    try { await api.guilds.categories.removeGuild(selectedCat, guildId); fetchCatGuilds(selectedCat); fetchCats(); }
    catch (e) { addToast({ type: "error", title: "Hata", msg: (e as Error).message }); }
  }

  const sel = cats.find(c => c.categoryId === selectedCat);
  const memberCount = catGuilds.filter(g => g.isMember).length;
  const catTotalPages = Math.ceil(totalCats / PAGE_SIZE);

  return (
    <div style={{ display: "flex", gap: 14, minHeight: 450 }}>
      {/* Left panel — account list */}
      <div style={{ width: 300, flexShrink: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".6px", color: "var(--t4)" }}>
            Hesaplar ({fmt(totalCats)})
          </span>
        </div>
        <input className="input input-sm" type="search" placeholder="Hesap ara..." value={catSearchRaw}
          onChange={e => setCatSearchRaw(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
        <div className="panel" style={{ flex: 1, overflow: "auto", maxHeight: 480 }}>
          {loading ? <div className="empty" style={{ height: 80 }}><Spinner /></div> : cats.length === 0 ? (
            <Empty text="Kategori yok" />
          ) : cats.map(cat => {
            const pct = Math.min(100, Math.round((cat.guildCount / 100) * 100));
            const barColor = pct >= 90 ? "var(--red)" : pct >= 60 ? "var(--orange)" : "var(--green)";
            const active = selectedCat === cat.categoryId;
            return (
              <div key={cat.categoryId} onClick={() => setSelectedCat(cat.categoryId)}
                style={{
                  padding: "10px 14px", borderBottom: "1px solid var(--b0)", cursor: "pointer",
                  background: active ? "rgba(88,101,242,.08)" : undefined, transition: "background .1s",
                  borderLeft: active ? "3px solid var(--blurple)" : "3px solid transparent",
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = "var(--g0)"; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.background = ""; }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                    {cat.accountLabel ?? cat.name}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--t3)", fontFamily: "var(--mono)", flexShrink: 0 }}>{cat.guildCount}/100</span>
                </div>
                <div style={{ height: 3, background: "var(--g1)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${pct}%`, background: barColor, borderRadius: 2, transition: "width .3s" }} />
                </div>
              </div>
            );
          })}
        </div>
        <Pager page={catPage} totalPages={catTotalPages} onChange={setCatPage} />
      </div>

      {/* Right panel — guilds */}
      <div className="panel" style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div className="panel-head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div>
            <span className="panel-title">{sel ? (sel.accountLabel ?? sel.name) : "Bir hesap secin"}</span>
            {sel?.accountDiscordId && <span style={{ fontSize: 10, color: "var(--t4)", fontFamily: "var(--mono)", marginLeft: 8 }}>{sel.accountDiscordId}</span>}
          </div>
          {selectedCat && (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input className="input input-sm" type="search" placeholder="Sunucu ara..." value={guildSearchRaw}
                onChange={e => setGuildSearchRaw(e.target.value)} style={{ width: 160 }} />
              <select className="input input-sm" value={memberFilter} onChange={e => setMemberFilter(e.target.value)} style={{ width: 100 }}>
                <option value="">Tumu</option>
                <option value="in">Uye ({memberCount})</option>
                <option value="out">Degil ({catGuildsTotal - memberCount})</option>
              </select>
              <span style={{ fontSize: 10, color: "var(--t3)", fontFamily: "var(--mono)" }}>{catGuildsTotal}/100</span>
            </div>
          )}
        </div>
        <div style={{ flex: 1, overflow: "auto" }}>
          {!selectedCat ? (
            <Empty text="Sol panelden bir hesap secin" />
          ) : catLoading ? (
            <div className="empty" style={{ height: 120 }}><Spinner /></div>
          ) : catGuilds.length === 0 ? (
            <Empty text={guildSearchRaw || memberFilter ? "Filtre sonucu bos" : "Sunucu yok"} />
          ) : catGuilds.map((g, i) => (
            <div key={g.guildId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px",
              borderBottom: i < catGuilds.length - 1 ? "1px solid var(--b0)" : "none" }}>
              <GuildIcon guildId={g.guildId} guildIcon={g.guildIcon} guildName={g.guildName} size={28} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.guildName || g.guildId}</div>
                <div style={{ fontSize: 9, color: "var(--t4)", fontFamily: "var(--mono)" }}>{g.guildId}</div>
              </div>
              <MemberBadge isMember={g.isMember} />
              {g.inviteCode && !g.inviteCode.startsWith("existing_") && <InviteLink code={g.inviteCode} />}
              <button className="btn btn-danger btn-icon btn-xs" style={{ opacity: 0.4 }}
                onMouseEnter={e => e.currentTarget.style.opacity = "1"}
                onMouseLeave={e => e.currentTarget.style.opacity = "0.4"}
                onClick={() => removeGuild(g.guildId)}>x</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   ARCHIVED ACCOUNTS TAB
   ════════════════════════════════════════════════════════════════════════════ */
const MEMBERSHIP_LABEL: Record<string, string> = { member: "Uye", owner: "Sahip", assigned: "Atanmis", to_join: "Katilacak" };
const MEMBERSHIP_COLOR: Record<string, string> = { member: "var(--green)", owner: "var(--blurple)", assigned: "var(--orange)", to_join: "var(--yellow)" };
const REASON_LABEL: Record<string, string> = { banned: "Banli", disabled: "Devre Disi", token_expired: "Token Suresi Doldu", manual: "Manuel" };

function ArchivedAccountsTab() {
  const [accounts, setAccounts] = useState<ArchivedAccount[]>([]);
  const [failedAccounts, setFailedAccounts] = useState<FailedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ArchivedDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Transfer state
  const [transferToken, setTransferToken] = useState("");
  const [transferring, setTransferring] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);

  // Archive new account
  const [archiveId, setArchiveId] = useState("");
  const [archiveReason, setArchiveReason] = useState("manual");
  const [archiving, setArchiving] = useState(false);
  const [showArchiveForm, setShowArchiveForm] = useState(false);

  const fetchList = useCallback(async () => {
    try {
      const [archiveRes, failedRes] = await Promise.all([
        api.archive.list(),
        api.archive.failed(),
      ]);
      setAccounts(archiveRes.accounts ?? []);
      setFailedAccounts(failedRes.accounts ?? []);
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchList(); }, [fetchList]);
  useInterval(fetchList, 10_000, false);

  const fetchDetail = useCallback(async (accId: string) => {
    setDetailLoading(true);
    try {
      const r = await api.archive.detail(accId);
      setDetail(r);
    } catch { setDetail(null); }
    finally { setDetailLoading(false); }
  }, []);

  useEffect(() => { if (selected) fetchDetail(selected); else setDetail(null); }, [selected, fetchDetail]);

  async function handleArchive(e: React.FormEvent) {
    e.preventDefault();
    if (!archiveId.trim()) return;
    setArchiving(true);
    try {
      await api.archive.create(archiveId.trim(), archiveReason);
      addToast({ type: "success", title: "Hesap arsivlendi", msg: archiveId });
      setArchiveId(""); setShowArchiveForm(false);
      await fetchList();
    } catch (e) { addToast({ type: "error", title: "Arsivleme hatasi", msg: (e as Error).message }); }
    finally { setArchiving(false); }
  }

  async function handleDelete(accId: string) {
    if (!confirm(`"${accId}" arsivini silmek istediginize emin misiniz?`)) return;
    try {
      await api.archive.remove(accId);
      addToast({ type: "success", title: "Arsiv silindi" });
      if (selected === accId) { setSelected(null); setDetail(null); }
      await fetchList();
    } catch (e) { addToast({ type: "error", title: "Hata", msg: (e as Error).message }); }
  }

  async function handleTransfer() {
    if (!selected || !transferToken.trim()) return;
    setTransferring(true);
    try {
      const r = await api.archive.transfer(selected, transferToken.trim());
      addToast({ type: "success", title: "Transfer basarili", msg: `${r.newUsername} (${r.newAccountId}) — ${r.invitesCreated} davet, ${r.targetsCreated} hedef olusturuldu` });
      setTransferToken(""); setShowTransfer(false);
      await fetchList();
      await fetchDetail(selected);
    } catch (e) { addToast({ type: "error", title: "Transfer hatasi", msg: (e as Error).message }); }
    finally { setTransferring(false); }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: detail ? "1fr 1fr" : "1fr", gap: 14, minHeight: 400 }}>
      {/* Left: Account list */}
      <div className="panel" style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div className="panel-head">
          <span className="panel-title">Kapanan Hesaplar</span>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "var(--t4)", fontFamily: "var(--mono)" }}>{accounts.length}</span>
            <button className="btn btn-primary btn-xs" onClick={() => setShowArchiveForm(v => !v)}>
              {showArchiveForm ? "Kapat" : "+ Arsivle"}
            </button>
          </div>
        </div>

        {showArchiveForm && (
          <form onSubmit={handleArchive} style={{ padding: 12, borderBottom: "1px solid var(--b0)", display: "flex", gap: 8, alignItems: "flex-end", background: "rgba(0,0,0,.1)" }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 10, fontWeight: 600, color: "var(--t3)", display: "block", marginBottom: 3 }}>Discord Hesap ID</label>
              <input className="input input-sm" placeholder="123456789012345678" value={archiveId} onChange={e => setArchiveId(e.target.value)} disabled={archiving} />
            </div>
            <div>
              <label style={{ fontSize: 10, fontWeight: 600, color: "var(--t3)", display: "block", marginBottom: 3 }}>Sebep</label>
              <select className="input input-sm" value={archiveReason} onChange={e => setArchiveReason(e.target.value)} style={{ width: 130 }}>
                <option value="manual">Manuel</option>
                <option value="banned">Banli</option>
                <option value="disabled">Devre Disi</option>
                <option value="token_expired">Token Doldu</option>
              </select>
            </div>
            <button className="btn btn-primary btn-xs" type="submit" disabled={archiving || !archiveId.trim()}>
              {archiving ? <Spinner /> : "Arsivle"}
            </button>
          </form>
        )}

        <div style={{ flex: 1, overflowY: "auto" }}>
          {/* Failed accounts (auto-detected) */}
          {failedAccounts.length > 0 && (
            <div style={{ borderBottom: "2px solid var(--red-d)" }}>
              <div style={{ padding: "8px 16px", fontSize: 10, fontWeight: 700, color: "var(--red)", textTransform: "uppercase", letterSpacing: ".7px", background: "var(--red-d)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>Otomatik Algilanan ({failedAccounts.length})</span>
              </div>
              {failedAccounts.map(fa => (
                <div key={fa.accountId} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--b0)", background: "rgba(255,69,58,.03)" }}>
                  <div style={{ width: 32, height: 32, borderRadius: "50%", background: "var(--red-d)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: "var(--red)", flexShrink: 0, border: "1px solid rgba(255,69,58,.3)" }}>!</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--t1)" }}>{fa.username || fa.accountId}</div>
                    <div style={{ fontSize: 9, color: "var(--t4)", fontFamily: "var(--mono)", display: "flex", gap: 8 }}>
                      <span>{fa.tokenHint}</span>
                      {fa.detectedAt && <span>{fmtTs(fa.detectedAt)}</span>}
                    </div>
                  </div>
                  <button className="btn btn-primary btn-xs" onClick={async () => {
                    const accId = fa.accountId.startsWith("unknown_") ? prompt("Discord Hesap ID giriniz:") : fa.accountId;
                    if (!accId) return;
                    try {
                      await api.archive.create(accId, "login_failed");
                      await api.archive.clearFailed(fa.accountId);
                      addToast({ type: "success", title: "Arsivlendi", msg: fa.username || accId });
                      await fetchList();
                    } catch (e) { addToast({ type: "error", title: "Hata", msg: (e as Error).message }); }
                  }}>Arsivle</button>
                  <button className="btn btn-ghost btn-icon btn-xs" style={{ color: "var(--t4)" }} onClick={async () => {
                    await api.archive.clearFailed(fa.accountId); await fetchList();
                  }}>x</button>
                </div>
              ))}
            </div>
          )}

          {loading ? <div style={{ padding: 40, textAlign: "center" }}><Spinner /></div>
          : accounts.length === 0 && failedAccounts.length === 0 ? <Empty text="Arsivlenmis hesap yok" />
          : accounts.map(acc => (
            <div key={acc.accountId}
              onClick={() => setSelected(acc.accountId === selected ? null : acc.accountId)}
              style={{
                display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
                borderBottom: "1px solid var(--b0)", cursor: "pointer",
                background: selected === acc.accountId ? "var(--blurple-d2)" : "transparent",
                transition: "background .1s",
              }}
              onMouseEnter={e => { if (selected !== acc.accountId) e.currentTarget.style.background = "var(--g1)"; }}
              onMouseLeave={e => { if (selected !== acc.accountId) e.currentTarget.style.background = "transparent"; }}
            >
              {/* Avatar */}
              <div style={{ width: 36, height: 36, borderRadius: "50%", background: acc.transferredTo ? "var(--g3)" : "var(--red-d)",
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700,
                color: acc.transferredTo ? "var(--t3)" : "var(--red)", flexShrink: 0,
                border: `1px solid ${acc.transferredTo ? "var(--gb1)" : "rgba(255,69,58,.3)"}` }}>
                {(acc.username?.[0] ?? "?").toUpperCase()}
              </div>

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {acc.username || acc.accountId}
                  </span>
                  <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 4, fontWeight: 600,
                    color: acc.transferredTo ? "var(--green)" : "var(--red)",
                    background: acc.transferredTo ? "var(--green-d)" : "var(--red-d)",
                    border: `1px solid ${acc.transferredTo ? "rgba(48,209,88,.2)" : "rgba(255,69,58,.2)"}` }}>
                    {acc.transferredTo ? "Transfer Edildi" : REASON_LABEL[acc.reason] ?? acc.reason}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: "var(--t4)", marginTop: 2, display: "flex", gap: 10 }}>
                  <span>{acc.guildCount} sunucu</span>
                  <span>{acc.channelCount} kanal</span>
                  <span>{fmt(acc.totalScraped)} mesaj</span>
                </div>
              </div>

              {/* Actions */}
              <button className="btn btn-danger btn-icon btn-xs" style={{ opacity: 0.3, flexShrink: 0 }}
                onClick={e => { e.stopPropagation(); handleDelete(acc.accountId); }}
                onMouseEnter={e => e.currentTarget.style.opacity = "1"}
                onMouseLeave={e => e.currentTarget.style.opacity = "0.3"}>x</button>
            </div>
          ))}
        </div>
      </div>

      {/* Right: Detail panel */}
      {detail && (
        <div className="panel" style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {detailLoading ? <div style={{ padding: 40, textAlign: "center" }}><Spinner /></div> : (
            <>
              {/* Header */}
              <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--b0)", background: "rgba(0,0,0,.15)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: "var(--t1)" }}>{detail.account.username || detail.account.accountId}</span>
                  <span style={{ fontSize: 10, color: "var(--t4)", fontFamily: "var(--mono)" }}>{detail.account.accountId}</span>
                </div>
                <div style={{ display: "flex", gap: 12, fontSize: 11, color: "var(--t3)" }}>
                  <span>{detail.guilds.length} sunucu</span>
                  <span>{detail.channels.length} kanal</span>
                  <span>{fmt(detail.account.totalScraped)} mesaj cekildi</span>
                  {detail.account.archivedAt && <span>Arsiv: {fmtTs(detail.account.archivedAt)}</span>}
                </div>

                {/* Transfer section */}
                {!detail.account.transferredTo ? (
                  <div style={{ marginTop: 10 }}>
                    {!showTransfer ? (
                      <button className="btn btn-primary btn-sm" onClick={() => setShowTransfer(true)}>Transfer Et</button>
                    ) : (
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input className="input input-sm" placeholder="Yeni hesap tokeni" value={transferToken}
                          onChange={e => setTransferToken(e.target.value)} style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 11 }} />
                        <button className="btn btn-primary btn-sm" onClick={handleTransfer} disabled={transferring || !transferToken.trim()}>
                          {transferring ? <Spinner /> : "Onayla"}
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => { setShowTransfer(false); setTransferToken(""); }}>Iptal</button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ marginTop: 8, fontSize: 11, color: "var(--green)", display: "flex", alignItems: "center", gap: 6 }}>
                    <span>Transfer edildi →</span>
                    <span style={{ fontWeight: 600 }}>{detail.account.transferredTo}</span>
                    {detail.account.transferredAt && <span style={{ color: "var(--t4)" }}>({fmtTs(detail.account.transferredAt)})</span>}
                  </div>
                )}
              </div>

              {/* Guilds */}
              <div style={{ borderBottom: "1px solid var(--b0)" }}>
                <div style={{ padding: "8px 18px", fontSize: 10, fontWeight: 700, color: "var(--t4)", textTransform: "uppercase", letterSpacing: ".7px" }}>
                  Sunucular ({detail.guilds.length})
                </div>
                <div style={{ maxHeight: 240, overflowY: "auto" }}>
                  {detail.guilds.map(g => (
                    <div key={g.guildId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 18px", borderBottom: "1px solid var(--b0)", fontSize: 12 }}>
                      <GuildIcon guildId={g.guildId} guildIcon={g.guildIcon} guildName={g.guildName} size={24} />
                      <span style={{ flex: 1, color: "var(--t1)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.guildName || g.guildId}</span>
                      <span style={{ fontSize: 9, color: MEMBERSHIP_COLOR[g.membership] ?? "var(--t3)", fontWeight: 600 }}>
                        {MEMBERSHIP_LABEL[g.membership] ?? g.membership}
                      </span>
                      {g.inviteCode && <InviteLink code={g.inviteCode} />}
                    </div>
                  ))}
                </div>
              </div>

              {/* Channels */}
              <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                <div style={{ padding: "8px 18px", fontSize: 10, fontWeight: 700, color: "var(--t4)", textTransform: "uppercase", letterSpacing: ".7px" }}>
                  Kanallar ({detail.channels.length})
                </div>
                <div style={{ flex: 1, overflowY: "auto" }}>
                  {detail.channels.length === 0 ? <Empty text="Kanal yok" /> : (
                    <table>
                      <thead>
                        <tr>
                          <th>Kanal</th>
                          <th>Mesaj</th>
                          <th>Durum</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.channels.map(ch => (
                          <tr key={ch.channelId}>
                            <td>
                              <div style={{ fontWeight: 500, fontSize: 12, color: "var(--t1)" }}>{ch.channelName || ch.channelId}</div>
                              <div style={{ fontSize: 9, color: "var(--t5)", fontFamily: "var(--mono)" }}>{ch.channelId}</div>
                            </td>
                            <td className="num" style={{ fontSize: 11 }}>{fmt(ch.totalScraped)}</td>
                            <td>
                              {ch.complete
                                ? <span style={{ color: "var(--green)", fontSize: 10, fontWeight: 600 }}>Tamamlandi</span>
                                : ch.cursorId
                                  ? <span style={{ color: "var(--orange)", fontSize: 10, fontWeight: 600 }}>Devam Ediyor</span>
                                  : <span style={{ color: "var(--t4)", fontSize: 10 }}>Baslamadi</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </>
          )}
          
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   MAIN PAGE
   ════════════════════════════════════════════════════════════════════════════ */
type Tab = "invites" | "categories" | "archived";

export function GuildInventory() {
  const [tab, setTab] = useState<Tab>("invites");
  const [stats, setStats] = useState<GuildStatsResponse | null>(null);
  const fetchStats = useCallback(async () => { try { setStats(await api.guilds.stats() as GuildStatsResponse); } catch {} }, []);
  useEffect(() => { fetchStats(); }, [fetchStats]);
  useInterval(fetchStats, 5000, false);

  const [syncing, setSyncing] = useState(false);
  const prevSyncing = React.useRef<boolean | null>(null);

  // Auto-refresh icons when sync transitions from true → false
  useEffect(() => {
    const isSyncing = stats?.sync?.syncing ?? false;
    if (prevSyncing.current === true && isSyncing === false) {
      api.guilds.refreshIcons().then((r: any) => {
        if (r?.updatedPool > 0 || r?.updatedCat > 0) {
          addToast({ type: "success", title: "Ikonlar guncellendi", msg: `${r.updatedPool ?? 0} davet, ${r.updatedCat ?? 0} kategori` });
        }
      }).catch(() => {});
    }
    prevSyncing.current = isSyncing;
  }, [stats?.sync?.syncing]);

  async function triggerSync() {
    setSyncing(true);
    try { await api.guilds.triggerSync(); addToast({ type: "info", title: "Guild Sync baslatildi" }); }
    catch (e) { addToast({ type: "error", title: "Hata", msg: (e as Error).message }); }
    finally { setSyncing(false); }
  }

  return (
    <div className="page-enter">
      {/* Stats row */}
      <div className="stat-grid stat-grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Benzersiz Sunucu" value={stats?.totalUniqueGuilds ?? 0} color="var(--blurple)" delay={0} />
        <Stat label="Toplam Uyelik" value={stats?.totalMemberships ?? 0} color="var(--green)" delay={30} />
        <Stat label="Katilacak" value={stats?.invitePool?.to_join ?? 0} color="var(--orange)" delay={60} />
        <Stat label="Hesap Sayisi" value={stats?.totalCategories ?? 0} color="var(--purple)" delay={90} />
      </div>

      {/* Nav bar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
        {/* Sync status */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {stats?.sync?.syncing ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--orange)" }}>
              <Spinner /><span>Sync {stats.sync.syncedAccounts}/{stats.sync.totalAccounts}</span>
            </div>
          ) : stats?.sync?.lastSyncAt ? (
            <span style={{ fontSize: 10, color: "var(--t4)" }}>Sync: <span style={{ fontFamily: "var(--mono)", color: "var(--t3)" }}>{fmtTs(stats.sync.lastSyncAt)}</span></span>
          ) : null}
          <button className="btn btn-secondary btn-xs" onClick={triggerSync} disabled={syncing || stats?.sync?.syncing}
            style={{ fontSize: 10 }}>
            {syncing ? <Spinner /> : "Sync"}
          </button>
          <button className="btn btn-secondary btn-xs" style={{ fontSize: 10 }}
            onClick={() => {
              api.guilds.refreshIcons().then((r: any) => {
                addToast({ type: r?.updatedPool > 0 || r?.updatedCat > 0 ? "success" : "info",
                  title: r?.updatedPool > 0 || r?.updatedCat > 0 ? "Ikonlar guncellendi" : "Ikon degisiklik yok",
                  msg: r?.updatedPool > 0 || r?.updatedCat > 0 ? `${r.updatedPool ?? 0} davet, ${r.updatedCat ?? 0} kategori guncellendi` : `${r?.iconMapSize ?? 0} ikon bulundu`,
                });
              }).catch((e: Error) => addToast({ type: "error", title: "Hata", msg: e.message }));
            }}>
            İkon Güncelle
          </button>
        </div>

        {/* Tab switcher */}
        <div style={{ marginLeft: "auto", display: "flex", background: "var(--g0)", borderRadius: 8, padding: 2 }}>
          {(["invites", "categories", "archived"] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: "6px 16px", borderRadius: 6, fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer",
              background: tab === t ? "var(--blurple)" : "transparent",
              color: tab === t ? "#fff" : "var(--t3)",
              transition: "all .15s",
            }}>
              {t === "invites" ? "Davet Havuzu" : t === "categories" ? "Hesap Kategorileri" : "Kapanan Hesaplar"}
            </button>
          ))}
        </div>
      </div>

      {tab === "invites" ? <InvitePoolTab /> : tab === "categories" ? <CategoriesTab /> : <ArchivedAccountsTab />}
    </div>
  );
}
