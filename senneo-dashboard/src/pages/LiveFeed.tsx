import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { api } from "../api";
import { fmt } from "../hooks";
import { MessageGroupRow, groupMessages } from "../components/MessageRow";
import type { UserClickPayload } from "../components/MessageRow";
import { UserMiniProfileCard } from "../components/UserMiniProfileCard";
import type { Message } from "../types";

const MAX_DOM_MESSAGES = 200;
const POLL_MS = 3000;

export function LiveFeed() {
  const [msgs, setMsgs]         = useState<Message[]>([]);
  const [paused, setPaused]       = useState(false);
  const [filter, setFilter]       = useState("");
  const [total, setTotal]         = useState(0);
  const [miniProfile, setMiniProfile] = useState<UserClickPayload | null>(null);
  const pausedRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  pausedRef.current = paused;

  const handleUserClick = useCallback((p: UserClickPayload) => {
    setMiniProfile(prev => prev?.userId === p.userId ? null : p);
  }, []);

  useEffect(() => {
    const id = setInterval(async () => {
      if (pausedRef.current) return;
      try {
        const res = await api.live.recent(40) as { messages: Message[] };
        const fresh = res.messages ?? [];
        if (!fresh.length) return;
        setMsgs(prev => {
          const ids = new Set(prev.map(m => m.message_id));
          const n   = fresh.filter(m => !ids.has(m.message_id));
          if (!n.length) return prev;
          setTotal(t => t + n.length);
          return [...n, ...prev].slice(0, MAX_DOM_MESSAGES);
        });
      } catch {}
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(() =>
    msgs.filter(m =>
      !filter ||
      m.content?.toLowerCase().includes(filter.toLowerCase()) ||
      m.author_name?.toLowerCase().includes(filter.toLowerCase()) ||
      m.channel_name?.toLowerCase().includes(filter.toLowerCase())
    ), [msgs, filter]);

  const groups = useMemo(() => groupMessages(filtered), [filtered]);

  return (
    <div className="page-enter" style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 80px)", overflow: "hidden" }}>
      {/* Toolbar */}
      <div className="livefeed-toolbar">
        <div style={{ position: "relative", flex: 1, minWidth: 200 }}>
          <input
            className="input"
            placeholder={"Mesaj, kullanıcı veya kanal filtrele…"}
            aria-label="Canlı mesaj filtrele"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{ paddingLeft: 36 }}
          />
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"
               style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", width: 14, height: 14, color: "var(--t4)" }}>
            <circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3 3"/>
          </svg>
        </div>

        <button
          className={`btn btn-sm ${paused ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setPaused(p => !p)}
          data-tip={paused ? "Devam et" : "Duraklat"}
        >
          {paused ? "▶ Devam" : "⏸ Duraklat"}
        </button>

        <button className="btn btn-sm btn-secondary" onClick={() => { setMsgs([]); setTotal(0); }} data-tip="Temizle">
          Temizle
        </button>

        {/* Live indicator */}
        <div
          className="livefeed-indicator"
          style={{
            background: paused ? "var(--orange-d)" : "var(--green-d)",
            border: `1px solid ${paused ? "rgba(230,126,34,.25)" : "rgba(35,165,90,.25)"}`,
            color: paused ? "var(--orange)" : "var(--green)",
          }}
        >
          <div style={{
            width: 7, height: 7, borderRadius: "50%", background: "currentColor",
            animation: paused ? "none" : "breathe 2.5s ease-in-out infinite",
          }} />
          {fmt(total)} mesaj
          {filter && <span style={{ color: "var(--t4)", marginLeft: 4 }}>({filtered.length} filtre)</span>}
        </div>
      </div>

      {/* Feed */}
      <div className="livefeed-container">
        {!groups.length ? (
          <div className="empty" style={{ height: 200 }}>
            <div style={{ textAlign: "center" }}>
              <svg viewBox="0 0 48 48" fill="none" style={{ width: 48, height: 48, opacity: 0.15, margin: "0 auto 12px", display: "block" }}>
                <rect x="4" y="8" width="40" height="32" rx="6" stroke="currentColor" strokeWidth="2"/>
                <path d="M12 20h24M12 28h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
              <div style={{ color: "var(--t4)", fontSize: 13 }}>
                {filter ? `"${filter}" için mesaj bulunamadı` : "Mesaj bekleniyor…"}
              </div>
            </div>
          </div>
        ) : (
          groups.map((group, gi) => (
            <MessageGroupRow
              key={`${group.author_id}-${group.ts}-${gi}`}
              group={group}
              showMedia
              onUserClick={handleUserClick}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {miniProfile && (
        <UserMiniProfileCard
          userId={miniProfile.userId}
          userName={miniProfile.userName}
          avatarHash={miniProfile.avatarHash}
          anchor={miniProfile.anchor}
          onClose={() => setMiniProfile(null)}
        />
      )}

      {/* Footer hint */}
      <div style={{ fontSize: 11, color: "var(--t4)", marginTop: 8, flexShrink: 0 }}>
        {"Son "}{MAX_DOM_MESSAGES}{" mesaj gösteriliyor · Güncelleme: "}{POLL_MS / 1000}{"s aralıkla · Tarih: Europe/Istanbul (TRT)"}
      </div>
    </div>
  );
}