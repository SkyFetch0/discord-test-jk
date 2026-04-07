import React, { useState } from "react";
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip, Legend } from "chart.js";
import { Bar } from "react-chartjs-2";
import { useFetch, fmt, fmtDate, avatarColor } from "../hooks";
import { api, exportCSV } from "../api";
import { Spinner, Empty } from "../components";
import { DiscordAvatar } from "../components/DiscordAvatar";
import type { DailyActivity, HourlyActivity, TopChannel, TopUser } from "../types";

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

const CHART_OPTS = {
  responsive: true, maintainAspectRatio: false, animation: false as const,
  plugins: { legend: { display: false }, tooltip: { backgroundColor: "rgba(6,8,16,.95)", borderColor: "rgba(14,165,233,.3)", borderWidth: 1, cornerRadius: 8, padding: 10, titleFont: { family: "JetBrains Mono, monospace", size: 10 } as any, bodyFont: { family: "JetBrains Mono, monospace", size: 12, weight: 700 } as any } },
  scales: { x: { grid: { display: false }, ticks: { color: "rgba(235,235,245,.3)", font: { size: 9 } } }, y: { grid: { color: "rgba(255,255,255,.04)" }, ticks: { color: "rgba(235,235,245,.3)", font: { size: 10 } } } },
};

interface ContentTypes { text_only: number; with_attachment: number; with_embed: number; with_sticker: number; total: number }
interface MediaType { media_type: string; cnt: number }
interface MsgSize { avg_chars: number; median_chars: number; p95_chars: number; max_chars: number; empty_count: number; total: number }

function Metric({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div style={{ textAlign: "center", padding: "12px 6px" }}>
      <div style={{ fontSize: 22, fontWeight: 800, color, fontVariantNumeric: "tabular-nums", letterSpacing: "-1px" }}>{typeof value === "number" ? fmt(value) : value}</div>
      <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".5px", color: "var(--t4)", marginTop: 4 }}>{label}</div>
    </div>
  );
}

export function Analytics() {
  const [days, setDays] = useState(30);

  const { data: act, loading: aL } = useFetch<DailyActivity[]>(() => api.db.ch.activity(days) as Promise<DailyActivity[]>, [days]);
  const { data: hr, loading: hL }  = useFetch<HourlyActivity[]>(() => api.db.ch.hourly() as Promise<HourlyActivity[]>);
  const { data: tch, loading: tL } = useFetch<TopChannel[]>(() => api.db.ch.topChannels(10) as Promise<TopChannel[]>);
  const { data: tu, loading: uL }  = useFetch<TopUser[]>(() => api.db.ch.topUsers(20) as Promise<TopUser[]>);
  const { data: ct, loading: ctL } = useFetch<ContentTypes>(() => api.db.ch.contentTypes(days) as Promise<ContentTypes>, [days]);
  const { data: mt, loading: mtL } = useFetch<MediaType[]>(() => api.db.ch.mediaTypes(days) as Promise<MediaType[]>, [days]);
  const { data: ms, loading: msL } = useFetch<MsgSize>(() => api.db.ch.msgSize(days) as Promise<MsgSize>, [days]);

  return (
    <div className="page-enter">
      {/* ── Row 1: Daily + Hourly ── */}
      <div className="grid-2" style={{ marginBottom: 14 }}>
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Gunluk Aktivite</span>
            <div style={{ display: "flex", gap: 4 }}>
              {[7, 30, 90].map(d => <button key={d} className={`btn btn-xs ${days === d ? "btn-primary" : "btn-secondary"}`} onClick={() => setDays(d)}>{d}g</button>)}
              {act && <button className="btn btn-xs btn-secondary" onClick={() => exportCSV(act as unknown as Record<string, unknown>[], "activity")}>CSV</button>}
            </div>
          </div>
          <div className="chart-wrap" style={{ height: 200 }}>
            {aL ? <div className="empty"><Spinner /></div> : !act?.length ? <Empty /> :
              <Bar data={{ labels: act.map(r => fmtDate(r.date)), datasets: [
                { label: "Mesaj", data: act.map(r => Number(r.messages)), backgroundColor: "rgba(14,165,233,.55)", borderRadius: 4, borderSkipped: false },
                { label: "Kullanici", data: act.map(r => Number(r.users)), backgroundColor: "rgba(48,209,88,.45)", borderRadius: 4, borderSkipped: false },
              ] }} options={{ ...CHART_OPTS, plugins: { ...CHART_OPTS.plugins, legend: { display: true, labels: { color: "rgba(235,235,245,.5)", font: { size: 10 } } } } } as any} />
            }
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><span className="panel-title">Saatlik Dagilim</span></div>
          <div className="chart-wrap" style={{ height: 200 }}>
            {hL ? <div className="empty"><Spinner /></div> : !hr?.length ? <Empty /> :
              <Bar data={{ labels: Array.from({ length: 24 }, (_, i) => `${i}:00`), datasets: [{
                label: "Mesaj", data: Array.from({ length: 24 }, (_, i) => { const r = hr.find(h => Number(h.hour) === i); return r ? Number(r.messages) : 0; }),
                backgroundColor: "rgba(56,189,248,.5)", borderRadius: 4, borderSkipped: false,
              }] }} options={CHART_OPTS as any} />
            }
          </div>
        </div>
      </div>

      {/* ── Row 2: Content + Media + Msg Size ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 14 }}>
        {/* Content types */}
        <div className="panel">
          <div className="panel-head"><span className="panel-title">Icerik Turu</span></div>
          <div style={{ padding: "12px 16px" }}>
            {ctL ? <div className="empty" style={{ height: 80 }}><Spinner /></div> : !ct ? <Empty /> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {[
                  { label: "Metin", value: Number(ct.text_only), color: "var(--blue)" },
                  { label: "Ek dosya", value: Number(ct.with_attachment), color: "var(--green)" },
                  { label: "Embed", value: Number(ct.with_embed), color: "var(--purple)" },
                  { label: "Sticker", value: Number(ct.with_sticker), color: "var(--orange)" },
                ].map(item => {
                  const pct = ct.total > 0 ? Math.round((item.value / Number(ct.total)) * 100) : 0;
                  return (
                    <div key={item.label}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 2 }}>
                        <span style={{ color: "var(--t2)" }}>{item.label}</span>
                        <span style={{ color: item.color, fontWeight: 700, fontFamily: "var(--mono)" }}>{fmt(item.value)} ({pct}%)</span>
                      </div>
                      <div style={{ height: 3, background: "var(--g1)", borderRadius: 2, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${pct}%`, background: item.color, borderRadius: 2, transition: "width .5s" }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Media types */}
        <div className="panel">
          <div className="panel-head"><span className="panel-title">Medya Turu</span></div>
          <div style={{ padding: "12px 16px" }}>
            {mtL ? <div className="empty" style={{ height: 80 }}><Spinner /></div> : !mt?.length ? <Empty /> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {mt.slice(0, 6).map((m, i) => {
                  const max = Number(mt[0]?.cnt ?? 1);
                  const pct = max > 0 ? Math.round((Number(m.cnt) / max) * 100) : 0;
                  const colors = ["var(--blue)", "var(--green)", "var(--purple)", "var(--orange)", "var(--cyan)", "var(--red)"];
                  return (
                    <div key={m.media_type} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 10, color: "var(--t3)", minWidth: 45, fontFamily: "var(--mono)" }}>{m.media_type || "none"}</span>
                      <div style={{ flex: 1, height: 3, background: "var(--g1)", borderRadius: 2, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${pct}%`, background: colors[i % colors.length], borderRadius: 2 }} />
                      </div>
                      <span style={{ fontSize: 10, color: "var(--t2)", fontFamily: "var(--mono)", minWidth: 45, textAlign: "right" }}>{fmt(m.cnt)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Message size */}
        <div className="panel">
          <div className="panel-head"><span className="panel-title">Mesaj Boyutu</span></div>
          {msL ? <div className="empty" style={{ height: 80 }}><Spinner /></div> : !ms ? <Empty /> : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
              <Metric label="Ortalama" value={`${fmt(ms.avg_chars)} kr`} color="var(--blue)" />
              <Metric label="Medyan" value={`${fmt(ms.median_chars)} kr`} color="var(--green)" />
              <Metric label="P95" value={`${fmt(ms.p95_chars)} kr`} color="var(--orange)" />
              <Metric label="Maks" value={`${fmt(ms.max_chars)} kr`} color="var(--red)" />
              <Metric label="Bos" value={ms.empty_count} color="var(--t3)" />
              <Metric label="Toplam" value={ms.total} color="var(--t2)" />
            </div>
          )}
        </div>
      </div>

      {/* ── Row 3: Top channels + Top users ── */}
      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Top Kanallar</span>
            {tch && <button className="btn btn-xs btn-secondary" onClick={() => exportCSV(tch as unknown as Record<string, unknown>[], "top-channels")}>CSV</button>}
          </div>
          {tL ? <div className="empty" style={{ padding: 20 }}><Spinner /></div> : !tch?.length ? <Empty /> :
            <table><thead><tr><th>#</th><th>Kanal</th><th className="num">Mesaj</th><th>Kullanici</th></tr></thead>
            <tbody>{tch.map((c, i) => (
              <tr key={c.channel_id}>
                <td style={{ color: "var(--t4)", fontSize: 10 }}>{i + 1}</td>
                <td className="mono" style={{ color: "var(--blue)", fontSize: 10 }}>{c.channel_id}</td>
                <td className="num" style={{ color: "var(--yellow)" }}>{fmt(c.msg_count)}</td>
                <td>{fmt(c.unique_users)}</td>
              </tr>
            ))}</tbody></table>
          }
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Top Kullanicilar</span>
            {tu && <button className="btn btn-xs btn-secondary" onClick={() => exportCSV(tu as unknown as Record<string, unknown>[], "top-users")}>CSV</button>}
          </div>
          {uL ? <div className="empty" style={{ padding: 20 }}><Spinner /></div> : !tu?.length ? <Empty /> :
            <div style={{ maxHeight: 300, overflowY: "auto" }}>
              {tu.map((u, i) => (
                <div key={u.author_id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 14px", borderBottom: "1px solid var(--b0)" }}>
                  <span style={{ fontSize: 10, color: i < 3 ? ["#FFD60A","#C0C0C0","#CD7F32"][i] : "var(--t4)", width: 16, textAlign: "right", fontWeight: 700 }}>{i + 1}</span>
                  <DiscordAvatar userId={u.author_id} userName={u.display_name || u.author_name} avatarHash={u.author_avatar} size={24} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.author_name || "?"}</div>
                    <div style={{ fontSize: 9, color: "var(--t4)", fontFamily: "var(--mono)" }}>{u.author_id}</div>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "var(--blue)", fontVariantNumeric: "tabular-nums" }}>{fmt(u.msg_count)}</span>
                </div>
              ))}
            </div>
          }
        </div>
      </div>
    </div>
  );
}
