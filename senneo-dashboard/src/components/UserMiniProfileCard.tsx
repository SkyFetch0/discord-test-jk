import React, { useEffect, useRef } from "react";
import { api } from "../api";
import { useFetch, fmt } from "../hooks";
import { DiscordAvatar, avatarColorFromId } from "./DiscordAvatar";
import { DiscordUserBadges, BotBadge } from "./DiscordBadges";

export interface MiniProfileAnchor {
  x: number;
  y: number;
}

interface Props {
  userId: string;
  userName?: string;
  avatarHash?: string | null;
  anchor: MiniProfileAnchor;
  onClose: () => void;
  onViewProfile?: (userId: string) => void;
}

export function UserMiniProfileCard({ userId, userName, avatarHash, anchor, onClose, onViewProfile }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);

  const { data, loading } = useFetch<{ user: Record<string, unknown> | null }>(
    () => api.db.ch.userById(userId) as Promise<{ user: Record<string, unknown> | null }>,
    [userId]
  );
  const u = data?.user;

  /* close on outside click or Escape */
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  /* smart positioning — popup opens to the right of the element */
  const CARD_W = 280;
  const CARD_H = 240;
  const GAP = 10;
  /* anchor.x = right edge of clicked element, anchor.y = top of element */
  let left = anchor.x + GAP;
  let top  = anchor.y;
  /* flip to left if popup would overflow right edge */
  if (left + CARD_W > window.innerWidth - 8) {
    left = anchor.x - CARD_W - GAP;
  }
  /* clamp horizontally */
  if (left < 8) left = 8;
  /* clamp vertically */
  if (top + CARD_H > window.innerHeight - 8) top = window.innerHeight - CARD_H - 8;
  if (top < 8) top = 8;

  const displayName  = ((u?.display_name || u?.author_name || userName || userId) as string);
  const username     = (u?.author_name || userName || "") as string;
  const avatarToUse  = ((u?.author_avatar as string | null | undefined) || avatarHash || null) as string | null;
  const msgCount     = Number(u?.msg_count ?? 0);
  const badgeMask    = Number(u?.badge_mask ?? 0);
  const isBot        = Number(u?.is_bot ?? 0) === 1;
  const accentColor  = avatarColorFromId(userId);

  return (
    <div
      ref={cardRef}
      style={{
        position: "fixed",
        left,
        top,
        width: CARD_W,
        zIndex: 2000,
        background: "rgba(9,13,24,0.98)",
        border: "1px solid rgba(14,165,233,0.2)",
        borderRadius: 16,
        boxShadow: "0 24px 72px rgba(0,0,0,0.85), 0 0 0 1px rgba(14,165,233,0.06), 0 0 40px rgba(0,0,0,0.4)",
        backdropFilter: "blur(28px)",
        WebkitBackdropFilter: "blur(28px)",
        animation: "scaleIn .14s var(--ease-out) both",
      }}
      onClick={e => e.stopPropagation()}
    >
      {/* Banner */}
      <div style={{
        height: 68,
        background: `linear-gradient(135deg, ${accentColor}30 0%, ${accentColor}10 50%, transparent 100%)`,
        position: "relative",
        overflow: "hidden",
        borderRadius: "16px 16px 0 0",
      }} />

      {/* Avatar — overlaps banner bottom, rendered outside banner so it isn't clipped */}
      <div style={{ position: "relative", height: 0 }}>
        <div style={{
          position: "absolute",
          top: -28,
          left: 14,
          padding: 3,
          borderRadius: "50%",
          background: "rgba(9,13,24,0.98)",
          display: "inline-block",
          boxShadow: `0 0 0 2px ${accentColor}40`,
          zIndex: 1,
        }}>
          <DiscordAvatar userId={userId} userName={displayName} avatarHash={avatarToUse} size={54} />
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: "30px 16px 16px" }}>
        {/* Name row */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 16, fontWeight: 800, color: "var(--t1)", letterSpacing: "-.3px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>
                {displayName}
              </span>
              {isBot && <BotBadge />}
            </div>
            {username && displayName !== username && (
              <div style={{ fontSize: 11, color: "var(--t4)", marginTop: 2 }}>@{username}</div>
            )}
          </div>
          {badgeMask > 0 && (
            <div style={{ flexShrink: 0, marginLeft: 6 }}>
              <DiscordUserBadges mask={badgeMask} size={16} />
            </div>
          )}
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: "var(--b0)", margin: "10px 0" }} />

        {/* Stats */}
        <div style={{ display: "flex", gap: 20, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".8px", color: "var(--t5)", marginBottom: 2 }}>Mesaj</div>
            {loading
              ? <div style={{ width: 40, height: 14, borderRadius: 4, background: "var(--g2)" }} className="skeleton" />
              : <div style={{ fontSize: 14, fontWeight: 800, color: "var(--blue)", fontFamily: "var(--mono)", letterSpacing: "-.5px" }}>{fmt(msgCount)}</div>
            }
          </div>
        </div>

        {/* User ID */}
        <div style={{ fontSize: 9, fontFamily: "var(--mono)", color: "var(--t5)", marginBottom: 12, letterSpacing: ".2px" }}>
          ID: {userId}
        </div>

        {/* View Profile button */}
        {onViewProfile && (
          <button
            className="btn btn-primary btn-sm"
            style={{ width: "100%", justifyContent: "center" }}
            onClick={() => { onViewProfile(userId); onClose(); }}
          >
            Profili Gör →
          </button>
        )}
      </div>
    </div>
  );
}
