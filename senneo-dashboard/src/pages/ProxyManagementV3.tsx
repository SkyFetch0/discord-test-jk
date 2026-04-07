import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Empty, Spinner } from '../components';
import { addToast, fmt, fmtTs, useDebounce, useInterval } from '../hooks';
import { Icon } from '../icons';
import type { AccountsListResponse, ProxyAccountAssignment, ProxyConfigEditorRow, ProxyConfigPayload, ProxyHealthStatus, ProxyOverviewResponse, ProxyPoolEntry, ProxyRotationMode } from '../types';

const ACC_LIMIT = 50;
const PX_LIMIT = 40;

type Tab = 'overview' | 'import' | 'inventory' | 'accounts';
type PxFilter = 'all' | 'healthy' | 'issues' | 'unassigned' | 'disabled';
type AccFilter = 'all' | 'proxied' | 'direct' | 'issues';

const HC: Record<ProxyHealthStatus, string> = { healthy: 'var(--green)', degraded: 'var(--orange)', down: 'var(--red)', cooldown: 'var(--purple)', disabled: 'var(--t3)', unknown: 'var(--t4)', removed: 'var(--pink)' };
const HL: Record<ProxyHealthStatus, string> = { healthy: 'Sağlıklı', degraded: 'Yavaş', down: 'Hatalı', cooldown: 'Dinleniyor', disabled: 'Kapalı', unknown: 'Ölçülmedi', removed: 'Silindi' };

const ROT: Array<{ v: ProxyRotationMode; l: string; d: string }> = [
  { v: 'weighted', l: 'Ağırlıklı', d: 'Güçlü proxy daha fazla hesap alır.' },
  { v: 'least-connections', l: 'En boş proxy', d: 'En az doluluk tercih edilir.' },
  { v: 'round-robin', l: 'Sırayla', d: 'Hesaplar sırayla dağılır.' },
];

/* style */
const pill = (c: string): React.CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700, color: c, whiteSpace: 'nowrap', background: `color-mix(in srgb, ${c} 14%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 28%, transparent)` });
const box: React.CSSProperties = { padding: 12, borderRadius: 12, border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' };

/* helpers */
function toForm(c: ProxyOverviewResponse['config']): ProxyConfigPayload {
  return { enabled: c.enabled, strictMode: c.strictMode, rotationMode: c.rotationMode, healthCheckMs: c.healthCheckMs, failThreshold: c.failThreshold, cooldownMs: c.cooldownMs, proxies: c.proxies.map(p => ({ id: p.id, label: p.label, url: p.url, region: p.region, maxConns: p.maxConns, weight: p.weight, enabled: p.enabled })) };
}
function latStr(ms: number | null) { return ms == null ? '—' : `${ms}ms`; }
function rtLabel(a: ProxyAccountAssignment | undefined, on: boolean) {
  if (!a) return on ? 'Bekliyor' : 'Direct';
  if (!on) return a.connected ? 'Direct' : 'Plan';
  if (a.direct && a.connected) return 'Direct FB';
  if (a.direct) return 'Direct';
  if (a.connected) return 'Bağlı';
  return 'Plan';
}
function reasonLbl(r: string) {
  if (r === 'assigned') return 'Atandı';
  if (r === 'over_capacity') return 'Kapasite';
  if (r === 'pool_disabled') return 'Proxy kapalı';
  if (r === 'no_enabled_proxy') return 'Proxy yok';
  return r || '—';
}

function parseLines(text: string, proto: string): ProxyConfigEditorRow[] {
  const out: ProxyConfigEditorRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [first, region] = line.split(',').map(s => s.trim());
    const url = first.includes('://') ? first : `${proto}://${first}`;
    out.push({ id: `imp-${Date.now()}-${out.length}`, label: `P-${String(out.length + 1).padStart(4, '0')}`, url, region: region || '', maxConns: 2, weight: 1, enabled: true });
  }
  return out;
}

/* sub-components */
function Stat({ label, value, sub, color, icon }: { label: string; value: string | number; sub: string; color: string; icon: string }) {
  return (
    <div className="stat-card" style={{ '--accent-color': color } as React.CSSProperties}>
      <div className="stat-card-icon"><Icon name={icon as never} size={20} /></div>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color }}>{value}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}

/* ═══════════════ MAIN ═══════════════ */
export function ProxyManagement() {
  const [ov, setOv] = useState<ProxyOverviewResponse | null>(null);
  const [ovLoad, setOvLoad] = useState(true);
  const [ovErr, setOvErr] = useState<string | null>(null);
  const [accData, setAccData] = useState<AccountsListResponse | null>(null);
  const [accLoad, setAccLoad] = useState(true);
  const [accErr, setAccErr] = useState<string | null>(null);
  const [accPage, setAccPage] = useState(1);
  const [accQRaw, setAccQRaw] = useState('');
  const accQ = useDebounce(accQRaw, 300);
  const [form, setForm] = useState<ProxyConfigPayload | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [pxQ, setPxQ] = useState('');
  const pxNeedle = useDebounce(pxQ, 200);
  const [pxFilter, setPxFilter] = useState<PxFilter>('all');
  const [pxPage, setPxPage] = useState(1);
  const [accFilter, setAccFilter] = useState<AccFilter>('all');
  const [impText, setImpText] = useState('');
  const [impProto, setImpProto] = useState('socks5');
  const [impMode, setImpMode] = useState<'append' | 'replace'>('append');
  const impRef = useRef<HTMLTextAreaElement>(null);

  /* data */
  const loadOv = useCallback(async (force = false) => {
    if (force) setRefreshing(true); else setOvLoad(true);
    setOvErr(null);
    try { setOv(await api.proxies.overview(force)); } catch (e) { setOvErr(e instanceof Error ? e.message : 'Hata'); } finally { setOvLoad(false); setRefreshing(false); }
  }, []);
  const loadAcc = useCallback(async () => {
    setAccLoad(true); setAccErr(null);
    try { setAccData(await api.accounts.accountsList(accPage, ACC_LIMIT, accQ || undefined)); } catch (e) { setAccErr(e instanceof Error ? e.message : 'Hata'); } finally { setAccLoad(false); }
  }, [accPage, accQ]);

  useEffect(() => { void loadOv(); }, [loadOv]);
  useEffect(() => { void loadAcc(); }, [loadAcc]);
  useInterval(() => { void loadOv(); void loadAcc(); }, 30_000, false);
  useEffect(() => { if (ov && (!dirty || !form)) setForm(toForm(ov.config)); }, [ov, dirty, form]);
  useEffect(() => { setAccPage(1); }, [accQ]);
  useEffect(() => { setPxPage(1); }, [pxNeedle, pxFilter, form?.proxies.length]);

  /* derived */
  const pxById = useMemo(() => new Map((ov?.proxies ?? []).map(p => [p.proxyId, p])), [ov]);
  const aById = useMemo(() => new Map((ov?.assignments ?? []).filter(a => !!a.accountId).map(a => [a.accountId!, a])), [ov]);
  const aByIdx = useMemo(() => new Map((ov?.assignments ?? []).filter(a => a.accountIdx != null).map(a => [a.accountIdx!, a])), [ov]);

  const merged = useMemo(() => (accData?.accounts ?? []).map(ac => ({ ac, asgn: (ac.accountId ? aById.get(ac.accountId) : undefined) ?? aByIdx.get(ac.idx) })), [accData, aById, aByIdx]);
  const fAcc = useMemo(() => merged.filter(({ ac, asgn }) => {
    if (accFilter === 'proxied') return !!asgn && !asgn.direct;
    if (accFilter === 'direct') return !asgn || asgn.direct;
    if (accFilter === 'issues') return !!asgn?.lastError || !!ac.failedError || ac.status === 'failed';
    return true;
  }), [merged, accFilter]);

  const fPx = useMemo(() => {
    if (!form) return [] as Array<{ px: ProxyConfigEditorRow; idx: number; live: ProxyPoolEntry | null }>;
    const n = pxNeedle.trim().toLowerCase();
    return form.proxies.map((px, idx) => ({ px, idx, live: px.id ? pxById.get(px.id) ?? null : null })).filter(({ px, live }) => {
      const h = live?.health.status ?? (px.enabled ? 'unknown' : 'disabled');
      if (pxFilter === 'healthy' && !['healthy', 'degraded'].includes(h)) return false;
      if (pxFilter === 'issues' && !['down', 'cooldown'].includes(h) && !live?.overCapacity) return false;
      if (pxFilter === 'unassigned' && (live?.assignmentCount ?? 0) > 0) return false;
      if (pxFilter === 'disabled' && px.enabled) return false;
      if (!n) return true;
      return [px.label, px.url, px.region, live?.host, live?.maskedUrl].filter(Boolean).join(' ').toLowerCase().includes(n);
    });
  }, [form, pxById, pxNeedle, pxFilter]);

  const pxPages = Math.max(1, Math.ceil(fPx.length / PX_LIMIT));
  const pxRows = fPx.slice((pxPage - 1) * PX_LIMIT, pxPage * PX_LIMIT);

  /* actions */
  async function doSave(payload?: ProxyConfigPayload) {
    const d = payload ?? form;
    if (!d) return;
    setSaving(true);
    try {
      await api.proxies.saveConfig(d);
      setDirty(false);
      addToast({ type: 'success', title: 'Kaydedildi', msg: `${d.proxies.length} proxy sisteme yazıldı.` });
      await loadOv(true);
    } catch (e) { addToast({ type: 'error', title: 'Kayıt hatası', msg: e instanceof Error ? e.message : 'Hata' }); } finally { setSaving(false); }
  }

  function pf<K extends keyof ProxyConfigPayload>(k: K, v: ProxyConfigPayload[K]) { setForm(p => p ? { ...p, [k]: v } : p); setDirty(true); }
  function pRow(i: number, p: Partial<ProxyConfigEditorRow>) { setForm(prev => prev ? { ...prev, proxies: prev.proxies.map((r, ri) => ri === i ? { ...r, ...p } : r) } : prev); setDirty(true); }
  function delRow(i: number) { setForm(prev => prev ? { ...prev, proxies: prev.proxies.filter((_, ri) => ri !== i) } : prev); setDirty(true); }
  function addRow() { setForm(prev => prev ? { ...prev, proxies: [...prev.proxies, { id: `loc-${Math.random().toString(36).slice(2, 10)}`, label: '', url: 'socks5://host:1080', region: '', maxConns: 2, weight: 1, enabled: true }] } : prev); setDirty(true); }

  async function handleImport() {
    if (!form || !impText.trim()) { addToast({ type: 'error', title: 'Boş alan', msg: 'En az 1 proxy satırı yapıştır.' }); return; }
    const rows = parseLines(impText, impProto);
    if (!rows.length) { addToast({ type: 'error', title: 'Parse hatası', msg: 'Hiçbir satır geçerli değil.' }); return; }
    let next: ProxyConfigPayload;
    if (impMode === 'replace') {
      next = { ...form, proxies: rows };
    } else {
      const seen = new Set(form.proxies.map(p => p.url.trim()));
      const uniq = rows.filter(r => !seen.has(r.url.trim()));
      const dup = rows.length - uniq.length;
      if (dup > 0) addToast({ type: 'info', title: `${dup} tekrar atlandı` });
      next = { ...form, proxies: [...form.proxies, ...uniq] };
    }
    setForm(next);
    setImpText('');
    addToast({ type: 'info', title: `${rows.length} proxy eklendi`, msg: 'Otomatik kaydediliyor...' });
    setDirty(false);
    await doSave(next);
  }

  /* loading */
  if (ovLoad && !ov) return <div className="empty" style={{ height: 320 }}><Spinner /></div>;
  if (!ov || !form) return <div className="empty" style={{ height: 320 }}>{ovErr ?? 'Proxy sayfası yüklenemedi'}</div>;

  const sm = ov.summary;
  const risky = sm.unhealthyProxies + sm.overCapacityProxies;
  const proxied = Math.max(sm.connectedAccounts - sm.directAccounts, 0);
  const rot = ROT.find(r => r.v === form.rotationMode);
  const tabCounts: Record<Tab, number | string> = { overview: '—', import: '—', inventory: fmt(form.proxies.length), accounts: fmt(sm.totalAccounts) };

  return (
    <div className="page-enter" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* HEADER */}
      <div className="panel" style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: -.5 }}>Proxy Yönetimi</div>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 3 }}>
            {fmt(sm.totalProxies)} proxy &middot; {fmt(sm.totalAccounts)} hesap &middot; {fmt(proxied)} aktif bağlantı
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {dirty && <span style={pill('var(--orange)')}>Kaydedilmemiş</span>}
          <button className="btn btn-secondary btn-sm" onClick={() => void loadOv(true)} disabled={refreshing || saving}>{refreshing ? 'Yenileniyor…' : 'Yenile'}</button>
          <button className="btn btn-primary btn-sm" onClick={() => void doSave()} disabled={saving || !dirty}>{saving ? 'Kaydediliyor…' : 'Kaydet'}</button>
        </div>
      </div>

      {/* METRICS */}
      <div className="stat-grid stat-grid-6">
        <Stat label="Toplam Proxy" value={fmt(sm.totalProxies)} sub="Havuzdaki kayıtlar" color="var(--blurple)" icon="globe" />
        <Stat label="Sağlıklı" value={fmt(sm.healthyProxies)} sub="Yanıt veren" color="var(--green)" icon="shield" />
        <Stat label="Sorunlu" value={fmt(risky)} sub="Hatalı veya aşırı yük" color="var(--red)" icon="alert-triangle" />
        <Stat label="Proxy Bağlı" value={fmt(proxied)} sub="Proxy üzerinden çalışan" color="var(--brand)" icon="users-lucide" />
        <Stat label="Direct" value={fmt(sm.directAccounts)} sub="Proxy dışında kalan" color="var(--orange)" icon="activity" />
        <Stat label="Boşta" value={fmt(sm.unassignedProxies)} sub="Hesap almamış" color="var(--teal)" icon="database" />
      </div>

      {/* TABS */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {([['overview', 'Genel Bakış', 'activity'], ['import', 'Toplu Ekle', 'upload'], ['inventory', 'Envanter', 'globe'], ['accounts', 'Hesap Eşleşmesi', 'users-lucide']] as Array<[Tab, string, string]>).map(([k, l, ic]) => (
          <button key={k} className={tab === k ? 'filter-chip active' : 'filter-chip'} onClick={() => setTab(k)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px' }}>
            <Icon name={ic as never} size={14} />{l}{k === 'inventory' || k === 'accounts' ? <span style={{ opacity: .5, fontSize: 11 }}>({tabCounts[k]})</span> : null}
          </button>
        ))}
      </div>

      {/* ══════ TAB: OVERVIEW ══════ */}
      {tab === 'overview' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) minmax(300px,.9fr)', gap: 14, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* settings */}
            <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                <div style={{ fontSize: 17, fontWeight: 800 }}>Ayarlar</div>
                <span style={pill('var(--brand)')}>{rot?.l ?? form.rotationMode}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 10 }}>
                <div style={box}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Proxy Sistemi</div>
                  <div style={{ fontSize: 11, color: 'var(--t4)', marginBottom: 8 }}>Açıkken hesaplar proxy havuzunu kullanır.</div>
                  <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={form.enabled} onChange={e => pf('enabled', e.target.checked)} /><span style={{ fontSize: 12 }}>{form.enabled ? 'Açık' : 'Kapalı'}</span></label>
                </div>
                <div style={box}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Strict Mode</div>
                  <div style={{ fontSize: 11, color: 'var(--t4)', marginBottom: 8 }}>Açıkken proxy yoksa hesap çalışmaz.</div>
                  <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={form.strictMode} onChange={e => pf('strictMode', e.target.checked)} /><span style={{ fontSize: 12 }}>{form.strictMode ? 'Açık' : 'Kapalı'}</span></label>
                </div>
                <div style={box}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Dağıtım</div>
                  <div style={{ fontSize: 11, color: 'var(--t4)', marginBottom: 8 }}>{rot?.d ?? ''}</div>
                  <select className="input input-sm" value={form.rotationMode} onChange={e => pf('rotationMode', e.target.value as ProxyRotationMode)}>{ROT.map(r => <option key={r.v} value={r.v}>{r.l}</option>)}</select>
                </div>
                <div style={box}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Health Check (ms)</div>
                  <div style={{ fontSize: 11, color: 'var(--t4)', marginBottom: 8 }}>Proxy ne sıklıkla test edilsin.</div>
                  <input className="input input-sm" type="number" value={form.healthCheckMs} onChange={e => pf('healthCheckMs', Number(e.target.value) || 0)} />
                </div>
                <div style={box}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Fail Threshold</div>
                  <div style={{ fontSize: 11, color: 'var(--t4)', marginBottom: 8 }}>Arka arkaya kaç hata → dinlendir.</div>
                  <input className="input input-sm" type="number" value={form.failThreshold} onChange={e => pf('failThreshold', Number(e.target.value) || 0)} />
                </div>
                <div style={box}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Cooldown (ms)</div>
                  <div style={{ fontSize: 11, color: 'var(--t4)', marginBottom: 8 }}>Kötü proxy ne kadar beklesin.</div>
                  <input className="input input-sm" type="number" value={form.cooldownMs} onChange={e => pf('cooldownMs', Number(e.target.value) || 0)} />
                </div>
              </div>
            </div>

            {/* info cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
              {([
                ['shield', 'var(--green)', 'Sağlıklı Proxy', 'Son kontrolde yanıt veren proxy. İlk bu sayıya bak.'],
                ['activity', 'var(--orange)', 'Direct Fallback', 'Hesap proxy yerine kendi IP\'siyle çalışıyor. Düşük olmalı.'],
                ['info', 'var(--blurple)', 'Strict Mode', 'Açıkken proxy yoksa hesap çalışmaz. Stabil olunca aç.'],
              ] as Array<[string, string, string, string]>).map(([ic, ac, t, b]) => (
                <div key={t} className="panel" style={{ padding: 14, background: `linear-gradient(180deg, color-mix(in srgb, ${ac} 8%, rgba(255,255,255,0.02)), rgba(255,255,255,0.02))`, borderColor: `color-mix(in srgb, ${ac} 20%, rgba(255,255,255,0.08))` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <div style={{ width: 30, height: 30, borderRadius: 10, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${ac} 16%, transparent)`, color: ac }}><Icon name={ic as never} size={14} /></div>
                    <span style={{ fontSize: 12, fontWeight: 800 }}>{t}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', lineHeight: 1.5 }}>{b}</div>
                </div>
              ))}
            </div>
          </div>

          {/* sidebar */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, position: 'sticky', top: 0 }}>
            <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 15, fontWeight: 800 }}>Runtime Durumu</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div style={box}><div style={{ fontSize: 10, color: 'var(--t4)' }}>Config hash</div><div className="mono" style={{ fontSize: 11, fontWeight: 700 }}>{ov.config.configHash}</div></div>
                <div style={box}><div style={{ fontSize: 10, color: 'var(--t4)' }}>Runtime hash</div><div className="mono" style={{ fontSize: 11, fontWeight: 700 }}>{ov.runtime.configHash ?? '—'}</div></div>
                <div style={box}><div style={{ fontSize: 10, color: 'var(--t4)' }}>Son snapshot</div><div style={{ fontSize: 11, fontWeight: 700 }}>{fmtTs(ov.runtime.updatedAt)}</div></div>
                <div style={box}><div style={{ fontSize: 10, color: 'var(--t4)' }}>Senkron</div><div style={{ fontSize: 11, fontWeight: 700, color: ov.runtime.restartRequired ? 'var(--red)' : 'var(--green)' }}>{ov.runtime.restartRequired ? 'Restart gerekli' : 'Uyumlu'}</div></div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span style={pill(form.enabled ? 'var(--green)' : 'var(--t3)')}>{form.enabled ? 'Proxy açık' : 'Proxy kapalı'}</span>
                <span style={pill(form.strictMode ? 'var(--purple)' : 'var(--t3)')}>{form.strictMode ? 'Strict' : 'Esnek'}</span>
                {ov.runtime.restartRequired && <span style={pill('var(--red)')}>Restart gerekli</span>}
              </div>
            </div>
            <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 15, fontWeight: 800 }}>Uyarılar</div>
              {ov.diagnostics.warnings.length === 0 ? <Empty text="Uyarı yok" /> : ov.diagnostics.warnings.map((w, i) => (
                <div key={i} style={{ padding: '8px 12px', borderRadius: 10, background: 'rgba(255,69,58,0.08)', border: '1px solid rgba(255,69,58,0.15)', fontSize: 12, lineHeight: 1.5 }}>{w}</div>
              ))}
            </div>
            <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 15, fontWeight: 800 }}>Terimler</div>
              {([['Capacity', 'Bir proxy kaç hesap taşıyabilir.'], ['Weight', 'Yüksek ağırlık = daha çok hesap.'], ['Assigned', 'Sisteme planlanmış hesap sayısı.'], ['Connected', 'Gerçekte bağlı olan hesap sayısı.']] as Array<[string, string]>).map(([t, d]) => (
                <div key={t} style={box}><b style={{ fontSize: 12 }}>{t}</b><div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 2 }}>{d}</div></div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ══════ TAB: IMPORT ══════ */}
      {tab === 'import' && (
        <div className="panel" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 900 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>Toplu Proxy İçeri Aktar</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4 }}>Her satıra bir proxy yaz. Format: <code style={{ background: 'rgba(255,255,255,0.06)', padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>IP:PORT</code> veya <code style={{ background: 'rgba(255,255,255,0.06)', padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>socks5://IP:PORT</code>. Virgülden sonra bölge eklenebilir.</div>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select className="input input-sm" style={{ width: 130 }} value={impProto} onChange={e => setImpProto(e.target.value)}>
              <option value="socks5">SOCKS5</option>
              <option value="http">HTTP</option>
            </select>
            <select className="input input-sm" style={{ width: 200 }} value={impMode} onChange={e => setImpMode(e.target.value as 'append' | 'replace')}>
              <option value="append">Mevcut listeye ekle</option>
              <option value="replace">Tüm listeyi değiştir</option>
            </select>
            <span style={{ fontSize: 12, color: 'var(--t4)' }}>Mevcut: {fmt(form.proxies.length)} proxy</span>
          </div>

          <textarea
            ref={impRef}
            className="input mono"
            rows={16}
            placeholder={'Her satıra bir proxy yaz:\n65.111.22.8:1081\n65.111.13.250:1081\n216.26.230.61:1081\n\nBölge eklemek için:\n65.111.22.8:1081,US'}
            value={impText}
            onChange={e => setImpText(e.target.value)}
            style={{ fontSize: 12, lineHeight: 1.6 }}
          />

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 12, color: 'var(--t4)' }}>
              {impText.trim() ? `${impText.trim().split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#')).length} satır algılandı` : 'Yapıştırmayı bekliyor'}
            </div>
            <button className="btn btn-primary" onClick={() => void handleImport()} disabled={saving || !impText.trim()} style={{ padding: '10px 28px' }}>
              {saving ? 'Kaydediliyor…' : 'İçeri Al ve Kaydet'}
            </button>
          </div>
        </div>
      )}

      {/* ══════ TAB: INVENTORY ══════ */}
      {tab === 'inventory' && (
        <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 17, fontWeight: 800 }}>Proxy Envanteri</div>
              <div style={{ fontSize: 12, color: 'var(--t3)' }}>{fmt(form.proxies.length)} kayıt &middot; sayfa {pxPage}/{pxPages}</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={addRow}>+ Satır ekle</button>
              <button className="btn btn-primary btn-sm" onClick={() => void doSave()} disabled={saving || !dirty}>{saving ? 'Kaydediliyor…' : 'Kaydet'}</button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="input input-sm" style={{ minWidth: 220 }} placeholder="Ara: label, url, bölge…" value={pxQ} onChange={e => setPxQ(e.target.value)} />
            {(['all', 'healthy', 'issues', 'unassigned', 'disabled'] as PxFilter[]).map(k => (
              <button key={k} className={pxFilter === k ? 'filter-chip active' : 'filter-chip'} onClick={() => setPxFilter(k)}>
                {{ all: 'Tümü', healthy: 'Sağlıklı', issues: 'Sorunlu', unassigned: 'Boşta', disabled: 'Kapalı' }[k]}
              </button>
            ))}
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t4)' }}>{fmt(fPx.length)} sonuç</span>
          </div>

          {pxRows.length === 0 ? <Empty text="Bu filtrede proxy yok" /> : (
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>URL</th><th>Label</th><th>Bölge</th><th>Kap.</th><th>Ağırl.</th><th>Health</th><th>Atama</th><th>Aktif</th><th></th></tr></thead>
                <tbody>
                  {pxRows.map(({ px, idx, live }) => {
                    const hk = live?.health.status ?? (px.enabled ? 'unknown' : 'disabled');
                    return (
                      <tr key={px.id ?? idx}>
                        <td><input className="input input-sm mono" style={{ minWidth: 220 }} value={px.url} onChange={e => pRow(idx, { url: e.target.value })} /></td>
                        <td><input className="input input-sm" style={{ width: 120 }} placeholder="Oto" value={px.label ?? ''} onChange={e => pRow(idx, { label: e.target.value })} /></td>
                        <td><input className="input input-sm" style={{ width: 60 }} value={px.region ?? ''} onChange={e => pRow(idx, { region: e.target.value })} /></td>
                        <td><input className="input input-sm" type="number" style={{ width: 60 }} value={px.maxConns} onChange={e => pRow(idx, { maxConns: Number(e.target.value) || 1 })} /></td>
                        <td><input className="input input-sm" type="number" style={{ width: 60 }} value={px.weight} onChange={e => pRow(idx, { weight: Number(e.target.value) || 1 })} /></td>
                        <td><span style={pill(HC[hk])}>{HL[hk]}</span><div style={{ fontSize: 10, color: 'var(--t4)', marginTop: 3 }}>{latStr(live?.health.latencyMs ?? null)}</div></td>
                        <td style={{ textAlign: 'center' }}>{live ? `${live.assignmentCount}/${px.maxConns}` : '—'}</td>
                        <td><label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={px.enabled} onChange={e => pRow(idx, { enabled: e.target.checked })} /><span style={{ fontSize: 11 }}>{px.enabled ? 'Açık' : 'Kapalı'}</span></label></td>
                        <td><button className="btn btn-secondary btn-xs" style={{ color: 'var(--red)' }} onClick={() => delRow(idx)}>Sil</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--t4)' }}>Sayfa başına {PX_LIMIT} satır</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-secondary btn-xs" disabled={pxPage <= 1} onClick={() => setPxPage(p => p - 1)}>Önceki</button>
              <button className="btn btn-secondary btn-xs" disabled={pxPage >= pxPages} onClick={() => setPxPage(p => p + 1)}>Sonraki</button>
            </div>
          </div>
        </div>
      )}

      {/* ══════ TAB: ACCOUNTS ══════ */}
      {tab === 'accounts' && (
        <div className="panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 17, fontWeight: 800 }}>Hesap → Proxy Eşleşmesi</div>
              <div style={{ fontSize: 12, color: 'var(--t3)' }}>{fmt(fAcc.length)} hesap gösteriliyor</div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input className="input input-sm" style={{ minWidth: 200 }} placeholder="Hesap ara…" value={accQRaw} onChange={e => setAccQRaw(e.target.value)} />
              <button className="btn btn-secondary btn-sm" onClick={() => void loadAcc()} disabled={accLoad}>{accLoad ? 'Yükleniyor…' : 'Yenile'}</button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(['all', 'proxied', 'direct', 'issues'] as AccFilter[]).map(k => (
              <button key={k} className={accFilter === k ? 'filter-chip active' : 'filter-chip'} onClick={() => setAccFilter(k)}>
                {{ all: 'Tümü', proxied: 'Proxy kullanan', direct: 'Direct', issues: 'Sorunlu' }[k]}
              </button>
            ))}
          </div>

          {accErr && <div style={{ color: 'var(--red)', fontSize: 12 }}>{accErr}</div>}
          {accLoad && !accData ? <div className="empty" style={{ height: 200 }}><Spinner /></div> : null}
          {!accLoad && fAcc.length === 0 ? <Empty text="Bu filtrede hesap yok" /> : null}

          {fAcc.length > 0 && (
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Hesap</th><th>Durum</th><th>Proxy</th><th>Health</th><th>Bağlantı</th><th>Detay</th></tr></thead>
                <tbody>
                  {fAcc.map(({ ac, asgn }) => {
                    const hk = asgn?.proxyHealthStatus ?? 'unknown';
                    return (
                      <tr key={`${ac.accountId}-${ac.idx}`}>
                        <td>
                          <div style={{ fontWeight: 700 }}>{ac.username}</div>
                          <div className="mono" style={{ fontSize: 10, color: 'var(--t4)' }}>idx {ac.idx} &middot; {ac.accountId}</div>
                        </td>
                        <td>
                          <span style={pill(ac.status === 'active' ? 'var(--green)' : 'var(--red)')}>{ac.status === 'active' ? 'Aktif' : 'Hatalı'}</span>
                          {ac.paused && <span style={{ ...pill('var(--orange)'), marginLeft: 4 }}>Duraklı</span>}
                        </td>
                        <td>
                          {asgn?.proxyMaskedUrl
                            ? <><div style={{ fontWeight: 600, fontSize: 12 }}>{asgn.proxyLabel ?? '—'}</div><div className="mono" style={{ fontSize: 10, color: 'var(--t4)' }}>{asgn.proxyMaskedUrl}</div></>
                            : <span style={{ color: 'var(--t4)', fontSize: 12 }}>Direct / atanmadı</span>}
                        </td>
                        <td><span style={pill(HC[hk])}>{HL[hk]}</span><div style={{ fontSize: 10, color: 'var(--t4)', marginTop: 2 }}>{latStr(asgn?.proxyLatencyMs ?? null)}</div></td>
                        <td>
                          <span style={pill(asgn?.connected ? 'var(--green)' : 'var(--t3)')}>{rtLabel(asgn, ov.config.enabled)}</span>
                          <div style={{ fontSize: 10, color: 'var(--t4)', marginTop: 2 }}>{reasonLbl(asgn?.assignmentReason ?? '')}</div>
                        </td>
                        <td style={{ maxWidth: 260 }}>
                          {asgn?.lastError && <div style={{ fontSize: 11, color: 'var(--red)' }}>{asgn.lastError}</div>}
                          {ac.failedError && <div style={{ fontSize: 11, color: 'var(--red)' }}>{ac.failedError}</div>}
                          <div style={{ fontSize: 10, color: 'var(--t4)' }}>{ac.healthLabel} &middot; RL {fmt(ac.totalRateLimitHits)}</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--t4)' }}>{accData ? `${fmt(accData.total)} hesap toplam &middot; sayfa ${accData.page}/${accData.pages}` : '—'}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-secondary btn-xs" disabled={accPage <= 1} onClick={() => setAccPage(p => p - 1)}>Önceki</button>
              <button className="btn btn-secondary btn-xs" disabled={accPage >= (accData?.pages ?? 1)} onClick={() => setAccPage(p => p + 1)}>Sonraki</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
