import React, { useState } from "react";

/**
 * Shared Discord avatar component — single source of truth.
 * Used by MessageRow, UserProfile, UserRow, and any other place that shows a user avatar.
 *
 * Fallback chain:
 *   1. Real CDN avatar (hash available, a_ prefix → .gif for animated)
 *   2. Discord embed default avatar (index based on user ID)
 *   3. Color circle + initial letter
 */

export function discordAvatarUrl(authorId: string, avatarHash: string, size = 80): string {
  const ext = avatarHash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${authorId}/${avatarHash}.${ext}?size=${size}`;
}

export function defaultAvatarUrl(userId: string): string {
  const idx = Math.abs([...userId].reduce((a, c) => a + c.charCodeAt(0), 0)) % 6;
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

export function avatarColorFromId(seed: string): string {
  const palette = ["#0EA5E9", "#30D158", "#BF5AF2", "#FF9F0A", "#FF453A", "#38BDF8", "#0284C7", "#5AC8FA"];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = seed.charCodeAt(i) + ((h << 5) - h);
  return palette[Math.abs(h) % palette.length];
}

export interface DiscordAvatarProps {
  userId: string;
  userName?: string;
  avatarHash?: string | null;
  size?: number;
  className?: string;
}

export function DiscordAvatar({ userId, userName, avatarHash, size = 36, className }: DiscordAvatarProps) {
  const [imgErr, setImgErr] = useState(false);
  const [fallbackErr, setFallbackErr] = useState(false);
  const color = avatarColorFromId(userId);
  const initial = ((userName ?? userId)?.[0] ?? "?").toUpperCase();

  const cleanHash = avatarHash && avatarHash !== '0' && avatarHash !== 'null' && avatarHash !== 'undefined' ? avatarHash : null;
  const realUrl = cleanHash ? discordAvatarUrl(userId, cleanHash, size > 64 ? 128 : 80) : null;
  const fallbackUrl = defaultAvatarUrl(userId);
  const showUrl = !imgErr ? (realUrl ?? fallbackUrl) : (!fallbackErr ? fallbackUrl : null);

  return (
    <div
      className={className ?? "discord-avatar"}
      role="img"
      aria-label={userName ?? userId}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: showUrl ? "transparent" : color,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.4,
        fontWeight: 700,
        color: "#fff",
        overflow: "hidden",
        flexShrink: 0,
      }}
      data-tip={userName ?? userId}
    >
      {showUrl ? (
        <img
          src={showUrl}
          alt=""
          onError={() => {
            if (!imgErr) setImgErr(true);
            else setFallbackErr(true);
          }}
          style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover" }}
          loading="lazy"
        />
      ) : (
        initial
      )}
    </div>
  );
}
