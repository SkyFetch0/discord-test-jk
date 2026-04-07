import os

base = "/root/senneo-dashboard/src/pages"
os.makedirs(base, exist_ok=True)

# ── Scraper ────────────────────────────────────────────────────────
open(f"{base}/Scraper.tsx","w").write(r"""import React,{useState} from "react";
import {useSSE,fmt,fmtTs,avatarColor} from "../hooks";
import {StatusTag,ProgressBar,Spinner} from "../components";
import {exportCSV} from "../api";
import type {ChannelStats} from "../types";
export function Scraper(){
  const {stats}=useSSE();
  const [filter,setFilter]=useState<"all"|"active"|"queued"|"done">("all");
  const chs=stats?Object.values(stats.channels):[];
  const done=chs.filter(c=>c.complete).length;
  const active=chs.filter(c=>!c.complete&&c.msgsPerSec>0).length;
  const queued=chs.filter(c=>!c.complete&&c.msgsPerSec===0).length;
  const guilds=chs.reduce<Record<string,ChannelStats[]>>((a,c)=>{const g=c.guildId||"?";(a[g]=a[g]||[]).push(c);return a;},{});
  const fil=(l:ChannelStats[])=>filter==="active"?l.filter(c=>!c.complete&&c.msgsPerSec>0):filter==="queued"?l.filter(c=>!c.complete&&c.msgsPerSec===0):filter==="done"?l.filter(c=>c.complete):l;
  return(
    <div className="page-enter">
      <div className="stat-grid stat-grid-4" style={{marginBottom:16}}>
        {[["Toplam",fmt(stats?.totalScraped),"var(--blue)"],["Tamamlanan",String(done),"var(--green)"],["Aktif",String(active),"var(--yellow)"],["Sırada",String(queued),"var(--orange)"]].map(([l,v,c],i)=>(
          <div key={i} className="stat-card" style={{"--accent-color":c} as React.CSSProperties}>
            <div className="stat-label">{l}</div>
            <div className="stat-value" style={{color:c as string}}>{v}</div>
          </div>))}
      </div>
      <div style={{display:"flex",gap:4,marginBottom:12}}>
        {(["all","active","queued","done"] as const).map(f=>(
          <button key={f} className={`btn btn-sm ${filter===f?"btn-primary":"btn-secondary"}`} onClick={()=>setFilter(f)}>
            {{all:"Tümü",active:"Aktif",queued:"Sırada",done:"Bitti"}[f]}
          </button>))}
        <span className="chip" style={{marginLeft:"auto"}}>{chs.length} kanal</span>
        <button className="btn btn-secondary btn-sm" onClick={()=>exportCSV(chs as unknown as Record<string,unknown>[],"channels")}>Export</button>
      </div>
      {Object.entries(guilds).map(([gId,channels])=>{
        const vis=fil(channels);if(!vis.length)return null;
        return(
          <div key={gId} className="guild-section">
            <div className="guild-section-head">
              <div style={{width:28,height:28,borderRadius:8,background:avatarColor(gId),display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,color:"#fff"}}>{gId[0]?.toUpperCase()||"G"}</div>
              <div><div className="guild-section-name">{gId}</div></div>
              <span className="chip" style={{marginLeft:"auto"}}>{channels.length} kanal</span>
            </div>
            <div className="panel">
              <div className="tbl-wrap"><table>
                <thead><tr><th>Kanal</th><th>Hesap</th><th>Toplam</th><th>Msg/s</th><th>RL</th><th>Güncelleme</th><th>İlerleme</th><th>Durum</th></tr></thead>
                <tbody>{vis.map(c=>(
                  <tr key={c.channelId}>
                    <td><span className="mono" style={{color:"var(--blue)",fontSize:11}}>{c.channelId}</span></td>
                    <td>{c.accountIdx!=null?<span className="chip" style={{background:"var(--blue-d)",color:"var(--blue)"}}>#{c.accountIdx}</span>:"—"}</td>
                    <td className="num">{c.totalScraped>0?fmt(c.totalScraped):"—"}</td>
                    <td>{c.msgsPerSec>0?<span style={{color:"var(--yellow)",fontWeight:600}}>{c.msgsPerSec}/s</span>:"—"}</td>
                    <td><span style={{color:c.rateLimitHits>0?"var(--red)":"var(--t3)"}}>{c.rateLimitHits||0}</span></td>
                    <td className="mono" style={{color:"var(--t3)",fontSize:11}}>{fmtTs(c.lastUpdated)}</td>
                    <td><ProgressBar value={c.progress??0} complete={c.complete}/></td>
                    <td><StatusTag complete={c.complete} msgsPerSec={c.msgsPerSec} errors={c.errors} totalScraped={c.totalScraped}/></td>
                  </tr>))}</tbody>
              </table></div>
            </div>
          </div>);})}
    </div>);}
""")
print("✓ Scraper.tsx")

# ── Accounts ───────────────────────────────────────────────────────
open(f"{base}/Accounts.tsx","w").write(r"""import React,{useState} from "react";
import {useFetch} from "../hooks";
import {api} from "../api";
import {Spinner} from "../components";
import type {AccountsResponse} from "../types";
export function Accounts(){
  const {data,loading,reload}=useFetch<AccountsResponse>(()=>api.accounts.list() as Promise<AccountsResponse>);
  const [token,setToken]=useState("");
  const [chId,setChId]=useState("");
  const [gId,setGId]=useState("");
  async function addToken(){if(!token.trim())return;try{await api.accounts.add(token.trim());setToken("");reload();}catch(e){alert((e as Error).message);}}
  async function removeToken(idx:number){if(!confirm("Hesap silinecek?"))return;await api.accounts.remove(idx);reload();}
  async function addChannel(){if(!chId||!gId)return;await api.accounts.addTarget(chId,gId);setChId("");setGId("");reload();}
  async function removeChannel(id:string){await api.accounts.removeTarget(id);reload();}
  if(loading)return <div className="empty" style={{height:200}}><Spinner/></div>;
  return(
    <div className="page-enter">
      <div className="grid-2">
        <div>
          <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",color:"var(--t2)",marginBottom:10}}>Hesaplar</div>
          <div className="panel" style={{marginBottom:12}}>
            <div className="panel-head"><span className="panel-title">Token Ekle</span></div>
            <div style={{padding:"12px 14px",display:"flex",flexDirection:"column",gap:8}}>
              <input className="input" type="password" placeholder="Discord token..." value={token} onChange={e=>setToken(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addToken()}/>
              <button className="btn btn-primary btn-sm" onClick={addToken} disabled={!token.trim()}>+ Ekle</button>
            </div>
          </div>
          {(data?.accounts||[]).map(acc=>(
            <div key={acc.idx} className="account-card" style={{marginBottom:10}}>
              <div className="account-header">
                <div className="account-avatar" style={{background:acc.color}}>{acc.user?acc.user.username[0].toUpperCase():"!"}</div>
                <div>
                  <div className="account-name">{acc.user?.username||"Geçersiz"}</div>
                  <div className="account-tag">#{acc.idx} · {acc.targets.length} kanal</div>
                </div>
                <button className="btn btn-danger btn-icon btn-sm" style={{marginLeft:"auto"}} onClick={()=>removeToken(acc.idx)}>×</button>
              </div>
            </div>))}
        </div>
        <div>
          <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",color:"var(--t2)",marginBottom:10}}>Kanallar ({data?.targets.length||0})</div>
          <div className="panel" style={{marginBottom:10}}>
            <div className="panel-head"><span className="panel-title">Manuel Ekle</span></div>
            <div style={{padding:"12px 14px",display:"flex",flexDirection:"column",gap:6}}>
              <input className="input input-sm" placeholder="Channel ID" value={chId} onChange={e=>setChId(e.target.value)}/>
              <input className="input input-sm" placeholder="Guild ID" value={gId} onChange={e=>setGId(e.target.value)}/>
              <button className="btn btn-primary btn-sm" onClick={addChannel} disabled={!chId||!gId}>+ Ekle</button>
            </div>
          </div>
          <div className="panel">
            {data?.targets.length?data.targets.map(t=>(
              <div key={t.channelId} className="channel-row">
                <span style={{color:"var(--t3)"}}>#</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:500}}>{t.channelName||t.channelId}</div>
                  <div style={{fontSize:10,color:"var(--t3)",fontFamily:"var(--mono)"}}>{t.guildId}</div>
                </div>
                <button className="btn btn-danger btn-icon btn-sm" onClick={()=>removeChannel(t.channelId)}>×</button>
              </div>)):<div className="empty">Hedef yok</div>}
          </div>
        </div>
      </div>
    </div>);}
""")
print("✓ Accounts.tsx")

# ── LiveFeed ───────────────────────────────────────────────────────
open(f"{base}/LiveFeed.tsx","w").write(r"""import React,{useState,useEffect,useRef} from "react";
import {api} from "../api";
import {avatarColor,avatarInitial,fmtTs,fmt} from "../hooks";
import type {Message} from "../types";
export function LiveFeed(){
  const [msgs,setMsgs]=useState<Message[]>([]);
  const [paused,setPaused]=useState(false);
  const [filter,setFilter]=useState("");
  const [total,setTotal]=useState(0);
  const pausedRef=useRef(false);
  pausedRef.current=paused;
  useEffect(()=>{
    const id=setInterval(async()=>{
      if(pausedRef.current)return;
      try{
        const res=await api.live.recent(30) as {messages:Message[]};
        const fresh=res.messages??[];
        if(!fresh.length)return;
        setMsgs(prev=>{
          const ids=new Set(prev.map(m=>m.message_id));
          const n=fresh.filter(m=>!ids.has(m.message_id));
          if(!n.length)return prev;
          setTotal(t=>t+n.length);
          return [...n,...prev].slice(0,200);
        });
      }catch{}
    },1500);
    return()=>clearInterval(id);
  },[]);
  const fil=msgs.filter(m=>!filter||m.content?.toLowerCase().includes(filter.toLowerCase())||m.author_name?.toLowerCase().includes(filter.toLowerCase()));
  return(
    <div className="page-enter" style={{display:"flex",flexDirection:"column",height:"calc(100vh - 80px)",overflow:"hidden"}}>
      <div style={{display:"flex",gap:8,marginBottom:12,flexShrink:0}}>
        <input className="input" placeholder="Filtrele..." value={filter} onChange={e=>setFilter(e.target.value)} style={{flex:1}}/>
        <button className={`btn ${paused?"btn-primary":"btn-secondary"}`} onClick={()=>setPaused(p=>!p)}>{paused?"▶ Devam":"⏸ Duraklat"}</button>
        <button className="btn btn-secondary" onClick={()=>setMsgs([])}>Temizle</button>
        <span style={{fontSize:11,color:"var(--t2)",display:"flex",alignItems:"center",gap:6}}>
          <div style={{width:6,height:6,borderRadius:"50%",background:paused?"var(--orange)":"var(--green)"}}/>
          {fmt(total)} mesaj
        </span>
      </div>
      <div style={{flex:1,overflowY:"auto",background:"var(--s1)",border:"1px solid var(--border)",borderRadius:"var(--r)",padding:"8px 0"}}>
        {!fil.length?<div className="empty" style={{height:120}}>Mesaj bekleniyor...</div>:
        <div className="msg-stream">
          {fil.map(m=>(
            <div key={m.message_id} className="msg-item">
              <div className="msg-avatar" style={{background:avatarColor(m.author_id)}}>{avatarInitial(m.author_name||m.author_id)}</div>
              <div className="msg-body">
                <div className="msg-header">
                  <span className="msg-author">{m.author_name}</span>
                  <span className="msg-channel">#{m.channel_id.slice(-6)}</span>
                  <span className="msg-time">{fmtTs(m.ts)}</span>
                </div>
                {m.content&&<div className="msg-content">{m.content}</div>}
                {m.media_urls?.filter((u:string)=>/\.(png|jpg|gif|webp)$/i.test(u)).slice(0,2).map((url:string,i:number)=>(
                  <img key={i} src={url} alt="" loading="lazy" style={{maxWidth:200,maxHeight:140,borderRadius:6,marginTop:6}} onError={(e)=>(e.target as HTMLImageElement).style.display="none"}/>))}
              </div>
            </div>))}
        </div>}
      </div>
    </div>);}
""")
print("✓ LiveFeed.tsx")

# ── Analytics ──────────────────────────────────────────────────────
open(f"{base}/Analytics.tsx","w").write(r"""import React,{useState} from "react";
import {Chart as ChartJS,CategoryScale,LinearScale,BarElement,Tooltip,Legend} from "chart.js";
import {Bar} from "react-chartjs-2";
import {useFetch,fmt,fmtDate,avatarColor} from "../hooks";
import {api,exportCSV} from "../api";
import {Spinner,Empty} from "../components";
import type {DailyActivity,HourlyActivity,TopChannel,TopUser} from "../types";
ChartJS.register(CategoryScale,LinearScale,BarElement,Tooltip,Legend);
const TO={responsive:true,maintainAspectRatio:false,animation:false as const,plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{color:"rgba(235,235,245,0.3)",font:{size:9}}},y:{grid:{color:"rgba(255,255,255,0.04)"},ticks:{color:"rgba(235,235,245,0.3)",font:{size:10}}}}};
export function Analytics(){
  const [days,setDays]=useState(30);
  const {data:act,loading:aL}=useFetch<DailyActivity[]>(()=>api.db.ch.activity(days) as Promise<DailyActivity[]>,[days]);
  const {data:hr,loading:hL}=useFetch<HourlyActivity[]>(()=>api.db.ch.hourly() as Promise<HourlyActivity[]>);
  const {data:tch,loading:tL}=useFetch<TopChannel[]>(()=>api.db.ch.topChannels(10) as Promise<TopChannel[]>);
  const {data:tu,loading:uL}=useFetch<TopUser[]>(()=>api.db.ch.topUsers(20) as Promise<TopUser[]>);
  return(
    <div className="page-enter">
      <div className="grid-2" style={{marginBottom:14}}>
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Günlük Aktivite</span>
            <div className="panel-actions">
              {[7,30,90].map(d=><button key={d} className={`btn btn-sm ${days===d?"btn-primary":"btn-secondary"}`} onClick={()=>setDays(d)}>{d}g</button>)}
              {act&&<button className="btn btn-secondary btn-sm" onClick={()=>exportCSV(act as unknown as Record<string,unknown>[],"activity")}>CSV</button>}
            </div>
          </div>
          <div className="chart-wrap" style={{height:200}}>
            {aL?<div className="empty"><Spinner/></div>:!act?.length?<Empty/>:
            <Bar data={{labels:act.map(r=>fmtDate(r.date)),datasets:[{label:"Mesaj",data:act.map(r=>Number(r.messages)),backgroundColor:"rgba(10,132,255,0.6)",borderRadius:3,borderSkipped:false},{label:"Kullanıcı",data:act.map(r=>Number(r.users)),backgroundColor:"rgba(48,209,88,0.5)",borderRadius:3,borderSkipped:false}]}} options={{...TO,plugins:{legend:{display:true,labels:{color:"rgba(235,235,245,0.6)",font:{size:10}}}}}}/>}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><span className="panel-title">Saate Göre Dağılım</span></div>
          <div className="chart-wrap" style={{height:200}}>
            {hL?<div className="empty"><Spinner/></div>:!hr?.length?<Empty/>:
            <Bar data={{labels:Array.from({length:24},(_,i)=>i+":00"),datasets:[{label:"Mesaj",data:Array.from({length:24},(_,i)=>{const r=hr.find(h=>Number(h.hour)===i);return r?Number(r.messages):0;}),backgroundColor:"rgba(191,90,242,0.55)",borderRadius:3,borderSkipped:false}]}} options={TO}/>}
          </div>
        </div>
      </div>
      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Top Kanallar</span>
            {tch&&<button className="btn btn-secondary btn-sm" onClick={()=>exportCSV(tch as unknown as Record<string,unknown>[],"top-ch")}>CSV</button>}
          </div>
          {tL?<div className="empty" style={{padding:30}}><Spinner/></div>:!tch?.length?<Empty/>:
          <table><thead><tr><th>#</th><th>Kanal</th><th>Mesaj</th><th>Kullanıcı</th></tr></thead>
          <tbody>{tch.map((c,i)=><tr key={c.channel_id}><td style={{color:"var(--t3)",fontSize:11}}>{i+1}</td><td className="mono" style={{color:"var(--blue)",fontSize:11}}>{c.channel_id}</td><td className="num" style={{color:"var(--yellow)"}}>{fmt(c.msg_count)}</td><td>{fmt(c.unique_users)}</td></tr>)}</tbody></table>}
        </div>
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Top Kullanıcılar</span>
            {tu&&<button className="btn btn-secondary btn-sm" onClick={()=>exportCSV(tu as unknown as Record<string,unknown>[],"top-users")}>CSV</button>}
          </div>
          {uL?<div className="empty" style={{padding:30}}><Spinner/></div>:!tu?.length?<Empty/>:
          tu.map((u,i)=>(
            <div key={u.author_id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 14px",borderBottom:"1px solid var(--border)"}}>
              <span style={{fontSize:11,color:"var(--t3)",width:18,textAlign:"right"}}>{i+1}</span>
              <div style={{width:26,height:26,borderRadius:"50%",background:avatarColor(u.author_id),display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:"#fff"}}>{(u.author_name?.[0]||"?").toUpperCase()}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{u.author_name}</div>
                <div style={{fontSize:10,color:"var(--t3)",fontFamily:"var(--mono)"}}>{u.author_id}</div>
              </div>
              <div style={{fontSize:13,fontWeight:700,color:"var(--blue)"}}>{fmt(u.msg_count)}</div>
            </div>))}
        </div>
      </div>
    </div>);}
""")
print("✓ Analytics.tsx")

# ── Search ─────────────────────────────────────────────────────────
open(f"{base}/Search.tsx","w").write(r"""import React,{useState} from "react";
import {api,exportCSV} from "../api";
import {avatarColor,fmtTs} from "../hooks";
import {Spinner,Empty} from "../components";
import type {Message} from "../types";
export function Search(){
  const [q,setQ]=useState("");
  const [limit,setLimit]=useState(50);
  const [results,setResults]=useState<Message[]>([]);
  const [loading,setLoading]=useState(false);
  const [searched,setSearched]=useState(false);
  async function doSearch(){if(!q.trim())return;setLoading(true);setSearched(true);try{const r=await api.db.ch.search(q.trim(),limit) as {rows:Message[]};setResults(r.rows??[]);}catch{setResults([]);}finally{setLoading(false);}}
  return(
    <div className="page-enter">
      <div style={{display:"flex",gap:8,marginBottom:14}}>
        <input className="input" placeholder="Mesaj içeriğinde ara..." value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==="Enter"&&doSearch()} style={{flex:1}}/>
        <select className="input" value={limit} onChange={e=>setLimit(Number(e.target.value))} style={{width:110}}>
          {[20,50,100,200].map(l=><option key={l} value={l}>{l} sonuç</option>)}
        </select>
        <button className="btn btn-primary" onClick={doSearch} disabled={loading||!q.trim()}>{loading?<Spinner/>:"Ara"}</button>
      </div>
      <div className="panel">
        {!searched?<div className="empty" style={{height:140}}>Arama yapın</div>:
        loading?<div className="empty" style={{height:140}}><Spinner/></div>:
        !results.length?<Empty text={`"${q}" bulunamadı`}/>:
        <div>
          <div className="export-bar">
            <span className="count">{results.length} sonuç</span>
            <button className="btn btn-secondary btn-sm" onClick={()=>exportCSV(results as unknown as Record<string,unknown>[],`search-${q}`)}>CSV</button>
          </div>
          {results.map(m=>(
            <div key={m.message_id} style={{padding:"10px 14px",borderBottom:"1px solid var(--border)"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                <div style={{width:22,height:22,borderRadius:"50%",background:avatarColor(m.author_id),display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,color:"#fff"}}>{(m.author_name?.[0]||"?").toUpperCase()}</div>
                <span style={{fontSize:13,fontWeight:600}}>{m.author_name}</span>
                <span style={{fontSize:10,color:"var(--blue)",fontFamily:"var(--mono)"}}>{m.channel_id.slice(-6)}</span>
                <span style={{fontSize:10,color:"var(--t3)",marginLeft:"auto",fontFamily:"var(--mono)"}}>{fmtTs(m.ts)}</span>
              </div>
              <div style={{fontSize:13,color:"var(--t2)",lineHeight:1.45,wordBreak:"break-word"}}>{m.content}</div>
            </div>))}
        </div>}
      </div>
    </div>);}
""")
print("✓ Search.tsx")

# ── DbPages ────────────────────────────────────────────────────────
open(f"{base}/DbPages.tsx","w").write(r"""import React,{useState} from "react";
import {useFetch} from "../hooks";
import {api,exportCSV,exportJSON} from "../api";
import {Spinner,Empty,DataTable} from "../components";
function DbExplorer({engine}:{engine:"ch"|"scylla"}){
  const isCh=engine==="ch";
  const [active,setActive]=useState<string|null>(null);
  const [tRows,setTRows]=useState<Record<string,unknown>[]>([]);
  const [tLoad,setTLoad]=useState(false);
  const [query,setQuery]=useState(isCh?"SELECT count() FROM senneo.messages":"SELECT * FROM senneo.messages_by_id LIMIT 10");
  const [qRows,setQRows]=useState<Record<string,unknown>[]>([]);
  const [qLoad,setQLoad]=useState(false);
  const [qErr,setQErr]=useState("");
  const [ms,setMs]=useState<number|null>(null);
  const {data:tables}=useFetch<{name:string;total_rows?:number}[]>(isCh?()=>api.db.ch.tables() as Promise<{name:string;total_rows?:number}[]>:()=>api.db.scylla.tables() as Promise<{name:string}[]>);
  async function selTable(name:string){setActive(name);setTLoad(true);try{if(isCh){setTRows(await api.db.ch.rows(name,50,0) as Record<string,unknown>[]);}else{const r=await api.db.scylla.query(`SELECT * FROM senneo.${name} LIMIT 50`) as {rows:Record<string,unknown>[]};setTRows(r.rows??[]);}}catch{setTRows([]);}finally{setTLoad(false);}}
  async function runQ(){if(!query.trim())return;setQLoad(true);setQErr("");setMs(null);const t=Date.now();try{let rows:Record<string,unknown>[]=[];if(isCh){const r=await api.db.ch.query(query) as {rows:Record<string,unknown>[];elapsedMs:number;error?:string};if(r.error){setQErr(r.error);return;}rows=r.rows;setMs(r.elapsedMs);}else{const r=await api.db.scylla.query(query) as {rows:Record<string,unknown>[];error?:string};if(r.error){setQErr(r.error);return;}rows=r.rows;setMs(Date.now()-t);}setQRows(rows);}catch(e){setQErr((e as Error).message);}finally{setQLoad(false);}}
  return(
    <div className="db-layout">
      <div className="db-tree">
        <div className="tree-engine">{isCh?"ClickHouse":"ScyllaDB"}</div>
        {!tables?<div className="empty" style={{height:60}}><Spinner/></div>:tables.map(t=>(
          <div key={t.name} className={`tree-table${active===t.name?" active":""}`} onClick={()=>selTable(t.name)}>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1" y="1" width="10" height="10" rx="1.5"/><path d="M1 4h10M4 1v10"/></svg>
            {t.name}
            {t.total_rows!=null&&<span className="tree-rows">{Number(t.total_rows).toLocaleString()}</span>}
          </div>))}
      </div>
      <div className="db-right">
        {active&&(
          <div className="results-card" style={{maxHeight:240}}>
            <div className="results-head" style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",borderBottom:"1px solid var(--border)",flexShrink:0}}>
              <span className="editor-label">{active}</span>
              <div style={{display:"flex",gap:6}}>
                <span className="editor-meta">{tRows.length} satır</span>
                {tRows.length>0&&<button className="btn btn-secondary btn-sm" onClick={()=>exportCSV(tRows,active)}>CSV</button>}
              </div>
            </div>
            <div className="results-body">{tLoad?<div className="empty"><Spinner/></div>:<DataTable rows={tRows}/>}</div>
          </div>)}
        <div className="editor-card">
          <div className="editor-head">
            <span className="editor-label">{isCh?"SQL":"CQL"}</span>
            <div style={{display:"flex",gap:6,alignItems:"center"}}>
              {ms!=null&&<span className="editor-meta">{ms}ms</span>}
              <button className="btn btn-primary btn-sm" onClick={runQ} disabled={qLoad}>{qLoad?<Spinner/>:"▶ Çalıştır"}</button>
            </div>
          </div>
          <textarea className="query-input" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key==="Enter"){e.preventDefault();runQ();}}}/>
        </div>
        <div className="results-card">
          <div className="results-head" style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",borderBottom:"1px solid var(--border)",flexShrink:0}}>
            <span className="editor-label">Sonuçlar</span>
            <div style={{display:"flex",gap:6}}>
              {qRows.length>0&&<button className="btn btn-secondary btn-sm" onClick={()=>exportCSV(qRows,"result")}>CSV</button>}
              {qRows.length>0&&<button className="btn btn-secondary btn-sm" onClick={()=>exportJSON(qRows,"result")}>JSON</button>}
            </div>
          </div>
          <div className="results-body">
            {qErr?<div className="err-box">{qErr}</div>:qLoad?<div className="empty"><Spinner/></div>:qRows.length===0?<div className="empty">Sorgu çalıştırın</div>:<DataTable rows={qRows}/>}
          </div>
        </div>
      </div>
    </div>);}
export const ClickHousePage=()=><div className="page-enter"><DbExplorer engine="ch"/></div>;
export const ScyllaPage=()=><div className="page-enter"><DbExplorer engine="scylla"/></div>;
""")
print("✓ DbPages.tsx")

# Fix App.tsx
app_path = "/root/senneo-dashboard/src/App.tsx"
with open(app_path) as f: app = f.read()
# Remove onSearch prop from CommandPalette usage
import re
app = re.sub(r'\s*onSearch=\{[^}]+\}', '', app)
with open(app_path,"w") as f: f.write(app)
print("✓ App.tsx fixed")
print("ALL DONE")
