import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { addToast } from '../hooks';
import type { DashboardUser, UserTask, UserOnlineStatus, LeaderboardEntry, UserActivity, UserSession, TaskComment, PasswordPolicy } from '../types';
import { ALL_PAGES as PAGE_LIST } from '../types';

type Tab = 'users' | 'tasks' | 'performance' | 'activity' | 'distribute' | 'settings';
const PRIORITY_COLORS: Record<string, string> = { high: 'var(--red)', medium: 'var(--orange)', low: 'var(--green)' };
const STATUS_LABELS: Record<string, string> = { pending: 'Bekliyor', in_progress: 'Devam Ediyor', completed: 'Tamamlandi' };
const ACTION_LABELS: Record<string, string> = {
  login: 'Giris', logout: 'Cikis', login_failed: 'Basarisiz Giris',
  task_create: 'Gorev Olusturma', task_comment: 'Yorum', password_change: 'Sifre Degisiklik',
  password_reset: 'Sifre Sifirlama', session_revoke: 'Oturum Iptal', force_logout: 'Zorla Cikis',
};
const STATUS_DOT: Record<string, string> = { online: '#30d158', away: '#ff9f0a', offline: '#666' };

function relTime(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'az once';
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}dk once`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}sa once`;
  return new Date(iso).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}

function isOverdue(deadline: string | null): boolean {
  return deadline ? new Date(deadline).getTime() < Date.now() : false;
}

export function UserManagement() {
  const [tab, setTab] = useState<Tab>('users');
  const [users, setUsers] = useState<DashboardUser[]>([]);
  const [tasks, setTasks] = useState<UserTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [distributing, setDistributing] = useState(false);
  const [onlineMap, setOnlineMap] = useState<Map<string, UserOnlineStatus>>(new Map());

  // Create user form
  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newRole, setNewRole] = useState<'user' | 'admin'>('user');
  const [creating, setCreating] = useState(false);

  // Create task form
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [taskUser, setTaskUser] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDesc, setTaskDesc] = useState('');
  const [taskPriority, setTaskPriority] = useState('medium');
  const [taskDeadline, setTaskDeadline] = useState('');

  // Performance
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);

  // Activity & Sessions
  const [activityUser, setActivityUser] = useState('');
  const [activities, setActivities] = useState<UserActivity[]>([]);
  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [sessionUser, setSessionUser] = useState('');

  // Task detail / comments
  const [detailTask, setDetailTask] = useState<UserTask | null>(null);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [newComment, setNewComment] = useState('');

  // Password reset
  const [resetUser, setResetUser] = useState('');
  const [resetPw, setResetPw] = useState('');

  // U1 — Page permissions
  const [permUser, setPermUser] = useState<string | null>(null);
  const [permPages, setPermPages] = useState<string[]>([]);
  const [permBusy, setPermBusy] = useState(false);

  // U4 — Password policy
  const [policy, setPolicy] = useState<PasswordPolicy | null>(null);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyMaxDays, setPolicyMaxDays] = useState(0);
  const [policyEnforce, setPolicyEnforce] = useState(false);
  const [policyMinLength, setPolicyMinLength] = useState(4);

  // U5 — Bulk task mode
  const [taskBulkMode, setTaskBulkMode] = useState(false);
  const [taskBulkUsers, setTaskBulkUsers] = useState<string[]>([]);

  const loadAll = useCallback(async () => {
    try {
      const [u, t, o] = await Promise.allSettled([
        api.auth.users(),
        api.auth.tasks(true),
        api.auth.online(),
      ]);
      if (u.status === 'fulfilled') setUsers(u.value.users);
      if (t.status === 'fulfilled') setTasks(t.value.tasks);
      if (o.status === 'fulfilled') {
        const m = new Map<string, UserOnlineStatus>();
        for (const s of o.value.users) m.set(s.username, s);
        setOnlineMap(m);
      }
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Load tab-specific data
  useEffect(() => {
    if (tab === 'performance') {
      api.auth.leaderboard().then(r => setLeaderboard(r.leaderboard)).catch(() => {});
    }
  }, [tab]);

  async function loadActivity(username: string) {
    setActivityUser(username);
    try {
      const [a, s] = await Promise.allSettled([
        api.auth.activity(username, 100),
        api.auth.sessions(username),
      ]);
      if (a.status === 'fulfilled') setActivities(a.value.activities);
      if (s.status === 'fulfilled') setSessions(s.value.sessions);
    } catch {}
  }

  async function loadComments(task: UserTask) {
    setDetailTask(task);
    setNewComment('');
    try {
      const r = await api.auth.taskComments(task.taskId, task.assignedTo);
      setComments(r.comments);
    } catch { setComments([]); }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newUsername.trim() || !newPassword.trim()) return;
    setCreating(true);
    try {
      await api.auth.createUser({ username: newUsername.trim(), password: newPassword, displayName: newDisplayName.trim() || undefined, role: newRole });
      addToast({ type: 'success', title: 'Kullanici olusturuldu', msg: newUsername });
      setNewUsername(''); setNewPassword(''); setNewDisplayName(''); setNewRole('user'); setShowCreate(false);
      loadAll();
    } catch (e) { addToast({ type: 'error', title: 'Hata', msg: (e as Error).message }); }
    finally { setCreating(false); }
  }

  async function handleDelete(username: string) {
    if (!confirm(`"${username}" silinecek. Emin misiniz?`)) return;
    try { await api.auth.deleteUser(username); addToast({ type: 'success', title: 'Silindi' }); loadAll(); }
    catch (e) { addToast({ type: 'error', title: 'Hata', msg: (e as Error).message }); }
  }

  async function handleToggleRole(u: DashboardUser) {
    const nr = u.role === 'admin' ? 'user' : 'admin';
    try { await api.auth.updateUser(u.username, { role: nr }); loadAll(); }
    catch (e) { addToast({ type: 'error', title: 'Hata', msg: (e as Error).message }); }
  }

  async function handleCreateTask(e: React.FormEvent) {
    e.preventDefault();
    if (!taskUser || !taskTitle.trim()) return;
    try {
      await api.auth.createTask({
        assignedTo: taskUser, title: taskTitle.trim(),
        description: taskDesc.trim() || undefined, priority: taskPriority,
        deadline: taskDeadline || undefined,
      });
      addToast({ type: 'success', title: 'Gorev olusturuldu' });
      setTaskTitle(''); setTaskDesc(''); setTaskDeadline(''); setShowTaskForm(false);
      loadAll();
    } catch (e) { addToast({ type: 'error', title: 'Hata', msg: (e as Error).message }); }
  }

  async function handleDeleteTask(task: UserTask) {
    try { await api.auth.deleteTask(task.taskId, task.assignedTo); loadAll(); if (detailTask?.taskId === task.taskId) setDetailTask(null); }
    catch (e) { addToast({ type: 'error', title: 'Hata', msg: (e as Error).message }); }
  }

  async function handleAddComment() {
    if (!detailTask || !newComment.trim()) return;
    try {
      await api.auth.addComment(detailTask.taskId, newComment.trim(), detailTask.assignedTo);
      setNewComment('');
      loadComments(detailTask);
    } catch (e) { addToast({ type: 'error', title: 'Hata', msg: (e as Error).message }); }
  }

  async function handleDistribute() {
    setDistributing(true);
    try {
      const r = await api.auth.distributeTasks();
      if (r.distributed > 0) {
        addToast({ type: 'success', title: 'Gorevler dagitildi', msg: `${r.distributed} gorev, ${r.users} kullaniciya` });
      } else {
        addToast({ type: 'info', title: 'Dagitilacak gorev yok', msg: r.message ?? '' });
      }
      loadAll();
    } catch (e) { addToast({ type: 'error', title: 'Hata', msg: (e as Error).message }); }
    finally { setDistributing(false); }
  }

  async function handleResetPassword() {
    if (!resetUser || !resetPw.trim()) return;
    try {
      await api.auth.resetPassword(resetUser, resetPw);
      addToast({ type: 'success', title: 'Sifre sifirlandi', msg: resetUser });
      setResetPw(''); setResetUser('');
    } catch (e) { addToast({ type: 'error', title: 'Hata', msg: (e as Error).message }); }
  }

  async function handleForceLogout(username: string) {
    try {
      const r = await api.auth.forceLogout(username) as any;
      addToast({ type: 'success', title: 'Oturumlar iptal edildi', msg: `${r.revoked ?? 0} oturum` });
      if (activityUser === username) loadActivity(username);
    } catch (e) { addToast({ type: 'error', title: 'Hata', msg: (e as Error).message }); }
  }

  async function handleRevokeSession(sid: string) {
    try {
      await api.auth.revokeSession(sid);
      addToast({ type: 'success', title: 'Oturum iptal edildi' });
      if (activityUser) loadActivity(activityUser);
    } catch (e) { addToast({ type: 'error', title: 'Hata', msg: (e as Error).message }); }
  }

  const nonAdminUsers = users.filter(u => u.role !== 'admin');
  const lbl = (_s: string) => ({ fontSize: 11, fontWeight: 600, color: 'var(--t3)', display: 'block' as const, marginBottom: 4 });

  async function openPermissions(username: string) {
    setPermUser(username);
    try {
      const r = await api.auth.pagePermissions(username);
      setPermPages(r.pages);
    } catch { setPermPages([]); }
  }

  async function savePermissions() {
    if (!permUser) return;
    setPermBusy(true);
    try {
      await api.auth.setPagePermissions(permUser, permPages);
      addToast({ type: 'success', title: 'Sayfa izinleri guncellendi', msg: permUser });
      setPermUser(null);
    } catch (e) { addToast({ type: 'error', title: 'Hata', msg: (e as Error).message }); }
    finally { setPermBusy(false); }
  }

  function togglePage(id: string) {
    setPermPages(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);
  }

  async function loadPolicy() {
    try {
      const p = await api.auth.passwordPolicy();
      setPolicy(p); setPolicyMaxDays(p.maxDays); setPolicyEnforce(p.enforce); setPolicyMinLength(p.minLength);
    } catch { setPolicy(null); }
  }

  async function savePolicy() {
    setPolicyBusy(true);
    try {
      await api.auth.setPasswordPolicy({ maxDays: policyMaxDays, enforce: policyEnforce, minLength: policyMinLength });
      addToast({ type: 'success', title: 'Sifre politikasi guncellendi' });
      loadPolicy();
    } catch (e) { addToast({ type: 'error', title: 'Hata', msg: (e as Error).message }); }
    finally { setPolicyBusy(false); }
  }

  async function handleBulkCreateTask(e: React.FormEvent) {
    e.preventDefault();
    if (!taskTitle.trim() || taskBulkUsers.length === 0) return;
    try {
      const r = await api.auth.bulkCreateTask({
        usernames: taskBulkUsers, title: taskTitle.trim(),
        description: taskDesc.trim() || undefined, priority: taskPriority,
        deadline: taskDeadline || undefined,
      });
      addToast({ type: 'success', title: `Toplu gorev olusturuldu`, msg: `${r.created} kullaniciya atandi` });
      setTaskTitle(''); setTaskDesc(''); setTaskDeadline(''); setTaskBulkUsers([]); setShowTaskForm(false);
      loadAll();
    } catch (e) { addToast({ type: 'error', title: 'Hata', msg: (e as Error).message }); }
  }

  return (
    <div style={{ animation: 'pageIn .24s var(--ease-out) both' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.8px', marginBottom: 4 }}>
            Kullanici Yonetimi
          </div>
          <div style={{ fontSize: 13, color: 'var(--t3)' }}>
            Kullanicilari yonetin, gorev atayin, performans takip edin.
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
        {([['users', 'Kullanicilar'], ['tasks', 'Gorevler'], ['performance', 'Performans'], ['activity', 'Aktivite & Oturumlar'], ['distribute', 'Gorev Dagitimi'], ['settings', 'Ayarlar']] as [Tab, string][]).map(([t, label]) => (
          <button key={t} className={`btn btn-sm ${tab === t ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setTab(t); if (t === 'settings' && !policy) loadPolicy(); }}>
            {label}
          </button>
        ))}
      </div>

      {/* ── Users Tab ── */}
      {tab === 'users' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10, gap: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(s => !s)}>
              {showCreate ? 'Kapat' : '+ Yeni Kullanici'}
            </button>
          </div>

          {showCreate && (
            <div className="panel" style={{ marginBottom: 16, padding: 20 }}>
              <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', marginBottom: 4 }}>Yeni Kullanici Olustur</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={lbl('')}>Kullanici Adi *</label>
                    <input className="input input-sm" placeholder="ornek: ahmet" value={newUsername} onChange={e => setNewUsername(e.target.value)} disabled={creating} />
                  </div>
                  <div>
                    <label style={lbl('')}>Sifre *</label>
                    <input className="input input-sm" type="password" placeholder="Sifre" value={newPassword} onChange={e => setNewPassword(e.target.value)} disabled={creating} />
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={lbl('')}>Gorunen Ad</label>
                    <input className="input input-sm" placeholder="Ahmet Yilmaz" value={newDisplayName} onChange={e => setNewDisplayName(e.target.value)} disabled={creating} />
                  </div>
                  <div>
                    <label style={lbl('')}>Rol</label>
                    <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                      <button type="button" className={`filter-chip${newRole === 'user' ? ' active' : ''}`} onClick={() => setNewRole('user')}>Kullanici</button>
                      <button type="button" className={`filter-chip${newRole === 'admin' ? ' active' : ''}`} onClick={() => setNewRole('admin')}>Yonetici</button>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowCreate(false)}>Iptal</button>
                  <button type="submit" className="btn btn-primary btn-sm" disabled={creating || !newUsername.trim() || !newPassword.trim()}>
                    {creating ? 'Olusturuluyor...' : 'Olustur'}
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">Kayitli Kullanicilar</span>
              <span style={{ fontSize: 11, color: 'var(--t4)', fontFamily: 'var(--mono)' }}>{users.length} kullanici</span>
            </div>
            {loading ? (
              <div style={{ padding: 40, textAlign: 'center' }}><div className="spin" /></div>
            ) : (
              <div style={{ overflow: 'auto' }}>
                <table>
                  <thead><tr><th>Kullanici Adi</th><th>Gorunen Ad</th><th>Rol</th><th>Durum</th><th>Olusturulma</th><th style={{ textAlign: 'right' }}>Islemler</th></tr></thead>
                  <tbody>
                    {users.map(u => {
                      const online = onlineMap.get(u.username);
                      const statusColor = STATUS_DOT[online?.status ?? 'offline'];
                      return (
                        <tr key={u.username}>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <div style={{ position: 'relative' }}>
                                <div style={{ width: 28, height: 28, borderRadius: '50%', background: u.role === 'admin' ? 'var(--blurple)' : 'var(--g3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                                  {(u.displayName?.[0] ?? u.username[0]).toUpperCase()}
                                </div>
                                <div style={{ position: 'absolute', bottom: -1, right: -1, width: 10, height: 10, borderRadius: '50%', background: statusColor, border: '2px solid var(--bg-2)' }} />
                              </div>
                              <span style={{ fontWeight: 600, color: 'var(--t1)' }}>{u.username}</span>
                            </div>
                          </td>
                          <td>{u.displayName}</td>
                          <td>
                            <span className={u.role === 'admin' ? 'chip chip-blue' : 'chip'} style={{ cursor: 'pointer' }} onClick={() => handleToggleRole(u)} title="Tikla: Rol degistir">
                              {u.role === 'admin' ? 'Yonetici' : 'Kullanici'}
                            </span>
                          </td>
                          <td>
                            <span style={{ fontSize: 11, color: statusColor }}>
                              {online?.status === 'online' ? 'Cevrimici' : online?.status === 'away' ? 'Uzakta' : 'Cevrimdisi'}
                            </span>
                            {online?.lastSeen && online.status !== 'online' && (
                              <div style={{ fontSize: 10, color: 'var(--t4)' }}>{relTime(online.lastSeen)}</div>
                            )}
                          </td>
                          <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
                            {u.createdAt ? new Date(u.createdAt).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                              {u.role !== 'admin' && <button className="btn btn-secondary btn-xs" onClick={() => openPermissions(u.username)} title="Sayfa izinlerini duzenle">Izinler</button>}
                              <button className="btn btn-secondary btn-xs" onClick={() => { setResetUser(u.username); setResetPw(''); }} title="Sifre sifirla">Sifre</button>
                              <button className="btn btn-secondary btn-xs" onClick={() => handleForceLogout(u.username)} title="Tum oturumlari kapat">Cikis</button>
                              <button className="btn btn-danger btn-xs" onClick={() => handleDelete(u.username)}>Sil</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* U1 — Page permissions inline editor */}
          {permUser && (
            <div className="panel" style={{ marginTop: 12, padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>Sayfa Izinleri: {permUser}</div>
                <button className="btn btn-secondary btn-xs" onClick={() => setPermUser(null)}>Kapat</button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 10 }}>
                Sec: Kullanicinin erisebilecegi sayfalar. Hic sec: Tum sayfalara erisebilir.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                {PAGE_LIST.map(p => (
                  <button key={p.id} type="button"
                    className={permPages.includes(p.id) ? 'filter-chip active' : 'filter-chip'}
                    onClick={() => togglePage(p.id)}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--t4)' }}>{permPages.length === 0 ? 'Hepsi serbest' : `${permPages.length} sayfa secili`}</span>
                <button className="btn btn-secondary btn-xs" onClick={() => setPermPages([])} disabled={permBusy}>Temizle</button>
                <button className="btn btn-primary btn-sm" onClick={savePermissions} disabled={permBusy}>Kaydet</button>
              </div>
            </div>
          )}

          {/* Password reset inline */}
          {resetUser && (
            <div className="panel" style={{ marginTop: 12, padding: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', marginBottom: 8 }}>Sifre Sifirla: {resetUser}</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input className="input input-sm" type="password" placeholder="Yeni sifre" value={resetPw} onChange={e => setResetPw(e.target.value)} style={{ maxWidth: 250 }} />
                <button className="btn btn-primary btn-sm" onClick={handleResetPassword} disabled={!resetPw.trim()}>Sifirla</button>
                <button className="btn btn-secondary btn-sm" onClick={() => setResetUser('')}>Iptal</button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Tasks Tab ── */}
      {tab === 'tasks' && (
        <div style={{ display: 'grid', gridTemplateColumns: detailTask ? '1fr 340px' : '1fr', gap: 16 }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10, gap: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => { setTaskBulkMode(v => !v); setTaskBulkUsers([]); }}>
                {taskBulkMode ? 'Tekli Mod' : 'Toplu Atama'}
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => setShowTaskForm(s => !s)}>
                {showTaskForm ? 'Kapat' : '+ Yeni Gorev'}
              </button>
            </div>

            {showTaskForm && (
              <div className="panel" style={{ marginBottom: 16, padding: 20 }}>
                <form onSubmit={taskBulkMode ? handleBulkCreateTask : handleCreateTask} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{taskBulkMode ? 'Toplu Gorev Olustur' : 'Gorev Olustur'}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      {taskBulkMode ? (
                        <>
                          <label style={lbl('')}>Kullanicilar * ({taskBulkUsers.length} secili)</label>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                            {nonAdminUsers.map(u => (
                              <button key={u.username} type="button"
                                className={taskBulkUsers.includes(u.username) ? 'filter-chip active' : 'filter-chip'}
                                onClick={() => setTaskBulkUsers(p => p.includes(u.username) ? p.filter(x => x !== u.username) : [...p, u.username])}>
                                {u.displayName || u.username}
                              </button>
                            ))}
                          </div>
                        </>
                      ) : (
                        <>
                          <label style={lbl('')}>Kullanici *</label>
                          <select className="input input-sm" value={taskUser} onChange={e => setTaskUser(e.target.value)}>
                            <option value="">Sec...</option>
                            {nonAdminUsers.map(u => <option key={u.username} value={u.username}>{u.displayName || u.username}</option>)}
                          </select>
                        </>
                      )}
                    </div>
                    <div>
                      <label style={lbl('')}>Oncelik</label>
                      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                        {['low', 'medium', 'high'].map(p => (
                          <button key={p} type="button" className={`filter-chip${taskPriority === p ? ' active' : ''}`}
                            style={taskPriority === p ? { borderColor: PRIORITY_COLORS[p], color: PRIORITY_COLORS[p] } : {}}
                            onClick={() => setTaskPriority(p)}>
                            {p === 'low' ? 'Dusuk' : p === 'medium' ? 'Orta' : 'Yuksek'}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <label style={lbl('')}>Baslik *</label>
                      <input className="input input-sm" placeholder="Gorev basligi" value={taskTitle} onChange={e => setTaskTitle(e.target.value)} />
                    </div>
                    <div>
                      <label style={lbl('')}>Son Tarih</label>
                      <input className="input input-sm" type="datetime-local" value={taskDeadline} onChange={e => setTaskDeadline(e.target.value)} />
                    </div>
                  </div>
                  <div>
                    <label style={lbl('')}>Aciklama</label>
                    <textarea className="input input-sm" placeholder="Detaylar..." value={taskDesc} onChange={e => setTaskDesc(e.target.value)} rows={2} style={{ resize: 'vertical' }} />
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowTaskForm(false)}>Iptal</button>
                    <button type="submit" className="btn btn-primary btn-sm"
                      disabled={taskBulkMode ? taskBulkUsers.length === 0 || !taskTitle.trim() : !taskUser || !taskTitle.trim()}>
                      {taskBulkMode ? `${taskBulkUsers.length} Kullaniciya Ata` : 'Olustur'}
                    </button>
                  </div>
                </form>
              </div>
            )}

            <div className="panel">
              <div className="panel-head">
                <span className="panel-title">Tum Gorevler</span>
                <span style={{ fontSize: 11, color: 'var(--t4)', fontFamily: 'var(--mono)' }}>{tasks.length}</span>
              </div>
              {tasks.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--t4)', fontSize: 13 }}>Henuz gorev yok</div>
              ) : (
                <div>
                  {tasks.map(task => {
                    const overdue = task.status !== 'completed' && isOverdue(task.deadline);
                    return (
                      <div key={task.taskId}
                        style={{ padding: '10px 16px', borderBottom: '1px solid var(--b0)', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', background: detailTask?.taskId === task.taskId ? 'var(--g1)' : 'transparent' }}
                        onClick={() => loadComments(task)}
                      >
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: PRIORITY_COLORS[task.priority] ?? 'var(--t4)', flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: overdue ? 'var(--red)' : 'var(--t1)', textDecoration: task.status === 'completed' ? 'line-through' : 'none' }}>
                            {task.title}
                            {overdue && <span style={{ fontSize: 10, marginLeft: 6, color: 'var(--red)', fontWeight: 400 }}>GECIKTI</span>}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--t4)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <span>{task.assignedTo}</span>
                            {task.accountName && (
                              <>
                                <span>·</span>
                                <span style={{ color: 'var(--blurple-l)' }}>{task.accountName}</span>
                              </>
                            )}
                            <span>·</span>
                            <span>{STATUS_LABELS[task.status] ?? task.status}</span>
                            {task.deadline && (
                              <>
                                <span>·</span>
                                <span style={{ color: overdue ? 'var(--red)' : 'var(--t4)' }}>
                                  Son: {new Date(task.deadline).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                                </span>
                              </>
                            )}
                            {task.createdAt && (
                              <>
                                <span>·</span>
                                <span>{new Date(task.createdAt).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })}</span>
                              </>
                            )}
                          </div>
                        </div>
                        <button className="btn btn-danger btn-xs" onClick={e => { e.stopPropagation(); handleDeleteTask(task); }}>Sil</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Task detail / comments side panel */}
          {detailTask && (
            <div className="panel" style={{ padding: 16, alignSelf: 'start', position: 'sticky', top: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>Gorev Detay</div>
                <button className="btn btn-secondary btn-xs" onClick={() => setDetailTask(null)}>Kapat</button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--t2)', marginBottom: 4 }}>{detailTask.title}</div>
              {detailTask.description && <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 8 }}>{detailTask.description}</div>}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <span className="chip">{detailTask.assignedTo}</span>
                <span className="chip" style={{ color: PRIORITY_COLORS[detailTask.priority] }}>{detailTask.priority}</span>
                <span className="chip">{STATUS_LABELS[detailTask.status]}</span>
              </div>
              {detailTask.deadline && (
                <div style={{ fontSize: 11, color: isOverdue(detailTask.deadline) ? 'var(--red)' : 'var(--t3)', marginBottom: 12 }}>
                  Son Tarih: {new Date(detailTask.deadline).toLocaleString('tr-TR')}
                </div>
              )}

              {/* Comments */}
              <div style={{ borderTop: '1px solid var(--b0)', paddingTop: 10, marginTop: 4 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.5px' }}>Yorumlar</div>
                {comments.length === 0 ? (
                  <div style={{ fontSize: 11, color: 'var(--t4)', marginBottom: 8 }}>Henuz yorum yok</div>
                ) : (
                  <div style={{ maxHeight: 200, overflowY: 'auto', marginBottom: 8 }}>
                    {comments.map(c => (
                      <div key={c.commentId} style={{ marginBottom: 8, padding: '6px 8px', background: 'var(--g1)', borderRadius: 6 }}>
                        <div style={{ fontSize: 11, color: 'var(--t2)' }}>{c.content}</div>
                        <div style={{ fontSize: 9, color: 'var(--t4)', marginTop: 2 }}>{c.username} · {relTime(c.createdAt)}</div>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <input className="input input-sm" placeholder="Yorum yaz..." value={newComment} onChange={e => setNewComment(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleAddComment(); }}
                    style={{ flex: 1 }} />
                  <button className="btn btn-primary btn-xs" onClick={handleAddComment} disabled={!newComment.trim()}>Gonder</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Performance Tab ── */}
      {tab === 'performance' && (
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Kullanici Performans Siralamasi</span>
            <button className="btn btn-secondary btn-xs" onClick={() => api.auth.leaderboard().then(r => setLeaderboard(r.leaderboard)).catch(() => {})}>Yenile</button>
          </div>
          {leaderboard.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--t4)', fontSize: 13 }}>Henuz veri yok</div>
          ) : (
            <div style={{ overflow: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Kullanici</th>
                    <th style={{ textAlign: 'center' }}>Toplam</th>
                    <th style={{ textAlign: 'center' }}>Tamamlanan</th>
                    <th style={{ textAlign: 'center' }}>Bekleyen</th>
                    <th style={{ textAlign: 'center' }}>Devam Eden</th>
                    <th style={{ textAlign: 'center' }}>Basari %</th>
                    <th style={{ textAlign: 'center' }}>Ort. Sure</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map((e, i) => (
                    <tr key={e.username}>
                      <td>
                        <span style={{ fontSize: 13, fontWeight: 700, color: i === 0 ? 'var(--orange)' : i === 1 ? 'var(--t3)' : i === 2 ? '#cd7f32' : 'var(--t4)' }}>
                          {i + 1}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--g3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                            {(e.displayName?.[0] ?? e.username[0]).toUpperCase()}
                          </div>
                          <span style={{ fontWeight: 600, color: 'var(--t1)', fontSize: 13 }}>{e.displayName}</span>
                        </div>
                      </td>
                      <td style={{ textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 12 }}>{e.total}</td>
                      <td style={{ textAlign: 'center' }}><span style={{ color: 'var(--green)', fontFamily: 'var(--mono)', fontSize: 12 }}>{e.completed}</span></td>
                      <td style={{ textAlign: 'center' }}><span style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>{e.pending}</span></td>
                      <td style={{ textAlign: 'center' }}><span style={{ color: 'var(--blue)', fontFamily: 'var(--mono)', fontSize: 12 }}>{e.inProgress}</span></td>
                      <td style={{ textAlign: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
                          <div style={{ width: 40, height: 4, borderRadius: 2, background: 'var(--g2)', overflow: 'hidden' }}>
                            <div style={{ width: `${e.successRate}%`, height: '100%', background: e.successRate >= 70 ? 'var(--green)' : e.successRate >= 40 ? 'var(--orange)' : 'var(--red)', borderRadius: 2 }} />
                          </div>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)' }}>{e.successRate}%</span>
                        </div>
                      </td>
                      <td style={{ textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
                        {e.avgCompletionHours > 0 ? `${e.avgCompletionHours}sa` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Activity & Sessions Tab ── */}
      {tab === 'activity' && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
            <select className="input input-sm" value={activityUser} onChange={e => { if (e.target.value) loadActivity(e.target.value); else { setActivityUser(''); setActivities([]); setSessions([]); } }} style={{ maxWidth: 200 }}>
              <option value="">Kullanici sec...</option>
              {users.map(u => <option key={u.username} value={u.username}>{u.displayName || u.username}</option>)}
            </select>
            {activityUser && (
              <button className="btn btn-danger btn-xs" onClick={() => handleForceLogout(activityUser)}>
                Tum Oturumlari Kapat
              </button>
            )}
          </div>

          {activityUser && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              {/* Activity log */}
              <div className="panel">
                <div className="panel-head">
                  <span className="panel-title">Aktivite Logu</span>
                  <span style={{ fontSize: 11, color: 'var(--t4)', fontFamily: 'var(--mono)' }}>{activities.length}</span>
                </div>
                {activities.length === 0 ? (
                  <div style={{ padding: 30, textAlign: 'center', color: 'var(--t4)', fontSize: 12 }}>Aktivite bulunamadi</div>
                ) : (
                  <div style={{ maxHeight: 500, overflowY: 'auto' }}>
                    {activities.map((a, i) => (
                      <div key={i} style={{ padding: '8px 14px', borderBottom: '1px solid var(--b0)', display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{
                          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                          background: a.action === 'login' ? 'var(--green)' : a.action === 'login_failed' ? 'var(--red)' : a.action === 'logout' ? 'var(--t4)' : 'var(--blue)',
                        }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, color: 'var(--t1)' }}>{ACTION_LABELS[a.action] ?? a.action}</div>
                          <div style={{ fontSize: 10, color: 'var(--t4)' }}>{a.detail}</div>
                        </div>
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{ fontSize: 10, color: 'var(--t4)', fontFamily: 'var(--mono)' }}>{relTime(a.ts)}</div>
                          {a.ip && <div style={{ fontSize: 9, color: 'var(--t5)', fontFamily: 'var(--mono)' }}>{a.ip}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Sessions */}
              <div className="panel">
                <div className="panel-head">
                  <span className="panel-title">Oturumlar</span>
                  <span style={{ fontSize: 11, color: 'var(--t4)', fontFamily: 'var(--mono)' }}>{sessions.filter(s => !s.revoked).length} aktif</span>
                </div>
                {sessions.length === 0 ? (
                  <div style={{ padding: 30, textAlign: 'center', color: 'var(--t4)', fontSize: 12 }}>Oturum bulunamadi</div>
                ) : (
                  <div style={{ maxHeight: 500, overflowY: 'auto' }}>
                    {sessions.map(s => (
                      <div key={s.sessionId} style={{
                        padding: '8px 14px', borderBottom: '1px solid var(--b0)',
                        opacity: s.revoked ? 0.4 : 1,
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div>
                            <div style={{ fontSize: 11, color: 'var(--t2)', fontFamily: 'var(--mono)' }}>
                              {s.sessionId.slice(0, 12)}...
                              {s.revoked && <span style={{ color: 'var(--red)', marginLeft: 6, fontSize: 10 }}>IPTAL</span>}
                            </div>
                            <div style={{ fontSize: 10, color: 'var(--t4)' }}>
                              {s.ip ?? ''} · {relTime(s.createdAt)}
                            </div>
                            {s.userAgent && (
                              <div style={{ fontSize: 9, color: 'var(--t5)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {s.userAgent.slice(0, 60)}
                              </div>
                            )}
                          </div>
                          {!s.revoked && (
                            <button className="btn btn-danger btn-xs" onClick={() => handleRevokeSession(s.sessionId)}>Iptal</button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {!activityUser && (
            <div className="panel" style={{ padding: 40, textAlign: 'center', color: 'var(--t4)', fontSize: 13 }}>
              Aktivite ve oturum bilgilerini gormek icin bir kullanici secin
            </div>
          )}
        </>
      )}

      {/* ── Settings Tab (U4 Password Policy) ── */}
      {tab === 'settings' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
          <div className="panel" style={{ padding: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)', marginBottom: 4 }}>Sifre Politikasi</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 16 }}>Tum kullanicilar icin gecerli sifre kurallari</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={lbl('')}>Maksimum Sifre Omru (gun)</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                  <input className="input input-sm" type="number" min={0} max={365} value={policyMaxDays}
                    onChange={e => setPolicyMaxDays(Number(e.target.value))} style={{ width: 90 }} />
                  <span style={{ fontSize: 11, color: 'var(--t4)' }}>0 = limitsiz</span>
                </div>
              </div>
              <div>
                <label style={lbl('')}>Minimum Sifre Uzunlugu</label>
                <input className="input input-sm" type="number" min={4} max={64} value={policyMinLength}
                  onChange={e => setPolicyMinLength(Number(e.target.value))} style={{ width: 90, marginTop: 4 }} />
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={policyEnforce} onChange={e => setPolicyEnforce(e.target.checked)}
                    style={{ width: 15, height: 15, accentColor: '#38BDF8' }} />
                  <span style={{ fontSize: 12, color: 'var(--t2)' }}>Sifre suresi dolumunu zorla (login'de blokla)</span>
                </label>
              </div>
              {policy && (
                <div style={{ fontSize: 10, color: 'var(--t4)', fontStyle: 'italic' }}>
                  Son guncelleme: {policy.updatedBy} {policy.updatedAt ? new Date(policy.updatedAt).toLocaleDateString('tr-TR') : ''}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                <button className="btn btn-secondary btn-sm" onClick={loadPolicy}>Yenile</button>
                <button className="btn btn-primary btn-sm" onClick={savePolicy} disabled={policyBusy}>Kaydet</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Auto Distribution Tab ── */}
      {tab === 'distribute' && (
        <>
          <div className="panel" style={{ marginBottom: 16, padding: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', marginBottom: 8 }}>Otomatik Gorev Dagitimi</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 16, lineHeight: 1.5 }}>
              Davet havuzundaki (invite_pool) katilim bekleyen sunuculari otomatik olarak kullanicilara esit dagitir.
              Zaten bir hesabin uye oldugu sunucular atlanir. Her kullaniciya rastgele ve esit gorev atanir.
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleDistribute}
                disabled={distributing || nonAdminUsers.length === 0}
                style={{ padding: '8px 20px' }}
              >
                {distributing ? 'Dagitiliyor...' : 'Gorevleri Dagit'}
              </button>
              <span style={{ fontSize: 11, color: 'var(--t4)' }}>
                {nonAdminUsers.length} kullanici mevcut
              </span>
            </div>
            {nonAdminUsers.length === 0 && (
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--red)' }}>
                Gorev atanacak kullanici yok. Once "Kullanicilar" sekmesinden kullanici ekleyin.
              </div>
            )}
          </div>

          {/* Distribution summary — by account */}
          <div className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-head">
              <span className="panel-title">Hesap Bazli Gorev Dagilimi</span>
            </div>
            {(() => {
              const guildTasks = tasks.filter(t => t.taskType === 'guild_join');
              // Group by account name
              const byAccount = new Map<string, { pending: number; active: number; completed: number; assignedTo: Set<string> }>();
              for (const t of guildTasks) {
                const accKey = t.accountName ?? 'Bilinmeyen';
                const a = byAccount.get(accKey) ?? { pending: 0, active: 0, completed: 0, assignedTo: new Set<string>() };
                if (t.status === 'completed') a.completed++;
                else if (t.status === 'in_progress') a.active++;
                else a.pending++;
                a.assignedTo.add(t.assignedTo);
                byAccount.set(accKey, a);
              }
              if (byAccount.size === 0) {
                return <div style={{ padding: 40, textAlign: 'center', color: 'var(--t4)', fontSize: 13 }}>Henuz dagitilmis gorev yok</div>;
              }
              return (
                <div>
                  {[...byAccount.entries()].map(([accName, counts]) => {
                    const total = counts.pending + counts.active + counts.completed;
                    return (
                      <div key={accName} style={{ padding: '10px 16px', borderBottom: '1px solid var(--b0)', display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--blurple-d2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: 'var(--blurple-l)', flexShrink: 0 }}>
                          {accName[0]?.toUpperCase()}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{accName}</div>
                          <div style={{ fontSize: 10, color: 'var(--t4)' }}>
                            {total} sunucu · Atanan: {[...counts.assignedTo].join(', ')}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          {counts.pending > 0 && <span className="chip">{counts.pending} bekliyor</span>}
                          {counts.active > 0 && <span className="chip chip-blue">{counts.active} aktif</span>}
                          {counts.completed > 0 && <span className="chip chip-green">{counts.completed} tamam</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>

          {/* Distribution summary — by user */}
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">Kullanici Basina Gorev Dagilimi</span>
            </div>
            {(() => {
              const guildTasks = tasks.filter(t => t.taskType === 'guild_join');
              const byUser = new Map<string, { pending: number; active: number; completed: number; accounts: Set<string> }>();
              for (const t of guildTasks) {
                const u = byUser.get(t.assignedTo) ?? { pending: 0, active: 0, completed: 0, accounts: new Set<string>() };
                if (t.status === 'completed') u.completed++;
                else if (t.status === 'in_progress') u.active++;
                else u.pending++;
                if (t.accountName) u.accounts.add(t.accountName);
                byUser.set(t.assignedTo, u);
              }
              if (byUser.size === 0) {
                return <div style={{ padding: 40, textAlign: 'center', color: 'var(--t4)', fontSize: 13 }}>Henuz dagitilmis gorev yok</div>;
              }
              return (
                <div>
                  {[...byUser.entries()].map(([username, counts]) => (
                    <div key={username} style={{ padding: '10px 16px', borderBottom: '1px solid var(--b0)', display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--g3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                        {username[0]?.toUpperCase()}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{username}</div>
                        {counts.accounts.size > 0 && (
                          <div style={{ fontSize: 10, color: 'var(--blurple-l)' }}>
                            Hesaplar: {[...counts.accounts].join(', ')}
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        {counts.pending > 0 && <span className="chip">{counts.pending} bekliyor</span>}
                        {counts.active > 0 && <span className="chip chip-blue">{counts.active} aktif</span>}
                        {counts.completed > 0 && <span className="chip chip-green">{counts.completed} tamam</span>}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        </>
      )}
    </div>
  );
}
