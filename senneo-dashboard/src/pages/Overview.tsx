import React, { useEffect, useState } from 'react';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip } from 'chart.js';
import { Line } from 'react-chartjs-2';
import { useSSE, useInterval, useCountUp, fmt, fmtTs } from '../hooks';
import { api } from '../api';
import { Spinner, Empty, RateLimitLog } from '../components';
import { Icon } from '../icons';
import type { IconName } from '../icons';
import type { HealthAll, DbSummary, RateLimitEntry } from '../types';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip);

const MPS_HISTORY = 60;
const mpsLabels: string[] = Array(MPS_HISTORY).fill('');
const mpsData: number[]   = Array(MPS_HISTORY).fill(0);

/* ── Stat card ── */
function Stat({ label, value, sub, color, icon }: { label: string; value: number; sub: string; color: string; icon?: IconName }) {
  const v = useCountUp(value);
  return (
    <div className="stat-card" style={{ '--accent-color': color } as React.CSSProperties}>
      {icon && <div className="stat-card-icon"><Icon name={icon} size={22} /></div>}
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color }}>{v.toLocaleString('tr-TR')}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}

/* ── Health row ── */
function HealthRow({ name, h }: { name: string; h: { ok: boolean; latencyMs?: number; error?: string } }) {
  const ms = h.latencyMs ?? 0;
  const barW = Math.min((ms / 50) * 100, 100);
  return (
    <div className="health-card">
      <div className={`health-dot ${h.ok ? 'ok' : 'fail'}`} />
      <div style={{ flex: 1 }}>
        <div className="health-card-name">{name}</div>
        {h.ok && (
          <div style={{ height: 3, background: 'var(--g1)', borderRadius: 2, marginTop: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.max(barW, 4)}%`, borderRadius: 2, background: ms < 10 ? 'var(--green)' : ms < 30 ? 'var(--yellow)' : 'var(--orange)', transition: 'width .5s ease' }} />
          </div>
        )}
      </div>
      <div className={`health-card-lat ${h.ok ? 'ok' : 'fail'}`}>
        {h.ok ? `${ms}ms` : (h.error?.slice(0, 16) ?? 'ERR')}
      </div>
    </div>
  );
}

/* ── DB summary cell ── */
function DbCell({ label, value, color }: { label: string; value: number; color: string }) {
  const v = useCountUp(value);
  return (
    <div style={{ textAlign: 'center', padding: '10px 0' }}>
      <div style={{ fontSize: 24, fontWeight: 800, color, fontVariantNumeric: 'tabular-nums', letterSpacing: '-1px' }}>{v.toLocaleString('tr-TR')}</div>
      <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 4, textTransform: 'uppercase', letterSpacing: '.6px' }}>{label}</div>
    </div>
  );
}

/* ═══ OVERVIEW ════════════════════════════════════ */
export function Overview() {
  const { summary } = useSSE();
  const [health, setHealth]       = useState<HealthAll | null>(null);
  const [dbSummary, setDbSummary] = useState<DbSummary | null>(null);
  const [rlLog, setRlLog]         = useState<RateLimitEntry[]>([]);
  const [chart, setChart]         = useState({ labels: [...mpsLabels], data: [...mpsData] });

  useInterval(() => {
    api.health.all().then(d => setHealth(d as HealthAll)).catch(() => {});
    api.live.summary().then(d => setDbSummary(d as DbSummary)).catch(() => {});
    fetch('/live/ratelimits').then(r => r.json()).then(d => setRlLog(d as RateLimitEntry[])).catch(() => {});
  }, 15_000);

  useEffect(() => {
    if (!summary) return;
    mpsLabels.shift(); mpsLabels.push(new Date().toLocaleTimeString('tr-TR'));
    mpsData.shift();   mpsData.push(summary.msgsPerSec ?? 0);
    setChart({ labels: [...mpsLabels], data: [...mpsData] });
  }, [summary]);

  const pc = summary?.phaseCounts ?? {};
  const db = dbSummary?.database;
  const dbAny = db as Record<string, unknown> | undefined;
  const humanAuthors = Number(dbAny?.db_human_authors ?? dbAny?.db_total_authors ?? 0);
  const botMsgs = Number(dbAny?.db_bot_messages ?? 0);

  return (
    <div className="page-enter">
      {/* ── 6 stat cards ── */}
      <div className="stat-grid stat-grid-6" style={{ marginBottom: 14 }}>
        <Stat label="Toplam Scraped" value={Number(summary?.totalScraped ?? 0)} sub="scraper" color="var(--blurple)" icon="message-square" />
        <Stat label="Veritabani"     value={Number(db?.db_total_messages ?? 0)} sub="ClickHouse" color="var(--green)" icon="database" />
        <Stat label="Throughput"     value={Number(summary?.msgsPerSec ?? 0)}   sub="msg/s anlik" color="var(--yellow)" icon="speed" />
        <Stat label="Aktif Kanal"    value={Number(pc.active ?? 0)}             sub={`/ ${summary?.totalChannels ?? 0} toplam`} color="var(--cyan)" icon="channel" />
        <Stat label="Insan"          value={humanAuthors}                       sub="benzersiz" color="var(--purple)" icon="users-custom" />
        <Stat label="Bot Mesaj"      value={botMsgs}                            sub="toplam" color="var(--t3)" icon="bot" />
      </div>

      {/* ── Scraper phase breakdown ── */}
      {summary && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.6px' }}>Scraper</span>
          {([
            ['active','Aktif','var(--orange)'],['idle','Beklemede','var(--cyan)'],['queued','Sirada','var(--yellow)'],['done','Bitti','var(--green)'],['error','Hata','var(--red)']
          ] as const).map(([k,l,c]) => {
            const n = Number(pc[k] ?? 0);
            return n > 0 ? <span key={k} className="chip" style={{ color: c, borderColor: `color-mix(in srgb, ${c} 30%, transparent)`, background: `color-mix(in srgb, ${c} 10%, transparent)` }}>{l}: {n}</span> : null;
          })}
        </div>
      )}

      {/* ── Health ── */}
      <div className="health-card-grid" style={{ marginBottom: 14 }}>
        {health
          ? Object.entries(health).map(([n, h]) => <HealthRow key={n} name={n} h={h} />)
          : [0,1,2,3].map(i => <div key={i} className="health-card"><div className="health-dot unk" /><div style={{ flex: 1 }}><div className="skeleton skeleton-text" style={{ width: '60%' }} /></div></div>)
        }
      </div>

      {/* ── Throughput chart + Rate limit ── */}
      <div className="grid-2-1" style={{ marginBottom: 14 }}>
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Throughput</span>
            <span className="chip chip-blue">{fmt(summary?.msgsPerSec ?? 0)} msg/s</span>
          </div>
          <div className="chart-wrap">
            <Line
              data={{ labels: chart.labels, datasets: [{ label: 'msg/s', data: chart.data, borderColor: '#0EA5E9', backgroundColor: (ctx: any) => { const g = ctx.chart.ctx.createLinearGradient(0,0,0,200); g.addColorStop(0,'rgba(14,165,233,.2)'); g.addColorStop(1,'rgba(14,165,233,0)'); return g; }, fill: true, tension: .45, pointRadius: 0, borderWidth: 2 }] }}
              options={{ responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(6,8,16,.95)', borderColor: 'rgba(14,165,233,.35)', borderWidth: 1, padding: 10, titleFont: { family: 'JetBrains Mono, monospace', size: 10 }, bodyFont: { family: 'JetBrains Mono, monospace', size: 13, weight: 700 }, callbacks: { label: (c: any) => ` ${c.raw} msg/s` } } }, scales: { x: { display: false }, y: { min: 0, grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: 'rgba(255,255,255,.25)', font: { family: 'JetBrains Mono, monospace', size: 10 } } } } }}
            />
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Rate Limit Log</span>
            <span className="chip">{rlLog.length}</span>
          </div>
          <div style={{ maxHeight: 222, overflowY: 'auto' }}>
            <RateLimitLog log={rlLog} />
          </div>
        </div>
      </div>

      {/* ── DB Summary ── */}
      {db && (
        <div className="panel">
          <div className="panel-head"><span className="panel-title">Veritabani Ozeti</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', padding: '14px 20px', gap: 8 }}>
            <DbCell label="Mesaj"     value={Number(db.db_total_messages)} color="var(--blurple)" />
            <DbCell label="Kullanici" value={Number(db.db_total_authors)}  color="var(--purple)" />
            <DbCell label="Kanal"     value={Number(db.db_total_channels)} color="var(--green)" />
            <DbCell label="Guild"     value={Number(db.db_total_guilds)}   color="var(--yellow)" />
          </div>
          <div style={{ display: 'flex', gap: 16, padding: '8px 20px', borderTop: '1px solid var(--b0)', fontSize: 11, color: 'var(--t3)' }}>
            <span>Ilk: <span style={{ color: 'var(--t2)', fontFamily: 'var(--mono)' }}>{fmtTs(db.oldest_ts)}</span></span>
            <span>Son: <span style={{ color: 'var(--t2)', fontFamily: 'var(--mono)' }}>{fmtTs(db.newest_ts)}</span></span>
            <span style={{ marginLeft: 'auto' }}>Son ekleme: <span style={{ color: 'var(--green)', fontFamily: 'var(--mono)' }}>{fmtTs(db.last_insert_ts)}</span></span>
          </div>
        </div>
      )}
    </div>
  );
}
