import React, { useState, useCallback } from 'react';
import { useSSE, useKeyboard, useInterval, fmt } from './hooks';
import { CommandPalette } from './CommandPalette';
import { Icon, ToastContainer } from './components';
import { Overview } from './pages/Overview';
import { Scraper } from './pages/Scraper';
import { Accounts } from './pages/Accounts';
import { LiveFeed } from './pages/LiveFeed';
import { Analytics } from './pages/Analytics';
import { Search } from './pages/Search';
import { UserProfiles } from './pages/UserProfile';
import { ClickHousePage, ScyllaPage } from './pages/DbPages';
import { ErrorLog } from './pages/ErrorLog';
import { GuildInventory } from './pages/GuildInventory';
import { UserManagement } from './pages/UserManagement';
import { ProxyManagement } from './pages/ProxyManagementV3';
import { ApiDocs } from './pages/ApiDocs';
import { ServerMonitor } from './pages/ServerMonitor';
import { useAuth } from './AuthContext';
import { api } from './api';
import { SenneoLogo } from './components/SenneoLogo';
import type { Page, HealthAll } from './types';

const PAGE_TITLES: Record<Page, string> = {
  overview:   'Overview',
  scraper:    'Scraper',
  accounts:   'Hesaplar & Kanallar',
  livefeed:   'Canlı Mesajlar',
  analytics:  'Analitik',
  users:      'Kullanıcı Profilleri',
  search:     'Mesaj Ara',
  clickhouse: 'ClickHouse',
  scylla:     'ScyllaDB',
  errors:     'Hata Gunlugu',
  guilds:     'Sunucu Yonetimi',
  proxies:    'Proxy Yönetimi',
  'user-mgmt': 'Kullanici Yonetimi',
  'api-docs':  'API Docs',
  'server-monitor': 'Sunucu Kontrol',
};

const NAV = [
  {
    section: 'Monitor',
    items: [
      { page: 'overview'  as Page, label: 'Overview',           icon: <Icon.grid />,    shortcut: '1' },
      { page: 'scraper'   as Page, label: 'Scraper',            icon: <Icon.clock />,   shortcut: '2' },
      { page: 'errors'    as Page, label: 'Hata G\u00FCnl\u00FC\u011F\u00FC',       icon: <Icon.alert />,   shortcut: '9' },
    ],
  },
  {
    section: 'Yönetim',
    items: [
      { page: 'accounts'  as Page, label: 'Hesaplar & Kanallar',icon: <Icon.account />, shortcut: '3' },
      { page: 'proxies'   as Page, label: 'Proxy Yönetimi',    icon: <Icon.proxy />,   shortcut: 'p' },
      { page: 'guilds'    as Page, label: 'Sunucu Y\u00F6netimi', icon: <Icon.widget />,  shortcut: '0' },
      { page: 'livefeed'  as Page, label: 'Canlı Mesajlar',     icon: <Icon.live />,    shortcut: '4' },
    ],
  },
  {
    section: 'Analiz',
    items: [
      { page: 'analytics' as Page, label: 'Analitik',           icon: <Icon.chart />,   shortcut: '5' },
      { page: 'users'     as Page, label: 'Kullanıcılar',       icon: <Icon.users />,   shortcut: '6' },
      { page: 'search'    as Page, label: 'Mesaj Ara',          icon: <Icon.search />,  shortcut: 'k' },
    ],
  },
  {
    section: 'Veritabanı',
    items: [
      { page: 'clickhouse'as Page, label: 'ClickHouse',         icon: <Icon.db />,      shortcut: '7' },
      { page: 'scylla'    as Page, label: 'ScyllaDB',           icon: <Icon.db />,      shortcut: '8' },
    ],
  },
  {
    section: 'Sistem',
    items: [
      { page: 'server-monitor' as Page, label: 'Sunucu Kontrol', icon: <Icon.server />, shortcut: 's' },
      { page: 'user-mgmt' as Page, label: 'Kullanıcı Yönetimi', icon: <Icon.users />, shortcut: '' },
      { page: 'api-docs'  as Page, label: 'API Docs',            icon: <Icon.widget />, shortcut: '' },
    ],
  },
];


export default function App() {
  const [page, setPage]       = useState<Page>('overview');
  const [cmdOpen, setCmdOpen] = useState(false);
  const [health, setHealth]   = useState<HealthAll | null>(null);
  const { summary, connected }  = useSSE();
  const { user, logout } = useAuth();

  // U1 — Allowed pages filter for non-admin users
  const allowedSet = user?.role !== 'admin' && user?.allowedPages && user.allowedPages.length > 0
    ? new Set(user.allowedPages)
    : null; // null = no restriction (admin or no allowedPages set)

  function isPageAllowed(p: Page): boolean {
    if (!allowedSet) return true;
    return allowedSet.has(p);
  }

  useInterval(() => {
    api.health.all().then(d => setHealth(d as HealthAll)).catch(() => {});
  }, 20_000);

  const navigate = useCallback((p: Page) => { setPage(p); setCmdOpen(false); }, []);

  useKeyboard({
    'cmd+k': () => setCmdOpen(o => !o),
    '1': () => navigate('overview'),
    '2': () => navigate('scraper'),
    '3': () => navigate('accounts'),
    '4': () => navigate('livefeed'),
    '5': () => navigate('analytics'),
    '6': () => navigate('users'),
    '7': () => navigate('clickhouse'),
    '8': () => navigate('scylla'),
    '9': () => navigate('errors'),
    '0': () => navigate('guilds'),
    'p': () => navigate('proxies'),
    'k': () => navigate('search'),
    's': () => navigate('server-monitor'),
    'escape': () => setCmdOpen(false),
  });

  const activeCount   = summary?.phaseCounts?.active ?? 0;
  const totalChannels = summary?.totalChannels ?? 0;

  function renderPage() {
    if (!isPageAllowed(page)) {
      const firstAllowed = allowedSet ? ([...allowedSet][0] as Page) : 'overview';
      return <div style={{ padding: 40, textAlign: 'center', color: 'var(--t4)', fontSize: 13 }}>
        Bu sayfaya erişim izniniz yok.{' '}
        <button className="btn btn-secondary btn-sm" onClick={() => setPage(firstAllowed)} style={{ marginLeft: 8 }}>Ana Sayfaya Dön</button>
      </div>;
    }
    switch (page) {
      case 'overview':   return <Overview />;
      case 'scraper':    return <Scraper />;
      case 'accounts':   return <Accounts />;
      case 'livefeed':   return <LiveFeed />;
      case 'analytics':  return <Analytics />;
      case 'users':      return <UserProfiles />;
      case 'search':     return <Search />;
      case 'clickhouse': return <ClickHousePage />;
      case 'scylla':     return <ScyllaPage />;
      case 'errors':     return <ErrorLog />;
      case 'guilds':     return <GuildInventory />;
      case 'proxies':    return <ProxyManagement />;
      case 'user-mgmt':  return <UserManagement />;
      case 'server-monitor': return <ServerMonitor />;
      case 'api-docs':   return <ApiDocs />;
      default:           return <Overview />;
    }
  }

  return (
    <div className="shell">
      <div className="ambient-mid" />
      <div className="ambient-4" />

      {/* ── Sidebar ── */}
      <aside className="sidebar">
        {/* Logo */}
        <div className="sidebar-logo">
          <div className="logo-icon">
            <SenneoLogo size={30} glowIntensity="normal" />
          </div>
          <div>
            <div className="logo-name">Senneo</div>
            <div className="logo-version">v2.0</div>
          </div>
        </div>

        {/* Nav */}
        <nav className="sidebar-nav">
          {NAV.map(section => {
            const visibleItems = section.items.filter(item => isPageAllowed(item.page));
            if (visibleItems.length === 0) return null;
            return (
            <div key={section.section}>
              <div className="nav-section-label">{section.section}</div>
              {visibleItems.map(item => (
                <div
                  key={item.page}
                  className={`nav-item${page === item.page ? ' active' : ''}`}
                  onClick={() => navigate(item.page)}
                >
                  {item.icon}
                  <span style={{ flex: 1 }}>{item.label}</span>
                  {item.page === 'scraper' && totalChannels > 0 && (
                    <span className="nav-badge">{activeCount > 0 ? `${activeCount}` : totalChannels}</span>
                  )}
                  {item.shortcut && (
                    <span style={{ fontSize: 10, color: 'var(--t5)', fontFamily: 'var(--mono)', marginLeft: 'auto' }}>
                      {item.shortcut}
                    </span>
                  )}
                </div>
              ))}
            </div>
          );
          })}
        </nav>

        {/* User */}
        <div className="sidebar-user">
          <div className="sidebar-user-avatar">
            {(user?.displayName?.[0] ?? 'A').toUpperCase()}
          </div>
          <div className="sidebar-user-info">
            <div className="sidebar-user-name">{user?.displayName ?? user?.username}</div>
            <div className="sidebar-user-role">{user?.role === 'admin' ? 'Yönetici' : 'Kullanıcı'}</div>
          </div>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={logout} title="Çıkış Yap"
            style={{ marginLeft: 'auto', color: 'var(--t4)', flexShrink: 0 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
          </button>
        </div>

        {/* Health */}
        <div className="sidebar-footer">
          {health
            ? Object.entries(health).map(([name, h]) => (
                <div key={name} className="health-row">
                  <span className="svc">{name}</span>
                  <span className={`health-val ${h.ok ? 'ok' : 'fail'}`}>{h.ok ? `${h.latencyMs}ms` : 'ERR'}</span>
                </div>
              ))
            : <div style={{ fontSize: 10, color: 'var(--t5)' }}>Bağlanıyor…</div>
          }
        </div>
      </aside>

      {/* ── Main ── */}
      <div className="main">
        {/* Topbar */}
        <div className="topbar">
          <span className="topbar-title">{PAGE_TITLES[page]}</span>
          <div className="topbar-right">
            {summary && summary.msgsPerSec > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px',
                borderRadius: 20, background: 'rgba(255,159,10,0.1)',
                border: '1px solid rgba(255,159,10,0.2)',
              }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--orange)', animation: 'breathe 1.5s ease-in-out infinite' }} />
                <span style={{ fontSize: 11, color: 'var(--orange)', fontFamily: 'var(--mono)', fontWeight: 700 }}>
                  {fmt(summary.msgsPerSec)}/s
                </span>
              </div>
            )}
            <div className="kbd-hint" onClick={() => setCmdOpen(true)}>
              <kbd>⌘K</kbd>
              <span>Ara</span>
            </div>
            <div className={`status-pill ${connected ? 'live' : 'dead'}`}>
              <div className={`status-dot ${connected ? 'pulse' : ''}`} />
              <span>{connected ? 'Canlı' : 'Bağlanıyor…'}</span>
            </div>
          </div>
        </div>

        {/* Page content */}
        <div className="content" key={page}>
          {renderPage()}
        </div>
      </div>

      {cmdOpen && <CommandPalette onClose={() => setCmdOpen(false)} onPage={navigate} />}
      <ToastContainer />
    </div>
  );
}