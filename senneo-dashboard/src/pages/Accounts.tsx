import React, { useState, useEffect } from "react";
import { useFetch, useCountUp, useDebounce, useInterval, addToast } from "../hooks";
import { api } from "../api";
import { Spinner } from "../components";
import { ConfirmModal } from "../components/ConfirmModal";
import { PauseReasonModal } from "../components/PauseReasonModal";
import type { AccountGuildChannelOption, AccountGuildEntry, AccountListItem, AccountsListResponse, AccountCredentials, AccountPauseState, AccountTargetsListItem, PauseSource, RuntimeStateCounts, SchedulerState } from "../types";

/* ── helpers ── */
function discordAvatarUrl(userId: string, hash: string): string {
  if (hash && hash !== "0") return `https://cdn.discordapp.com/avatars/${userId}/${hash}.png?size=64`;
  const idx = Math.abs([...userId].reduce((a, c) => a + c.charCodeAt(0), 0)) % 6;
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

function formatTimestamp(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" });
}

function guildIconUrl(guildId: string, icon: string | null | undefined): string | null {
  if (!icon) return null;
  return `https://cdn.discordapp.com/icons/${guildId}/${icon}.png?size=96`;
}

function buildChannelInput(targets: AccountTargetsListItem[]): string {
  return [...targets]
    .sort((a, b) => (a.channelName || a.channelId).localeCompare(b.channelName || b.channelId))
    .map(target => target.channelId)
    .join("\n");
}

function parseChannelIdsInput(input: string): { valid: string[]; invalid: string[] } {
  const parts = input
    .split(/[\n,]+/)
    .map(part => part.trim())
    .filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  const seenValid = new Set<string>();
  const seenInvalid = new Set<string>();
  for (const part of parts) {
    if (/^\d{17,20}$/.test(part)) {
      if (!seenValid.has(part)) {
        seenValid.add(part);
        valid.push(part);
      }
    } else if (!seenInvalid.has(part)) {
      seenInvalid.add(part);
      invalid.push(part);
    }
  }
  return { valid, invalid };
}

function archiveReasonForAccount(account: AccountListItem): string {
  switch (account.failedReason) {
    case "banned":
    case "disabled":
    case "token_expired":
      return account.failedReason;
    default:
      return "login_failed";
  }
}

function toneChipStyle(color: string): React.CSSProperties {
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

function accountStateMeta(acc: AccountListItem): { label: string; color: string } {
  if (acc.status === "failed") return { label: "İnaktif", color: "var(--red)" };
  if (acc.paused && acc.pauseAcknowledged) return { label: "Duraklatıldı", color: "var(--orange)" };
  if (acc.paused) return { label: "Duraklatılıyor", color: "var(--yellow)" };
  return { label: "Aktif", color: "var(--green)" };
}

function runtimeEntries(counts: RuntimeStateCounts): Array<{ key: string; label: string; color: string }> {
  return [
    { key: "running", label: `${counts.running} çalışan`, color: "var(--orange)" },
    { key: "queued", label: `${counts.queued} sırada`, color: "var(--yellow)" },
    { key: "paused", label: `${counts.paused} durdu`, color: "var(--orange)" },
    { key: "completed", label: `${counts.completed} bitti`, color: "var(--green)" },
    { key: "error", label: `${counts.error_retryable + counts.error_terminal} hata`, color: "var(--red)" },
  ].filter(entry => parseInt(entry.label, 10) > 0);
}

function targetPauseMeta(target: AccountTargetsListItem): { label: string; color: string } | null {
  if (!target.pauseRequested) return null;
  if (target.pauseAcknowledged) return { label: `${pauseSourceText(target.requestedPauseSource)} durdu`, color: "var(--orange)" };
  return { label: `${pauseSourceText(target.requestedPauseSource)} duruyor`, color: "var(--yellow)" };
}

function targetDisplayName(target: AccountTargetsListItem): string {
  return target.channelName || target.label || target.channelId;
}

/* ── A1: Health badge ── */
function HealthBadge({ score, label, rlHits, lastActiveAt }: { score: number; label: string; rlHits: number; lastActiveAt: string | null }) {
  const color =
    label === 'excellent' ? '#30d158'
    : label === 'good'    ? '#5ec87e'
    : label === 'warning' ? 'var(--orange)'
    : 'var(--red)';
  const lastStr = lastActiveAt ? formatTimestamp(lastActiveAt) : null;
  const ageMs   = lastActiveAt ? Date.now() - new Date(lastActiveAt).getTime() : null;
  const ageLabel = ageMs == null ? '—' : ageMs < 60_000 ? 'Az önce' : ageMs < 3600_000 ? `${Math.floor(ageMs/60_000)}dk` : ageMs < 86400_000 ? `${Math.floor(ageMs/3600_000)}sa` : `${Math.floor(ageMs/86400_000)}g`;
  const tip = `Sağlık skoru: ${score}/100 · ${rlHits} rate-limit · Son aktif: ${lastStr ?? '—'}`;
  return (
    <div title={tip} style={{ textAlign: 'center' }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 700, color }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
        {score}
      </div>
      {lastActiveAt && (
        <div style={{ fontSize: 9, color: 'var(--t4)', marginTop: 1 }}>{ageLabel}</div>
      )}
    </div>
  );
}

/* ── Stat card ── */
function StatCard({ label, value, color, delay }: { label: string; value: number; color: string; delay: number }) {
  const animated = useCountUp(value);
  return (
    <div className="stat-card" style={{ "--accent-color": color, animation: `slideUp .2s ease ${delay}ms both` } as React.CSSProperties}>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color }}>{animated.toLocaleString("tr-TR")}</div>
    </div>
  );
}

/* ── Credentials modal ── */
function CredentialsModal({ accountId, username, onClose }: {
  accountId: string; username: string; onClose: () => void;
}) {
  const [email, setEmail]               = useState("");
  const [mailSite, setMailSite]         = useState("");
  const [accountPassword, setAccountPw] = useState("");
  const [mailPassword, setMailPw]       = useState("");
  const [showAccPwd, setShowAccPwd]     = useState(false);
  const [showMailPwd, setShowMailPwd]   = useState(false);
  const [loading, setLoading]           = useState(true);
  const [saving, setSaving]             = useState(false);

  useEffect(() => {
    api.accounts.getCredentials(accountId)
      .then((d: AccountCredentials) => {
        setEmail(d.email || "");
        setMailSite(d.mailSite || "");
        setAccountPw(d.accountPassword || "");
        setMailPw(d.mailPassword || "");
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [accountId]);

  async function save() {
    setSaving(true);
    try {
      await api.accounts.updateCredentials(accountId, { email, mailSite, accountPassword, mailPassword });
      addToast({ type: "success", title: "Bilgiler kaydedildi" });
      onClose();
    } catch (e) {
      addToast({ type: "error", title: "Kaydetme hatası", msg: (e as Error).message });
    } finally { setSaving(false); }
  }

  const overlayStyle: React.CSSProperties = {
    position: "fixed", inset: 0, zIndex: 9000,
    background: "rgba(0,0,0,0.65)", backdropFilter: "blur(6px)",
    display: "flex", alignItems: "center", justifyContent: "center",
    animation: "fadeIn .15s ease both",
  };
  const boxStyle: React.CSSProperties = {
    background: "var(--bg-3)", border: "1px solid var(--gb1)",
    borderRadius: "var(--r-xl)", width: 440, maxWidth: "92vw",
    boxShadow: "var(--sh-float)", animation: "scaleIn .18s ease both",
  };

  return (
    <div style={overlayStyle} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={boxStyle}>
        {/* Header */}
        <div style={{ padding: "18px 22px 14px", borderBottom: "1px solid var(--gb1)", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--t1)" }}>Hesap Bilgileri</div>
            <div style={{ fontSize: 11, color: "var(--t4)", marginTop: 2, fontFamily: "var(--mono)" }}>{username}</div>
          </div>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} style={{ fontSize: 18, lineHeight: 1 }}>×</button>
        </div>
        {/* Body */}
        {loading ? (
          <div style={{ padding: 40, display: "flex", justifyContent: "center" }}><Spinner /></div>
        ) : (
          <div style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <label style={{ fontSize: 10, color: "var(--t4)", fontWeight: 700, textTransform: "uppercase", letterSpacing: .7, display: "block", marginBottom: 5 }}>Email</label>
              <input className="input" type="email" placeholder="discord@example.com" value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: 10, color: "var(--t4)", fontWeight: 700, textTransform: "uppercase", letterSpacing: .7, display: "block", marginBottom: 5 }}>Mail Sitesi</label>
              <input className="input" type="url" placeholder="https://mail.google.com" value={mailSite} onChange={e => setMailSite(e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: 10, color: "var(--t4)", fontWeight: 700, textTransform: "uppercase", letterSpacing: .7, display: "block", marginBottom: 5 }}>Hesap Şifresi</label>
              <div style={{ position: "relative" }}>
                <input className="input" type={showAccPwd ? "text" : "password"} placeholder="Discord hesap şifresi"
                  value={accountPassword} onChange={e => setAccountPw(e.target.value)} style={{ paddingRight: 68 }} />
                <button className="btn btn-ghost btn-xs" onClick={() => setShowAccPwd(v => !v)}
                  style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)" }}>
                  {showAccPwd ? "Gizle" : "Göster"}
                </button>
              </div>
            </div>
            <div>
              <label style={{ fontSize: 10, color: "var(--t4)", fontWeight: 700, textTransform: "uppercase", letterSpacing: .7, display: "block", marginBottom: 5 }}>Mail Şifresi</label>
              <div style={{ position: "relative" }}>
                <input className="input" type={showMailPwd ? "text" : "password"} placeholder="Email hesabı şifresi"
                  value={mailPassword} onChange={e => setMailPw(e.target.value)} style={{ paddingRight: 68 }} />
                <button className="btn btn-ghost btn-xs" onClick={() => setShowMailPwd(v => !v)}
                  style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)" }}>
                  {showMailPwd ? "Gizle" : "Göster"}
                </button>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
              <button className="btn btn-secondary btn-sm" onClick={onClose}>İptal</button>
              <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
                {saving ? <Spinner /> : "Kaydet"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FailedTransferModal({ account, token, submitting, onTokenChange, onConfirm, onClose }: {
  account: AccountListItem;
  token: string;
  submitting: boolean;
  onTokenChange: (value: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const overlayStyle: React.CSSProperties = {
    position: "fixed", inset: 0, zIndex: 9000,
    background: "rgba(0,0,0,0.65)", backdropFilter: "blur(6px)",
    display: "flex", alignItems: "center", justifyContent: "center",
    animation: "fadeIn .15s ease both",
  };
  const boxStyle: React.CSSProperties = {
    background: "var(--bg-3)", border: "1px solid var(--gb1)",
    borderRadius: "var(--r-xl)", width: 520, maxWidth: "94vw",
    boxShadow: "var(--sh-float)", animation: "scaleIn .18s ease both",
  };

  return (
    <div style={overlayStyle} onClick={e => { if (e.target === e.currentTarget && !submitting) onClose(); }}>
      <div style={boxStyle}>
        <div style={{ padding: "18px 22px 14px", borderBottom: "1px solid var(--gb1)", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--t1)" }}>Geçersiz Hesabı Transfer Et</div>
            <div style={{ fontSize: 11, color: "var(--t4)", marginTop: 2, fontFamily: "var(--mono)" }}>{account.username || account.accountId}</div>
          </div>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} disabled={submitting} style={{ fontSize: 18, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ padding: 14, borderRadius: 12, background: "rgba(255,69,58,.08)", border: "1px solid rgba(255,69,58,.22)" }}>
            <div style={{ fontSize: 12, color: "var(--t2)", lineHeight: 1.6 }}>
              Bu işlem önce hesabın arşiv snapshot&apos;ını alır, ardından yeni token ile hedef ve davetleri geri yükler.
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8, fontSize: 10, color: "var(--t4)" }}>
              {account.tokenHint ? <span style={{ fontFamily: "var(--mono)" }}>{account.tokenHint}</span> : null}
              {account.failedDetectedAt ? <span>{formatTimestamp(account.failedDetectedAt)}</span> : null}
            </div>
            {account.failedError ? (
              <div style={{ marginTop: 8, fontSize: 11, color: "var(--red)", lineHeight: 1.5, wordBreak: "break-word" }}>
                {account.failedError}
              </div>
            ) : null}
          </div>
          <div>
            <label style={{ fontSize: 10, color: "var(--t4)", fontWeight: 700, textTransform: "uppercase", letterSpacing: .7, display: "block", marginBottom: 5 }}>Yeni Hesap Token&apos;ı</label>
            <input
              className="input"
              type="password"
              placeholder="Yeni aktif Discord token'ı"
              value={token}
              onChange={e => onTokenChange(e.target.value)}
              autoFocus
            />
          </div>
          <div style={{ fontSize: 11, color: "var(--t4)", lineHeight: 1.6 }}>
            Email, hesap şifresi ve mail bilgileri korunur. Eski invalid token sistemden temizlenir.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
            <button className="btn btn-secondary btn-sm" onClick={onClose} disabled={submitting}>İptal</button>
            <button className="btn btn-primary btn-sm" onClick={onConfirm} disabled={submitting || !token.trim()}>
              {submitting ? <Spinner /> : "Transfer Et"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TargetsDrawer({ account, onClose, onChanged }: {
  account: AccountListItem; onClose: () => void; onChanged: () => void;
}) {
  const [guilds, setGuilds] = useState<AccountGuildEntry[]>([]);
  const [items, setItems] = useState<AccountTargetsListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchRaw, setSearchRaw] = useState("");
  const search = useDebounce(searchRaw, 250);
  const [selectedGuildId, setSelectedGuildId] = useState<string | null>(null);
  const [editors, setEditors] = useState<Record<string, { input: string; error: string; dirty: boolean; saving: boolean }>>({});
  const [guildChannels, setGuildChannels] = useState<Record<string, AccountGuildChannelOption[]>>({});
  const [loadingGuildChannels, setLoadingGuildChannels] = useState<Record<string, boolean>>({});
  const [accountPause, setAccountPause] = useState<AccountPauseState | null>(null);
  const [pauseTarget, setPauseTarget] = useState<AccountTargetsListItem | null>(null);
  const [channelActionId, setChannelActionId] = useState<string | null>(null);
  const [showPauseAccountModal, setShowPauseAccountModal] = useState(false);
  const [accountAction, setAccountAction] = useState<"pause" | "resume" | null>(null);

  const targetsByGuild = React.useMemo(() => {
    const grouped = new Map<string, AccountTargetsListItem[]>();
    for (const target of items) {
      const existing = grouped.get(target.guildId) ?? [];
      existing.push(target);
      grouped.set(target.guildId, existing);
    }
    for (const targets of grouped.values()) {
      targets.sort((a, b) => (a.channelName || a.channelId).localeCompare(b.channelName || b.channelId));
    }
    return grouped;
  }, [items]);

  const filteredGuilds = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return guilds;
    return guilds.filter(guild => {
      const targets = targetsByGuild.get(guild.guildId) ?? [];
      return guild.guildId.includes(needle)
        || guild.guildName.toLowerCase().includes(needle)
        || targets.some(target =>
          target.channelId.includes(needle)
          || target.channelName.toLowerCase().includes(needle)
          || target.label.toLowerCase().includes(needle)
        );
    });
  }, [guilds, search, targetsByGuild]);

  const activeGuild = React.useMemo(() => {
    if (filteredGuilds.length === 0) return null;
    return filteredGuilds.find(guild => guild.guildId === selectedGuildId) ?? filteredGuilds[0];
  }, [filteredGuilds, selectedGuildId]);

  const activeTargets = activeGuild ? (targetsByGuild.get(activeGuild.guildId) ?? []) : [];
  const activeEditor = activeGuild
    ? (editors[activeGuild.guildId] ?? { input: buildChannelInput(activeTargets), error: "", dirty: false, saving: false })
    : null;
  const activeParsed = activeEditor ? parseChannelIdsInput(activeEditor.input) : { valid: [], invalid: [] };
  const activeQuickChannels = activeGuild ? (guildChannels[activeGuild.guildId] ?? []) : [];
  const activeLoadingChannels = activeGuild ? !!loadingGuildChannels[activeGuild.guildId] : false;
  const activeCanSubmit = !!activeGuild && activeParsed.invalid.length === 0 && (activeParsed.valid.length > 0 || activeTargets.length > 0);
  const total = items.length;
  const effectivePause = accountPause ?? {
    accountId: account.accountId,
    paused: account.paused,
    pauseReason: account.pauseReason,
    pauseRequestedBy: account.pauseRequestedBy,
    pauseRequestedAt: account.pauseRequestedAt,
    pauseRequestId: account.pauseRequestId,
    pauseAcknowledged: account.pauseAcknowledged,
    targetCount: account.targetCount,
    runtimeStateCounts: account.runtimeStateCounts,
    runningTargetCount: account.runningTargetCount,
    queuedTargetCount: account.queuedTargetCount,
    pausedTargetCount: account.pausedTargetCount,
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    void refreshData(false);
  }, [account.accountId]);

  useEffect(() => {
    if (filteredGuilds.length === 0) {
      if (selectedGuildId !== null) setSelectedGuildId(null);
      return;
    }
    if (!selectedGuildId || !filteredGuilds.some(guild => guild.guildId === selectedGuildId)) {
      setSelectedGuildId(filteredGuilds[0].guildId);
    }
  }, [filteredGuilds, selectedGuildId]);

  useEffect(() => {
    if (activeGuild?.guildId) void loadGuildChannels(activeGuild.guildId);
  }, [activeGuild?.guildId]);

  async function refreshData(background: boolean) {
    if (background) setRefreshing(true);
    else setLoading(true);
    try {
      const [guildRes, targetRes, pauseRes] = await Promise.all([
        api.guilds.accountGuilds(account.accountId),
        api.accounts.accountTargets(account.accountId, { limit: 1000 }),
        api.accounts.pauseState(account.accountId),
      ]);
      const nextTargets = targetRes.targets;
      const nextTargetsByGuild = new Map<string, AccountTargetsListItem[]>();
      for (const target of nextTargets) {
        const existing = nextTargetsByGuild.get(target.guildId) ?? [];
        existing.push(target);
        nextTargetsByGuild.set(target.guildId, existing);
      }

      const guildMap = new Map<string, AccountGuildEntry>();
      for (const guild of guildRes.guilds) guildMap.set(guild.guildId, guild);
      for (const [guildId, guildTargets] of nextTargetsByGuild) {
        if (!guildMap.has(guildId)) {
          guildMap.set(guildId, {
            guildId,
            guildName: guildTargets[0]?.guildName || guildId,
            guildIcon: null,
            guildOwner: false,
            lastSynced: null,
          });
        }
      }

      const nextGuilds = [...guildMap.values()].sort((a, b) => {
        const countDiff = (nextTargetsByGuild.get(b.guildId)?.length ?? 0) - (nextTargetsByGuild.get(a.guildId)?.length ?? 0);
        if (countDiff !== 0) return countDiff;
        return (a.guildName || a.guildId).localeCompare(b.guildName || b.guildId);
      });

      setGuilds(nextGuilds);
      setItems(nextTargets);
      setAccountPause(pauseRes);
      setEditors(prev => {
        const next: Record<string, { input: string; error: string; dirty: boolean; saving: boolean }> = {};
        for (const guild of nextGuilds) {
          const existing = prev[guild.guildId];
          const baseInput = buildChannelInput(nextTargetsByGuild.get(guild.guildId) ?? []);
          next[guild.guildId] = existing?.dirty
            ? { ...existing, saving: false }
            : { input: baseInput, error: "", dirty: false, saving: false };
        }
        return next;
      });
      setSelectedGuildId(prev => prev && nextGuilds.some(guild => guild.guildId === prev) ? prev : (nextGuilds[0]?.guildId ?? null));
    } catch (e) {
      addToast({ type: "error", title: "Sunucu kanalları alınamadı", msg: (e as Error).message });
    } finally {
      if (background) setRefreshing(false);
      else setLoading(false);
    }
  }

  async function loadGuildChannels(guildId: string) {
    if (guildChannels[guildId] || loadingGuildChannels[guildId]) return;
    setLoadingGuildChannels(prev => ({ ...prev, [guildId]: true }));
    try {
      const channels = await api.accounts.guildChannels(guildId, { accountId: account.accountId });
      setGuildChannels(prev => ({ ...prev, [guildId]: channels }));
    } catch (e) {
      addToast({ type: "error", title: "Sunucu kanal listesi alınamadı", msg: (e as Error).message });
    } finally {
      setLoadingGuildChannels(prev => ({ ...prev, [guildId]: false }));
    }
  }

  function updateEditor(guildId: string, input: string) {
    setEditors(prev => ({
      ...prev,
      [guildId]: {
        input,
        error: "",
        dirty: true,
        saving: prev[guildId]?.saving ?? false,
      },
    }));
  }

  function fillFromCurrentTargets(guildId: string) {
    updateEditor(guildId, buildChannelInput(targetsByGuild.get(guildId) ?? []));
  }

  function appendSuggestedChannel(guildId: string, channelId: string) {
    const currentInput = editors[guildId]?.input ?? buildChannelInput(targetsByGuild.get(guildId) ?? []);
    const parsed = parseChannelIdsInput(currentInput);
    if (parsed.valid.includes(channelId)) return;
    updateEditor(guildId, currentInput.trim() ? `${currentInput.trim()}\n${channelId}` : channelId);
  }

  async function saveGuildTargets(guild: AccountGuildEntry) {
    const editor = editors[guild.guildId] ?? { input: buildChannelInput(targetsByGuild.get(guild.guildId) ?? []), error: "", dirty: false, saving: false };
    const parsed = parseChannelIdsInput(editor.input);
    if (parsed.invalid.length > 0) {
      setEditors(prev => ({
        ...prev,
        [guild.guildId]: { ...editor, error: `Geçersiz kanal ID'leri: ${parsed.invalid.join(", ")}` },
      }));
      return;
    }

    const currentTargets = targetsByGuild.get(guild.guildId) ?? [];
    const canSubmit = parsed.valid.length > 0 || currentTargets.length > 0;
    if (!canSubmit) return;

    setEditors(prev => ({
      ...prev,
      [guild.guildId]: { ...editor, error: "", saving: true },
    }));
    try {
      const result = await api.accounts.syncGuildTargets(account.accountId, guild.guildId, parsed.valid);
      const nextInput = parsed.valid.join("\n");
      setEditors(prev => ({
        ...prev,
        [guild.guildId]: { input: nextInput, error: "", dirty: false, saving: false },
      }));
      addToast({
        type: "success",
        title: "Kanal hedefleri güncellendi",
        msg: `${guild.guildName} — +${result.addedCount} / -${result.removedCount}`,
      });
      await refreshData(true);
      onChanged();
    } catch (e) {
      setEditors(prev => ({
        ...prev,
        [guild.guildId]: { ...editor, error: (e as Error).message, saving: false },
      }));
    }
  }

  async function pauseAccount(reason: string) {
    setAccountAction("pause");
    try {
      const state = await api.accounts.pause(account.accountId, reason || undefined);
      setAccountPause(state);
      setShowPauseAccountModal(false);
      addToast({
        type: "success",
        title: state.pauseAcknowledged ? "Hesap duraklatıldı" : "Duraklatma isteği gönderildi",
        msg: `${account.username || account.accountId} · ${state.pausedTargetCount} kanal durdu`,
      });
      await refreshData(true);
      onChanged();
    } catch (e) {
      addToast({ type: "error", title: "Hesap duraklatılamadı", msg: (e as Error).message });
    } finally {
      setAccountAction(null);
    }
  }

  async function resumeAccount() {
    setAccountAction("resume");
    try {
      const state = await api.accounts.resume(account.accountId);
      setAccountPause(state);
      addToast({
        type: "success",
        title: "Hesap devam ediyor",
        msg: `${account.username || account.accountId} yeniden planlanabilir`,
      });
      await refreshData(true);
      onChanged();
    } catch (e) {
      addToast({ type: "error", title: "Hesap devam ettirilemedi", msg: (e as Error).message });
    } finally {
      setAccountAction(null);
    }
  }

  async function pauseChannel(reason: string) {
    if (!pauseTarget) return;
    const target = pauseTarget;
    setChannelActionId(target.channelId);
    try {
      const state = await api.accounts.pauseTarget(target.channelId, reason || undefined);
      setPauseTarget(null);
      addToast({
        type: "success",
        title: state.pauseAcknowledged ? "Kanal duraklatıldı" : "Kanal duraklatma isteği gönderildi",
        msg: targetDisplayName(target),
      });
      await refreshData(true);
      onChanged();
    } catch (e) {
      addToast({ type: "error", title: "Kanal duraklatılamadı", msg: (e as Error).message });
    } finally {
      setChannelActionId(null);
    }
  }

  async function resumeChannel(target: AccountTargetsListItem) {
    setChannelActionId(target.channelId);
    try {
      const state = await api.accounts.resumeTarget(target.channelId);
      addToast({
        type: "success",
        title: "Kanal devam ediyor",
        msg: state.pauseRequested ? "Kanal düzeyi duraklatma kaldırıldı, ancak hesap duraklatması sürüyor" : targetDisplayName(target),
      });
      await refreshData(true);
      onChanged();
    } catch (e) {
      addToast({ type: "error", title: "Kanal devam ettirilemedi", msg: (e as Error).message });
    } finally {
      setChannelActionId(null);
    }
  }

  const overlayStyle: React.CSSProperties = {
    position: "fixed", inset: 0, zIndex: 9100,
    background: "rgba(0,0,0,0.62)", backdropFilter: "blur(6px)",
    display: "flex", justifyContent: "flex-end",
    animation: "fadeIn .15s ease both",
  };
  const drawerStyle: React.CSSProperties = {
    width: 1080, maxWidth: "98vw", height: "100%",
    background: "var(--bg-3)", borderLeft: "1px solid var(--gb1)",
    boxShadow: "var(--sh-float)", display: "flex", flexDirection: "column",
    animation: "slideInRight .18s ease both",
  };

  return (
    <div style={overlayStyle} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={drawerStyle} onClick={e => e.stopPropagation()}>
        <div style={{ padding: "18px 22px 14px", borderBottom: "1px solid var(--gb1)", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--t1)" }}>Kanal Hedefleri</div>
            <div style={{ fontSize: 11, color: "var(--t4)", marginTop: 2 }}>{account.username} · {account.accountId}</div>
          </div>
          {effectivePause.paused ? <span style={toneChipStyle(effectivePause.pauseAcknowledged ? "var(--orange)" : "var(--yellow)")}>{effectivePause.pauseAcknowledged ? "Hesap durdu" : "Hesap duruyor"}</span> : null}
          {runtimeEntries(effectivePause.runtimeStateCounts).slice(0, 3).map(entry => (
            <span key={entry.key} style={toneChipStyle(entry.color)}>{entry.label}</span>
          ))}
          <span className="chip chip-blue" style={{ fontSize: 11 }}>{total} kanal</span>
          {effectivePause.paused ? (
            <button className="btn btn-primary btn-sm" onClick={() => { void resumeAccount(); }} disabled={accountAction !== null}>
              {accountAction === "resume" ? <Spinner /> : "Hesabı Devam Ettir"}
            </button>
          ) : (
            <button className="btn btn-secondary btn-sm" onClick={() => setShowPauseAccountModal(true)} disabled={accountAction !== null || total === 0}>
              {accountAction === "pause" ? <Spinner /> : "Hesabı Duraklat"}
            </button>
          )}
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} style={{ fontSize: 18, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--b0)", display: "flex", alignItems: "center", gap: 10 }}>
          <input className="input input-sm" style={{ flex: 1 }} placeholder="Sunucu, kanal veya ID ara…" value={searchRaw} onChange={e => setSearchRaw(e.target.value)} />
          <button className="btn btn-secondary btn-sm" onClick={() => { void refreshData(true); }} disabled={refreshing}>{refreshing ? <Spinner /> : "Yenile"}</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(280px, 320px) minmax(0, 1fr)" }}>
          <div style={{ minHeight: 0, borderRight: "1px solid var(--b0)", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--b0)", fontSize: 12, color: "var(--t4)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span>{filteredGuilds.length} sunucu</span>
              {search ? <span style={{ color: "var(--t4)" }}>filtreli</span> : null}
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
              {loading ? (
                <div style={{ padding: 32, display: "flex", justifyContent: "center" }}><Spinner /></div>
              ) : filteredGuilds.length === 0 ? (
                <div className="empty" style={{ height: 180 }}>{search ? `"${search}" için sonuç bulunamadı` : "Bu hesap için sunucu bulunamadı"}</div>
              ) : (
                filteredGuilds.map(guild => {
                  const rowTargets = targetsByGuild.get(guild.guildId) ?? [];
                  const selected = activeGuild?.guildId === guild.guildId;
                  const icon = guildIconUrl(guild.guildId, guild.guildIcon);
                  return (
                    <button
                      key={guild.guildId}
                      onClick={() => setSelectedGuildId(guild.guildId)}
                      style={{
                        textAlign: "left",
                        border: selected ? "1px solid rgba(56,189,248,.45)" : "1px solid var(--b0)",
                        background: selected ? "rgba(56,189,248,.08)" : "rgba(255,255,255,.02)",
                        borderRadius: 14,
                        padding: 12,
                        cursor: "pointer",
                        display: "flex",
                        gap: 12,
                        alignItems: "center",
                      }}
                    >
                      {icon ? (
                        <img src={icon} alt="" style={{ width: 42, height: 42, borderRadius: 11, objectFit: "cover", flexShrink: 0 }} />
                      ) : (
                        <div style={{ width: 42, height: 42, borderRadius: 11, background: "var(--g2)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--t4)", fontWeight: 800, flexShrink: 0 }}>
                          {(guild.guildName || "?")[0]?.toUpperCase()}
                        </div>
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {guild.guildName || guild.guildId}
                        </div>
                        <div style={{ fontSize: 10, color: "var(--t4)", marginTop: 3, fontFamily: "var(--mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {guild.guildId}
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
                          <span className="chip chip-blue" style={{ fontSize: 10 }}>{rowTargets.length} hedef</span>
                          {guild.guildOwner ? <span className="chip" style={{ fontSize: 10 }}>Owner</span> : null}
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
          <div style={{ minHeight: 0, display: "flex", flexDirection: "column" }}>
            {loading ? (
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}><Spinner /></div>
            ) : !activeGuild || !activeEditor ? (
              <div className="empty" style={{ flex: 1 }}>Düzenlemek için soldan bir sunucu seç</div>
            ) : (
              <>
                <div style={{ padding: "18px 20px", borderBottom: "1px solid var(--b0)", display: "flex", gap: 14, alignItems: "center" }}>
                  {guildIconUrl(activeGuild.guildId, activeGuild.guildIcon) ? (
                    <img src={guildIconUrl(activeGuild.guildId, activeGuild.guildIcon)!} alt="" style={{ width: 48, height: 48, borderRadius: 12, objectFit: "cover", flexShrink: 0 }} />
                  ) : (
                    <div style={{ width: 48, height: 48, borderRadius: 12, background: "var(--g2)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--t4)", fontWeight: 800, flexShrink: 0 }}>
                      {(activeGuild.guildName || "?")[0]?.toUpperCase()}
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 18, fontWeight: 800, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {activeGuild.guildName || activeGuild.guildId}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--t4)", marginTop: 4, fontFamily: "var(--mono)" }}>{activeGuild.guildId}</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                      <span className="chip chip-blue" style={{ fontSize: 10 }}>{activeTargets.length} hedef kanal</span>
                      {activeGuild.guildOwner ? <span className="chip" style={{ fontSize: 10 }}>Owner</span> : null}
                      {activeGuild.lastSynced ? <span style={{ fontSize: 10, color: "var(--t4)", alignSelf: "center" }}>{formatTimestamp(activeGuild.lastSynced)}</span> : null}
                    </div>
                  </div>
                </div>
                <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ padding: 16, background: "rgba(255,255,255,.02)", borderRadius: 14, border: "1px solid var(--b0)" }}>
                    <div style={{ fontSize: 10, color: "var(--t4)", fontWeight: 700, textTransform: "uppercase", letterSpacing: .6, marginBottom: 6 }}>Kanal ID'leri (her satıra bir tane)</div>
                    <textarea
                      value={activeEditor.input}
                      onChange={e => updateEditor(activeGuild.guildId, e.target.value)}
                      rows={7}
                      placeholder={"123456789012345678\n234567890123456789"}
                      style={{ width: "100%", resize: "vertical", boxSizing: "border-box", background: "var(--bg-2)", color: "var(--t1)", border: "1px solid var(--gb1)", borderRadius: 12, padding: "12px 14px", fontSize: 12, fontFamily: "var(--mono)", minHeight: 160 }}
                    />
                    {activeEditor.input ? (
                      <div style={{ fontSize: 11, color: activeParsed.invalid.length > 0 ? "var(--red)" : activeParsed.valid.length > 0 ? "var(--green)" : "var(--t4)", marginTop: 6, fontWeight: 600 }}>
                        {activeParsed.invalid.length > 0
                          ? `Geçersiz ID: ${activeParsed.invalid.join(", ")}`
                          : activeParsed.valid.length > 0
                            ? `${activeParsed.valid.length} geçerli ID`
                            : "Geçerli ID yok"}
                      </div>
                    ) : null}
                    <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => fillFromCurrentTargets(activeGuild.guildId)}>Mevcutları Doldur</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => updateEditor(activeGuild.guildId, "")}>Temizle</button>
                      <button className="btn btn-primary btn-sm" onClick={() => { void saveGuildTargets(activeGuild); }} disabled={activeEditor.saving || !activeCanSubmit} style={{ marginLeft: "auto" }}>
                        {activeEditor.saving ? <Spinner /> : activeParsed.valid.length > 0 ? `Doğrula & Kaydet (${activeParsed.valid.length} kanal)` : "Tüm Hedefleri Kaldır"}
                      </button>
                    </div>
                    {activeEditor.error ? (
                      <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, background: "rgba(255,69,58,.1)", border: "1px solid rgba(255,69,58,.25)", color: "#ff453a", fontSize: 12, fontWeight: 600 }}>
                        {activeEditor.error}
                      </div>
                    ) : (
                      <div style={{ fontSize: 10, color: "var(--t4)", marginTop: 8 }}>
                        Hesabın sunucuda olup olmadığı ve kanal erişimi kontrol edilecek. Boş bırakıp kaydedersen bu sunucu için hedefler kaldırılır.
                      </div>
                    )}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14, alignItems: "start" }}>
                    <div style={{ padding: 16, background: "rgba(255,255,255,.02)", borderRadius: 14, border: "1px solid var(--b0)" }}>
                      <div style={{ fontSize: 10, color: "var(--t4)", fontWeight: 700, textTransform: "uppercase", letterSpacing: .6, marginBottom: 8 }}>Mevcut Hedefler</div>
                      {activeTargets.length === 0 ? (
                        <div style={{ fontSize: 12, color: "var(--t4)", fontStyle: "italic" }}>Henüz hedef kanal yok</div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          {activeTargets.map(target => (
                            <div key={target.channelId} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: 12, borderRadius: 12, border: "1px solid var(--b0)", background: "rgba(255,255,255,.02)" }}>
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{targetDisplayName(target)}</div>
                                <div style={{ fontSize: 10, color: "var(--t4)", marginTop: 3, fontFamily: "var(--mono)" }}>{target.channelId}</div>
                                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                                  <span style={toneChipStyle(schedulerMeta(target.schedulerState).color)}>{schedulerMeta(target.schedulerState).label}</span>
                                  {targetPauseMeta(target) ? <span style={toneChipStyle(targetPauseMeta(target)!.color)}>{targetPauseMeta(target)!.label}</span> : null}
                                  {target.requestedPauseSource && target.pauseRequested ? <span className="chip" style={{ fontSize: 10 }}>{pauseSourceText(target.requestedPauseSource)}</span> : null}
                                </div>
                                {target.pauseReason ? <div style={{ fontSize: 10, color: "var(--t4)", marginTop: 8, lineHeight: 1.5 }}>{target.pauseReason}</div> : null}
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                                {target.channelPauseRequested ? (
                                  <button className="btn btn-primary btn-xs" onClick={() => { void resumeChannel(target); }} disabled={channelActionId === target.channelId}>
                                    {channelActionId === target.channelId ? <Spinner /> : "Devam"}
                                  </button>
                                ) : target.pauseRequested ? (
                                  <button className="btn btn-secondary btn-xs" disabled title="Kanal hesap düzeyi duraklatmadan etkileniyor">
                                    Beklemede
                                  </button>
                                ) : (
                                  <button className="btn btn-secondary btn-xs" onClick={() => setPauseTarget(target)} disabled={channelActionId === target.channelId || effectivePause.paused} title={effectivePause.paused ? "Hesap duraklatılmışken yeni kanal duraklatması gerekmez" : undefined}>
                                    Duraklat
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div style={{ padding: 16, background: "rgba(255,255,255,.02)", borderRadius: 14, border: "1px solid var(--b0)" }}>
                      <div style={{ fontSize: 10, color: "var(--t4)", fontWeight: 700, textTransform: "uppercase", letterSpacing: .6, marginBottom: 8 }}>Hızlı Kanal Seçimi</div>
                      <div style={{ fontSize: 11, color: "var(--t4)", marginBottom: 8 }}>Bir kanala tıklayınca üstteki listeye eklenir.</div>
                      {activeLoadingChannels ? (
                        <div style={{ paddingTop: 4 }}><Spinner /></div>
                      ) : activeQuickChannels.length === 0 ? (
                        <div style={{ fontSize: 12, color: "var(--t4)", fontStyle: "italic" }}>Öneri kanal yüklenemedi veya erişim yok</div>
                      ) : (
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {activeQuickChannels.map(channel => (
                            <button key={channel.id} className="chip" onClick={() => appendSuggestedChannel(activeGuild.guildId, channel.id)} style={{ fontSize: 10, border: "none", cursor: "pointer" }}>
                              #{channel.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {showPauseAccountModal && (
        <PauseReasonModal
          title="Hesabı Duraklat"
          message={`${account.username || account.accountId} için çalışan ve kuyruktaki kanallar güvenli şekilde durdurulacak.`}
          confirmLabel="Duraklat"
          submitting={accountAction === "pause"}
          initialReason={effectivePause.pauseReason ?? ""}
          onConfirm={pauseAccount}
          onCancel={() => { if (accountAction === null) setShowPauseAccountModal(false); }}
        />
      )}
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

/* ── Single account row ── */
function AccountRow({ acc, onEdit, onDelete, onTargets, onArchive, onTransfer, onPause, onResume, busy, bulkMode, selected, onSelect }: {
  acc: AccountListItem;
  onEdit: (a: AccountListItem) => void;
  onDelete: (a: AccountListItem) => void;
  onTargets: (a: AccountListItem) => void;
  onArchive: (a: AccountListItem) => void;
  onTransfer: (a: AccountListItem) => void;
  onPause: (a: AccountListItem) => void;
  onResume: (a: AccountListItem) => void;
  busy: boolean;
  bulkMode?: boolean;
  selected?: boolean;
  onSelect?: (id: string, checked: boolean) => void;
}) {
  const [imgErr, setImgErr] = useState(false);
  const avatar = imgErr ? discordAvatarUrl(acc.accountId, "") : discordAvatarUrl(acc.accountId, acc.avatar);
  const statusMeta = accountStateMeta(acc);
  const runtimeSummary = runtimeEntries(acc.runtimeStateCounts).slice(0, 3);
  const baseBackground = acc.status === "failed" ? "rgba(255,69,58,.03)" : acc.paused ? "rgba(255,159,10,.04)" : "";
  const hoverBackground = acc.status === "failed" ? "rgba(255,69,58,.06)" : acc.paused ? "rgba(255,159,10,.08)" : "var(--g1)";
  const canDelete = acc.idx >= 0;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12, padding: "9px 16px",
      borderBottom: "1px solid var(--b0)", transition: "background .1s",
      background: selected ? "rgba(56,189,248,.06)" : baseBackground,
      boxShadow: selected ? "inset 3px 0 0 #38BDF8" : acc.status === "failed" ? "inset 3px 0 0 rgba(255,69,58,.5)" : acc.paused ? "inset 3px 0 0 rgba(255,159,10,.5)" : undefined,
    }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = hoverBackground; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = baseBackground; }}
    >
      {/* A4: Bulk checkbox */}
      {bulkMode && (
        <input type="checkbox" checked={!!selected} onChange={e => onSelect?.(acc.accountId, e.target.checked)}
          style={{ width: 15, height: 15, cursor: 'pointer', flexShrink: 0, accentColor: '#38BDF8' }} onClick={e => e.stopPropagation()} />
      )}
      {/* Avatar */}
      <div style={{ width: 34, height: 34, borderRadius: "50%", overflow: "hidden", flexShrink: 0, background: "var(--g2)", border: acc.status === "failed" ? "1px solid rgba(255,69,58,.25)" : undefined }}>
        <img src={avatar} alt="" style={{ width: "100%", height: "100%" }} onError={() => setImgErr(true)} />
      </div>

      {/* Username + Discord ID */}
      <div style={{ width: 188, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {acc.username || <span style={{ color: "var(--t4)", fontStyle: "italic" }}>Geçersiz</span>}
        </div>
        <div style={{ fontSize: 10, color: "var(--t4)", fontFamily: "var(--mono)", marginTop: 1 }}>
          {acc.accountId}
        </div>
        {acc.status === "failed" && (acc.tokenHint || acc.failedDetectedAt) ? (
          <div style={{ fontSize: 9, color: "var(--t4)", marginTop: 4, display: "flex", gap: 8, flexWrap: "wrap", fontFamily: "var(--mono)" }}>
            {acc.tokenHint ? <span>{acc.tokenHint}</span> : null}
            {acc.failedDetectedAt ? <span style={{ fontFamily: "inherit" }}>{formatTimestamp(acc.failedDetectedAt)}</span> : null}
          </div>
        ) : null}
      </div>

      {/* Email */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        {acc.email
          ? <span style={{ fontSize: 12, color: "var(--t2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{acc.email}</span>
          : <span style={{ fontSize: 12, color: "var(--t4)", fontStyle: "italic" }}>—</span>
        }
        {acc.status === "failed" && acc.failedError ? (
          <span title={acc.failedError} style={{ fontSize: 10, color: "var(--red)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
            {acc.failedError}
          </span>
        ) : null}
        {(acc.paused || runtimeSummary.length > 0) ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
            {acc.paused ? <span style={toneChipStyle(statusMeta.color)}>{statusMeta.label}</span> : null}
            {runtimeSummary.map(entry => <span key={entry.key} style={toneChipStyle(entry.color)}>{entry.label}</span>)}
          </div>
        ) : null}
        {acc.pauseReason ? <span style={{ fontSize: 10, color: "var(--t4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{acc.pauseReason}</span> : null}
      </div>

      {/* Guild count */}
      <div style={{ width: 76, textAlign: "center", flexShrink: 0 }}>
        <span className="chip chip-blue" style={{ fontSize: 11 }}>{acc.guildCount} guild</span>
      </div>

      {/* Target count */}
      <div style={{ width: 80, textAlign: "center", flexShrink: 0 }}>
        <button className="chip" onClick={() => onTargets(acc)} style={{ fontSize: 11, border: "none", cursor: "pointer" }}>{acc.targetCount} kanal</button>
      </div>

      {/* A1/A2: Health + last active */}
      <div style={{ width: 72, textAlign: "center", flexShrink: 0 }}>
        {acc.status !== 'failed' ? (
          <HealthBadge score={acc.healthScore ?? 100} label={acc.healthLabel ?? 'excellent'} rlHits={acc.totalRateLimitHits ?? 0} lastActiveAt={acc.lastActiveAt ?? null} />
        ) : (
          <span style={{ fontSize: 10, color: 'var(--t4)' }}>—</span>
        )}
      </div>

      {/* Status */}
      <div style={{ width: 118, textAlign: "center", flexShrink: 0 }}>
        <span style={{ fontSize: 11, color: statusMeta.color, display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 600 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: statusMeta.color, display: "inline-block" }} />
          {statusMeta.label}
        </span>
        {acc.pauseRequestedAt ? <div style={{ fontSize: 9, color: "var(--t4)", marginTop: 4 }}>{formatTimestamp(acc.pauseRequestedAt)}</div> : null}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 6, flexShrink: 0, width: 320, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button className="btn btn-secondary btn-xs" onClick={() => onEdit(acc)} disabled={busy}>✏ Düzenle</button>
        {acc.status !== "failed" ? (
          acc.paused
            ? <button className="btn btn-primary btn-xs" onClick={() => onResume(acc)} disabled={busy}>Devam</button>
            : <button className="btn btn-secondary btn-xs" onClick={() => onPause(acc)} disabled={busy || acc.targetCount === 0} title={acc.targetCount === 0 ? "Hedef kanal yok" : undefined}>Duraklat</button>
        ) : null}
        {acc.status === "failed" ? <button className="btn btn-secondary btn-xs" onClick={() => onArchive(acc)} disabled={busy}>Arşivle</button> : null}
        {acc.status === "failed" ? <button className="btn btn-primary btn-xs" onClick={() => onTransfer(acc)} disabled={busy}>Transfer</button> : null}
        <button className="btn btn-danger btn-icon btn-xs" onClick={() => onDelete(acc)} disabled={busy || !canDelete} title={canDelete ? undefined : "Aktif token bulunamadı"}>×</button>
      </div>
    </div>
  );
}

/* ═══ MAIN PAGE ═════════════════════════════════════════════════════════════ */
export function Accounts() {
  const [page, setPage]         = useState(1);
  const LIMIT                   = 50;
  const [searchRaw, setSearchRaw] = useState("");
  const search = useDebounce(searchRaw, 300);

  // A4: Bulk select state
  const [bulkMode, setBulkMode]   = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy]   = useState(false);

  // Reset page on search change
  useEffect(() => { setPage(1); }, [search]);

  const { data, loading, reload } = useFetch<AccountsListResponse>(
    () => api.accounts.accountsList(page, LIMIT, search || undefined) as Promise<AccountsListResponse>,
    [page, LIMIT, search],
  );
  useInterval(() => { void reload(); }, 10_000, false);

  // Add-account form state
  const [token, setToken]               = useState("");
  const [email, setEmail]               = useState("");
  const [mailSite, setMailSite]         = useState("");
  const [accountPassword, setAccountPw] = useState("");
  const [mailPassword, setMailPw]       = useState("");
  const [showAccPwd, setShowAccPwd]     = useState(false);
  const [showMailPwd, setShowMailPwd]   = useState(false);
  const [adding, setAdding]             = useState(false);

  // Modal state
  const [editingAcc, setEditingAcc]   = useState<AccountListItem | null>(null);
  const [deletingAcc, setDeletingAcc] = useState<AccountListItem | null>(null);
  const [deleting, setDeleting]       = useState(false);
  const [targetsAcc, setTargetsAcc]   = useState<AccountListItem | null>(null);
  const [archivingAcc, setArchivingAcc] = useState<AccountListItem | null>(null);
  const [archiving, setArchiving]       = useState(false);
  const [transferAcc, setTransferAcc]   = useState<AccountListItem | null>(null);
  const [transferToken, setTransferToken] = useState("");
  const [transferring, setTransferring] = useState(false);
  const [pauseAcc, setPauseAcc] = useState<AccountListItem | null>(null);
  const [pausing, setPausing] = useState(false);
  const [resumeAccountId, setResumeAccountId] = useState<string | null>(null);

  const accounts = data?.accounts || [];
  const total    = data?.total    || 0;
  const pages    = data?.pages    || 1;

  // Bug fix B+D: use global totals from API (not current-page sums)
  const totalAccounts = data?.totalUnfiltered  ?? total;
  const totalGuilds   = data?.globalGuildCount  ?? 0;
  const totalTargets  = data?.globalTargetCount ?? 0;
  const showInitialLoading = loading && accounts.length === 0;
  const busyAccountId = deleting
    ? deletingAcc?.accountId ?? null
    : pausing
      ? pauseAcc?.accountId ?? null
      : resumeAccountId
        ? resumeAccountId
        : archiving
    ? archivingAcc?.accountId ?? null
    : transferring
      ? transferAcc?.accountId ?? null
      : null;

  // A4: Bulk select helpers
  function handleBulkSelect(id: string, checked: boolean) {
    setSelectedIds(prev => { const n = new Set(prev); checked ? n.add(id) : n.delete(id); return n; });
  }
  function handleSelectAll(checked: boolean) {
    setSelectedIds(checked ? new Set(accounts.map(a => a.accountId)) : new Set());
  }
  function exitBulkMode() { setBulkMode(false); setSelectedIds(new Set()); }

  async function bulkPause() {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      const ids = [...selectedIds];
      const r = await api.accounts.bulkAction(ids, 'pause');
      addToast({ type: 'success', title: `${r.succeeded}/${ids.length} hesap duraklatıldı` });
      exitBulkMode(); reload();
    } catch (e) { addToast({ type: 'error', title: 'Toplu duraklatma hatası', msg: (e as Error).message }); }
    finally { setBulkBusy(false); }
  }

  async function bulkResume() {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      const ids = [...selectedIds];
      const r = await api.accounts.bulkAction(ids, 'resume');
      addToast({ type: 'success', title: `${r.succeeded}/${ids.length} hesap devam ettirildi` });
      exitBulkMode(); reload();
    } catch (e) { addToast({ type: 'error', title: 'Toplu devam ettirme hatası', msg: (e as Error).message }); }
    finally { setBulkBusy(false); }
  }

  function withPauseState(acc: AccountListItem, snapshot: AccountPauseState): AccountListItem {
    return {
      ...acc,
      paused: snapshot.paused,
      pauseReason: snapshot.pauseReason,
      pauseRequestedBy: snapshot.pauseRequestedBy,
      pauseRequestedAt: snapshot.pauseRequestedAt,
      pauseRequestId: snapshot.pauseRequestId,
      pauseAcknowledged: snapshot.pauseAcknowledged,
      runtimeStateCounts: snapshot.runtimeStateCounts,
      runningTargetCount: snapshot.runningTargetCount,
      queuedTargetCount: snapshot.queuedTargetCount,
      pausedTargetCount: snapshot.pausedTargetCount,
    };
  }

  async function addToken() {
    if (!token.trim()) return;
    setAdding(true);
    try {
      const r = await api.accounts.add(
        token.trim(),
        email.trim() || undefined,
        accountPassword || undefined,
        mailPassword || undefined,
        mailSite.trim() || undefined,
      ) as any;
      setToken(""); setEmail(""); setMailSite(""); setAccountPw(""); setMailPw("");
      if (r?.restored) {
        addToast({ type: "success", title: "Hesap geri yüklendi!",
          msg: `${r.restored.username} — ${r.restored.guildsRestored} sunucu, ${r.restored.channelsRestored} kanal` });
      } else {
        addToast({ type: "success", title: "Hesap eklendi" });
      }
      reload();
    } catch (e) {
      addToast({ type: "error", title: "Ekleme hatası", msg: (e as Error).message });
    } finally { setAdding(false); }
  }

  async function deleteAccount() {
    if (!deletingAcc) return;
    setDeleting(true);
    try {
      if (deletingAcc.idx < 0) throw new Error("Hesap indeksi bulunamadı, sayfayı yenileyin");
      await api.accounts.remove(deletingAcc.idx);
      addToast({ type: "success", title: "Hesap silindi", msg: deletingAcc.username });
      if (targetsAcc?.accountId === deletingAcc.accountId) setTargetsAcc(null);
      if (transferAcc?.accountId === deletingAcc.accountId) { setTransferAcc(null); setTransferToken(""); }
      if (archivingAcc?.accountId === deletingAcc.accountId) setArchivingAcc(null);
      setDeletingAcc(null);
      reload();
    } catch (e) {
      addToast({ type: "error", title: "Silme hatası", msg: (e as Error).message });
    } finally { setDeleting(false); }
  }

  async function archiveInvalidAccount() {
    if (!archivingAcc) return;
    setArchiving(true);
    try {
      await api.archive.create(archivingAcc.accountId, archiveReasonForAccount(archivingAcc));
      addToast({
        type: "success",
        title: "Hesap arşivlendi",
        msg: `${archivingAcc.username || archivingAcc.accountId} için snapshot alındı`,
      });
      setArchivingAcc(null);
      reload();
    } catch (e) {
      addToast({ type: "error", title: "Arşivleme hatası", msg: (e as Error).message });
    } finally {
      setArchiving(false);
    }
  }

  async function transferInvalidAccount() {
    if (!transferAcc || !transferToken.trim()) return;
    setTransferring(true);
    try {
      await api.archive.create(transferAcc.accountId, archiveReasonForAccount(transferAcc));
      const result = await api.archive.transfer(transferAcc.accountId, transferToken.trim());
      addToast({
        type: "success",
        title: "Transfer başarılı",
        msg: `${result.newUsername} (${result.newAccountId}) — ${result.invitesCreated} davet, ${result.targetsCreated} hedef oluşturuldu`,
      });
      if (editingAcc?.accountId === transferAcc.accountId) setEditingAcc(null);
      if (targetsAcc?.accountId === transferAcc.accountId) setTargetsAcc(null);
      setTransferToken("");
      setTransferAcc(null);
      reload();
    } catch (e) {
      addToast({ type: "error", title: "Transfer hatası", msg: (e as Error).message });
    } finally {
      setTransferring(false);
    }
  }

  async function pauseAccount(reason: string) {
    if (!pauseAcc) return;
    setPausing(true);
    try {
      const snapshot = await api.accounts.pause(pauseAcc.accountId, reason || undefined);
      addToast({
        type: "success",
        title: snapshot.pauseAcknowledged ? "Hesap duraklatıldı" : "Duraklatma isteği gönderildi",
        msg: `${pauseAcc.username || pauseAcc.accountId} · ${snapshot.pausedTargetCount} kanal durdu`,
      });
      if (targetsAcc?.accountId === pauseAcc.accountId) setTargetsAcc(withPauseState(targetsAcc, snapshot));
      setPauseAcc(null);
      reload();
    } catch (e) {
      addToast({ type: "error", title: "Hesap duraklatılamadı", msg: (e as Error).message });
    } finally {
      setPausing(false);
    }
  }

  async function resumeAccount(acc: AccountListItem) {
    setResumeAccountId(acc.accountId);
    try {
      const snapshot = await api.accounts.resume(acc.accountId);
      addToast({
        type: "success",
        title: "Hesap devam ediyor",
        msg: `${acc.username || acc.accountId} yeniden planlanabilir`,
      });
      if (targetsAcc?.accountId === acc.accountId) setTargetsAcc(withPauseState(targetsAcc, snapshot));
      reload();
    } catch (e) {
      addToast({ type: "error", title: "Hesap devam ettirilemedi", msg: (e as Error).message });
    } finally {
      setResumeAccountId(null);
    }
  }

  return (
    <div className="page-enter">
      {/* ── Stat cards ── */}
      <div className="stat-grid stat-grid-3" style={{ marginBottom: 16 }}>
        <StatCard label="Toplam Hesap"    value={totalAccounts} color="var(--blurple)" delay={0}  />
        <StatCard label="Toplam Guild"    value={totalGuilds}   color="var(--green)"   delay={45} />
        <StatCard label="Kanal Hedefleri" value={totalTargets}  color="var(--orange)"  delay={90} />
      </div>

      {/* ── Add account form ── */}
      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="panel-head"><span className="panel-title">Hesap Ekle</span></div>
        <div style={{ padding: "14px 16px" }}>
          {/* Row 1: Token + Email + Mail Site */}
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1.4fr 1.4fr", gap: 10, marginBottom: 8 }}>
            <div>
              <label style={{ fontSize: 10, color: "var(--t4)", fontWeight: 700, textTransform: "uppercase", letterSpacing: .6, display: "block", marginBottom: 4 }}>
                Discord Token *
              </label>
              <input className="input input-sm" type="password" placeholder="Discord kullanıcı token'ı…"
                value={token} onChange={e => setToken(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addToken()} />
            </div>
            <div>
              <label style={{ fontSize: 10, color: "var(--t4)", fontWeight: 700, textTransform: "uppercase", letterSpacing: .6, display: "block", marginBottom: 4 }}>Email</label>
              <input className="input input-sm" type="email" placeholder="hesap@email.com"
                value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: 10, color: "var(--t4)", fontWeight: 700, textTransform: "uppercase", letterSpacing: .6, display: "block", marginBottom: 4 }}>Mail Sitesi</label>
              <input className="input input-sm" type="url" placeholder="https://mail.google.com"
                value={mailSite} onChange={e => setMailSite(e.target.value)} />
            </div>
          </div>
          {/* Row 2: Account password + Mail password + Submit */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 10, alignItems: "end" }}>
            <div>
              <label style={{ fontSize: 10, color: "var(--t4)", fontWeight: 700, textTransform: "uppercase", letterSpacing: .6, display: "block", marginBottom: 4 }}>Hesap Şifresi</label>
              <div style={{ position: "relative" }}>
                <input className="input input-sm" type={showAccPwd ? "text" : "password"} placeholder="Discord şifresi"
                  value={accountPassword} onChange={e => setAccountPw(e.target.value)} style={{ paddingRight: 52 }} />
                <button className="btn btn-ghost btn-xs" onClick={() => setShowAccPwd(v => !v)}
                  style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", fontSize: 10 }}>
                  {showAccPwd ? "Gizle" : "Göster"}
                </button>
              </div>
            </div>
            <div>
              <label style={{ fontSize: 10, color: "var(--t4)", fontWeight: 700, textTransform: "uppercase", letterSpacing: .6, display: "block", marginBottom: 4 }}>Mail Şifresi</label>
              <div style={{ position: "relative" }}>
                <input className="input input-sm" type={showMailPwd ? "text" : "password"} placeholder="Email şifresi"
                  value={mailPassword} onChange={e => setMailPw(e.target.value)} style={{ paddingRight: 52 }} />
                <button className="btn btn-ghost btn-xs" onClick={() => setShowMailPwd(v => !v)}
                  style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", fontSize: 10 }}>
                  {showMailPwd ? "Gizle" : "Göster"}
                </button>
              </div>
            </div>
            <button className="btn btn-primary btn-sm" onClick={addToken} disabled={!token.trim() || adding}
              style={{ whiteSpace: "nowrap" }}>
              {adding ? <Spinner /> : "+ Hesap Ekle"}
            </button>
          </div>
        </div>
      </div>

      {/* ── Account table ── */}
      <div className="panel" style={{ overflow: "hidden" }}>
        {/* Search + count header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid var(--b0)" }}>
          <input className="input input-sm" style={{ width: 280 }}
            placeholder="Kullanıcı adı, Discord ID veya email ara…"
            value={searchRaw} onChange={e => setSearchRaw(e.target.value)} />
          <button className="btn btn-secondary btn-xs" onClick={() => { setBulkMode(v => !v); if (bulkMode) setSelectedIds(new Set()); }}
            style={{ marginLeft: 'auto' }}>
            {bulkMode ? 'Toplu Mod Kapat' : 'Toplu Seç'}
          </button>
          <span style={{ fontSize: 12, color: "var(--t4)" }}>
            {total} hesap{search ? ` · "${search}" filtreli` : ""}
          </span>
        </div>

        {/* A4: Bulk action toolbar */}
        {bulkMode && selectedIds.size > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', background: 'rgba(56,189,248,.08)', borderBottom: '1px solid rgba(56,189,248,.2)' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#38BDF8' }}>{selectedIds.size} hesap seçili</span>
            <div style={{ flex: 1 }} />
            <button className="btn btn-secondary btn-sm" onClick={bulkPause} disabled={bulkBusy}>Toplu Duraklat</button>
            <button className="btn btn-primary btn-sm" onClick={bulkResume} disabled={bulkBusy}>Toplu Devam</button>
            <button className="btn btn-ghost btn-sm" onClick={exitBulkMode}>İptal</button>
          </div>
        )}

        {/* Column headers */}
        <div style={{
          display: "flex", alignItems: "center", gap: 12, padding: "7px 16px",
          background: "var(--g1)", borderBottom: "1px solid var(--b0)",
          fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: .7, color: "var(--t4)",
        }}>
          {bulkMode ? (
            <input type="checkbox"
              checked={selectedIds.size === accounts.length && accounts.length > 0}
              onChange={e => handleSelectAll(e.target.checked)}
              style={{ width: 15, height: 15, cursor: 'pointer', accentColor: '#38BDF8', flexShrink: 0 }}
            />
          ) : <div style={{ width: 34 }} />}
          <div style={{ width: 188 }}>Kullanıcı</div>
          <div style={{ flex: 1 }}>Email</div>
          <div style={{ width: 76, textAlign: "center" }}>Guild</div>
          <div style={{ width: 80, textAlign: "center" }}>Kanal</div>
          <div style={{ width: 72, textAlign: "center" }}>Sağlık</div>
          <div style={{ width: 118, textAlign: "center" }}>Durum</div>
          <div style={{ width: 320 }} />
        </div>

        {/* Rows */}
        {showInitialLoading ? (
          <div style={{ padding: 32, display: "flex", justifyContent: "center" }}><Spinner /></div>
        ) : accounts.length === 0 ? (
          <div className="empty" style={{ height: 120 }}>
            {search ? `"${search}" için sonuç bulunamadı` : "Henüz hesap eklenmemiş"}
          </div>
        ) : (
          accounts.map(acc => (
            <AccountRow key={acc.accountId} acc={acc}
              onEdit={setEditingAcc}
              onDelete={setDeletingAcc}
              onTargets={setTargetsAcc}
              onArchive={setArchivingAcc}
              onTransfer={acc => { setTransferToken(""); setTransferAcc(acc); }}
              onPause={setPauseAcc}
              onResume={acc => { void resumeAccount(acc); }}
              busy={busyAccountId === acc.accountId}
              bulkMode={bulkMode}
              selected={selectedIds.has(acc.accountId)}
              onSelect={handleBulkSelect}
            />
          ))
        )}

        {/* Pagination */}
        {pages > 1 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "12px 16px", borderTop: "1px solid var(--b0)" }}>
            <button className="btn btn-secondary btn-sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>
              ◀ Önceki
            </button>
            <span style={{ fontSize: 12, color: "var(--t3)", minWidth: 90, textAlign: "center" }}>
              Sayfa {page} / {pages}
            </span>
            <button className="btn btn-secondary btn-sm" onClick={() => setPage(p => Math.min(pages, p + 1))} disabled={page >= pages}>
              Sonraki ▶
            </button>
          </div>
        )}
      </div>

      {/* Credentials edit modal */}
      {editingAcc && (
        <CredentialsModal
          accountId={editingAcc.accountId}
          username={editingAcc.username || editingAcc.accountId}
          onClose={() => { setEditingAcc(null); reload(); }}
        />
      )}

      {transferAcc && (
        <FailedTransferModal
          account={transferAcc}
          token={transferToken}
          submitting={transferring}
          onTokenChange={setTransferToken}
          onConfirm={transferInvalidAccount}
          onClose={() => { if (!transferring) { setTransferAcc(null); setTransferToken(""); } }}
        />
      )}

      {targetsAcc && (
        <TargetsDrawer
          account={targetsAcc}
          onClose={() => setTargetsAcc(null)}
          onChanged={reload}
        />
      )}

      {/* Delete confirmation modal */}
      {deletingAcc && (
        <ConfirmModal
          title="Hesabı Sil"
          message={`"${deletingAcc.username}" hesabı ve tüm kanal atamaları silinecek. Bu işlem geri alınamaz.`}
          detail={`${deletingAcc.guildCount} guild, ${deletingAcc.targetCount} kanal hedef etkilenecek`}
          confirmLabel={deleting ? "Siliniyor…" : "Sil"}
          variant="danger"
          onConfirm={deleteAccount}
          onCancel={() => setDeletingAcc(null)}
        />
      )}

      {archivingAcc && (
        <ConfirmModal
          title="Geçersiz Hesabı Arşivle"
          message={`"${archivingAcc.username || archivingAcc.accountId}" için mevcut hedef ve sunucu snapshot'ı alınacak.`}
          detail={archivingAcc.failedError ?? `${archivingAcc.targetCount} kanal hedefi ve ${archivingAcc.guildCount} guild arşivlenecek`}
          confirmLabel={archiving ? "Arşivleniyor…" : "Arşivle"}
          variant="warning"
          onConfirm={archiveInvalidAccount}
          onCancel={() => { if (!archiving) setArchivingAcc(null); }}
        />
      )}

      {pauseAcc && (
        <PauseReasonModal
          title="Hesabı Duraklat"
          message={`${pauseAcc.username || pauseAcc.accountId} için çalışan ve kuyruktaki kanallar güvenli şekilde durdurulacak.`}
          confirmLabel="Duraklat"
          submitting={pausing}
          initialReason={pauseAcc.pauseReason ?? ""}
          onConfirm={pauseAccount}
          onCancel={() => { if (!pausing) setPauseAcc(null); }}
        />
      )}
    </div>
  );
}