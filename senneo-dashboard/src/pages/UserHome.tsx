import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../AuthContext';
import { api } from '../api';
import { addToast, useInterval } from '../hooks';
import type { UserNotification, TaskComment, UserStats, MyServer, MyServerAccount } from '../types';

const S_LBL: Record<string, string> = { pending: 'Bekliyor', in_progress: 'Devam Ediyor', completed: 'Tamamlandi' };
const S_CLR: Record<string, string> = { pending: '#a0a0a0', in_progress: '#5b9aff', completed: '#30d158' };
const ACC_COLORS = ['#0EA5E9', '#57F287', '#EB459E', '#ED4245', '#38BDF8', '#ff9f0a', '#30d158', '#BF5AF2'];
const discordIcon = (id: string, hash: string | null) => hash ? `https://cdn.discordapp.com/icons/${id}/${hash}.webp?size=64` : null;

function copyToClipboard(text: string): Promise<boolean> {
  // Method 1: Modern clipboard API
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}
function fallbackCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.top = '50%';
  ta.style.left = '50%';
  ta.style.width = '2em';
  ta.style.height = '2em';
  ta.style.padding = '0';
  ta.style.border = 'none';
  ta.style.outline = 'none';
  ta.style.boxShadow = 'none';
  ta.style.background = 'transparent';
  ta.style.opacity = '0.01';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}
function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = React.useState(false);
  return (
    <button type="button"
      onClick={() => { copyToClipboard(text).then(r => { if (r) { setOk(true); setTimeout(() => setOk(false), 1500); addToast({ type: 'success', title: 'Kopyalandi' }); } else { addToast({ type: 'error', title: 'Kopyalanamadi' }); } }); }}
      style={{ background: ok ? 'rgba(48,209,88,.15)' : 'rgba(255,255,255,.08)', border: 'none', color: ok ? '#30d158' : 'rgba(255,255,255,.5)', padding: '6px 14px', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 600, flexShrink: 0 }}>
      {ok ? '✓ Kopyalandi' : 'Kopyala'}
    </button>
  );
}

function AccAvatar({ acc, color, size = 36 }: { acc: MyServerAccount; color: string; size?: number }) {
  const [err, setErr] = React.useState(false);
  const url = !err && acc.accountId && acc.accountAvatar
    ? `https://cdn.discordapp.com/avatars/${acc.accountId}/${acc.accountAvatar}.png?size=64`
    : null;
  if (url) {
    return <img src={url} alt="" onError={() => setErr(true)}
      style={{ width: size, height: size, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }} />;
  }
  return (
    <div style={{ width: size, height: size, borderRadius: 10, background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: Math.round(size * 0.42), fontWeight: 800, color, flexShrink: 0 }}>
      {acc.accountName[0]?.toUpperCase() ?? '?'}
    </div>
  );
}

function CredRow({ label, value, masked, show, onToggle, isLink }: {
  label: string; value: string; masked?: boolean; show?: boolean; onToggle?: () => void; isLink?: boolean;
}) {
  const displayed = masked && !show ? '••••••••' : value;
  return (
    <div style={{ background: 'rgba(255,255,255,.05)', borderRadius: 8, padding: '8px 10px', minWidth: 0 }}>
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,.22)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 4 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {isLink ? (
          <a href={value.startsWith('http') ? value : `https://${value}`} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 12, color: '#5b9aff', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'none' }}
            onClick={e => e.stopPropagation()}>{value}</a>
        ) : (
          <span style={{ fontSize: 12, color: masked && !show ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.78)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: masked && !show ? 3 : 0, fontFamily: masked && !show ? 'monospace' : 'inherit' }}>
            {displayed}
          </span>
        )}
        {masked && onToggle && (
          <button type="button" onClick={e => { e.stopPropagation(); onToggle(); }}
            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.22)', cursor: 'pointer', fontSize: 10, padding: '0 2px', flexShrink: 0, lineHeight: 1 }}>
            {show ? 'Gizle' : 'Göster'}
          </button>
        )}
        <div onClick={e => e.stopPropagation()}><CopyBtn text={value} /></div>
      </div>
    </div>
  );
}

function CredCard({ acc, color }: { acc: MyServerAccount; color: string }) {
  const [showAccPw, setShowAccPw] = React.useState(false);
  const [showMailPw, setShowMailPw] = React.useState(false);
  const hasAny = acc.email || acc.mailSite || acc.accountPassword || acc.mailPassword;
  if (!hasAny) return null;
  return (
    <div style={{ padding: '10px 16px 12px', background: `${color}07`, borderBottom: '1px solid rgba(255,255,255,.05)' }}>
      <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'rgba(255,255,255,.2)', marginBottom: 8 }}>HESAP BİLGİLERİ</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 6 }}>
        {acc.email           && <CredRow label="Email"         value={acc.email}           />}
        {acc.mailSite        && <CredRow label="Mail Sitesi"   value={acc.mailSite}        isLink />}
        {acc.accountPassword && <CredRow label="Hesap Şifresi" value={acc.accountPassword} masked show={showAccPw}  onToggle={() => setShowAccPw(v => !v)} />}
        {acc.mailPassword    && <CredRow label="Mail Şifresi"  value={acc.mailPassword}    masked show={showMailPw} onToggle={() => setShowMailPw(v => !v)} />}
      </div>
    </div>
  );
}

function rel(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'az once';
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}dk`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}sa`;
  return new Date(iso).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}
function todayStr(): string { return new Date().toISOString().slice(0, 10); }

// ═══════════════════════════════════════════════════════════════
export function UserHome() {
  const { user, logout, passwordExpired } = useAuth();
  const [accounts, setAccounts] = useState<MyServerAccount[]>([]);
  const [total, setTotal] = useState(0);
  const [notifs, setNotifs] = useState<UserNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [notifsOpen, setNotifsOpen] = useState(false);
  const [myStats, setMyStats] = useState<UserStats | null>(null);
  const [showPw, setShowPw] = useState(false);
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [modal, setModal] = useState<MyServer | null>(null);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [commentText, setCommentText] = useState('');
  const [chInput, setChInput] = useState('');
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [openAccs, setOpenAccs] = useState<Set<string>>(new Set());

  // H1 — Live scrape stats for assigned accounts
  const [liveStats, setLiveStats] = useState<{ totalScraped: number; msgsPerSec: number; activeChannels: number } | null>(null);


  // H4 — Kanban board mode
  const [kanbanMode, setKanbanMode] = useState(false);

  // H5 — Performance score visible toggle
  const [showPerf, setShowPerf] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, n] = await Promise.allSettled([api.auth.myServers(), api.auth.notifications()]);
      if (s.status === 'fulfilled') { setAccounts(s.value.accounts); setTotal(s.value.total); }
      if (n.status === 'fulfilled') setNotifs(n.value.notifications);
    } catch {}
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.auth.heartbeat().catch(() => {}); const iv = setInterval(() => api.auth.heartbeat().catch(() => {}), 60_000); return () => clearInterval(iv); }, []);
  useEffect(() => { if (user?.username) api.auth.userStats(user.username).then(s => setMyStats(s)).catch(() => {}); }, [user?.username]);

  // H1 — Poll live scrape stats for assigned accounts
  async function fetchLiveStats() {
    const accIds = accounts.map(a => a.accountId).filter(Boolean) as string[];
    if (accIds.length === 0) { setLiveStats(null); return; }
    try {
      let ts = 0, mps = 0, active = 0;
      for (const aid of accIds.slice(0, 5)) { // limit: first 5 accounts
        const r = await api.live.channels({ accountId: aid, limit: 50 }) as any;
        if (r?.channels) {
          for (const c of r.channels) {
            ts += c.totalScraped ?? 0;
            mps += c.msgsPerSec ?? 0;
            if ((c.msgsPerSec ?? 0) > 0) active++;
          }
        }
      }
      setLiveStats({ totalScraped: ts, msgsPerSec: Math.round(mps * 10) / 10, activeChannels: active });
    } catch { /* non-fatal */ }
  }
  useEffect(() => { if (accounts.length > 0) { void fetchLiveStats(); } }, [accounts.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useInterval(fetchLiveStats, 5000, false);

  // Hesap grupları varsayılan kapalı başlar — kullanıcı tıklayarak açar

  async function updStatus(s: MyServer, status: string) {
    try { await api.auth.updateTask(s.taskId, { status, assignedTo: user?.username }); load(); if (modal?.taskId === s.taskId) setModal({ ...s, status }); }
    catch (e) { addToast({ type: 'error', title: 'Hata', msg: (e as Error).message }); }
  }
  async function submitChannels() {
    if (!modal?.guildId) return;
    const ids = chInput.split(/[\n,]+/).map(s => s.trim()).filter(s => /^\d{17,20}$/.test(s));
    if (!ids.length) return;
    setSubmitBusy(true);
    setSubmitError('');
    try {
      await api.auth.updateTask(modal.taskId, { channelIds: ids, guildId: modal.guildId, assignedTo: user?.username });
      addToast({ type: 'success', title: 'Dogrulandi & Tamamlandi', msg: `Uyelik onaylandi — ${ids.length} kanal eklendi` });
      setChInput(''); setSubmitError(''); setModal(null); load();
    } catch (e) {
      const msg = (e as Error).message;
      setSubmitError(msg);
    } finally { setSubmitBusy(false); }
  }
  function markRead(id: string) { api.auth.markRead(id).catch(() => {}); setNotifs(p => p.map(n => n.id === id ? { ...n, read: true } : n)); }
  async function handlePw() {
    if (!curPw || !newPw) return; setPwBusy(true);
    try { await api.auth.changePassword(curPw, newPw); addToast({ type: 'success', title: 'Sifre degistirildi' }); setCurPw(''); setNewPw(''); setShowPw(false); }
    catch (e) { addToast({ type: 'error', title: 'Hata', msg: (e as Error).message }); } finally { setPwBusy(false); }
  }
  async function openModal(s: MyServer) {
    setModal(s); setChInput(''); setCommentText('');
    try { const r = await api.auth.taskComments(s.taskId, user?.username ?? ''); setComments(r.comments); } catch { setComments([]); }
  }
  async function sendComment() {
    if (!modal || !commentText.trim()) return;
    try { await api.auth.addComment(modal.taskId, commentText.trim(), user?.username); setCommentText('');
      const r = await api.auth.taskComments(modal.taskId, user?.username ?? ''); setComments(r.comments);
    } catch (e) { addToast({ type: 'error', title: 'Hata', msg: (e as Error).message }); }
  }

  const unread = notifs.filter(n => !n.read).length;
  const totalPending = accounts.reduce((s, a) => s + a.pendingCount + a.activeCount, 0);
  const totalDone = accounts.reduce((s, a) => s + a.doneCount, 0);
  const today = todayStr();
  const weeklyData = myStats?.weeklyData ?? [];
  const chIds = chInput.split(/[\n,]+/).map(s => s.trim()).filter(s => /^\d{17,20}$/.test(s));

  const fl: React.CSSProperties = { fontSize: 10, color: 'rgba(255,255,255,.3)', fontWeight: 600, letterSpacing: '.3px', marginBottom: 4 };

  // H4 — Get all servers flat (for Kanban)
  const allServers = accounts.flatMap(a => a.servers);
  const kanbanCols: Array<{ key: string; label: string; color: string; servers: MyServer[] }> = [
    { key: 'pending',     label: 'Bekliyor',      color: '#a0a0a0',  servers: allServers.filter(s => s.status === 'pending') },
    { key: 'in_progress', label: 'Devam Ediyor',  color: '#5b9aff',  servers: allServers.filter(s => s.status === 'in_progress') },
    { key: 'completed',  label: 'Tamamlandı',    color: '#30d158',  servers: allServers.filter(s => s.status === 'completed') },
  ];

  // H5 — Performance score
  const perfScore = myStats && myStats.total > 0
    ? Math.round((myStats.completed / myStats.total) * 100)
    : null;
  const perfColor = perfScore == null ? 'var(--t4)' : perfScore >= 80 ? '#30d158' : perfScore >= 50 ? 'var(--orange)' : 'var(--red)';

  return (
    <div className="uh">
      {/* ── Header ── */}
      <header className="uh-header">
        <div className="uh-brand">
          <div className="uh-avatar">{(user?.displayName?.[0] ?? 'U').toUpperCase()}</div>
          <div><div className="uh-user">{user?.displayName ?? user?.username}</div><div className="uh-role">{user?.role === 'admin' ? 'Yonetici' : 'Kullanici'}</div></div>
        </div>
        <div className="uh-header-actions">
          <button className="uh-btn" onClick={() => setShowPw(v => !v)} style={{ fontSize: 11 }}>Sifre</button>
          {/* H2 — Notification bell with animated badge */}
          <button className="uh-notif-badge" onClick={() => setNotifsOpen(v => !v)}
            style={{ position: 'relative', background: 'none', border: 'none', color: unread > 0 ? '#38BDF8' : 'rgba(255,255,255,.4)', cursor: 'pointer', padding: '4px 6px', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
            {unread > 0 && (
              <span style={{ position: 'absolute', top: 0, right: 0, background: '#ff453a', borderRadius: '50%', width: 15, height: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 800, color: '#fff', animation: 'pulse 1.5s infinite' }}>
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>
          {user?.role === 'admin' && <button className="uh-btn uh-btn-admin" onClick={() => { window.history.pushState({}, '', '/admin'); window.dispatchEvent(new PopStateEvent('popstate')); }}>Admin</button>}
          <button className="uh-btn uh-btn-logout" onClick={logout}>Cikis</button>
        </div>
      </header>

      {/* H2 — Improved notification dropdown with grouping */}
      {notifsOpen && (
        <div className="uh-notif-dropdown" style={{ minWidth: 300, maxWidth: 360 }}>
          {notifs.length === 0 ? (
            <div style={{ padding: '20px 16px', textAlign: 'center', color: 'rgba(255,255,255,.2)', fontSize: 12 }}>Bildirim yok</div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px 6px', borderBottom: '1px solid rgba(255,255,255,.06)' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,.4)', textTransform: 'uppercase', letterSpacing: '.5px' }}>Bildirimler</span>
                {unread > 0 && <button type="button" onClick={() => notifs.filter(n => !n.read).forEach(n => markRead(n.id))}
                  style={{ background: 'none', border: 'none', color: '#38BDF8', fontSize: 10, cursor: 'pointer', padding: 0 }}>Hepsini oku</button>}
              </div>
              {notifs.slice(0, 20).map(n => {
                const typeColor = n.type === 'warning' ? '#ff9f0a' : n.type === 'task' ? '#38BDF8' : '#30d158';
                return (
                  <div key={n.id} className={`uh-notif-item${n.read ? '' : ' unread'}`} onClick={() => { if (!n.read) markRead(n.id); }}
                    style={{ borderLeft: !n.read ? `2px solid ${typeColor}` : '2px solid transparent' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {!n.read && <span style={{ width: 5, height: 5, borderRadius: '50%', background: typeColor, flexShrink: 0, display: 'inline-block' }} />}
                        <div className="uh-notif-title">{n.title}</div>
                      </div>
                      <div className="uh-notif-msg" style={{ marginLeft: n.read ? 0 : 11 }}>{n.message}</div>
                    </div>
                    {n.createdAt && <span className="uh-time">{rel(n.createdAt)}</span>}
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}

      {showPw && (
        <div style={{ margin: '0 auto', maxWidth: 560, padding: '10px 14px', background: 'rgba(255,255,255,.03)', borderRadius: 8, marginBottom: 6, border: '1px solid rgba(255,255,255,.05)' }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input className="uh-textarea" type="password" placeholder="Mevcut" value={curPw} onChange={e => setCurPw(e.target.value)} style={{ flex: 1, padding: '5px 8px', height: 28, fontSize: 11 }} />
            <input className="uh-textarea" type="password" placeholder="Yeni" value={newPw} onChange={e => setNewPw(e.target.value)} style={{ flex: 1, padding: '5px 8px', height: 28, fontSize: 11 }} />
            <button className="uh-btn uh-btn-submit" onClick={handlePw} disabled={pwBusy || !curPw || !newPw} style={{ padding: '5px 12px', fontSize: 10 }}>{pwBusy ? '...' : 'OK'}</button>
            <button className="uh-btn" onClick={() => setShowPw(false)} style={{ padding: '5px 6px', fontSize: 10 }}>X</button>
          </div>
        </div>
      )}

      <main className="uh-main">
        {/* U4 — Password expired banner */}
        {passwordExpired && (
          <div className="pw-expired-banner">
            <span className="pw-expired-banner-icon">⚠</span>
            <div className="pw-expired-banner-text">
              <div className="pw-expired-banner-title">Şifrenizin süresi doldu</div>
              <div className="pw-expired-banner-msg">Lütfen şifrenizi değiştirin. Değiştirmeden bazı işlemler kısıtlanabilir.</div>
            </div>
            <button className="uh-btn" onClick={() => setShowPw(true)} style={{ flexShrink: 0, fontSize: 11, padding: '5px 10px' }}>
              Şifre Değiştir
            </button>
          </div>
        )}

        {/* ── Stats + H1 + H5 ── */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          {/* Task summary card */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 16px', background: 'rgba(255,255,255,.025)', borderRadius: 10, border: '1px solid rgba(255,255,255,.04)', flex: 1, minWidth: 200 }}>
            <div style={{ display: 'flex', gap: 16 }}>
              <div style={{ textAlign: 'center' }}><div style={{ fontSize: 22, fontWeight: 800, color: '#ff9f0a' }}>{totalPending}</div><div style={{ fontSize: 9, color: 'rgba(255,255,255,.35)' }}>bekliyor</div></div>
              <div style={{ textAlign: 'center' }}><div style={{ fontSize: 22, fontWeight: 800, color: '#30d158' }}>{totalDone}</div><div style={{ fontSize: 9, color: 'rgba(255,255,255,.35)' }}>bitti</div></div>
              <div style={{ textAlign: 'center' }}><div style={{ fontSize: 22, fontWeight: 800, color: 'rgba(255,255,255,.6)' }}>{total}</div><div style={{ fontSize: 9, color: 'rgba(255,255,255,.35)' }}>toplam</div></div>
            </div>
            <div style={{ flex: 1 }} />
            {weeklyData.length > 0 && (
              <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 28 }}>
                {weeklyData.map((d, i) => { const mx = Math.max(1, ...weeklyData.map(w => w.count)); return <div key={i} style={{ width: 6, height: Math.max(3, (d.count / mx) * 26), borderRadius: 2, background: d.date === today ? '#30d158' : 'rgba(255,255,255,.08)' }} title={`${d.date}: ${d.count}`} />; })}
              </div>
            )}
          </div>

          {/* H1 — Live scrape stats */}
          {liveStats && (
            <div style={{ padding: '10px 16px', background: 'rgba(255,255,255,.025)', borderRadius: 10, border: '1px solid rgba(255,255,255,.04)', display: 'flex', gap: 16, alignItems: 'center' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#ff9f0a', fontFamily: 'var(--mono)' }}>{liveStats.msgsPerSec}<span style={{ fontSize: 10, fontWeight: 400 }}>/s</span></div>
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,.3)' }}>çanlı hiz</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#38BDF8' }}>{liveStats.activeChannels}</div>
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,.3)' }}>aktif kanal</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'rgba(255,255,255,.5)' }}>{(liveStats.totalScraped / 1000).toFixed(0)}K</div>
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,.3)' }}>toplam mesaj</div>
              </div>
            </div>
          )}

          {/* H5 — Performance score */}
          {perfScore != null && (
            <div style={{ padding: '10px 16px', background: 'rgba(255,255,255,.025)', borderRadius: 10, border: '1px solid rgba(255,255,255,.04)', display: 'flex', gap: 12, alignItems: 'center', cursor: 'pointer' }}
              onClick={() => setShowPerf(v => !v)} title="Performans detayı">
              <div style={{ position: 'relative', width: 44, height: 44 }}>
                <svg viewBox="0 0 44 44" width="44" height="44" style={{ transform: 'rotate(-90deg)' }}>
                  <circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,.06)" strokeWidth="4" />
                  <circle cx="22" cy="22" r="18" fill="none" stroke={perfColor} strokeWidth="4"
                    strokeDasharray={`${(perfScore / 100) * 113} 113`} strokeLinecap="round" />
                </svg>
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: perfColor }}>{perfScore}%</div>
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t1)' }}>Performans</div>
                {myStats && myStats.avgCompletionHours > 0 && <div style={{ fontSize: 10, color: 'rgba(255,255,255,.3)' }}>Ort. {myStats.avgCompletionHours}sa</div>}
              </div>
            </div>
          )}
        </div>

        {/* H5 — Performance details (expandable) */}
        {showPerf && myStats && (
          <div style={{ padding: 14, background: 'rgba(255,255,255,.025)', borderRadius: 10, border: '1px solid rgba(255,255,255,.04)', marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,.3)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 10 }}>Haftalik Aktivite</div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 40 }}>
              {weeklyData.map((d, i) => { const mx = Math.max(1, ...weeklyData.map(w => w.count)); const h = Math.max(4, (d.count / mx) * 38); return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                  <div style={{ width: '100%', height: h, borderRadius: 3, background: d.date === today ? perfColor : 'rgba(255,255,255,.08)', transition: 'height .3s' }} title={`${d.date}: ${d.count}`} />
                  <div style={{ fontSize: 7, color: 'rgba(255,255,255,.2)' }}>{d.date.slice(5)}</div>
                </div>
              ); })}
            </div>
            <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,.35)' }}>✅ <span style={{ color: '#30d158', fontWeight: 700 }}>{myStats.completed}</span> tamamlandi</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,.35)' }}>⏳ <span style={{ color: '#ff9f0a', fontWeight: 700 }}>{myStats.pending}</span> bekliyor</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,.35)' }}>&#128293; <span style={{ color: '#5b9aff', fontWeight: 700 }}>{myStats.inProgress}</span> devam ediyor</div>
              {myStats.avgCompletionHours > 0 && <div style={{ fontSize: 11, color: 'rgba(255,255,255,.35)' }}>⏱ Ort. <span style={{ fontWeight: 700, color: 'rgba(255,255,255,.55)' }}>{myStats.avgCompletionHours}sa</span></div>}
            </div>
          </div>
        )}

        {/* H4 — Kanban board toggle */}
        {accounts.length > 0 && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,.3)', fontWeight: 600 }}>GOREVLER</span>
            <div style={{ flex: 1 }} />
            <button type="button" onClick={() => setKanbanMode(v => !v)}
              style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(255,255,255,.1)', background: kanbanMode ? 'rgba(56,189,248,.12)' : 'rgba(255,255,255,.04)', color: kanbanMode ? '#38BDF8' : 'rgba(255,255,255,.35)', fontSize: 10, fontWeight: 600, cursor: 'pointer' }}>
              {kanbanMode ? '≡ Liste' : '▣ Kanban'}
            </button>
          </div>
        )}

        {/* H4 — Kanban board view */}
        {kanbanMode && accounts.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
            {kanbanCols.map(col => (
              <div key={col.key} style={{ background: 'rgba(255,255,255,.02)', borderRadius: 12, border: '1px solid rgba(255,255,255,.06)', overflow: 'hidden' }}>
                <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid rgba(255,255,255,.05)', background: `${col.color}08` }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: col.color, flexShrink: 0, display: 'inline-block' }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: col.color }}>{col.label}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'rgba(255,255,255,.25)', fontFamily: 'var(--mono)' }}>{col.servers.length}</span>
                </div>
                <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                  {col.servers.length === 0 ? (
                    <div style={{ padding: 20, textAlign: 'center', fontSize: 11, color: 'rgba(255,255,255,.15)' }}>Boş</div>
                  ) : (
                    col.servers.map(s => {
                      const icon = discordIcon(s.guildId, s.guildIcon);
                      return (
                        <div key={s.taskId} onClick={() => openModal(s)} style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,.03)', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,.03)')}
                          onMouseLeave={e => (e.currentTarget.style.background = '')}>  
                          {icon ? <img src={icon} alt="" style={{ width: 24, height: 24, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }} /> : <div style={{ width: 24, height: 24, borderRadius: 6, background: 'rgba(255,255,255,.06)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,.2)' }}>{(s.guildName||'?')[0]}</div>}
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.guildName}</div>
                            {s.accountName && <div style={{ fontSize: 9, color: 'rgba(255,255,255,.2)' }}>{s.accountName}</div>}
                          </div>
                          {s.status !== 'completed' && (
                            <button onClick={e => { e.stopPropagation(); void updStatus(s, s.status === 'pending' ? 'in_progress' : 'completed'); }}
                              style={{ marginLeft: 'auto', padding: '2px 8px', borderRadius: 4, border: 'none', background: s.status === 'pending' ? 'rgba(91,154,255,.15)' : 'rgba(48,209,88,.15)', color: s.status === 'pending' ? '#5b9aff' : '#30d158', fontSize: 9, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}>
                              {s.status === 'pending' ? '▶' : '✓'}
                            </button>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Account Groups (list view) ── */}
        {loading ? (
          <div style={{ padding: 60, textAlign: 'center' }}><div className="spin" /></div>
        ) : accounts.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', color: 'rgba(255,255,255,.2)', fontSize: 13 }}>Henuz gorev atanmamis</div>
        ) : !kanbanMode ? (
          <div>
            {accounts.map((acc, ai) => {
              const color = ACC_COLORS[ai % ACC_COLORS.length];
              const isOpen = openAccs.has(acc.accountName);
              const pendingSvrs = acc.servers.filter(s => s.status !== 'completed');
              const doneSvrs = acc.servers.filter(s => s.status === 'completed');
              const pct = acc.totalCount > 0 ? Math.round(acc.doneCount / acc.totalCount * 100) : 0;
              return (
                <div key={acc.accountName} style={{ marginBottom: 12, borderRadius: 12, border: '1px solid rgba(255,255,255,.06)', overflow: 'hidden', background: 'rgba(255,255,255,.015)' }}>
                  {/* Account Header */}
                  <div onClick={() => { const n = new Set(openAccs); if (n.has(acc.accountName)) n.delete(acc.accountName); else n.add(acc.accountName); setOpenAccs(n); }}
                    style={{ padding: '12px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, background: isOpen ? `${color}08` : 'transparent', borderBottom: isOpen ? '1px solid rgba(255,255,255,.04)' : 'none' }}>
                    <AccAvatar acc={acc} color={color} size={36} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>{acc.accountName}</div>
                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,.35)', marginTop: 1 }}>
                        <span style={{ color }}>{acc.pendingCount + acc.activeCount}</span> bekliyor
                        <span style={{ margin: '0 4px', opacity: .3 }}>·</span>
                        <span style={{ color: '#30d158' }}>{acc.doneCount}</span> tamamlandi
                        <span style={{ margin: '0 4px', opacity: .3 }}>·</span>
                        {acc.totalCount} sunucu
                      </div>
                    </div>
                    {/* Progress */}
                    <div style={{ width: 80, textAlign: 'right' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: pct === 100 ? '#30d158' : 'rgba(255,255,255,.4)', marginBottom: 3 }}>{pct}%</div>
                      <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,.06)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', borderRadius: 2, background: pct === 100 ? '#30d158' : color, width: `${pct}%`, transition: 'width .3s' }} />
                      </div>
                    </div>
                    <span style={{ fontSize: 14, color: 'rgba(255,255,255,.2)', transform: isOpen ? 'rotate(90deg)' : '', transition: 'transform .15s', marginLeft: 4 }}>›</span>
                  </div>

                  {/* Server List + Credentials */}
                  {isOpen && (
                    <div>
                      <CredCard acc={acc} color={color} />
                      {pendingSvrs.length === 0 && doneSvrs.length === 0 && (
                        <div style={{ padding: 24, textAlign: 'center', color: 'rgba(255,255,255,.12)', fontSize: 12 }}>Bu hesapta sunucu yok</div>
                      )}
                      {pendingSvrs.map(s => {
                        const icon = discordIcon(s.guildId, s.guildIcon);
                        const od = s.deadline ? new Date(s.deadline).getTime() < Date.now() : false;
                        return (
                          <div key={s.taskId} onClick={() => openModal(s)} style={{
                            padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
                            borderBottom: '1px solid rgba(255,255,255,.03)', transition: 'background .1s',
                          }}
                            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,.03)')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                            {/* Server icon */}
                            {icon ? (
                              <img src={icon} alt="" style={{ width: 32, height: 32, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />
                            ) : (
                              <div style={{ width: 32, height: 32, borderRadius: 8, background: 'rgba(255,255,255,.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,.2)', flexShrink: 0 }}>
                                {(s.guildName || '?')[0]?.toUpperCase()}
                              </div>
                            )}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 600, color: od ? '#ff453a' : '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {s.guildName}
                              </div>
                              <div style={{ display: 'flex', gap: 6, marginTop: 2, alignItems: 'center', fontSize: 10 }}>
                                <span style={{ color: S_CLR[s.status], fontWeight: 600 }}>{S_LBL[s.status] ?? s.status}</span>
                                {s.memberCount > 0 && <span style={{ color: 'rgba(255,255,255,.2)' }}>{s.memberCount.toLocaleString('tr-TR')} uye</span>}
                                {od && <span style={{ color: '#ff453a', fontWeight: 600 }}>GECIKTI</span>}
                                {s.poolStatus === 'already_in' && <span style={{ color: '#30d158', fontWeight: 600 }}>UYE</span>}
                              </div>
                            </div>
                            {s.status !== 'completed' && (
                              <button onClick={e => { e.stopPropagation(); openModal(s); }}
                                style={{ padding: '5px 14px', borderRadius: 6, border: 'none', background: 'rgba(48,209,88,.1)', color: '#30d158', fontSize: 11, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}>Tamamla</button>
                            )}
                            {s.status === 'completed' && <span style={{ fontSize: 14, flexShrink: 0 }}>✓</span>}
                          </div>
                        );
                      })}
                      {doneSvrs.length > 0 && (
                        <details style={{ borderTop: '1px solid rgba(255,255,255,.03)' }}>
                          <summary style={{ padding: '8px 16px', fontSize: 11, color: 'rgba(255,255,255,.25)', cursor: 'pointer' }}>{doneSvrs.length} tamamlanan sunucu</summary>
                          {doneSvrs.map(s => (
                            <div key={s.taskId} onClick={() => openModal(s)} style={{ padding: '6px 16px 6px 58px', fontSize: 12, color: 'rgba(255,255,255,.25)', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,.02)' }}>
                              <span style={{ textDecoration: 'line-through' }}>{s.guildName}</span>
                              {s.poolStatus === 'already_in' && <span style={{ marginLeft: 6, color: '#30d158', fontSize: 10 }}>UYE</span>}
                            </div>
                          ))}
                        </details>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </main>

      {/* ═══ MODAL ═══ */}
      {modal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {/* Backdrop — only clicks HERE close the modal */}
          <div onClick={() => setModal(null)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.7)', backdropFilter: 'blur(8px)', cursor: 'pointer' }} />
          {/* Modal */}
          <div style={{
            position: 'relative', zIndex: 1, width: '90%', maxWidth: 520, maxHeight: '85vh', overflowY: 'auto',
            background: '#131620', borderRadius: 14, border: '1px solid rgba(255,255,255,.08)',
            boxShadow: '0 24px 80px rgba(0,0,0,.8)', padding: '24px 28px',
          }}>
            {/* Close */}
            <button onClick={() => setModal(null)} style={{ position: 'absolute', top: 14, right: 16, background: 'none', border: 'none', color: 'rgba(255,255,255,.3)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>

            {/* Header with icon */}
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 16 }}>
              {discordIcon(modal.guildId, modal.guildIcon) ? (
                <img src={discordIcon(modal.guildId, modal.guildIcon)!} alt="" style={{ width: 48, height: 48, borderRadius: 12, objectFit: 'cover' }} />
              ) : (
                <div style={{ width: 48, height: 48, borderRadius: 12, background: 'rgba(255,255,255,.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 800, color: 'rgba(255,255,255,.15)' }}>
                  {(modal.guildName || '?')[0]?.toUpperCase()}
                </div>
              )}
              <div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#fff' }}>{modal.guildName}</div>
                <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                  {modal.accountName && <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'rgba(14,165,233,.12)', color: '#38BDF8', fontWeight: 600 }}>{modal.accountName}</span>}
                  <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: `${S_CLR[modal.status]}20`, color: S_CLR[modal.status], fontWeight: 600 }}>{S_LBL[modal.status] ?? modal.status}</span>
                  {modal.memberCount > 0 && <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'rgba(255,255,255,.04)', color: 'rgba(255,255,255,.35)' }}>{modal.memberCount.toLocaleString('tr-TR')} uye</span>}
                  {modal.poolStatus === 'already_in' && <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'rgba(48,209,88,.1)', color: '#30d158', fontWeight: 600 }}>UYE</span>}
                </div>
              </div>
            </div>

            {/* Info Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
              {modal.inviteUrl && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <div style={fl}>DAVET LINKI</div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'rgba(255,255,255,.04)', borderRadius: 8, padding: '8px 12px' }}>
                    <a href={modal.inviteUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: '#5b9aff', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'none' }}>{modal.inviteUrl}</a>
                    <CopyBtn text={modal?.inviteUrl ?? ''} />
                  </div>
                </div>
              )}
              {modal.guildId && (
                <div>
                  <div style={fl}>GUILD ID</div>
                  <code style={{ fontSize: 12, color: 'rgba(255,255,255,.55)', background: 'rgba(255,255,255,.04)', padding: '6px 10px', borderRadius: 6, display: 'block', fontFamily: 'var(--mono)' }}>{modal.guildId}</code>
                </div>
              )}
              {modal.accountId && (
                <div>
                  <div style={fl}>HESAP ID</div>
                  <code style={{ fontSize: 12, color: 'rgba(255,255,255,.55)', background: 'rgba(255,255,255,.04)', padding: '6px 10px', borderRadius: 6, display: 'block', fontFamily: 'var(--mono)' }}>{modal.accountId}</code>
                </div>
              )}
            </div>

            {modal.deadline && (
              <div style={{ marginBottom: 12 }}>
                <div style={fl}>SON TARIH</div>
                <div style={{ fontSize: 12, color: new Date(modal.deadline).getTime() < Date.now() ? '#ff453a' : 'rgba(255,255,255,.45)' }}>
                  {new Date(modal.deadline).toLocaleString('tr-TR')}
                  {new Date(modal.deadline).getTime() < Date.now() && <span style={{ marginLeft: 6, fontWeight: 600 }}>GECIKTI</span>}
                </div>
              </div>
            )}

            <div style={{ fontSize: 10, color: 'rgba(255,255,255,.15)', marginBottom: 16 }}>
              {modal.createdAt ? new Date(modal.createdAt).toLocaleDateString('tr-TR') : ''}{modal.createdBy ? ` · ${modal.createdBy}` : ''}
            </div>

            {/* Channel ID Submission */}
            {modal.status !== 'completed' && (
              <div style={{ marginBottom: 16, padding: 14, background: 'rgba(255,255,255,.025)', borderRadius: 10, border: '1px solid rgba(255,255,255,.05)' }}>
                <div style={fl}>KANAL ID'LERI (her satira bir tane)</div>
                <textarea className="uh-textarea" placeholder={"123456789012345678\n234567890123456789"} value={chInput} onChange={e => setChInput(e.target.value)} rows={3}
                  style={{ width: '100%', fontSize: 12, padding: '8px 10px', boxSizing: 'border-box', marginTop: 4 }} />
                {chInput && <div style={{ fontSize: 11, color: chIds.length ? '#30d158' : '#ff453a', marginTop: 4, fontWeight: 600 }}>{chIds.length ? `${chIds.length} gecerli ID` : 'Gecerli ID yok'}</div>}
                <button onClick={submitChannels} disabled={!chIds.length || submitBusy}
                  style={{ width: '100%', marginTop: 8, padding: '10px 0', borderRadius: 8, border: 'none', background: chIds.length ? 'rgba(48,209,88,.12)' : 'rgba(255,255,255,.03)', color: chIds.length ? '#30d158' : 'rgba(255,255,255,.15)', fontSize: 13, fontWeight: 700, cursor: chIds.length ? 'pointer' : 'default' }}>
                  {submitBusy ? 'Dogrulanıyor...' : `Dogrula & Tamamla (${chIds.length || 0} kanal)`}
                </button>
                {submitError && (
                  <div style={{ marginTop: 8, padding: '10px 14px', borderRadius: 8, background: 'rgba(255,69,58,.1)', border: '1px solid rgba(255,69,58,.25)', color: '#ff453a', fontSize: 12, fontWeight: 600 }}>
                    {submitError}
                  </div>
                )}
                {!submitError && (
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,.2)', marginTop: 6, textAlign: 'center' }}>
                    Hesabin sunucuya katilip katilmadigi kontrol edilecek
                  </div>
                )}
              </div>
            )}

            {/* Comments */}
            <div style={{ borderTop: '1px solid rgba(255,255,255,.05)', paddingTop: 12 }}>
              <div style={fl}>YORUMLAR</div>
              {comments.length === 0 && <div style={{ fontSize: 11, color: 'rgba(255,255,255,.12)', marginBottom: 8 }}>Henuz yorum yok</div>}
              <div style={{ maxHeight: 160, overflowY: 'auto', marginBottom: 8 }}>
                {comments.map(c => (
                  <div key={c.commentId} style={{ marginBottom: 6, padding: '6px 10px', background: 'rgba(255,255,255,.03)', borderRadius: 6 }}>
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,.55)' }}>{c.content}</div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,.18)', marginTop: 2 }}>{c.username} · {rel(c.createdAt)}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="uh-textarea" placeholder="Yorum yaz..." value={commentText} onChange={e => setCommentText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') sendComment(); }}
                  style={{ flex: 1, padding: '7px 10px', height: 32, fontSize: 11 }} />
                <button onClick={sendComment} disabled={!commentText.trim()}
                  style={{ background: commentText.trim() ? 'rgba(14,165,233,.15)' : 'rgba(255,255,255,.03)', border: 'none', color: commentText.trim() ? '#38BDF8' : 'rgba(255,255,255,.12)', padding: '7px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>Gönder</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
