import React, { useState, useEffect, useMemo, useCallback } from "react";
import { api, exportCSV } from "../api";
import { useFetch, useDebounce, useCountUp, fmt, fmtTs, fmtDate, avatarColor } from "../hooks";
import { Spinner, Empty } from "../components";
import { DiscordAvatar } from "../components/DiscordAvatar";
import { DiscordUserBadges, BotBadge, FLAGS, BadgeIcon } from "../components/DiscordBadges";
import type { BadgeDef } from "../components/DiscordBadges";
import { MessageRow } from "../components/MessageRow";
import type { UserClickPayload } from "../components/MessageRow";
import { UserMiniProfileCard } from "../components/UserMiniProfileCard";
import type { Message, TopUser, IdentityEvent } from "../types";

const SNOWFLAKE_RE = /^\d{17,20}$/;

/* ── Rank medal colors ── */
function rankColor(i: number) {
  if (i === 0) return "#FFD60A";
  if (i === 1) return "#C0C0C0";
  if (i === 2) return "#CD7F32";
  return "var(--t4)";
}

/* ── User list item ── */
function UserRow({ user, rank, onClick }: { user: TopUser; rank: number; onClick: () => void }) {
  const color = avatarColor(user.author_id);
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 14,
        padding: "12px 20px", cursor: "pointer",
        borderBottom: "1px solid var(--b0)",
        transition: "background .1s",
        animation: `slideUp .2s ease ${Math.min(rank * 18, 400)}ms both`,
      }}
      onMouseEnter={e => (e.currentTarget.style.background = "var(--g1)")}
      onMouseLeave={e => (e.currentTarget.style.background = "")}
    >
      {/* Rank */}
      <div style={{ width: 24, textAlign: "right", flexShrink: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: rankColor(rank) }}>
          {rank + 1}
        </span>
      </div>

      {/* Avatar */}
      <DiscordAvatar userId={user.author_id} userName={user.display_name || user.author_name} avatarHash={user.author_avatar} size={38} />

      {/* Name + ID + badges */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {user.display_name || user.author_name || "Bilinmeyen"}
          </span>
          {Number(user.is_bot) === 1 && <BotBadge />}
          <DiscordUserBadges mask={(user as any).badge_mask} size={13} />
        </div>
        <div style={{ fontSize: 10, color: "var(--t4)", fontFamily: "var(--mono)", marginTop: 1 }}>
          {user.display_name && user.author_name ? `@${user.author_name} · ` : ""}{user.author_id}
        </div>
      </div>

      {/* Msg count */}
      <div style={{ fontSize: 16, fontWeight: 800, color: "var(--blue)", fontVariantNumeric: "tabular-nums", letterSpacing: "-0.5px" }}>
        {fmt(user.msg_count)}
      </div>

      <span style={{ fontSize: 12, color: "var(--t4)" }}>→</span>
    </div>
  );
}

/* ── Identity history timeline ── */
function HistoryTimeline({ authorId }: { authorId: string }) {
  const { data, loading } = useFetch<{ history: IdentityEvent[] }>(
    () => api.db.ch.userHistory(authorId) as Promise<{ history: IdentityEvent[] }>,
    [authorId]
  );
  const events = data?.history ?? [];

  const FIELD_LABELS: Record<string, string> = { username: "Kullanici Adi", display_name: "Gorunen Ad", avatar: "Avatar", nick: "Takma Ad" };
  const FIELD_COLORS: Record<string, string> = { username: "var(--blue)", display_name: "var(--purple)", avatar: "var(--green)", nick: "var(--orange)" };

  if (loading) return <div className="empty" style={{ height: 60 }}><Spinner /></div>;
  if (events.length === 0) return <div className="empty" style={{ height: 60 }}>Gecmis kaydi yok</div>;

  return (
    <div>
      {/* Column header */}
      <div style={{ display: "flex", gap: 10, padding: "6px 16px", borderBottom: "1px solid var(--b0)", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".5px", color: "var(--t5)" }}>
        <span style={{ minWidth: 70 }}>Tespit</span>
        <span style={{ minWidth: 80 }}>Alan</span>
        <span style={{ flex: 1 }}>Deger</span>
      </div>
      <div style={{ maxHeight: 280, overflowY: "auto" }}>
      {events.map((e, i) => (
        <div key={`${e.observed_ts}-${e.field}-${i}`} style={{
          display: "flex", gap: 10, padding: "8px 16px", borderBottom: "1px solid var(--b0)",
          alignItems: "center", fontSize: 12,
        }}>
          <span style={{ color: "var(--t4)", fontFamily: "var(--mono)", fontSize: 10, minWidth: 70, flexShrink: 0 }} data-tip="Degisikligin tespit edildigi tarih (ingestion zamani)">
            {fmtDate(e.observed_ts)}
          </span>
          <span style={{
            color: FIELD_COLORS[e.field] ?? "var(--t3)",
            fontWeight: 600, fontSize: 10, minWidth: 80, flexShrink: 0,
          }}>
            {FIELD_LABELS[e.field] ?? e.field}
          </span>
          <span style={{ color: "var(--t2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {e.field === "avatar" ? `${e.value.slice(0, 16)}...` : e.value}
          </span>
          {e.guild_id && e.guild_id !== "0" && (
            <span style={{ fontSize: 9, color: "var(--t4)", fontFamily: "var(--mono)" }}>guild:{e.guild_id.slice(-6)}</span>
          )}
        </div>
      ))}
      </div>
    </div>
  );
}

/* ── User detail ── */
function UserDetail({ user, onBack, onViewUser }: { user: TopUser; onBack: () => void; onViewUser?: (userId: string) => void }) {
  const [limit, setLimit] = useState(50);
  const [miniProfile, setMiniProfile] = useState<UserClickPayload | null>(null);
  const color = avatarColor(user.author_id);

  // Fetch fresh profile from backend (latest avatar, display_name, badge_mask)
  const { data: freshProfile } = useFetch<{ user: Record<string, unknown> | null }>(
    () => api.db.ch.userById(user.author_id) as Promise<{ user: Record<string, unknown> | null }>,
    [user.author_id]
  );
  const fp = freshProfile?.user;
  const bestAvatar = ((fp?.author_avatar as string | null | undefined) || user.author_avatar || null) as string | null;
  const bestDisplayName = ((fp?.display_name as string | null | undefined) || user.display_name || null) as string | null;
  const isBot = Number(fp?.is_bot ?? user.is_bot ?? 0) === 1;
  const displayName = bestDisplayName;
  const avatarHash = bestAvatar && bestAvatar !== '0' ? bestAvatar : null;
  const msgCount = Number(fp?.msg_count ?? user.msg_count ?? 0);
  const badgeMask = Number(fp?.badge_mask ?? (user as any).badge_mask ?? 0);

  // Fetch messages via parameterized search (NOT string interpolation — safe)
  const { data: result, loading, error, reload } = useFetch<{ messages: Message[]; count: number }>(
    () => api.messages.search({ q: "", authorId: user.author_id, limit, sort: "newest" }) as Promise<{ messages: Message[]; count: number }>,
    [user.author_id, limit]
  );

  const msgs = result?.messages || [];
  const channels = [...new Set(msgs.map(m => m.channel_id))];
  const animCount = useCountUp(msgCount);

  return (
    <div style={{ animation: "pageIn .22s ease both" }}>
      {/* Back */}
      <button className="btn btn-secondary btn-sm" onClick={onBack} style={{ marginBottom: 16, gap: 6 }}>
        ← Geri
      </button>

      {/* Profile header */}
      <div style={{
        background: "var(--g0)", border: "1px solid var(--gb0)",
        borderRadius: "var(--r-xl)", padding: "28px 28px 24px",
        marginBottom: 16, position: "relative", overflow: "hidden",
        backdropFilter: "blur(20px)",
      }}>
        {/* Gradient bg */}
        <div style={{
          position: "absolute", inset: 0,
          background: `radial-gradient(ellipse at 0% 50%, ${color}18 0%, transparent 60%)`,
          pointerEvents: "none",
        }} />

        {/* Top row */}
        <div style={{ display: "flex", alignItems: "center", gap: 20, position: "relative", zIndex: 1, marginBottom: 24 }}>
          <div style={{
            width: 80, height: 80, borderRadius: "50%",
            border: `3px solid ${color}55`, overflow: "hidden", flexShrink: 0,
          }}>
            <DiscordAvatar userId={user.author_id} userName={displayName ?? user.author_name} avatarHash={avatarHash} size={80} />
          </div>
          <div>
            {/* Display name (prominent) + username + badges */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: "var(--t1)", letterSpacing: "-0.6px", lineHeight: 1 }}>
                {displayName || user.author_name || "Bilinmeyen"}
              </div>
              {isBot && <BotBadge />}
              <DiscordUserBadges mask={badgeMask} size={18} />
            </div>
            {displayName && user.author_name && (
              <div style={{ fontSize: 13, color: "var(--t3)", marginTop: 4 }}>
                @{user.author_name}
              </div>
            )}
            <div style={{ fontSize: 12, color: "var(--t4)", fontFamily: "var(--mono)", marginTop: 4 }}>
              ID: {user.author_id}
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div style={{ display: "flex", gap: 12, position: "relative", zIndex: 1 }}>
          {[
            { label: "Toplam Mesaj", value: animCount.toLocaleString("tr-TR"), color: "var(--blue)" },
            { label: "Kanallar",     value: loading ? "…" : String(channels.length || "—"), color: "var(--green)" },
            { label: "Son Mesaj",    value: msgs[0] ? fmtTs(msgs[0].ts) : "—", color: "var(--orange)" },
          ].map(s => (
            <div key={s.label} style={{
              flex: 1, padding: "14px 16px",
              background: "rgba(0,0,0,0.3)", border: "1px solid var(--b0)",
              borderRadius: "var(--r-md)", textAlign: "center",
            }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: s.color, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.8px", marginBottom: 4 }}>
                {s.value}
              </div>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".7px", color: "var(--t4)" }}>
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Identity history panel */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head"><span className="panel-title">Kimlik Gecmisi</span></div>
        <HistoryTimeline authorId={user.author_id} />
      </div>

      {/* Messages panel */}
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Mesajlar ({loading ? "\u2026" : msgs.length})</span>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <select className="input input-sm" value={limit} onChange={e => setLimit(Number(e.target.value))} style={{ width: 90 }}>
              {[50, 100, 200, 500].map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            {msgs.length > 0 && (
              <button className="btn btn-secondary btn-sm"
                onClick={() => exportCSV(msgs as unknown as Record<string, unknown>[], `user-${user.author_id}`)}>
                CSV
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="empty" style={{ height: 140 }}><Spinner /></div>
        ) : error ? (
          <div style={{ padding: 16, color: "var(--red)", fontFamily: "var(--mono)", fontSize: 12 }}>
            Hata: {error}
          </div>
        ) : msgs.length === 0 ? (
          <Empty text="Bu kullanıcıya ait mesaj bulunamadı" />
        ) : (
          msgs.map((m, i) => (
            <MessageRow
              key={m.message_id}
              msg={m}
              showMedia={false}
              animate
              animDelay={Math.min(i * 12, 300)}
              onUserClick={(p) => setMiniProfile(prev => prev?.userId === p.userId ? null : p)}
            />
          ))
        )}

        {miniProfile && (
          <UserMiniProfileCard
            userId={miniProfile.userId}
            userName={miniProfile.userName}
            avatarHash={miniProfile.avatarHash}
            anchor={miniProfile.anchor}
            onClose={() => setMiniProfile(null)}
            onViewProfile={onViewUser}
          />
        )}
      </div>
    </div>
  );
}

/* ═══ BADGE DIRECTORY — Premium UI ═════════════════════════════════ */
const TIER_LABEL: Record<string, string> = { legendary: "LEGENDARY", rare: "RARE", uncommon: "UNCOMMON", common: "COMMON" };
const TIER_COLOR: Record<string, string> = { legendary: "#FFD700", rare: "#A855F7", uncommon: "#3B82F6", common: "#6B7280" };
const TIER_ORDER = ["legendary", "rare", "uncommon", "common"] as const;

function BadgeDirectory({ onSelectUser }: { onSelectUser: (u: TopUser) => void }) {
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [totalUsers, setTotalUsers] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedBadges, setSelectedBadges] = useState<number[]>([]);
  const [matchMode, setMatchMode] = useState<"all" | "any">("any");
  const [users, setUsers] = useState<any[]>([]);
  const [guildNames, setGuildNames] = useState<Record<string, string>>({});
  const [searching, setSearching] = useState(false);
  const [enrichJob, setEnrichJob] = useState<{ running: boolean; processed: number; updated: number; total: number; errors: number } | null>(null);

  const fetchCounts = useCallback(async () => {
    try {
      const r = await api.messages.badgeCounts();
      setCounts(r.counts ?? {});
      setTotalUsers(r.totalUsersWithBadges ?? 0);
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchCounts(); }, [fetchCounts]);

  // Poll enrich status while running
  useEffect(() => {
    if (!enrichJob?.running) return;
    const id = setInterval(async () => {
      try {
        const s = await api.messages.badgeEnrichStatus();
        setEnrichJob(s);
        if (!s.running) { clearInterval(id); fetchCounts(); }
      } catch {}
    }, 2000);
    return () => clearInterval(id);
  }, [enrichJob?.running, fetchCounts]);

  async function startEnrich() {
    try {
      await api.messages.badgeEnrich(10000);
      setEnrichJob({ running: true, processed: 0, updated: 0, total: 0, errors: 0 });
    } catch {}
  }

  const combinedMask = selectedBadges.reduce((m, bit) => m | (1 << bit), 0);
  const maxCount = Math.max(1, ...Object.values(counts));

  useEffect(() => {
    if (combinedMask === 0) { setUsers([]); setGuildNames({}); return; }
    setSearching(true);
    api.messages.badges(combinedMask, 2000, matchMode).then(async (r: any) => {
      const rows: any[] = r.users ?? [];
      setUsers(rows);
      const ids = [...new Set(rows.map((u: any) => u.sample_guild).filter((g: any) => g && g !== '0'))].slice(0, 500) as string[];
      if (ids.length > 0) {
        try {
          const gn = await api.guilds.names(ids);
          setGuildNames(gn.names ?? {});
        } catch { setGuildNames({}); }
      } else { setGuildNames({}); }
    }).catch(() => {}).finally(() => setSearching(false));
  }, [combinedMask, matchMode]);

  function toggleBadge(bit: number) {
    setSelectedBadges(prev => prev.includes(bit) ? prev.filter(b => b !== bit) : [...prev, bit]);
  }

  function exportData(format: "csv" | "txt") {
    if (users.length === 0) return;
    if (format === "csv") {
      const header = "author_id,username,display_name,badge_mask,last_seen,guild_id,guild_name\n";
      const rows = users.map((u: any) => {
        const gid = u.sample_guild ?? '';
        const gname = guildNames[gid] || gid;
        return `${u.author_id},"${(u.author_name || '').replace(/"/g, '""')}","${(u.display_name || '').replace(/"/g, '""')}",${u.badge_mask},${u.last_seen_ts ?? ''},"${gid}","${gname.replace(/"/g, '""')}"`;
      }).join("\n");
      const blob = new Blob([header + rows], { type: "text/csv" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `badge_users_${Date.now()}.csv`; a.click();
    } else {
      const rows = users.map((u: any) => {
        const gid = u.sample_guild ?? '';
        const gname = guildNames[gid] || gid;
        return `${u.author_id}\t${u.author_name || ''}\t${u.display_name || ''}\t${gid}\t${gname}`;
      }).join("\n");
      const blob = new Blob([`author_id\tusername\tdisplay_name\tguild_id\tguild_name\n` + rows], { type: "text/plain" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `badge_users_${Date.now()}.txt`; a.click();
    }
  }

  const grouped = TIER_ORDER.map(tier => ({ tier, badges: FLAGS.filter(f => f.tier === tier) })).filter(g => g.badges.length > 0);

  return (
    <div>
      {/* Enrich progress */}
      {enrichJob?.running && (
        <div style={{ marginBottom: 14, padding: "10px 16px", borderRadius: 10, border: "1px solid color-mix(in srgb, var(--blurple) 30%, transparent)", background: "color-mix(in srgb, var(--blurple) 5%, transparent)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <Spinner />
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--blurple)" }}>Badge zenginlestirme calisiyor...</span>
            <span style={{ fontSize: 11, color: "var(--t3)", fontFamily: "var(--mono)", marginLeft: "auto" }}>
              {enrichJob.processed}/{enrichJob.total} | {enrichJob.updated} guncellendi
            </span>
          </div>
          <div style={{ height: 4, background: "var(--g1)", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${enrichJob.total > 0 ? (enrichJob.processed / enrichJob.total) * 100 : 0}%`, background: "var(--blurple)", borderRadius: 2, transition: "width .3s" }} />
          </div>
        </div>
      )}
      {enrichJob && !enrichJob.running && enrichJob.processed > 0 && (
        <div style={{ marginBottom: 14, padding: "8px 16px", borderRadius: 10, background: "color-mix(in srgb, var(--green) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--green) 25%, transparent)", fontSize: 12, color: "var(--green)" }}>
          Tamamlandi: {enrichJob.processed} kontrol, {enrichJob.updated} guncellendi, {enrichJob.errors} hata
        </div>
      )}

      {/* Header bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div style={{ fontSize: 13, color: "var(--t3)" }}>
          Badge'e sahip kullanicilari kesfet. {totalUsers > 0 && <span style={{ fontFamily: "var(--mono)", color: "var(--t2)" }}>{fmt(totalUsers)}</span>} indeksli kullanici arasinda filtrele.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="btn btn-secondary btn-xs" onClick={startEnrich} disabled={!!enrichJob?.running} style={{ fontSize: 10, padding: "5px 12px" }}>
            {enrichJob?.running ? "Calisiyor..." : "Badge Zenginlestir"}
          </button>
        <div style={{ display: "flex", background: "var(--g0)", borderRadius: 10, padding: 3, gap: 2 }}>
          {(["all", "any"] as const).map(m => (
            <button key={m} onClick={() => setMatchMode(m)} style={{
              padding: "6px 18px", borderRadius: 8, fontSize: 11, fontWeight: 700, border: "none", cursor: "pointer",
              background: matchMode === m ? "var(--blurple)" : "transparent",
              color: matchMode === m ? "#fff" : "var(--t4)", transition: "all .15s", letterSpacing: ".3px",
            }}>
              {m === "all" ? "ALL match" : "ANY match"}
            </button>
          ))}
        </div>
        </div>
      </div>

      {/* Badge cards by tier */}
      {loading ? <div className="empty" style={{ height: 120 }}><Spinner /></div> : grouped.map(({ tier, badges }) => (
        <div key={tier} style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 9, fontWeight: 900, letterSpacing: "2px", color: TIER_COLOR[tier], marginBottom: 10, textTransform: "uppercase" }}>
            {TIER_LABEL[tier]}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
            {badges.map(badge => {
              const bitIdx = Math.log2(badge.bit);
              const count = counts[bitIdx] ?? 0;
              const pct = maxCount > 0 ? Math.min(100, (count / maxCount) * 100) : 0;
              const active = selectedBadges.includes(bitIdx);
              return (
                <div key={badge.id} onClick={() => toggleBadge(bitIdx)} style={{
                  padding: "14px 16px", borderRadius: 14, cursor: "pointer", transition: "all .2s ease",
                  border: active ? `2px solid ${badge.color}` : "2px solid transparent",
                  background: active ? `color-mix(in srgb, ${badge.color} 6%, var(--g0))` : "var(--g0)",
                  boxShadow: active ? `0 0 20px color-mix(in srgb, ${badge.color} 15%, transparent)` : "none",
                  position: "relative", overflow: "hidden",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                    <BadgeIcon badge={badge} size={32} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: active ? "#fff" : "var(--t1)", lineHeight: 1.2 }}>{badge.label}</div>
                      <div style={{ fontSize: 10, color: "var(--t4)", fontFamily: "var(--mono)", marginTop: 2 }}>~{fmt(count)} kullanici</div>
                    </div>
                  </div>
                  {/* Progress bar */}
                  <div style={{ height: 3, background: "var(--b1)", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: badge.color, borderRadius: 2, transition: "width .4s ease" }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Selected badge summary */}
      {selectedBadges.length > 0 && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", marginBottom: 12,
          borderRadius: 12, background: "var(--g0)", border: "1px solid var(--b1)", flexWrap: "wrap",
        }}>
          <span style={{ fontSize: 11, color: "var(--t3)", fontWeight: 600 }}>Secili:</span>
          {selectedBadges.map(bit => {
            const b = FLAGS.find(f => Math.log2(f.bit) === bit);
            if (!b) return null;
            return (
              <span key={bit} onClick={() => toggleBadge(bit)} style={{
                display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 20,
                background: `color-mix(in srgb, ${b.color} 15%, transparent)`, border: `1px solid color-mix(in srgb, ${b.color} 30%, transparent)`,
                fontSize: 10, fontWeight: 600, color: b.color, cursor: "pointer",
              }}>
                <BadgeIcon badge={b} size={14} />
                {b.label}
                <span style={{ opacity: 0.6 }}>×</span>
              </span>
            );
          })}
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--t4)", fontFamily: "var(--mono)" }}>
            {searching ? "..." : `${users.length} sonuc`}
          </span>
        </div>
      )}

      {/* Results */}
      {combinedMask > 0 && (
        <div className="panel" style={{ overflow: "hidden", borderRadius: 14 }}>
          <div className="panel-head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 18px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--t1)" }}>
                {searching ? "Araniyor..." : `${fmt(users.length)} kullanici`}
              </span>
              <span style={{ fontSize: 10, color: "var(--t4)" }}>
                ({matchMode === "all" ? "tum secili badge'ler" : "herhangi biri"})
              </span>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn btn-secondary btn-xs" onClick={() => exportData("csv")} disabled={users.length === 0} style={{ fontSize: 10, padding: "4px 12px" }}>
                CSV indir
              </button>
              <button className="btn btn-secondary btn-xs" onClick={() => exportData("txt")} disabled={users.length === 0} style={{ fontSize: 10, padding: "4px 12px" }}>
                TXT indir
              </button>
            </div>
          </div>
          {searching ? <div className="empty" style={{ height: 100 }}><Spinner /></div>
          : users.length === 0 ? <Empty text="Secilen badge'lere sahip kullanici bulunamadi" />
          : (
            <div style={{ maxHeight: 450, overflowY: "auto" }}>
              {users.slice(0, 500).map((u: any, i: number) => (
                <div key={u.author_id} onClick={() => onSelectUser({
                  author_id: u.author_id, author_name: u.author_name ?? "", msg_count: 0,
                  is_bot: Number(u.is_bot ?? 0), display_name: u.display_name ?? "",
                  author_avatar: u.author_avatar ?? "", badge_mask: Number(u.badge_mask ?? 0),
                } as TopUser)} style={{
                  display: "flex", alignItems: "center", gap: 12, padding: "10px 18px",
                  borderBottom: i < Math.min(users.length, 500) - 1 ? "1px solid var(--b0)" : "none",
                  cursor: "pointer", transition: "background .1s",
                }}
                  onMouseEnter={e => e.currentTarget.style.background = "var(--g0)"}
                  onMouseLeave={e => e.currentTarget.style.background = ""}>
                  <DiscordAvatar userId={u.author_id} userName={u.display_name || u.author_name} avatarHash={u.author_avatar} size={36} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {u.display_name || u.author_name || u.author_id}
                      </span>
                      {u.author_name && u.display_name && (
                        <span style={{ fontSize: 10, color: "var(--t4)" }}>@{u.author_name}</span>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
                      <span style={{ fontSize: 9, color: "var(--t5)", fontFamily: "var(--mono)" }}>{u.author_id}</span>
                      {u.last_seen_ts && <span style={{ fontSize: 9, color: "var(--t5)" }}>Son: {fmtTs(u.last_seen_ts)}</span>}
                    </div>
                  </div>
                  <DiscordUserBadges mask={Number(u.badge_mask ?? 0)} size={18} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══ MAIN ══════════════════════════════════════════════════════════ */
export function UserProfiles() {
  const [tab, setTab] = useState<"users" | "badges">("users");
  const [q, setQ]               = useState("");
  const [selected, setSelected] = useState<TopUser | null>(null);
  const [searchResults, setSearchResults] = useState<TopUser[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const debouncedQ = useDebounce(q, 400);

  const { data: topUsers, loading } = useFetch<TopUser[]>(
    () => api.db.ch.topUsers(100) as Promise<TopUser[]>
  );

  // Global search: when debouncedQ is a snowflake, do PK lookup; otherwise name search
  useEffect(() => {
    const trimmed = debouncedQ.trim();
    if (!trimmed) { setSearchResults(null); setSearchError(null); return; }

    let cancelled = false;
    setSearching(true);
    setSearchError(null);

    (async () => {
      try {
        if (SNOWFLAKE_RE.test(trimmed)) {
          const res = await api.db.ch.userById(trimmed) as any;
          if (cancelled) return;
          if (res?.user) {
            const u = res.user;
            setSearchResults([{
              author_id: String(u.author_id),
              author_name: u.author_name ?? "",
              msg_count: Number(u.msg_count ?? 0),
              is_bot: Number(u.is_bot ?? 0),
              display_name: u.display_name ?? "",
              author_avatar: u.author_avatar ?? "",
              first_seen: u.first_seen ?? undefined,
              last_seen: u.last_seen ?? undefined,
              badge_mask: Number(u.badge_mask ?? 0),
            } as TopUser]);
          } else {
            setSearchResults([]);
          }
        } else {
          const res = await api.db.ch.userByName(trimmed, 50) as any;
          if (cancelled) return;
          const users = (res?.users ?? []).map((u: any) => ({
            author_id: String(u.author_id),
            author_name: u.author_name ?? "",
            msg_count: Number(u.msg_count ?? 0),
            is_bot: Number(u.is_bot ?? 0),
            display_name: u.display_name ?? "",
            author_avatar: u.author_avatar ?? "",
            first_seen: u.first_seen ?? undefined,
            last_seen: u.last_seen ?? undefined,
            badge_mask: Number(u.badge_mask ?? 0),
          } as TopUser));
          setSearchResults(users);
        }
      } catch (err) {
        if (!cancelled) setSearchError(err instanceof Error ? err.message : "Hata");
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();

    return () => { cancelled = true; };
  }, [debouncedQ]);

  // Show search results if query exists, otherwise top 100
  const displayList = searchResults !== null ? searchResults : (topUsers ?? []);
  const isSearchMode = debouncedQ.trim().length > 0;
  const listLoading = isSearchMode ? searching : loading;

  if (selected) {
    return (
      <div className="page-enter">
        <UserDetail
          user={selected}
          onBack={() => setSelected(null)}
          onViewUser={(userId) => {
            const found = displayList.find(u => u.author_id === userId);
            if (found) setSelected(found);
          }}
        />
      </div>
    );
  }

  return (
    <div className="page-enter">
      {/* Header + Tab */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--t1)", letterSpacing: "-.5px", marginBottom: 4 }}>
            Kullanici Profilleri
          </div>
          <div style={{ fontSize: 13, color: "var(--t3)" }}>
            {tab === "badges"
              ? "Badge'e gore kullanici arama ve filtreleme"
              : isSearchMode
                ? "Tum veritabaninda arama yapiliyor (ID veya isim)"
                : "En aktif 100 kullanici — ID veya isim ile tum DB'de arayabilirsiniz"}
          </div>
        </div>
        <div style={{ display: "flex", background: "var(--g0)", borderRadius: 8, padding: 2 }}>
          {(["users", "badges"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: "6px 16px", borderRadius: 6, fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer",
              background: tab === t ? "var(--blurple)" : "transparent",
              color: tab === t ? "#fff" : "var(--t3)", transition: "all .15s",
            }}>
              {t === "users" ? "Kullanicilar" : "Badge ile Bul"}
            </button>
          ))}
        </div>
      </div>

      {tab === "badges" ? (
        <BadgeDirectory onSelectUser={u => { setSelected(u); setTab("users"); }} />
      ) : (
      <>
      {/* Search */}
      <div style={{ position: "relative", marginBottom: 14 }}>
        <span style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: "var(--t4)", pointerEvents: "none" }}>🔍</span>
        <input
          className="input"
          placeholder="Kullanici ID (snowflake) veya isim ile ara..."
          value={q}
          onChange={e => setQ(e.target.value)}
          style={{ paddingLeft: 38, fontSize: 15 }}
          autoFocus
        />
        {searching && (
          <span style={{ position: "absolute", right: 13, top: "50%", transform: "translateY(-50%)" }}>
            <Spinner />
          </span>
        )}
      </div>

      {/* List */}
      <div className="panel" style={{ overflow: "hidden" }}>
        {/* Header row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 20px", borderBottom: "1px solid var(--b0)" }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: .8, color: "var(--t4)" }}>
            {listLoading ? "Araniyor..." : isSearchMode ? `${displayList.length} sonuc (tum DB)` : `Top ${displayList.length} kullanici`}
          </span>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: .8, color: "var(--t4)" }}>Mesaj</span>
        </div>

        {searchError ? (
          <div style={{ padding: 16, color: "var(--red)", fontFamily: "var(--mono)", fontSize: 12 }}>
            Hata: {searchError}
          </div>
        ) : listLoading ? (
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
            {[...Array(6)].map((_, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, padding: "0 4px" }}>
                <div className="skeleton" style={{ width: 24, height: 14, borderRadius: 4 }} />
                <div className="skeleton skeleton-avatar" style={{ width: 38, height: 38 }} />
                <div style={{ flex: 1 }}>
                  <div className="skeleton skeleton-line" style={{ width: "35%", marginBottom: 6 }} />
                  <div className="skeleton skeleton-text" style={{ width: "20%" }} />
                </div>
                <div className="skeleton" style={{ width: 60, height: 18, borderRadius: 4 }} />
              </div>
            ))}
          </div>
        ) : displayList.length === 0 ? (
          <div className="empty" style={{ height: 120 }}>
            {isSearchMode
              ? SNOWFLAKE_RE.test(debouncedQ.trim())
                ? `ID "${debouncedQ.trim()}" veritabaninda bulunamadi`
                : `"${debouncedQ.trim()}" ile eslesen kullanici yok`
              : "Kullanici yok"}
          </div>
        ) : (
          <div style={{ maxHeight: "calc(100vh - 280px)", overflowY: "auto" }}>
            {displayList.map((u, i) => (
              <UserRow key={u.author_id} user={u} rank={i} onClick={() => setSelected(u)} />
            ))}
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}