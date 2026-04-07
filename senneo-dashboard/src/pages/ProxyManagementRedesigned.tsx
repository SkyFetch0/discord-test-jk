import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Empty, Spinner } from '../components';
import { addToast, fmt, fmtTs, useDebounce, useInterval } from '../hooks';
import { Icon } from '../icons';
import type { AccountsListResponse, ProxyAccountAssignment, ProxyConfigEditorRow, ProxyConfigPayload, ProxyHealthStatus, ProxyOverviewResponse, ProxyPoolEntry, ProxyRotationMode } from '../types';

const ACCOUNT_LIMIT = 50;
const EDITOR_PAGE_SIZE = 25;

type ProxyFilter = 'all' | 'healthy' | 'issues' | 'unassigned' | 'disabled';
type AccountView = 'all' | 'proxied' | 'direct' | 'issues' | 'paused';
type ImportMode = 'append' | 'replace';
type ImportProtocol = 'socks5' | 'http';

const HEALTH_COLORS: Record<ProxyHealthStatus, string> = {
  healthy: 'var(--green)',
  degraded: 'var(--orange)',
  down: 'var(--red)',
  cooldown: 'var(--purple)',
  disabled: 'var(--t3)',
  unknown: 'var(--t4)',
  removed: 'var(--pink)',
};

const HEALTH_LABELS: Record<ProxyHealthStatus, string> = {
  healthy: 'Sağlıklı',
  degraded: 'Yavaş',
  down: 'Kapalı / Hatalı',
  cooldown: 'Dinleniyor',
  disabled: 'Kapalı',
  unknown: 'Henüz ölçülmedi',
  removed: 'Dosyadan kalktı',
};

const ROTATION_OPTIONS: Array<{ value: ProxyRotationMode; label: string; desc: string }> = [
  { value: 'weighted', label: 'Ağırlıklı', desc: 'Daha güçlü proxy daha fazla hesap alır.' },
  { value: 'least-connections', label: 'En Boş Proxy', desc: 'Sistemde en az dolu olan proxy tercih edilir.' },
  { value: 'round-robin', label: 'Sırayla Dağıt', desc: 'Hesaplar proxy’lere sırayla paylaştırılır.' },
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
    padding: '5px 10px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 700,
    color,
    whiteSpace: 'nowrap',
    background: `color-mix(in srgb, ${color} 14%, transparent)`,
    border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
  };
}

function softPanelStyle(): React.CSSProperties {
  return {
    padding: 14,
    borderRadius: 14,
    border: '1px solid rgba(255,255,255,0.07)',
    background: 'rgba(255,255,255,0.025)',
  };
}

function formatLatency(latencyMs: number | null): string {
  if (latencyMs == null) return '—';
  return `${latencyMs} ms`;
}

function runtimeStatusLabel(assignment: ProxyAccountAssignment | undefined, poolEnabled: boolean): string {
  if (!assignment) return poolEnabled ? 'Atama bekliyor' : 'Direct çalışıyor';
  if (!poolEnabled) return assignment.connected ? 'Direct oturum' : 'Direct plan';
  if (assignment.direct && assignment.connected) return 'Direct fallback';
  if (assignment.direct) return 'Direct plan';
  if (assignment.connected) return 'Proxy bağlı';
  return 'Proxy planlandı';
}

function accountStatusColor(status: 'active' | 'failed'): string {
  return status === 'active' ? 'var(--green)' : 'var(--red)';
}

function assignmentReasonLabel(reason: string): string {
  switch (reason) {
    case 'assigned': return 'Normal atama';
    case 'over_capacity': return 'Kapasite dolu';
    case 'pool_disabled': return 'Proxy kapalı';
    case 'no_enabled_proxy': return 'Aktif proxy yok';
    case 'missing_account_key': return 'Eşleşme eksik';
    default: return reason || '—';
  }
}

function parseImportLines(text: string, protocol: ImportProtocol, fallbackRegion: string): ProxyConfigEditorRow[] {
  const lines = text.split(/\r?\n/);
  const parsed: ProxyConfigEditorRow[] = [];
  for (const [index, raw] of lines.entries()) {
    const cleaned = raw.trim();
    if (!cleaned || cleaned.startsWith('#')) continue;
    const [first, second] = cleaned.split(',').map(part => part.trim());
    const url = first.includes('://') ? first : `${protocol}://${first}`;
    parsed.push({
      id: `import-${Date.now()}-${index}`,
      label: `Imported ${String(parsed.length + 1).padStart(3, '0')}`,
      url,
      region: second || fallbackRegion || '',
      maxConns: 1,
      weight: 1,
      enabled: true,
    });
  }
  return parsed;
}

function GuideCard({ icon, title, body, accent }: { icon: string; title: string; body: string; accent: string }) {
  return (
    <div className="panel" style={{ padding: 14, background: `linear-gradient(180deg, color-mix(in srgb, ${accent} 10%, rgba(255,255,255,0.02)), rgba(255,255,255,0.02))`, borderColor: `color-mix(in srgb, ${accent} 24%, rgba(255,255,255,0.08))` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div style={{ width: 34, height: 34, borderRadius: 12, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${accent} 18%, transparent)`, color: accent }}>
          <Icon name={icon as never} size={16} />
        </div>
        <div style={{ fontSize: 13, fontWeight: 800 }}>{title}</div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--t3)', lineHeight: 1.55 }}>{body}</div>
    </div>
  );
}

function MetricCard({ label, value, sub, color, icon }: { label: string; value: string | number; sub: string; color: string; icon: string }) {
  return (
    <div className="stat-card" style={{ '--accent-color': color } as React.CSSProperties}>
      <div className="stat-card-icon"><Icon name={icon as never} size={22} /></div>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color }}>{value}</div>
      <div className="stat-sub">{sub}</div>
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
  const [proxySearchRaw, setProxySearchRaw] = useState('');
  const proxySearch = useDebounce(proxySearchRaw, 200);
  const [proxyFilter, setProxyFilter] = useState<ProxyFilter>('all');
  const [accountView, setAccountView] = useState<AccountView>('all');
  const [editorPage, setEditorPage] = useState(1);
  const [importText, setImportText] = useState('');
  const [importMode, setImportMode] = useState<ImportMode>('append');
  const [importProtocol, setImportProtocol] = useState<ImportProtocol>('socks5');
  const [importRegion, setImportRegion] = useState('');

  const loadOverview = useCallback(async (force = false) => {
    if (force) setForceRefreshing(true); else setOverviewLoading(true);
    setOverviewError(null);
    try {
      setOverview(await api.proxies.overview(force));
    } catch (err) {
      setOverviewError(err instanceof Error ? err.message : 'Proxy verisi alınamadı');
    } finally {
      setOverviewLoading(false);
      if (force) setForceRefreshing(false);
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      setAccountsData(await api.accounts.accountsList(page, ACCOUNT_LIMIT, search || undefined));
    } catch (err) {
      setAccountsError(err instanceof Error ? err.message : 'Hesap listesi alınamadı');
    } finally {
      setAccountsLoading(false);
    }
  }, [page, search]);

  useEffect(() => { void loadOverview(); }, [loadOverview]);
  useEffect(() => { void loadAccounts(); }, [loadAccounts]);
  useInterval(() => { void loadOverview(); void loadAccounts(); }, 30_000, false);
  useEffect(() => { if (overview && (!dirty || !form)) setForm(toForm(overview.config)); }, [overview, dirty, form]);
  useEffect(() => { setPage(1); }, [search]);
  useEffect(() => { setEditorPage(1); }, [proxySearch, proxyFilter, form?.proxies.length]);

  const proxyById = useMemo(() => new Map((overview?.proxies ?? []).map(proxy => [proxy.proxyId, proxy])), [overview]);
  const assignmentByAccountId = useMemo(() => new Map((overview?.assignments ?? []).filter(item => !!item.accountId).map(item => [item.accountId!, item])), [overview]);
  const assignmentByIdx = useMemo(() => new Map((overview?.assignments ?? []).filter(item => item.accountIdx != null).map(item => [item.accountIdx!, item])), [overview]);

  const mergedAccounts = useMemo(() => {
    return (accountsData?.accounts ?? []).map(account => ({
      account,
      assignment: (account.accountId ? assignmentByAccountId.get(account.accountId) : undefined) ?? assignmentByIdx.get(account.idx),
    }));
  }, [accountsData, assignmentByAccountId, assignmentByIdx]);

  const filteredAccounts = useMemo(() => {
    return mergedAccounts.filter(({ account, assignment }) => {
      if (accountView === 'proxied') return !!assignment && !assignment.direct;
      if (accountView === 'direct') return !assignment || assignment.direct;
      if (accountView === 'issues') return !!assignment?.lastError || !!account.failedError || account.status === 'failed';
      if (accountView === 'paused') return account.paused;
      return true;
    });
  }, [mergedAccounts, accountView]);

  const filteredProxyRows = useMemo(() => {
    if (!form) return [] as Array<{ proxy: ProxyConfigEditorRow; index: number; live: ProxyPoolEntry | null }>;
    const needle = proxySearch.trim().toLowerCase();
    const rows = form.proxies.map((proxy, index) => ({ proxy, index, live: proxy.id ? proxyById.get(proxy.id) ?? null : null }));
    return rows.filter(({ proxy, live }) => {
      const health = live?.health.status ?? (proxy.enabled ? 'unknown' : 'disabled');
      if (proxyFilter === 'healthy' && !['healthy', 'degraded'].includes(health)) return false;
      if (proxyFilter === 'issues' && !(health === 'down' || health === 'cooldown' || live?.overCapacity || live?.health.lastError)) return false;
      if (proxyFilter === 'unassigned' && (live?.assignmentCount ?? 0) > 0) return false;
      if (proxyFilter === 'disabled' && proxy.enabled) return false;
      if (!needle) return true;
      const bag = [proxy.label, proxy.url, proxy.region, live?.host, live?.maskedUrl, live?.proxyId].filter(Boolean).join(' ').toLowerCase();
      return bag.includes(needle);
    });
  }, [form, proxyById, proxySearch, proxyFilter]);

  const editorPages = Math.max(1, Math.ceil(filteredProxyRows.length / EDITOR_PAGE_SIZE));
  const editorRows = filteredProxyRows.slice((editorPage - 1) * EDITOR_PAGE_SIZE, editorPage * EDITOR_PAGE_SIZE);

  async function handleSave() {
    if (!form) return;
    setSaving(true);
    try {
      await api.proxies.saveConfig(form);
      setDirty(false);
      addToast({ type: 'success', title: 'Proxy ayarları kaydedildi', msg: 'Yeni plan birkaç saniye içinde runtime tarafına yansır.' });
      await loadOverview(true);
    } catch (err) {
      addToast({ type: 'error', title: 'Proxy kaydedilemedi', msg: err instanceof Error ? err.message : 'Bilinmeyen hata' });
    } finally {
      setSaving(false);
    }
  }

  function patchForm<K extends keyof ProxyConfigPayload>(key: K, value: ProxyConfigPayload[K]) {
    setForm(prev => prev ? { ...prev, [key]: value } : prev);
    setDirty(true);
  }

  function patchProxyRow(index: number, patch: Partial<ProxyConfigEditorRow>) {
    setForm(prev => prev ? { ...prev, proxies: prev.proxies.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row) } : prev);
    setDirty(true);
  }

  function addProxyRow() {
    setForm(prev => prev ? { ...prev, proxies: [...prev.proxies, { id: `local-${Math.random().toString(36).slice(2, 10)}`, label: '', url: 'socks5://host:1080', region: '', maxConns: 1, weight: 1, enabled: true }] } : prev);
    setDirty(true);
  }

  function removeProxyRow(index: number) {
    setForm(prev => prev ? { ...prev, proxies: prev.proxies.filter((_, i) => i !== index) } : prev);
    setDirty(true);
  }

  function handleImport() {
    if (!form || !importText.trim()) return;
    const imported = parseImportLines(importText, importProtocol, importRegion.trim());
    if (imported.length === 0) {
      addToast({ type: 'error', title: 'İçeri aktarılacak satır yok', msg: 'Her satıra bir proxy yazın. Örn: 65.111.22.8:1081' });
      return;
    }
    setForm(prev => {
      if (!prev) return prev;
      if (importMode === 'replace') return { ...prev, proxies: imported };
      const seen = new Set(prev.proxies.map(proxy => proxy.url.trim()));
      const unique = imported.filter(proxy => !seen.has(proxy.url.trim()));
      addToast({ type: 'info', title: `${unique.length} proxy eklendi`, msg: imported.length !== unique.length ? `${imported.length - unique.length} tekrar satırı atlandı.` : undefined });
      return { ...prev, proxies: [...prev.proxies, ...unique] };
    });
    setDirty(true);
    setImportText('');
  }

  if (overviewLoading && !overview) return <div className="empty" style={{ height: 320 }}><Spinner /></div>;
  if (!overview || !form) return <div className="empty" style={{ height: 320 }}>{overviewError ?? 'Proxy sayfası yüklenemedi'}</div>;

  const riskyCount = overview.summary.unhealthyProxies + overview.summary.overCapacityProxies + (overview.runtime.restartRequired ? 1 : 0);
  const proxyUsingAccounts = Math.max(overview.summary.connectedAccounts - overview.summary.directAccounts, 0);
  const currentRotation = ROTATION_OPTIONS.find(option => option.value === form.rotationMode);

  return (
    <div className="page-enter" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(320px, .95fr)', gap: 14, alignItems: 'start' }}>
        <div className="panel" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 24, fontWeight: 900, letterSpacing: -.8 }}>Proxy Operasyon Merkezi</div>
              <div style={{ fontSize: 13, color: 'var(--t3)', maxWidth: 760, lineHeight: 1.55, marginTop: 6 }}>
                Bu ekran, hesapların hangi proxy ile çalıştığını, hangi proxy’nin sağlıklı olduğunu ve neyin sorun çıkardığını tek yerden gösterir. Teknik terimleri sade tuttum; önce özet rakamlara, sonra uyarılara, en son tek tek satırlara bakman yeterli.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {dirty ? <span style={badgeStyle('var(--orange)')}>Kaydedilmemiş değişiklik</span> : <span style={badgeStyle('var(--green)')}>Kaydedilmiş</span>}
              <button className="btn btn-secondary btn-sm" onClick={() => void loadOverview(true)} disabled={forceRefreshing || saving}>{forceRefreshing ? 'Yenileniyor…' : 'Health yenile'}</button>
              <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>{saving ? 'Kaydediliyor…' : 'Kaydet'}</button>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
            <GuideCard icon="shield" accent="var(--green)" title="Sağlıklı proxy" body="Son kontrolde yanıt veren ve kullanılabilir görünen proxy’dir. Önce bu sayıya bak." />
            <GuideCard icon="activity" accent="var(--orange)" title="Direct fallback" body="Hesap proxy yerine kendi bağlantısıyla çalışıyor demektir. Test aşamasında kabul edilebilir, kalıcıda düşük olmalı." />
            <GuideCard icon="info" accent="var(--blurple)" title="Strict mode" body="Açık olduğunda proxy yoksa hesap direct devam etmez. Stabil olduktan sonra açılması daha güvenlidir." />
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, position: 'sticky', top: 0 }}>
          <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>Şu an ne yapmalıyım?</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={softPanelStyle()}><b>1.</b> Listeyi toplu içeri aktar, sonra <b>Kaydet</b>.</div>
              <div style={softPanelStyle()}><b>2.</b> <b>Health yenile</b> ile kötü proxyleri ayıkla.</div>
              <div style={softPanelStyle()}><b>3.</b> <b>Direct fallback</b> sayısını düşürmeye çalış.</div>
              <div style={softPanelStyle()}><b>4.</b> Sorunlu hesapları en alttaki eşleşme tablosundan ara.</div>
            </div>
          </div>
          <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>Runtime Durumu</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
              <div style={softPanelStyle()}><div style={{ fontSize: 11, color: 'var(--t4)' }}>Config hash</div><div className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{overview.config.configHash}</div></div>
              <div style={softPanelStyle()}><div style={{ fontSize: 11, color: 'var(--t4)' }}>Runtime hash</div><div className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{overview.runtime.configHash ?? '—'}</div></div>
              <div style={softPanelStyle()}><div style={{ fontSize: 11, color: 'var(--t4)' }}>Son snapshot</div><div style={{ fontSize: 12, fontWeight: 700 }}>{fmtTs(overview.runtime.updatedAt)}</div></div>
              <div style={softPanelStyle()}><div style={{ fontSize: 11, color: 'var(--t4)' }}>Senkron</div><div style={{ fontSize: 12, fontWeight: 700 }}>{overview.runtime.restartRequired ? 'Restart gerekebilir' : 'Canlı plan uyumlu'}</div></div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span style={badgeStyle(form.enabled ? 'var(--green)' : 'var(--t3)')}>{form.enabled ? 'Proxy açık' : 'Proxy kapalı'}</span>
              <span style={badgeStyle(form.strictMode ? 'var(--purple)' : 'var(--t3)')}>{form.strictMode ? 'Strict açık' : 'Direct fallback açık'}</span>
              {overview.runtime.restartRequired ? <span style={badgeStyle('var(--red)')}>Worker restart önerilir</span> : null}
            </div>
          </div>
        </div>
      </div>

      <div className="stat-grid stat-grid-6">
        <MetricCard label="Toplam Proxy" value={fmt(overview.summary.totalProxies)} sub="Havuzdaki tüm satırlar" color="var(--blurple)" icon="globe" />
        <MetricCard label="Sağlıklı" value={fmt(overview.summary.healthyProxies)} sub="İlk bakılacak sayı" color="var(--green)" icon="shield" />
        <MetricCard label="Riskli" value={fmt(riskyCount)} sub="Sorunlu veya kapasite baskılı" color="var(--red)" icon="alert-triangle" />
        <MetricCard label="Proxy kullanan hesap" value={fmt(proxyUsingAccounts)} sub="Gerçekte proxy üstünde çalışan" color="var(--brand)" icon="users-lucide" />
        <MetricCard label="Direct fallback" value={fmt(overview.summary.directAccounts)} sub="Proxy dışına düşen hesap" color="var(--orange)" icon="activity" />
        <MetricCard label="Boştaki proxy" value={fmt(overview.summary.unassignedProxies)} sub="Henüz hesap almamış" color="var(--teal)" icon="database" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.45fr) minmax(320px, .95fr)', gap: 14, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>Kontrol Merkezi</div>
                <div style={{ fontSize: 12, color: 'var(--t3)' }}>Ayarların ne işe yaradığını tek satırda anlattım.</div>
              </div>
              <span style={badgeStyle('var(--brand)')}>{currentRotation?.label ?? form.rotationMode}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
              <div style={softPanelStyle()}><div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>Proxy Enabled</div><div style={{ fontSize: 11, color: 'var(--t4)', marginBottom: 8 }}>Açıkken hesaplar proxy havuzunu kullanır.</div><label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={form.enabled} onChange={e => patchForm('enabled', e.target.checked)} /> <span>{form.enabled ? 'Açık' : 'Kapalı'}</span></label></div>
              <div style={softPanelStyle()}><div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>Strict Mode</div><div style={{ fontSize: 11, color: 'var(--t4)', marginBottom: 8 }}>Açıkken proxy yoksa hesap direct çalışmaz.</div><label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={form.strictMode} onChange={e => patchForm('strictMode', e.target.checked)} /> <span>{form.strictMode ? 'Açık' : 'Kapalı'}</span></label></div>
              <div style={softPanelStyle()}><div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>Dağıtım Şekli</div><div style={{ fontSize: 11, color: 'var(--t4)', marginBottom: 8 }}>{currentRotation?.desc}</div><select className="input input-sm" value={form.rotationMode} onChange={e => patchForm('rotationMode', e.target.value as ProxyRotationMode)}>{ROTATION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
              <div style={softPanelStyle()}><div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>Health sıklığı</div><div style={{ fontSize: 11, color: 'var(--t4)', marginBottom: 8 }}>Kaç ms’de bir proxy tekrar ölçülsün.</div><input className="input input-sm" type="number" value={form.healthCheckMs} onChange={e => patchForm('healthCheckMs', Number(e.target.value) || 0)} /></div>
              <div style={softPanelStyle()}><div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>Fail threshold</div><div style={{ fontSize: 11, color: 'var(--t4)', marginBottom: 8 }}>Arka arkaya kaç başarısızlıkta dinlendirilsin.</div><input className="input input-sm" type="number" value={form.failThreshold} onChange={e => patchForm('failThreshold', Number(e.target.value) || 0)} /></div>
              <div style={softPanelStyle()}><div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>Cooldown</div><div style={{ fontSize: 11, color: 'var(--t4)', marginBottom: 8 }}>Kötü proxy’nin ne kadar süre dinleneceği.</div><input className="input input-sm" type="number" value={form.cooldownMs} onChange={e => patchForm('cooldownMs', Number(e.target.value) || 0)} /></div>
            </div>
          </div>

          <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>Toplu Proxy İçeri Aktarma</div>
                <div style={{ fontSize: 12, color: 'var(--t3)' }}>1000 satır proxyyi tek seferde içeri almak için burayı kullan. Elle tek tek eklemek zorunda değilsin.</div>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => setImportText('65.111.22.8:1081\n65.111.22.9:1081,UK')}>Örnek doldur</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '120px 120px 160px auto', gap: 10 }}>
              <select className="input input-sm" value={importProtocol} onChange={e => setImportProtocol(e.target.value as ImportProtocol)}><option value="socks5">SOCKS5</option><option value="http">HTTP</option></select>
              <select className="input input-sm" value={importMode} onChange={e => setImportMode(e.target.value as ImportMode)}><option value="append">Mevcut listeye ekle</option><option value="replace">Listeyi tamamen değiştir</option></select>
              <input className="input input-sm" placeholder="Varsayılan bölge (örn: UK)" value={importRegion} onChange={e => setImportRegion(e.target.value)} />
              <button className="btn btn-primary btn-sm" onClick={handleImport}>Listeyi içeri al</button>
            </div>
            <textarea className="input mono" rows={7} placeholder={'Her satıra bir proxy yaz\n65.111.22.8:1081\nuser:pass@host:port\nhttp://user:pass@host:8080\n65.111.22.9:1081,UK'} value={importText} onChange={e => setImportText(e.target.value)} />
          </div>

          <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>Proxy Envanteri</div>
                <div style={{ fontSize: 12, color: 'var(--t3)' }}>Arama, filtreleme ve sayfalama ile 1000+ proxyyi yönetmek için tasarlandı.</div>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={addProxyRow}>Boş satır ekle</button>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input className="input input-sm" style={{ minWidth: 240 }} placeholder="Label, URL, host veya bölge ara…" value={proxySearchRaw} onChange={e => setProxySearchRaw(e.target.value)} />
              {([
                ['all', 'Tümü'],
                ['healthy', 'Sağlıklı'],
                ['issues', 'Sorunlu'],
                ['unassigned', 'Boşta'],
                ['disabled', 'Kapalı'],
              ] as Array<[ProxyFilter, string]>).map(([key, label]) => (
                <button key={key} className={proxyFilter === key ? 'filter-chip active' : 'filter-chip'} onClick={() => setProxyFilter(key)}>{label}</button>
              ))}
              <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t4)' }}>{fmt(filteredProxyRows.length)} satır • sayfa {editorPage}/{editorPages}</span>
            </div>
            {editorRows.length === 0 ? <Empty text="Bu filtrede proxy yok" /> : (
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>Proxy</th><th>Bölge</th><th>Kapasite</th><th>Ağırlık</th><th>Health</th><th>Atama</th><th>Aktif</th><th /></tr></thead>
                  <tbody>
                    {editorRows.map(({ proxy, index, live }) => {
                      const color = HEALTH_COLORS[live?.health.status ?? (proxy.enabled ? 'unknown' : 'disabled')];
                      return (
                        <tr key={proxy.id ?? index}>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 260 }}>
                              <input className="input input-sm" placeholder="Label" value={proxy.label ?? ''} onChange={e => patchProxyRow(index, { label: e.target.value })} />
                              <input className="input input-sm mono" placeholder="socks5://host:1080" value={proxy.url} onChange={e => patchProxyRow(index, { url: e.target.value })} />
                              <div style={{ fontSize: 10, color: 'var(--t4)' }}>{live?.maskedUrl ?? 'Henüz kaydedilmedi'}</div>
                            </div>
                          </td>
                          <td><input className="input input-sm" placeholder="UK" value={proxy.region ?? ''} onChange={e => patchProxyRow(index, { region: e.target.value })} /></td>
                          <td><input className="input input-sm" type="number" value={proxy.maxConns} onChange={e => patchProxyRow(index, { maxConns: Number(e.target.value) || 0 })} /><div style={{ fontSize: 10, color: 'var(--t4)', marginTop: 4 }}>{live ? `${fmt(live.assignmentCount)}/${fmt(proxy.maxConns)}` : '—'}</div></td>
                          <td><input className="input input-sm" type="number" value={proxy.weight} onChange={e => patchProxyRow(index, { weight: Number(e.target.value) || 0 })} /></td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <span style={badgeStyle(color)}>{HEALTH_LABELS[live?.health.status ?? (proxy.enabled ? 'unknown' : 'disabled')]}</span>
                              <span style={{ fontSize: 10, color: 'var(--t4)' }}>{formatLatency(live?.health.latencyMs ?? null)}</span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <span>{fmt(live?.assignmentCount ?? 0)} hesap</span>
                              {live?.overCapacity ? <span style={{ fontSize: 10, color: 'var(--red)' }}>Kapasite baskısı</span> : <span style={{ fontSize: 10, color: 'var(--t4)' }}>{fmtTs(live?.health.lastCheckedAt ?? null)}</span>}
                            </div>
                          </td>
                          <td><label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><input type="checkbox" checked={proxy.enabled} onChange={e => patchProxyRow(index, { enabled: e.target.checked })} /><span>{proxy.enabled ? 'Açık' : 'Kapalı'}</span></label></td>
                          <td><button className="btn btn-secondary btn-xs" onClick={() => removeProxyRow(index)}>Sil</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ fontSize: 12, color: 'var(--t4)' }}>Her sayfada {EDITOR_PAGE_SIZE} proxy düzenlenir. 1000+ kayıt için performans burada korunur.</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-secondary btn-xs" disabled={editorPage <= 1} onClick={() => setEditorPage(page => Math.max(1, page - 1))}>Önceki</button>
                <button className="btn btn-secondary btn-xs" disabled={editorPage >= editorPages} onClick={() => setEditorPage(page => Math.min(editorPages, page + 1))}>Sonraki</button>
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, position: 'sticky', top: 0 }}>
          <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 16, fontWeight: 800 }}>Bu terimler ne demek?</div>
            <div style={softPanelStyle()}><b>Capacity</b><div style={{ fontSize: 12, color: 'var(--t4)', marginTop: 4 }}>Bir proxy’ye aynı anda kaç hesap bağlamak istediğin.</div></div>
            <div style={softPanelStyle()}><b>Weight</b><div style={{ fontSize: 12, color: 'var(--t4)', marginTop: 4 }}>Bazı proxy’lere daha fazla hesap vermek istersen artırırsın.</div></div>
            <div style={softPanelStyle()}><b>Assigned</b><div style={{ fontSize: 12, color: 'var(--t4)', marginTop: 4 }}>Sistemin bu proxy’ye planladığı hesap sayısı.</div></div>
            <div style={softPanelStyle()}><b>Connected</b><div style={{ fontSize: 12, color: 'var(--t4)', marginTop: 4 }}>Şu an gerçekten o proxy üzerinden bağlı duran hesap sayısı.</div></div>
          </div>
          <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 16, fontWeight: 800 }}>Uyarılar</div>
            {overview.diagnostics.warnings.length === 0 ? <Empty text="Aktif uyarı yok" /> : overview.diagnostics.warnings.map((warning, index) => (
              <div key={index} style={{ padding: '10px 12px', borderRadius: 12, background: 'rgba(255,69,58,0.08)', border: '1px solid rgba(255,69,58,0.16)', fontSize: 12 }}>{warning}</div>
            ))}
            {overviewError ? <div style={{ padding: '10px 12px', borderRadius: 12, background: 'rgba(255,69,58,0.08)', border: '1px solid rgba(255,69,58,0.16)', fontSize: 12 }}>{overviewError}</div> : null}
          </div>
        </div>
      </div>

      <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>Hesap → Proxy Eşleşme Gezgini</div>
            <div style={{ fontSize: 12, color: 'var(--t3)' }}>1000 hesapta en çok burada çalışırsın: arama yap, sorunlu hesapları filtrele, direct kalanları bul.</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="input input-sm" placeholder="Hesap ara…" value={searchRaw} onChange={e => setSearchRaw(e.target.value)} style={{ minWidth: 220 }} />
            <button className="btn btn-secondary btn-sm" onClick={() => void loadAccounts()} disabled={accountsLoading}>{accountsLoading ? 'Yükleniyor…' : 'Liste yenile'}</button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {([
            ['all', 'Tüm hesaplar'],
            ['proxied', 'Proxy kullanan'],
            ['direct', 'Direct kalan'],
            ['issues', 'Sorunlu'],
            ['paused', 'Duraklatılan'],
          ] as Array<[AccountView, string]>).map(([key, label]) => (
            <button key={key} className={accountView === key ? 'filter-chip active' : 'filter-chip'} onClick={() => setAccountView(key)}>{label}</button>
          ))}
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t4)' }}>{fmt(filteredAccounts.length)} hesap gösteriliyor</span>
        </div>
        {accountsError ? <div style={{ color: 'var(--red)', fontSize: 12 }}>{accountsError}</div> : null}
        {accountsLoading && !accountsData ? <div className="empty" style={{ height: 220 }}><Spinner /></div> : null}
        {!accountsLoading && filteredAccounts.length === 0 ? <Empty text="Bu filtrede hesap yok" /> : null}
        {filteredAccounts.length > 0 ? (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Hesap</th><th>Durum</th><th>Guild / Target</th><th>Proxy</th><th>Proxy Health</th><th>Runtime</th><th>Detay</th></tr></thead>
              <tbody>
                {filteredAccounts.map(({ account, assignment }) => {
                  const healthColor = HEALTH_COLORS[assignment?.proxyHealthStatus ?? 'unknown'];
                  return (
                    <tr key={`${account.accountId}-${account.idx}`}>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span style={{ fontWeight: 800, color: 'var(--t1)' }}>{account.username}</span>
                          <span style={{ fontSize: 10, color: 'var(--t4)', fontFamily: 'var(--mono)' }}>idx {account.idx} • {account.accountId}</span>
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <span style={badgeStyle(accountStatusColor(account.status))}>{account.status === 'active' ? 'Aktif' : 'Hatalı'}</span>
                          {account.paused ? <span style={badgeStyle('var(--orange)')}>Duraklatıldı</span> : null}
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span>{fmt(account.guildCount)} guild</span>
                          <span style={{ fontSize: 11, color: 'var(--t4)' }}>{fmt(account.targetCount)} target</span>
                        </div>
                      </td>
                      <td>
                        {assignment?.proxyMaskedUrl ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <span style={{ fontWeight: 700 }}>{assignment.proxyLabel ?? assignment.proxyMaskedUrl}</span>
                            <span style={{ fontSize: 10, color: 'var(--t4)', fontFamily: 'var(--mono)' }}>{assignment.proxyMaskedUrl}</span>
                          </div>
                        ) : <span style={{ color: 'var(--t4)' }}>Direct / atama yok</span>}
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <span style={badgeStyle(healthColor)}>{HEALTH_LABELS[assignment?.proxyHealthStatus ?? 'unknown']}</span>
                          <span style={{ fontSize: 10, color: 'var(--t4)' }}>{formatLatency(assignment?.proxyLatencyMs ?? null)}</span>
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <span style={badgeStyle(assignment?.connected ? 'var(--green)' : 'var(--t3)')}>{runtimeStatusLabel(assignment, overview.config.enabled)}</span>
                          <span style={{ fontSize: 10, color: 'var(--t4)' }}>{assignmentReasonLabel(assignment?.assignmentReason ?? '')}</span>
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 300 }}>
                          {assignment?.lastError ? <span style={{ fontSize: 11, color: 'var(--red)' }}>{assignment.lastError}</span> : null}
                          {account.failedError ? <span style={{ fontSize: 11, color: 'var(--red)' }}>{account.failedError}</span> : null}
                          <span style={{ fontSize: 10, color: 'var(--t4)' }}>Hesap sağlığı: {account.healthLabel} • RL {fmt(account.totalRateLimitHits)}</span>
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
          <div style={{ fontSize: 12, color: 'var(--t4)' }}>{accountsData ? `${fmt(accountsData.total)} hesap • sayfa ${accountsData.page}/${accountsData.pages}` : '—'}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-xs" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Önceki</button>
            <button className="btn btn-secondary btn-xs" disabled={page >= (accountsData?.pages ?? 1)} onClick={() => setPage(p => Math.min(accountsData?.pages ?? 1, p + 1))}>Sonraki</button>
          </div>
        </div>
      </div>
    </div>
  );
}
