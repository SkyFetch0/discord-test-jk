import React,{useState} from "react";
import {useFetch} from "../hooks";
import {api,exportCSV,exportJSON} from "../api";
import {Spinner,Empty,DataTable} from "../components";

interface DedupStatus { total_rows:number; unique_ids:number; duplicate_rows:number; duplicate_pct:number; }
interface DedupResult  { ok:boolean; elapsedMs:number; total_rows:number; unique_ids:number; }

function DedupPanel() {
  const [status,setStatus]=useState<DedupStatus|null>(null);
  const [checking,setChecking]=useState(false);
  const [running,setRunning]=useState(false);
  const [result,setResult]=useState<DedupResult|null>(null);
  const [err,setErr]=useState("");
  const [confirm,setConfirm]=useState(false);

  async function checkStatus(){
    setChecking(true);setErr("");setResult(null);setConfirm(false);
    try{ const r=await api.db.ch.dedupStatus() as DedupStatus; setStatus(r); }
    catch(e){ setErr((e as Error).message); }
    finally{ setChecking(false); }
  }

  async function runDedup(){
    setRunning(true);setErr("");setConfirm(false);
    try{ const r=await api.db.ch.dedupRun() as DedupResult; setResult(r); setStatus(null); }
    catch(e){ setErr((e as Error).message); }
    finally{ setRunning(false); }
  }

  const hasDups=status && status.duplicate_rows>0;

  return(
    <div style={{marginBottom:20,padding:"16px 20px",borderRadius:14,background:"var(--g0)",border:"1px solid var(--b1)"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:status||result||err?14:0}}>
        <div>
          <span style={{fontSize:13,fontWeight:700,color:"var(--t1)"}}>Duplicate Temizleme</span>
          <span style={{fontSize:11,color:"var(--t4)",marginLeft:10}}>messages tablosundaki duplicate message_id'leri tespit et ve sil</span>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {status&&hasDups&&!confirm&&(
            <button className="btn btn-sm" onClick={()=>setConfirm(true)} disabled={running}
              style={{background:"color-mix(in srgb,#ef4444 15%,transparent)",border:"1px solid color-mix(in srgb,#ef4444 40%,transparent)",color:"#ef4444",fontWeight:700,fontSize:11,padding:"5px 14px",borderRadius:8,cursor:"pointer"}}>
              {status.duplicate_rows.toLocaleString()} duplicate sil
            </button>
          )}
          {confirm&&(
            <>
              <span style={{fontSize:11,color:"#ef4444",fontWeight:600}}>Emin misin?</span>
              <button className="btn btn-sm" onClick={runDedup} disabled={running}
                style={{background:"#ef4444",border:"none",color:"#fff",fontWeight:700,fontSize:11,padding:"5px 14px",borderRadius:8,cursor:"pointer"}}>
                {running?<Spinner/>:"Evet, Sil"}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={()=>setConfirm(false)} disabled={running}>İptal</button>
            </>
          )}
          <button className="btn btn-secondary btn-sm" onClick={checkStatus} disabled={checking||running} style={{fontSize:11}}>
            {checking?<Spinner/>:"Kontrol Et"}
          </button>
        </div>
      </div>

      {err&&<div style={{padding:"8px 12px",borderRadius:8,background:"color-mix(in srgb,#ef4444 8%,transparent)",border:"1px solid color-mix(in srgb,#ef4444 25%,transparent)",fontSize:12,color:"#ef4444"}}>{err}</div>}

      {status&&(
        <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
          {([
            {label:"Toplam Satır",   value:status.total_rows.toLocaleString(),     color:"var(--t2)"},
            {label:"Benzersiz ID",   value:status.unique_ids.toLocaleString(),      color:"var(--green)"},
            {label:"Duplicate Satır",value:status.duplicate_rows.toLocaleString(), color:hasDups?"#ef4444":"var(--green)"},
            {label:"Duplicate %",    value:`${status.duplicate_pct.toFixed(4)}%`,  color:hasDups?"#ef4444":"var(--green)"},
          ] as {label:string;value:string;color:string}[]).map(s=>(
            <div key={s.label} style={{background:"var(--b0)",padding:"8px 14px",borderRadius:10,minWidth:120}}>
              <div style={{fontSize:9,color:"var(--t4)",fontWeight:700,letterSpacing:"1px",textTransform:"uppercase",marginBottom:3}}>{s.label}</div>
              <div style={{fontSize:18,fontWeight:800,color:s.color,fontFamily:"var(--mono)"}}>{s.value}</div>
            </div>
          ))}
          {!hasDups&&<div style={{display:"flex",alignItems:"center",fontSize:12,color:"var(--green)",fontWeight:600,gap:6}}>✓ Duplicate yok</div>}
        </div>
      )}

      {result&&(
        <div style={{padding:"10px 14px",borderRadius:10,background:"color-mix(in srgb,var(--green) 8%,transparent)",border:"1px solid color-mix(in srgb,var(--green) 25%,transparent)"}}>
          <div style={{fontSize:12,color:"var(--green)",fontWeight:700,marginBottom:4}}>✓ Deduplikasyon tamamlandı ({(result.elapsedMs/1000).toFixed(1)}s)</div>
          <div style={{fontSize:11,color:"var(--t3)",fontFamily:"var(--mono)"}}>
            Kalan: {result.total_rows.toLocaleString()} satır · {result.unique_ids.toLocaleString()} benzersiz mesaj
          </div>
        </div>
      )}
    </div>
  );
}
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
export const ClickHousePage=()=><div className="page-enter"><DedupPanel/><DbExplorer engine="ch"/></div>;
export const ScyllaPage=()=><div className="page-enter"><DbExplorer engine="scylla"/></div>;
