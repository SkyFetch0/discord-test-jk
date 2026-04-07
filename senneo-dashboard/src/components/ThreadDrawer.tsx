import React, { useState, useEffect, useCallback } from "react";
import { api } from "../api";
import { MessageRow } from "./MessageRow";
import { fmtFullDate } from "./MessageRow";
import { Spinner } from "../components";
import type { ContextMessage } from "../types";

interface Props {
  messageId: string;
  open: boolean;
  onClose: () => void;
}

export function ThreadDrawer({ messageId, open, onClose }: Props) {
  const [chain, setChain] = useState<ContextMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchChain = useCallback(async () => {
    if (!messageId) return;
    setLoading(true);
    setError(null);
    try {
      const res = (await api.messages.context(messageId, 8)) as { chain: ContextMessage[]; depth: number };
      setChain(res.chain ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Hata");
    } finally {
      setLoading(false);
    }
  }, [messageId]);

  useEffect(() => {
    if (open && messageId) fetchChain();
  }, [open, messageId, fetchChain]);

  if (!open) return null;

  return (
    <div className="thread-drawer">
      {/* Header */}
      <div className="thread-drawer-head">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
             style={{ width: 16, height: 16, opacity: 0.5, flexShrink: 0 }}>
          <path d="M6 3L2 7l4 4" /><path d="M2 7h9a3 3 0 013 3v2" />
        </svg>
        <span className="thread-drawer-title">Yanıt Zinciri</span>
        <span style={{ fontSize: 11, color: "var(--t4)", fontFamily: "var(--mono)" }}>
          {chain.length > 0 ? `${chain.length} mesaj` : ""}
        </span>
        <button className="btn btn-ghost btn-xs" onClick={onClose} aria-label="Kapat">
          ✕
        </button>
      </div>

      {/* Body */}
      <div className="thread-drawer-body">
        {loading ? (
          <div className="empty" style={{ height: 120 }}>
            <Spinner />
          </div>
        ) : error ? (
          <div style={{ padding: 16, color: "var(--red)", fontFamily: "var(--mono)", fontSize: 12 }}>
            Hata: {error}
          </div>
        ) : chain.length === 0 ? (
          <div className="empty" style={{ height: 120, fontSize: 13 }}>
            Zincir bulunamadı
          </div>
        ) : (
          <div className="thread-chain-line">
            {chain.map((msg, i) =>
              msg.deleted ? (
                <div key={`del-${msg.message_id}`} className="thread-deleted">
                  Silinmiş veya bulunamayan mesaj ({String(msg.message_id).slice(-8)})
                </div>
              ) : (
                <MessageRow
                  key={msg.message_id}
                  msg={msg}
                  showMedia={false}
                  animate
                  animDelay={i * 60}
                />
              )
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: "8px 16px", borderTop: "1px solid var(--b0)", fontSize: 10, color: "var(--t4)", flexShrink: 0 }}>
        Yukarıdan aşağıya: üst mesaj → yanıt zinciri (maks 8 adım)
      </div>
    </div>
  );
}
