import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../api';
import { Spinner, Empty } from '../components';
import { Icon } from '../icons';
import type { SystemStatsResponse, ChTableStats, ScyllaTableStats } from '../types';

/* ── helpers ─────────────────────────────────────────────── */
function fmtB(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString('tr-TR');
}

function pct(part: number, total: number): string {
  if (total <= 0) return '0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

const DB_COLORS: Record<string, string> = {
  scylla:     'var(--cyan)',
  clickhouse: 'var(--green)',
  kafka:      'var(--orange)',
  overhead:   'var(--t4)',
};

/* ── Stat mini-card ──────────────────────────────────────── */
function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div style={{
      background: 'var(--g1)', border: '1px solid var(--g2)', borderRadius: 10,
      padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0,
    }}>
      <div style={{ fontSize: 10, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.5px', whiteSpace: 'nowrap' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.5px' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--t5)' }}>{sub}</div>}
    </div>
  );
}

/* ── Horizontal usage bar ────────────────────────────────── */
function UsageBar({ items, total }: { items: { label: string; bytes: number; color: string }[]; total: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', height: 28, borderRadius: 6, overflow: 'hidden', background: 'var(--g2)' }}>
        {items.map((item, i) => {
          const w = total > 0 ? Math.max((item.bytes / total) * 100, 0.5) : 0;
          return (
            <div
              key={i}
              title={`${item.label}: ${fmtB(item.bytes)} (${pct(item.bytes, total)})`}
              style={{
                width: `${w}%`, background: item.color, transition: 'width .6s ease',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 9, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap',
                overflow: 'hidden', textOverflow: 'ellipsis', padding: '0 4px',
              }}
            >
              {w > 8 ? item.label : ''}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {items.map((item, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: item.color, flexShrink: 0 }} />
            <span style={{ color: 'var(--t3)' }}>{item.label}</span>
            <span style={{ color: 'var(--t1)', fontWeight: 700, fontFamily: 'var(--mono)' }}>{fmtB(item.bytes)}</span>
            <span style={{ color: 'var(--t5)', fontSize: 10 }}>{pct(item.bytes, total)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Table detail card ───────────────────────────────────── */
function TableDetail({ title, color, tables, msgCount }: {
  title: string; color: string;
  tables: Array<{ name: string; rows: number; diskBytes: number; bytesPerRow: number; formatted: string; engine?: string }>;
  msgCount: number;
}) {
  const total = tables.reduce((s, t) => s + t.diskBytes, 0);
  return (
    <div style={{
      background: 'var(--g1)', border: '1px solid var(--g2)', borderRadius: 10,
      overflow: 'hidden', flex: 1, minWidth: 320,
    }}>
      <div style={{
        padding: '10px 16px', borderBottom: '1px solid var(--g2)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <div style={{ width: 10, height: 10, borderRadius: 3, background: color }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{title}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>{fmtB(total)}</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--g2)' }}>
              <th style={thStyle}>Tablo</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Satir</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Boyut</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>B/Satir</th>
              {tables.some(t => t.engine) && <th style={{ ...thStyle, textAlign: 'right' }}>Engine</th>}
            </tr>
          </thead>
          <tbody>
            {tables.map(t => (
              <tr key={t.name} style={{ borderBottom: '1px solid var(--g2)' }}>
                <td style={{ ...tdStyle, color: 'var(--t1)', fontWeight: 600, fontFamily: 'var(--mono)', fontSize: 11 }}>{t.name}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtNum(t.rows)}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--mono)', color }}>{t.formatted}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{t.bytesPerRow > 0 ? `${t.bytesPerRow.toFixed(1)} B` : '-'}</td>
                {tables.some(tt => tt.engine) && <td style={{ ...tdStyle, textAlign: 'right', fontSize: 10, color: 'var(--t4)' }}>{t.engine ?? ''}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = { padding: '8px 12px', textAlign: 'left', fontSize: 10, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.4px', fontWeight: 600 };
const tdStyle: React.CSSProperties = { padding: '8px 12px', color: 'var(--t3)' };

/* ── Kafka info card ─────────────────────────────────────── */
function KafkaCard({ topics }: { topics: Array<{ name: string; partitions: number; totalProduced: number; retained: number }> }) {
  return (
    <div style={{
      background: 'var(--g1)', border: '1px solid var(--g2)', borderRadius: 10,
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '10px 16px', borderBottom: '1px solid var(--g2)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <div style={{ width: 10, height: 10, borderRadius: 3, background: DB_COLORS.kafka }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>Redpanda (Kafka)</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--g2)' }}>
              <th style={thStyle}>Topic</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Partition</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Toplam Uretilen</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Retention'da</th>
            </tr>
          </thead>
          <tbody>
            {topics.map(t => (
              <tr key={t.name} style={{ borderBottom: '1px solid var(--g2)' }}>
                <td style={{ ...tdStyle, color: 'var(--t1)', fontWeight: 600, fontFamily: 'var(--mono)', fontSize: 11 }}>{t.name}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{t.partitions}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtNum(t.totalProduced)}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--mono)', color: DB_COLORS.kafka }}>{fmtNum(t.retained)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Inline input ─────────────────────────────────────────── */
const inpStyle: React.CSSProperties = {
  padding: '5px 8px', borderRadius: 5, border: '1px solid var(--g3)',
  background: 'var(--g0)', color: 'var(--t1)', fontSize: 12,
  fontFamily: 'var(--mono)', outline: 'none', width: 90, textAlign: 'right',
};
const lblStyle: React.CSSProperties = {
  fontSize: 9, color: 'var(--t5)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 2,
};

/* ── Cost Simulator (v2) ─────────────────────────────────── */
function CostSimulator({ stats }: { stats: SystemStatsResponse }) {
  // ── Input state ──
  const [targetMsgs, setTargetMsgs] = useState<string>('100000000');
  const [pricingUnit, setPricingUnit] = useState<'gb' | 'tb'>('tb');
  const [pricePerUnit, setPricePerUnit] = useState<string>('');
  const [scyllaCostMul, setScyllaCostMul] = useState<string>('1.0');
  const [chCostMul, setChCostMul] = useState<string>('1.0');
  const [kafkaCostMul, setKafkaCostMul] = useState<string>('1.0');
  const [overheadPct, setOverheadPct] = useState<string>('15');
  const [replicationFactor, setReplicationFactor] = useState<string>('3');
  const [showFormulas, setShowFormulas] = useState(true);

  const target = parseInt(targetMsgs.replace(/\D/g, ''), 10) || 0;
  const currentMsgs = stats.messages.totalCount || 1;
  const ratio = target / currentMsgs;
  const overhead = (parseFloat(overheadPct) || 0) / 100;
  const repl = parseFloat(replicationFactor) || 1;
  const scyllaM = parseFloat(scyllaCostMul) || 1;
  const chM = parseFloat(chCostMul) || 1;
  const kafkaM = parseFloat(kafkaCostMul) || 1;

  // ── Per-table projections ──
  const projected = useMemo(() => {
    // CH tables
    const chTables = stats.clickhouse.tables.map(t => {
      const projBytes = t.diskBytes * ratio;
      return { name: t.name, currentBytes: t.diskBytes, currentRows: t.rows, projBytes, bpr: t.bytesPerRow };
    });
    const chRaw = chTables.reduce((s, t) => s + t.projBytes, 0);
    const chWithOverhead = chRaw * (1 + overhead);

    // Scylla tables
    const scyllaTables = stats.scylla.tables.map(t => {
      const projBytes = t.estimatedBytes * ratio;
      return { name: t.name, currentBytes: t.estimatedBytes, currentRows: t.rowCount, projBytes, bpr: t.bytesPerRow, isMsgTable: t.isMessageTable };
    });
    const scyllaRaw = scyllaTables.reduce((s, t) => s + t.projBytes, 0);
    const scyllaWithRepl = scyllaRaw * repl;
    const scyllaWithOverhead = scyllaWithRepl * (1 + overhead);

    // Kafka (fixed — retention-based)
    const kafkaRaw = stats.kafka?.topics.reduce((s, t) => s + t.retained * 550, 0) ?? 0;

    // Grand totals
    const totalRaw = chWithOverhead + scyllaWithOverhead + kafkaRaw;

    return { chTables, chRaw, chWithOverhead, scyllaTables, scyllaRaw, scyllaWithRepl, scyllaWithOverhead, kafkaRaw, totalRaw };
  }, [target, stats, ratio, overhead, repl]);

  // ── Cost calculations ──
  const unitDivisor = pricingUnit === 'tb' ? 1024 ** 4 : 1024 ** 3;
  const unitLabel = pricingUnit === 'tb' ? 'TB' : 'GB';
  const price = parseFloat(pricePerUnit) || 0;

  const scyllaCost = price > 0 ? (projected.scyllaWithOverhead / unitDivisor) * price * scyllaM : 0;
  const chCost     = price > 0 ? (projected.chWithOverhead / unitDivisor) * price * chM : 0;
  const kafkaCost  = price > 0 ? (projected.kafkaRaw / unitDivisor) * price * kafkaM : 0;
  const totalCost  = scyllaCost + chCost + kafkaCost;

  const presets = [
    { label: '50M', value: 50_000_000 },
    { label: '100M', value: 100_000_000 },
    { label: '250M', value: 250_000_000 },
    { label: '500M', value: 500_000_000 },
    { label: '1B', value: 1_000_000_000 },
    { label: '10B', value: 10_000_000_000 },
  ];

  return (
    <div style={{
      background: 'var(--g1)', border: '1px solid var(--g2)', borderRadius: 10,
      padding: 20, display: 'flex', flexDirection: 'column', gap: 18,
    }}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="speed" size={18} />
          <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)' }}>Maliyet Simulatoru</span>
          <span style={{ fontSize: 10, color: 'var(--t5)', background: 'var(--g2)', padding: '2px 6px', borderRadius: 4 }}>v2</span>
        </div>
        <button
          onClick={() => setShowFormulas(f => !f)}
          style={{
            fontSize: 10, color: 'var(--t4)', background: 'var(--g0)', border: '1px solid var(--g3)',
            borderRadius: 5, padding: '3px 10px', cursor: 'pointer',
          }}
        >
          {showFormulas ? 'Formulleri Gizle' : 'Formulleri Goster'}
        </button>
      </div>

      {/* ── Row 1: Target message count ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={lblStyle}>Hedef Mesaj Sayisi</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="text"
            value={Number(targetMsgs.replace(/\D/g, '')).toLocaleString('tr-TR')}
            onChange={e => setTargetMsgs(e.target.value.replace(/\D/g, ''))}
            style={{ ...inpStyle, flex: 1, minWidth: 160, fontSize: 16, fontWeight: 700, width: 'auto', textAlign: 'left', padding: '8px 12px' }}
          />
          {presets.map(p => (
            <button
              key={p.value}
              onClick={() => setTargetMsgs(String(p.value))}
              style={{
                padding: '5px 10px', borderRadius: 5, fontSize: 10, fontWeight: 700,
                border: target === p.value ? '1px solid var(--blurple)' : '1px solid var(--g3)',
                background: target === p.value ? 'rgba(88,101,242,0.15)' : 'var(--g0)',
                color: target === p.value ? 'var(--blurple)' : 'var(--t3)',
                cursor: 'pointer', transition: 'all .15s',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 10, color: 'var(--t5)' }}>
          Carpan: <span style={{ color: 'var(--yellow)', fontWeight: 700, fontFamily: 'var(--mono)' }}>{ratio.toFixed(1)}x</span> mevcut verinin
          ({fmtNum(currentMsgs)} → {fmtNum(target)})
        </div>
      </div>

      {/* ── Row 2: Pricing & Parameters ── */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
        gap: 12, padding: 14, borderRadius: 8, background: 'var(--g0)', border: '1px solid var(--g2)',
      }}>
        {/* Pricing unit toggle + price */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={lblStyle}>Birim Fiyat</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="text" placeholder="0.00" value={pricePerUnit} onChange={e => setPricePerUnit(e.target.value)} style={{ ...inpStyle, width: 70 }} />
            <div style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid var(--g3)' }}>
              {(['gb', 'tb'] as const).map(u => (
                <button key={u} onClick={() => setPricingUnit(u)} style={{
                  padding: '3px 8px', fontSize: 10, fontWeight: 700, border: 'none', cursor: 'pointer',
                  background: pricingUnit === u ? 'var(--blurple)' : 'var(--g1)',
                  color: pricingUnit === u ? '#fff' : 'var(--t4)',
                }}>
                  $/{u.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div style={{ fontSize: 9, color: 'var(--t5)' }}>/ay</div>
        </div>

        {/* Replication Factor (Scylla) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={lblStyle}>Scylla Replikasyon</div>
          <input type="text" value={replicationFactor} onChange={e => setReplicationFactor(e.target.value)} style={inpStyle} />
          <div style={{ fontSize: 9, color: 'var(--t5)' }}>RF (veri × {repl}x kopyalanir)</div>
        </div>

        {/* Overhead */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={lblStyle}>Overhead %</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="text" value={overheadPct} onChange={e => setOverheadPct(e.target.value)} style={inpStyle} />
            <span style={{ fontSize: 10, color: 'var(--t5)' }}>%</span>
          </div>
          <div style={{ fontSize: 9, color: 'var(--t5)' }}>index, compaction, WAL</div>
        </div>

        {/* Per-DB cost multipliers */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={lblStyle}>Scylla Fiyat Carpani</div>
          <input type="text" value={scyllaCostMul} onChange={e => setScyllaCostMul(e.target.value)} style={inpStyle} />
          <div style={{ fontSize: 9, color: 'var(--t5)' }}>farkli disk/vm fiyati</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={lblStyle}>CH Fiyat Carpani</div>
          <input type="text" value={chCostMul} onChange={e => setChCostMul(e.target.value)} style={inpStyle} />
          <div style={{ fontSize: 9, color: 'var(--t5)' }}>farkli disk/vm fiyati</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={lblStyle}>Kafka Fiyat Carpani</div>
          <input type="text" value={kafkaCostMul} onChange={e => setKafkaCostMul(e.target.value)} style={inpStyle} />
          <div style={{ fontSize: 9, color: 'var(--t5)' }}>farkli disk/vm fiyati</div>
        </div>
      </div>

      {/* ── Row 3: Grand total summary ── */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 10, padding: 14, borderRadius: 8, background: 'var(--g0)', border: '1px solid var(--g2)',
      }}>
        <SumCard label="ScyllaDB" bytes={projected.scyllaWithOverhead} color={DB_COLORS.scylla} cost={scyllaCost} unit={unitLabel} />
        <SumCard label="ClickHouse" bytes={projected.chWithOverhead} color={DB_COLORS.clickhouse} cost={chCost} unit={unitLabel} />
        <SumCard label="Redpanda" bytes={projected.kafkaRaw} color={DB_COLORS.kafka} cost={kafkaCost} unit={unitLabel} sub="sabit (retention)" />
        <div style={{ borderLeft: '1px solid var(--g3)', paddingLeft: 14, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ fontSize: 10, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.4px' }}>TOPLAM DISK</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t1)', fontFamily: 'var(--mono)', marginTop: 2 }}>{fmtB(projected.totalRaw)}</div>
          {price > 0 && (
            <div style={{ fontSize: 14, color: 'var(--green)', fontWeight: 800, marginTop: 4, fontFamily: 'var(--mono)' }}>
              ${totalCost.toFixed(2)}<span style={{ fontSize: 10, color: 'var(--t4)', fontWeight: 400 }}>/ay</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Row 4: Mevcut vs Tahmini karsilastirma ── */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <CmpBox label="Mevcut" msgs={currentMsgs} bytes={stats.clickhouse.totalDiskBytes + stats.scylla.totalEstimatedBytes} />
        <div style={{ display: 'flex', alignItems: 'center', color: 'var(--t5)', fontSize: 20, fontWeight: 700 }}>→</div>
        <CmpBox label="Tahmini" msgs={target} bytes={projected.totalRaw} highlight />
        {price > 0 && (
          <div style={{
            flex: '0 0 auto', padding: '10px 14px', borderRadius: 8,
            background: 'rgba(87,242,135,0.06)', border: '1px solid rgba(87,242,135,0.2)',
            display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
          }}>
            <div style={{ fontSize: 9, color: 'var(--green)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.4px' }}>Aylik Maliyet</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--green)', fontFamily: 'var(--mono)', marginTop: 4 }}>${totalCost.toFixed(2)}</div>
            <div style={{ fontSize: 9, color: 'var(--t5)', marginTop: 2 }}>{fmtB(projected.totalRaw)} × ${price}/{unitLabel}</div>
          </div>
        )}
      </div>

      {/* ── Row 5: Formula breakdown (collapsible) ── */}
      {showFormulas && (
        <div style={{
          padding: 14, borderRadius: 8, background: 'var(--g0)', border: '1px solid var(--g2)',
          display: 'flex', flexDirection: 'column', gap: 14,
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t1)' }}>Hesaplama Detaylari</div>

          {/* Scylla formula */}
          <FormulaSection
            title="ScyllaDB"
            color={DB_COLORS.scylla}
            lines={[
              { desc: 'Mevcut veri', formula: `${fmtB(stats.scylla.totalEstimatedBytes)}`, result: '' },
              { desc: 'Carpan (mesaj orani)', formula: `× ${ratio.toFixed(2)}`, result: fmtB(stats.scylla.totalEstimatedBytes * ratio) },
              { desc: `Replikasyon (RF=${repl})`, formula: `× ${repl}`, result: fmtB(projected.scyllaWithRepl) },
              { desc: `Overhead (+${overheadPct}%)`, formula: `× ${(1 + overhead).toFixed(2)}`, result: fmtB(projected.scyllaWithOverhead) },
              ...(price > 0 ? [{ desc: `Maliyet (×${scyllaM} carpan)`, formula: `${(projected.scyllaWithOverhead / unitDivisor).toFixed(2)} ${unitLabel} × $${price} × ${scyllaM}`, result: `$${scyllaCost.toFixed(2)}/ay` }] : []),
            ]}
          />

          {/* CH formula */}
          <FormulaSection
            title="ClickHouse"
            color={DB_COLORS.clickhouse}
            lines={[
              { desc: 'Mevcut veri', formula: `${fmtB(stats.clickhouse.totalDiskBytes)}`, result: '' },
              { desc: 'Carpan (mesaj orani)', formula: `× ${ratio.toFixed(2)}`, result: fmtB(projected.chRaw) },
              { desc: `Overhead (+${overheadPct}%)`, formula: `× ${(1 + overhead).toFixed(2)}`, result: fmtB(projected.chWithOverhead) },
              ...(price > 0 ? [{ desc: `Maliyet (×${chM} carpan)`, formula: `${(projected.chWithOverhead / unitDivisor).toFixed(2)} ${unitLabel} × $${price} × ${chM}`, result: `$${chCost.toFixed(2)}/ay` }] : []),
            ]}
          />

          {/* Kafka formula */}
          <FormulaSection
            title="Redpanda (Kafka)"
            color={DB_COLORS.kafka}
            lines={[
              { desc: 'Retention verisi', formula: `${fmtB(projected.kafkaRaw)} (sabit)`, result: '' },
              { desc: 'Not', formula: 'Mesaj sayisindan bagimsiz, retention penceresine bagli', result: '' },
              ...(price > 0 ? [{ desc: `Maliyet (×${kafkaM} carpan)`, formula: `${(projected.kafkaRaw / unitDivisor).toFixed(2)} ${unitLabel} × $${price} × ${kafkaM}`, result: `$${kafkaCost.toFixed(2)}/ay` }] : []),
            ]}
          />
        </div>
      )}

      {/* ── Row 6: Per-table projected sizes ── */}
      {showFormulas && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <TableProj title="ClickHouse Tablolar" color={DB_COLORS.clickhouse} tables={projected.chTables.map(t => ({
            name: t.name, currentBytes: t.currentBytes, projBytes: t.projBytes, rows: t.currentRows, bpr: t.bpr,
          }))} ratio={ratio} />
          <TableProj title="ScyllaDB Tablolar" color={DB_COLORS.scylla} tables={projected.scyllaTables.map(t => ({
            name: t.name, currentBytes: t.currentBytes, projBytes: t.projBytes, rows: t.currentRows, bpr: t.bpr,
          }))} ratio={ratio} />
        </div>
      )}
    </div>
  );
}

/* ── Summary card ────────────────────────────────────────── */
function SumCard({ label, bytes, color, cost, unit, sub }: { label: string; bytes: number; color: string; cost: number; unit: string; sub?: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.4px' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color, fontFamily: 'var(--mono)', marginTop: 2 }}>{fmtB(bytes)}</div>
      {sub && <div style={{ fontSize: 9, color: 'var(--t5)' }}>{sub}</div>}
      {cost > 0 && <div style={{ fontSize: 11, color: 'var(--green)', fontWeight: 600, fontFamily: 'var(--mono)', marginTop: 2 }}>${cost.toFixed(2)}/ay</div>}
    </div>
  );
}

/* ── Compare box ─────────────────────────────────────────── */
function CmpBox({ label, msgs, bytes, highlight }: { label: string; msgs: number; bytes: number; highlight?: boolean }) {
  return (
    <div style={{
      padding: '10px 14px', borderRadius: 8, flex: 1, minWidth: 140,
      background: highlight ? 'rgba(88,101,242,0.06)' : 'var(--g0)',
      border: highlight ? '1px solid rgba(88,101,242,0.2)' : '1px solid var(--g2)',
    }}>
      <div style={{ fontSize: 10, color: highlight ? 'var(--blurple)' : 'var(--t4)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.4px' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--t1)', fontFamily: 'var(--mono)', marginTop: 4 }}>{fmtNum(msgs)} mesaj</div>
      <div style={{ fontSize: 13, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>{fmtB(bytes)}</div>
    </div>
  );
}

/* ── Formula breakdown section ───────────────────────────── */
function FormulaSection({ title, color, lines }: {
  title: string; color: string;
  lines: Array<{ desc: string; formula: string; result: string }>;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
        <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--t2)' }}>{title}</span>
      </div>
      {lines.map((l, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: 8, fontSize: 11,
          padding: '3px 0', borderBottom: i < lines.length - 1 ? '1px solid var(--g2)' : 'none',
        }}>
          <span style={{ color: 'var(--t4)', minWidth: 160 }}>{l.desc}</span>
          <span style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', flex: 1, fontSize: 10 }}>{l.formula}</span>
          {l.result && <span style={{ color, fontWeight: 700, fontFamily: 'var(--mono)', fontSize: 11 }}>{l.result}</span>}
        </div>
      ))}
    </div>
  );
}

/* ── Table-level projected sizes ─────────────────────────── */
function TableProj({ title, color, tables, ratio }: {
  title: string; color: string; ratio: number;
  tables: Array<{ name: string; currentBytes: number; projBytes: number; rows: number; bpr: number }>;
}) {
  const total = tables.reduce((s, t) => s + t.projBytes, 0);
  return (
    <div style={{
      background: 'var(--g0)', border: '1px solid var(--g2)', borderRadius: 8,
      overflow: 'hidden', flex: 1, minWidth: 300,
    }}>
      <div style={{
        padding: '8px 12px', borderBottom: '1px solid var(--g2)',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--t2)' }}>{title}</span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color, fontFamily: 'var(--mono)', fontWeight: 700 }}>{fmtB(total)}</span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--g2)' }}>
            <th style={{ ...thStyle, fontSize: 9 }}>Tablo</th>
            <th style={{ ...thStyle, fontSize: 9, textAlign: 'right' }}>Mevcut</th>
            <th style={{ ...thStyle, fontSize: 9, textAlign: 'right' }}>×{ratio.toFixed(1)}</th>
            <th style={{ ...thStyle, fontSize: 9, textAlign: 'right' }}>Tahmini</th>
          </tr>
        </thead>
        <tbody>
          {tables.map(t => (
            <tr key={t.name} style={{ borderBottom: '1px solid var(--g2)' }}>
              <td style={{ padding: '5px 8px', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 10 }}>{t.name}</td>
              <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--t4)', fontSize: 10 }}>{fmtB(t.currentBytes)}</td>
              <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--yellow)', fontSize: 9 }}>×{ratio.toFixed(1)}</td>
              <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'var(--mono)', color, fontWeight: 600, fontSize: 10 }}>{fmtB(t.projBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Per-message cost card ───────────────────────────────── */
function PerMsgCard({ stats }: { stats: SystemStatsResponse }) {
  const items = [
    { label: 'ScyllaDB (3 tablo)', bytes: stats.perMessageCost.scyllaBytes, color: DB_COLORS.scylla },
    { label: 'ClickHouse', bytes: stats.perMessageCost.clickhouseBytes, color: DB_COLORS.clickhouse },
  ];
  const total = stats.perMessageCost.totalDbBytes;

  return (
    <div style={{
      background: 'var(--g1)', border: '1px solid var(--g2)', borderRadius: 10,
      padding: 16, display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>Mesaj Basina Maliyet</div>
      <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--blurple)', fontFamily: 'var(--mono)', letterSpacing: '-1px' }}>
        {total.toFixed(1)} <span style={{ fontSize: 14, color: 'var(--t3)' }}>byte/mesaj</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map(item => (
          <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 6, height: 6, borderRadius: 2, background: item.color }} />
            <span style={{ fontSize: 11, color: 'var(--t3)', flex: 1 }}>{item.label}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: item.color, fontFamily: 'var(--mono)' }}>{item.bytes.toFixed(1)} B</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, color: 'var(--t5)', marginTop: 4, borderTop: '1px solid var(--g2)', paddingTop: 8 }}>
        Ort. mesaj icerigi: {stats.messages.avgContentLength.toFixed(0)} byte
      </div>
    </div>
  );
}

/* ── Message Info Card ───────────────────────────────────── */
function MsgInfoCard({ stats }: { stats: SystemStatsResponse }) {
  const m = stats.messages;
  const rows = [
    { label: 'En Eski Mesaj', value: m.oldestTs ? new Date(m.oldestTs).toLocaleDateString('tr-TR') : '-' },
    { label: 'En Yeni Mesaj', value: m.newestTs ? new Date(m.newestTs).toLocaleDateString('tr-TR') : '-' },
    { label: 'Ort. Icerik', value: `${m.avgContentLength.toFixed(0)} byte` },
  ];
  return (
    <div style={{
      background: 'var(--g1)', border: '1px solid var(--g2)', borderRadius: 10,
      padding: 16, display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>Mesaj Bilgileri</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map(r => (
          <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
            <span style={{ color: 'var(--t4)' }}>{r.label}</span>
            <span style={{ color: 'var(--t1)', fontWeight: 600, fontFamily: 'var(--mono)' }}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════ */
/*                    MAIN PAGE COMPONENT                     */
/* ═══════════════════════════════════════════════════════════ */
export function ServerMonitor() {
  const [stats, setStats]     = useState<SystemStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.health.systemStats();
      setStats(data);
      setLastRefresh(new Date());
    } catch (e: any) {
      setError(e?.message ?? 'Veri alinamadi');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  if (loading && !stats) return <div style={{ padding: 40, textAlign: 'center' }}><Spinner /></div>;
  if (error && !stats) return <div style={{ padding: 40, textAlign: 'center' }}><Empty text={error} /></div>;
  if (!stats) return null;

  const chTotal     = stats.clickhouse.totalDiskBytes;
  const scyllaTotal = stats.scylla.totalEstimatedBytes;
  const kafkaTotal  = stats.kafka?.topics.reduce((s, t) => s + t.retained * 550, 0) ?? 0;
  const grandTotal  = chTotal + scyllaTotal + kafkaTotal;

  const usageItems = [
    { label: 'ScyllaDB',   bytes: scyllaTotal, color: DB_COLORS.scylla },
    { label: 'ClickHouse', bytes: chTotal,      color: DB_COLORS.clickhouse },
    { label: 'Redpanda',   bytes: kafkaTotal,   color: DB_COLORS.kafka },
  ];

  // Convert Scylla tables to the format TableDetail expects
  // rowCount = CH message count for message tables, partition count for others
  const scyllaTablesForDetail = stats.scylla.tables.map((t: ScyllaTableStats) => ({
    name: t.name,
    rows: t.rowCount,
    diskBytes: t.estimatedBytes,
    bytesPerRow: t.bytesPerRow,
    formatted: t.formatted,
  }));

  // CH tables with engine
  const chTablesForDetail = stats.clickhouse.tables.map((t: ChTableStats) => ({
    name: t.name,
    rows: t.rows,
    diskBytes: t.diskBytes,
    bytesPerRow: t.bytesPerRow,
    formatted: t.formatted,
    engine: t.engine,
  }));

  return (
    <div className="page-enter" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── Header with refresh ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="server" size={20} />
          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--t1)' }}>Sunucu Kontrol Paneli</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {lastRefresh && (
            <span style={{ fontSize: 10, color: 'var(--t5)' }}>
              Son: {lastRefresh.toLocaleTimeString('tr-TR')}
            </span>
          )}
          <button
            onClick={load}
            disabled={loading}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px',
              borderRadius: 6, fontSize: 11, fontWeight: 600,
              background: 'var(--g1)', border: '1px solid var(--g3)', color: 'var(--t2)',
              cursor: 'pointer', opacity: loading ? 0.5 : 1,
            }}
          >
            <Icon name="refresh-cw" size={13} />
            Yenile
          </button>
        </div>
      </div>

      {/* ── Summary stat cards (6 cards) ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 10,
      }}>
        <StatCard label="Toplam Mesaj" value={fmtNum(stats.messages.totalCount)} sub="ClickHouse" color="var(--blurple)" />
        <StatCard label="Toplam Disk" value={fmtB(grandTotal)} sub="tum bilesenler" color="var(--t1)" />
        <StatCard label="Mesaj/Byte" value={`${stats.perMessageCost.totalDbBytes.toFixed(0)} B`} sub="mesaj basina" color="var(--yellow)" />
        <StatCard label="Benzersiz Yazar" value={fmtNum(stats.messages.uniqueAuthors)} color="var(--purple)" />
        <StatCard label="Benzersiz Kanal" value={fmtNum(stats.messages.uniqueChannels)} color="var(--cyan)" />
        <StatCard label="Benzersiz Sunucu" value={fmtNum(stats.messages.uniqueGuilds)} color="var(--green)" />
      </div>

      {/* ── Disk usage visual breakdown ── */}
      <div style={{
        background: 'var(--g1)', border: '1px solid var(--g2)', borderRadius: 10,
        padding: 16, display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>Disk Kullanimi Dagilimi</span>
          <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--t1)', fontFamily: 'var(--mono)' }}>{fmtB(grandTotal)}</span>
        </div>
        <UsageBar items={usageItems} total={grandTotal} />
      </div>

      {/* ── Per-message cost + message info ── */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px' }}>
          <PerMsgCard stats={stats} />
        </div>
        <div style={{ flex: '1 1 260px' }}>
          <MsgInfoCard stats={stats} />
        </div>
      </div>

      {/* ── Table details: CH + Scylla side by side ── */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <TableDetail
          title="ClickHouse"
          color={DB_COLORS.clickhouse}
          tables={chTablesForDetail}
          msgCount={stats.messages.totalCount}
        />
        <TableDetail
          title="ScyllaDB"
          color={DB_COLORS.scylla}
          tables={scyllaTablesForDetail}
          msgCount={stats.messages.totalCount}
        />
      </div>

      {/* ── Kafka detail ── */}
      {stats.kafka && stats.kafka.topics.length > 0 && (
        <KafkaCard topics={stats.kafka.topics} />
      )}

      {/* ── Cost simulator ── */}
      <CostSimulator stats={stats} />

      {/* ── Footer note ── */}
      <div style={{ fontSize: 10, color: 'var(--t5)', textAlign: 'center', padding: '8px 0' }}>
        ScyllaDB boyutlari tahminidir (system.size_estimates). ClickHouse boyutlari system.parts'tan alinmistir.
        Redpanda boyutu retention'daki mesaj sayisi x ort. mesaj boyutundan hesaplanmistir.
      </div>
    </div>
  );
}
