import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Empty, Spinner } from '../components';
import { addToast, fmt, fmtTs, useDebounce, useInterval } from '../hooks';
import { Icon } from '../icons';
import type { AccountsListResponse, ProxyAccountAssignment, ProxyConfigEditorRow, ProxyConfigPayload, ProxyHealthStatus, ProxyOverviewResponse, ProxyPoolEntry, ProxyRotationMode } from '../types';

const LIMIT = 50;
const HEALTH_COLORS: Record<ProxyHealthStatus, string> = {
  healthy: 'var(--green)',
  degraded: 'var(--orange)',
  down: 'var(--red)',
  cooldown: 'var(--purple)',
  disabled: 'var(--t3)',
  unknown: 'var(--t3)',
  removed: 'var(--pink)',
};

const HEALTH_LABELS: Record<ProxyHealthStatus, string> = {
  healthy: 'Sağlıklı',
  degraded: 'Yavaş',
  down: 'Ulaşılamıyor',
  cooldown: 'Cooldown',
  disabled: 'Kapalı',
  unknown: 'Bilinmiyor',
  removed: 'Dosyadan silinmiş',
};

const ROTATION_OPTIONS: Array<{ value: ProxyRotationMode; label: string }> = [
  { value: 'weighted', label: 'Weighted' },
  { value: 'least-connections', label: 'Least Connections' },
  { value: 'round-robin', label: 'Round Robin' },
];

function toForm(config: ProxyOverviewResponse['config']): ProxyConfigPayload {
  return {
    enabled: config.enabled,
    strictMode: config.strictMode,
    rotationMode: config.rotationMode,
    healthCheckMs: config.healthCheckMs,
    failThreshold: config.failThreshold,
    cooldownMs: config.cooldownMs,
    proxies: config.proxies.map(proxy => ({
      id: proxy.id,
      label: proxy.label,
      url: proxy.url,
      region: proxy.region,
      maxConns: proxy.maxConns,
      weight: proxy.weight,
      enabled: proxy.enabled,
    })),
  };
}

function badgeStyle(color: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 9px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 700,
    background: `color-mix(in srgb, ${color} 14%, transparent)`,
    border: `1px solid color-mix(in srgb, ${color} 28%, transparent)`,
    color,
    whiteSpace: 'nowrap',
  };
}

function tinyTextStyle(): React.CSSProperties {
  return { fontSize: 11, color: 'var(--t3)' };
}

function formatLatency(latencyMs: number | null): string {
  if (latencyMs == null) return '—';
  return `${latencyMs}ms`;
}

function accountStatusColor(status: 'active' | 'failed'): string {
  return status === 'active' ? 'var(--green)' : 'var(--red)';
}

function runtimeStatusLabel(assignment: ProxyAccountAssignment | undefined, poolEnabled: boolean): string {
  if (!assignment) return 'Atama yok';
  if (!poolEnabled) return assignment.connected ? 'Direct oturum' : 'Direct plan';
  if (assignment.direct && assignment.connected) return 'Direct fallback';
  if (assignment.direct) return 'Direct plan';
  if (assignment.connected) return 'Proxy bağlı';
  return 'Proxy planlandı';
}

function ProxyCard({ proxy }: { proxy: ProxyPoolEntry }) {
  const healthColor = HEALTH_COLORS[proxy.health.status];
  return (
    <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 280 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name={proxy.protocol === 'socks' ? 'shield' : 'globe'} size={16} />
            {proxy.label ?? proxy.proxyId}
          </div>
          <div style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)', marginTop: 4 }}>{proxy.maskedUrl ?? '—'}</div>
        </div>
        <span style={badgeStyle(healthColor)}>{HEALTH_LABELS[proxy.health.status]}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
        <div>
          <div style={tinyTextStyle()}>Atanan</div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{fmt(proxy.assignmentCount)}</div>
        </div>
        <div>
          <div style={tinyTextStyle()}>Bağlı</div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{fmt(proxy.connectedAccountCount)}</div>
        </div>
        <div>
          <div style={tinyTextStyle()}>Latency</div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{formatLatency(proxy.health.latencyMs)}</div>
        </div>
        <div>
          <div style={tinyTextStyle()}>Kapasite</div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{proxy.maxConns > 0 ? `${proxy.assignmentCount}/${proxy.maxConns}` : 'Legacy'}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <span style={badgeStyle('var(--blurple)')}>{proxy.protocol ?? '—'}</span>
        {proxy.region ? <span style={badgeStyle('var(--teal)')}>{proxy.region}</span> : null}
        {proxy.overCapacity ? <span style={badgeStyle('var(--red)')}>Over capacity</span> : null}
        {proxy.removed ? <span style={badgeStyle('var(--pink)')}>Runtime’da kaldı</span> : null}
      </div>

      <div style={{ borderTop: '1px solid var(--b0)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 11, color: 'var(--t3)', display: 'flex', justifyContent: 'space-between' }}>
          <span>Son kontrol</span>
          <span>{fmtTs(proxy.health.lastCheckedAt)}</span>
        </div>
        {proxy.health.lastError ? (
          <div style={{ fontSize: 11, color: 'var(--red)' }}>{proxy.health.lastError}</div>
        ) : null}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 160, overflow: 'auto', paddingRight: 2 }}>
          {proxy.assignedAccounts.slice(0, 8).map(account => (
            <div key={account.accountKey} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 8px', borderRadius: 10, background: 'rgba(255,255,255,0.03)' }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)' }}>{account.username ?? account.accountId ?? account.accountKey}</div>
                <div style={{ fontSize: 10, color: 'var(--t4)', fontFamily: 'var(--mono)' }}>idx {account.accountIdx ?? '—'}</div>
              </div>
              <span style={badgeStyle(account.connected ? 'var(--green)' : 'var(--t3)')}>{account.connected ? 'Bağlı' : 'Plan'}</span>
            </div>
          ))}
          {proxy.assignedAccounts.length === 0 ? <Empty text="Atanan hesap yok" /> : null}
        </div>
      </div>
    </div>
  );
}

export function ProxyManagement() {
  const [overview, setOverview] = useState<ProxyOverviewResponse | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [accountsData, setAccountsData] = useState<AccountsListResponse | null>(null);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [searchRaw, setSearchRaw] = useState('');
  const search = useDebounce(searchRaw, 300);
  const [form, setForm] = useState<ProxyConfigPayload | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [forceRefreshing, setForceRefreshing] = useState(false);

  const loadOverview = useCallback(async (force = false) => {
    if (force) setForceRefreshing(true);
    else setOverviewLoading(true);
    setOverviewError(null);
    try {
      const next = await api.proxies.overview(force);
      setOverview(next);
    } catch (err) {
      setOverviewError(err instanceof Error ? err.message : 'Proxy overview alınamadı');
    } finally {
      setOverviewLoading(false);
      if (force) setForceRefreshing(false);
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const next = await api.accounts.accountsList(page, LIMIT, search || undefined);
      setAccountsData(next);
    } catch (err) {
      setAccountsError(err instanceof Error ? err.message : 'Accounts list alınamadı');
    } finally {
      setAccountsLoading(false);
    }
  }, [page, search]);

  useEffect(() => { loadOverview().catch(() => {}); }, [loadOverview]);
  useEffect(() => { loadAccounts().catch(() => {}); }, [loadAccounts]);
  useInterval(() => { loadOverview().catch(() => {}); loadAccounts().catch(() => {}); }, 30_000, false);

  useEffect(() => {
    if (!overview) return;
    if (dirty && form) return;
    setForm(toForm(overview.config));
  }, [overview, dirty, form]);

  useEffect(() => { setPage(1); }, [search]);

  const assignmentByAccountId = useMemo(() => new Map((overview?.assignments ?? []).filter(assignment => !!assignment.accountId).map(assignment => [assignment.accountId!, assignment])), [overview]);
  const assignmentByIdx = useMemo(() => new Map((overview?.assignments ?? []).filter(assignment => assignment.accountIdx != null).map(assignment => [assignment.accountIdx!, assignment])), [overview]);

  const mergedAccounts = useMemo(() => {
    return (accountsData?.accounts ?? []).map(account => ({
      account,
      assignment: (account.accountId ? assignmentByAccountId.get(account.accountId) : undefined) ?? assignmentByIdx.get(account.idx),
    }));
  }, [accountsData, assignmentByAccountId, assignmentByIdx]);

  const pages = accountsData?.pages ?? 1;

  async function handleSave() {
    if (!form) return;
    setSaving(true);
    try {
      await api.proxies.saveConfig(form);
      setDirty(false);
      addToast({ type: 'success', title: 'Proxy config kaydedildi', msg: 'Worker hot-reload snapshot’ı birkaç saniye içinde güncelleyecek.' });
      await loadOverview(true);
    } catch (err) {
      addToast({ type: 'error', title: 'Proxy config kaydedilemedi', msg: err instanceof Error ? err.message : 'Bilinmeyen hata' });
    } finally {
      setSaving(false);
    }
  }

  function patchForm<K extends keyof ProxyConfigPayload>(key: K, value: ProxyConfigPayload[K]) {
    setForm(prev => prev ? { ...prev, [key]: value } : prev);
    setDirty(true);
  }

  function patchProxyRow(index: number, patch: Partial<ProxyConfigEditorRow>) {
    setForm(prev => prev ? {
      ...prev,
      proxies: prev.proxies.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row),
    } : prev);
    setDirty(true);
  }

  function addProxyRow() {
    setForm(prev => prev ? {
      ...prev,
      proxies: [...prev.proxies, { id: `local-${Math.random().toString(36).slice(2, 10)}`, label: '', url: 'socks5://user:pass@host:1080', region: '', maxConns: 50, weight: 1, enabled: true }],
    } : prev);
    setDirty(true);
  }

  function removeProxyRow(index: number) {
    setForm(prev => prev ? { ...prev, proxies: prev.proxies.filter((_, rowIndex) => rowIndex !== index) } : prev);
    setDirty(true);
  }

  if (overviewLoading && !overview) {
    return <div className="empty" style={{ height: 320 }}><Spinner /></div>;
  }

  if (!overview || !form) {
    return <div className="empty" style={{ height: 320 }}>{overviewError ?? 'Proxy overview yüklenemedi'}</div>;
  }

  return (
    <div className="page-enter" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="stat-grid stat-grid-4">
        {[
          { label: 'Toplam Proxy', value: overview.summary.totalProxies, color: 'var(--blurple)', icon: 'globe' as const },
          { label: 'Sağlıklı', value: overview.summary.healthyProxies, color: 'var(--green)', icon: 'shield' as const },
          { label: 'Direct Fallback', value: overview.summary.directAccounts, color: 'var(--orange)', icon: 'activity' as const },
          { label: 'Riskli', value: overview.summary.unhealthyProxies + (overview.diagnostics.restartRequired ? 1 : 0), color: 'var(--red)', icon: 'alert-triangle' as const },
        ].map((card, index) => (
          <div key={card.label} className="stat-card" style={{ '--accent-color': card.color, animation: `slideUp .2s ease ${index * 35}ms both` } as React.CSSProperties}>
            <div className="stat-card-icon"><Icon name={card.icon} size={22} /></div>
            <div className="stat-label">{card.label}</div>
            <div className="stat-value" style={{ color: card.color }}>{fmt(card.value)}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(420px, 1.35fr) minmax(300px, 1fr)', gap: 14, alignItems: 'start' }}>
        <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 800 }}>Proxy Havuzu</div>
              <div style={{ fontSize: 12, color: 'var(--t3)' }}>{overview.config.path}</div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {dirty ? <span style={badgeStyle('var(--orange)')}>Kaydedilmemiş değişiklik</span> : null}
              <button className="btn btn-secondary btn-sm" onClick={() => loadOverview(true)} disabled={forceRefreshing || saving}>{forceRefreshing ? 'Yenileniyor…' : 'Health Refresh'}</button>
              <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>{saving ? 'Kaydediliyor…' : 'Kaydet'}</button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
            <label className="panel" style={{ padding: 12, display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(255,255,255,0.02)' }}>
              <input type="checkbox" checked={form.enabled} onChange={e => patchForm('enabled', e.target.checked)} />
              <div>
                <div style={{ fontSize: 12, fontWeight: 700 }}>Proxy Enabled</div>
                <div style={{ fontSize: 11, color: 'var(--t3)' }}>Worker proxy pool kullanır</div>
              </div>
            </label>
            <label className="panel" style={{ padding: 12, display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(255,255,255,0.02)' }}>
              <input type="checkbox" checked={form.strictMode} onChange={e => patchForm('strictMode', e.target.checked)} />
              <div>
                <div style={{ fontSize: 12, fontWeight: 700 }}>Strict Mode</div>
                <div style={{ fontSize: 11, color: 'var(--t3)' }}>Proxy yoksa direct fallback engellenir</div>
              </div>
            </label>
            <div className="panel" style={{ padding: 12, background: 'rgba(255,255,255,0.02)' }}>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 6 }}>Runtime Snapshot</div>
              <div style={{ fontSize: 12, fontWeight: 700 }}>{overview.runtime.exists ? fmtTs(overview.runtime.updatedAt) : 'Yok'}</div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr repeat(3, minmax(0, 1fr))', gap: 10 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 6 }}>Rotation Mode</div>
              <select className="input" value={form.rotationMode} onChange={e => patchForm('rotationMode', e.target.value as ProxyRotationMode)}>
                {ROTATION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 6 }}>Health Check (ms)</div>
              <input className="input" value={form.healthCheckMs} type="number" onChange={e => patchForm('healthCheckMs', Number(e.target.value) || 0)} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 6 }}>Fail Threshold</div>
              <input className="input" value={form.failThreshold} type="number" onChange={e => patchForm('failThreshold', Number(e.target.value) || 0)} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 6 }}>Cooldown (ms)</div>
              <input className="input" value={form.cooldownMs} type="number" onChange={e => patchForm('cooldownMs', Number(e.target.value) || 0)} />
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 800 }}>Proxy Satırları</div>
              <div style={{ fontSize: 11, color: 'var(--t3)' }}>HTTP/HTTPS ve SOCKS5 URL’leri desteklenir</div>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={addProxyRow}>Proxy Ekle</button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflow: 'auto', paddingRight: 2 }}>
            {form.proxies.map((proxy, index) => (
              <div key={proxy.id ?? index} className="panel" style={{ padding: 12, background: 'rgba(255,255,255,0.02)', display: 'grid', gridTemplateColumns: 'minmax(120px, 1fr) minmax(220px, 2.2fr) minmax(90px, .8fr) 84px 84px auto', gap: 8, alignItems: 'center' }}>
                <input className="input input-sm" placeholder="Label" value={proxy.label ?? ''} onChange={e => patchProxyRow(index, { label: e.target.value })} />
                <input className="input input-sm mono" placeholder="socks5://user:pass@host:1080" value={proxy.url} onChange={e => patchProxyRow(index, { url: e.target.value })} />
                <input className="input input-sm" placeholder="Region" value={proxy.region ?? ''} onChange={e => patchProxyRow(index, { region: e.target.value })} />
                <input className="input input-sm" type="number" placeholder="Conn" value={proxy.maxConns} onChange={e => patchProxyRow(index, { maxConns: Number(e.target.value) || 0 })} />
                <input className="input input-sm" type="number" placeholder="Weight" value={proxy.weight} onChange={e => patchProxyRow(index, { weight: Number(e.target.value) || 0 })} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--t2)' }}>
                    <input type="checkbox" checked={proxy.enabled} onChange={e => patchProxyRow(index, { enabled: e.target.checked })} />
                    Aktif
                  </label>
                  <button className="btn btn-secondary btn-xs" onClick={() => removeProxyRow(index)}>Sil</button>
                </div>
              </div>
            ))}
            {form.proxies.length === 0 ? <Empty text="Henüz proxy eklenmedi" /> : null}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 800 }}>Runtime & Diagnostics</div>
                <div style={{ fontSize: 12, color: 'var(--t3)' }}>Worker snapshot ve config senkron durumu</div>
              </div>
              {overview.runtime.restartRequired ? <span style={badgeStyle('var(--red)')}>Restart önerilir</span> : <span style={badgeStyle('var(--green)')}>Senkron</span>}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
              <div className="panel" style={{ padding: 12, background: 'rgba(255,255,255,0.02)' }}>
                <div style={{ fontSize: 11, color: 'var(--t3)' }}>Config Hash</div>
                <div className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{overview.config.configHash}</div>
              </div>
              <div className="panel" style={{ padding: 12, background: 'rgba(255,255,255,0.02)' }}>
                <div style={{ fontSize: 11, color: 'var(--t3)' }}>Runtime Hash</div>
                <div className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{overview.runtime.configHash ?? '—'}</div>
              </div>
              <div className="panel" style={{ padding: 12, background: 'rgba(255,255,255,0.02)' }}>
                <div style={{ fontSize: 11, color: 'var(--t3)' }}>Assigned Accounts</div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>{fmt(overview.summary.assignedAccounts)}</div>
              </div>
              <div className="panel" style={{ padding: 12, background: 'rgba(255,255,255,0.02)' }}>
                <div style={{ fontSize: 11, color: 'var(--t3)' }}>Connected Accounts</div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>{fmt(overview.summary.connectedAccounts)}</div>
              </div>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <span style={badgeStyle(overview.config.enabled ? 'var(--green)' : 'var(--t3)')}>{overview.config.enabled ? 'Proxy enabled' : 'Proxy disabled'}</span>
              <span style={badgeStyle(overview.config.strictMode ? 'var(--purple)' : 'var(--t3)')}>{overview.config.strictMode ? 'Strict mode' : 'Fallback allowed'}</span>
              {overview.diagnostics.staleRuntimeAssignments > 0 ? <span style={badgeStyle('var(--pink)')}>{overview.diagnostics.staleRuntimeAssignments} stale runtime</span> : null}
            </div>
          </div>

          <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 16, fontWeight: 800 }}>Uyarılar</div>
            {overview.diagnostics.warnings.length === 0 ? <Empty text="Aktif uyarı yok" /> : overview.diagnostics.warnings.map((warning, index) => (
              <div key={index} style={{ padding: '10px 12px', borderRadius: 12, background: 'rgba(255,69,58,0.08)', border: '1px solid rgba(255,69,58,0.16)', color: 'var(--t2)', fontSize: 12 }}>
                {warning}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>Proxy Durum Kartları</div>
            <div style={{ fontSize: 12, color: 'var(--t3)' }}>Health, kapasite ve atanan hesaplar</div>
          </div>
          {overviewError ? <span style={badgeStyle('var(--red)')}>{overviewError}</span> : null}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
          {overview.proxies.map(proxy => <ProxyCard key={proxy.proxyId} proxy={proxy} />)}
        </div>
      </div>

      <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>Hesap → Proxy Eşleşmeleri</div>
            <div style={{ fontSize: 12, color: 'var(--t3)' }}>Mevcut Accounts listesi ile proxy assignment snapshot birleşimi</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="input input-sm" placeholder="Hesap ara…" value={searchRaw} onChange={e => setSearchRaw(e.target.value)} style={{ minWidth: 220 }} />
            <button className="btn btn-secondary btn-sm" onClick={() => loadAccounts().catch(() => {})} disabled={accountsLoading}>{accountsLoading ? 'Yükleniyor…' : 'Liste Yenile'}</button>
          </div>
        </div>

        {accountsError ? <div style={{ color: 'var(--red)', fontSize: 12 }}>{accountsError}</div> : null}
        {accountsLoading && !accountsData ? <div className="empty" style={{ height: 220 }}><Spinner /></div> : null}
        {!accountsLoading && mergedAccounts.length === 0 ? <Empty text="Gösterilecek hesap yok" /> : null}

        {mergedAccounts.length > 0 ? (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Hesap</th>
                  <th>Durum</th>
                  <th>Guild</th>
                  <th>Target</th>
                  <th>Proxy</th>
                  <th>Health</th>
                  <th>Runtime</th>
                  <th>Detay</th>
                </tr>
              </thead>
              <tbody>
                {mergedAccounts.map(({ account, assignment }) => {
                  const healthColor = assignment ? HEALTH_COLORS[assignment.proxyHealthStatus] : 'var(--t3)';
                  return (
                    <tr key={`${account.accountId}-${account.idx}`}>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                          <span style={{ fontWeight: 800, color: 'var(--t1)' }}>{account.username}</span>
                          <span style={{ fontSize: 10, color: 'var(--t4)', fontFamily: 'var(--mono)' }}>idx {account.idx}{account.accountId ? ` • ${account.accountId}` : ''}</span>
                        </div>
                      </td>
                      <td>
                        <span style={badgeStyle(accountStatusColor(account.status))}>{account.status === 'active' ? 'Aktif' : 'Failed'}</span>
                      </td>
                      <td>{fmt(account.guildCount)}</td>
                      <td>{fmt(account.targetCount)}</td>
                      <td>
                        {assignment?.proxyMaskedUrl ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)' }}>{assignment.proxyLabel ?? assignment.proxyMaskedUrl}</span>
                            <span style={{ fontSize: 10, color: 'var(--t4)', fontFamily: 'var(--mono)' }}>{assignment.proxyMaskedUrl}</span>
                          </div>
                        ) : (
                          <span style={{ color: 'var(--t4)' }}>Direct</span>
                        )}
                      </td>
                      <td>
                        <span style={badgeStyle(healthColor)}>{assignment ? HEALTH_LABELS[assignment.proxyHealthStatus] : '—'}</span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span style={badgeStyle(assignment?.connected ? 'var(--green)' : 'var(--t3)')}>{runtimeStatusLabel(assignment, overview.config.enabled)}</span>
                          {account.paused ? <span style={badgeStyle('var(--orange)')}>Pause</span> : null}
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 280 }}>
                          {assignment?.lastError ? <span style={{ fontSize: 11, color: 'var(--red)' }}>{assignment.lastError}</span> : null}
                          {account.failedError ? <span style={{ fontSize: 11, color: 'var(--red)' }}>{account.failedError}</span> : null}
                          <span style={{ fontSize: 10, color: 'var(--t4)' }}>Health {account.healthLabel} • RL {fmt(account.totalRateLimitHits)}</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ fontSize: 12, color: 'var(--t3)' }}>
            {accountsData ? `${fmt(accountsData.total)} hesap • sayfa ${accountsData.page}/${accountsData.pages}` : '—'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-xs" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Önceki</button>
            <button className="btn btn-secondary btn-xs" disabled={page >= pages} onClick={() => setPage(p => Math.min(pages, p + 1))}>Sonraki</button>
          </div>
        </div>
      </div>
    </div>
  );
}
