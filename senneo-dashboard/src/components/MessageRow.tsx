import React, { useState, useCallback } from "react";
import type { Message } from "../types";
import { api } from "../api";
import { DiscordAvatar } from "./DiscordAvatar";
import { BotBadge } from "./DiscordBadges";

export interface UserClickPayload {
  userId: string;
  userName?: string;
  avatarHash?: string | null;
  anchor: { x: number; y: number };
}

/* ── TZ-aware full date+time formatter (Europe/Istanbul, tr-TR) ── */
const DATE_FMT = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const UTC_FMT = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "UTC",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function fmtFullDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try { return DATE_FMT.format(new Date(iso)); }
  catch { return iso; }
}

export function fmtUtcDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try { return UTC_FMT.format(new Date(iso)) + " UTC"; }
  catch { return iso; }
}

/* ── Avatar — delegates to shared DiscordAvatar ── */
export function MsgAvatar({ authorId, authorName, authorAvatar, size = 36, onClick }: {
  authorId: string; authorName?: string; authorAvatar?: string | null; size?: number;
  onClick?: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{ cursor: onClick ? "pointer" : undefined, flexShrink: 0 }}
      title={onClick ? "Profili gör" : undefined}
    >
      <DiscordAvatar
        userId={authorId}
        userName={authorName}
        avatarHash={authorAvatar}
        size={size}
        className="msgrow-avatar"
      />
    </div>
  );
}

/* ── Guild badge ── */
function GuildBadge({ guildId, guildName }: { guildId?: string; guildName?: string | null }) {
  if (!guildId) return null;
  const display = guildName || guildId.slice(-6);
  const tip = guildName ? `${guildName} · ${guildId}` : guildId;
  return (
    <span className="msgrow-guild" data-tip={tip} title={tip}>
      {display}
    </span>
  );
}

/* ── Channel badge ── */
function ChannelBadge({ channelId, channelName }: { channelId: string; channelName?: string | null }) {
  const display = channelName ? `#${channelName}` : `#${channelId.slice(-6)}`;
  const tip = channelName ? `${channelName} · ${channelId}` : channelId;
  return (
    <span className="msgrow-channel" data-tip={tip} title={tip}>
      {display}
    </span>
  );
}

/* ── Highlight matching keyword in text ── */
export function Highlight({ text, keyword }: { text: string; keyword?: string }) {
  if (!keyword || !text) return <>{text}</>;
  try {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = text.split(new RegExp(`(${escaped})`, "gi"));
    return (
      <>
        {parts.map((part, i) =>
          part.toLowerCase() === keyword.toLowerCase() ? (
            <mark key={i} className="highlight">{part}</mark>
          ) : (
            <span key={i}>{part}</span>
          )
        )}
      </>
    );
  } catch {
    return <>{text}</>;
  }
}

/* ── Reply preview bar + expanded quote ── */
function hasReply(refId: string | null | undefined): boolean {
  return !!refId && refId !== "0" && refId !== "";
}

type ReplyState = null | "loading" | "error" | Message;

function ReplyBar({ refMsgId }: { refMsgId: string }) {
  const [state, setState] = useState<ReplyState>(null);

  const load = useCallback(async () => {
    if (state !== null) {
      /* toggle: if already loaded/error, collapse */
      setState(null);
      return;
    }
    setState("loading");
    try {
      const res = await (api.messages.byId(refMsgId) as Promise<Message>);
      setState((res as any)?.message_id ? (res as unknown as Message) : "error");
    } catch {
      setState("error");
    }
  }, [refMsgId, state]);

  const isOpen = state !== null;

  return (
    <>
      <div
        className={`msgrow-reply-bar${isOpen ? " open" : ""}`}
        onClick={load}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") load(); }}
        title={isOpen ? "Yanıtı kapat" : "Yanıtı göster"}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
             style={{ width: 12, height: 12, flexShrink: 0, opacity: 0.55 }}>
          <path d="M6 3L2 7l4 4" /><path d="M2 7h9a3 3 0 013 3v2" />
        </svg>
        <span className="msgrow-reply-label">Yanıt verilen</span>
        <span className="msgrow-reply-id">{refMsgId.slice(-8)}</span>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"
             style={{ width: 10, height: 10, opacity: 0.4, marginLeft: 2, transform: isOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }}>
          <path d="M4 6l4 4 4-4" />
        </svg>
      </div>

      {/* Expanded reply quote */}
      {state === "loading" && (
        <div className="reply-quote">
          <div style={{ width: 80, height: 11, borderRadius: 4, background: "var(--g2)" }} className="skeleton" />
        </div>
      )}
      {state === "error" && (
        <div className="reply-quote reply-quote-error">Mesaj bulunamadı</div>
      )}
      {state !== null && state !== "loading" && state !== "error" && (
        <div className="reply-quote">
          <MsgAvatar
            authorId={state.author_id}
            authorName={state.display_name || state.author_name}
            authorAvatar={state.author_avatar}
            size={18}
          />
          <span className="reply-quote-author">{state.nick || state.display_name || state.author_name || state.author_id}</span>
          <span className="reply-quote-text">
            {state.content
              ? state.content.slice(0, 140) + (state.content.length > 140 ? "…" : "")
              : state.media_urls?.length
              ? "[resim/dosya]"
              : "[içerik yok]"}
          </span>
        </div>
      )}
    </>
  );
}

/* ── MessageRow — shared between LiveFeed and Search ── */
export interface MessageRowProps {
  msg: Message;
  keyword?: string;
  showMedia?: boolean;
  animate?: boolean;
  animDelay?: number;
  onViewThread?: (messageId: string) => void;
  onUserClick?: (payload: UserClickPayload) => void;
}

export function MessageRow({ msg, keyword, showMedia = true, animate = false, animDelay = 0, onViewThread, onUserClick }: MessageRowProps) {
  const displayName = msg.nick || msg.display_name || msg.author_name || msg.author_id;
  const isBot = Number(msg.is_bot ?? 0) === 1;
  const showReply = hasReply(msg.ref_msg_id);

  function handleUserClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (!onUserClick) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onUserClick({
      userId: msg.author_id,
      userName: msg.display_name || msg.author_name,
      avatarHash: msg.author_avatar,
      anchor: { x: rect.right, y: rect.top },
    });
  }

  return (
    <div
      className="msgrow"
      style={animate ? { animation: `slideUp .2s ease ${animDelay}ms both` } : undefined}
    >
      <MsgAvatar
        authorId={msg.author_id}
        authorName={msg.display_name || msg.author_name}
        authorAvatar={msg.author_avatar}
        size={36}
        onClick={onUserClick ? handleUserClick : undefined}
      />

      <div className="msgrow-body">
        {showReply && <ReplyBar refMsgId={msg.ref_msg_id!} />}

        <div className="msgrow-meta">
          <span
            className="msgrow-author"
            onClick={onUserClick ? handleUserClick : undefined}
            style={onUserClick ? { cursor: "pointer" } : undefined}
          >
            {displayName}
          </span>
          {isBot && <BotBadge />}
          <GuildBadge guildId={msg.guild_id} guildName={msg.guild_name} />
          <ChannelBadge channelId={msg.channel_id} channelName={msg.channel_name} />
          <span className="msgrow-ts" data-tip={fmtUtcDate(msg.ts)}>
            {fmtFullDate(msg.ts)}
          </span>
        </div>

        {msg.content ? (
          <div className="msgrow-text">
            {keyword ? <Highlight text={msg.content} keyword={keyword} /> : msg.content}
          </div>
        ) : (
          <div className="msgrow-text msgrow-text-empty">İçerik yok</div>
        )}

        {showMedia &&
          msg.media_urls
            ?.filter((u: string) => /\.(png|jpg|jpeg|gif|webp)$/i.test(u))
            .slice(0, 2)
            .map((url: string, i: number) => (
              <img
                key={i}
                src={url}
                alt=""
                loading="lazy"
                className="msgrow-media"
                onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
              />
            ))}
      </div>
    </div>
  );
}

/* ── Grouped messages (consecutive same author+channel) for LiveFeed ── */
export interface MessageGroup {
  author_id: string;
  author_name: string;
  author_avatar?: string | null;
  channel_id: string;
  channel_name?: string | null;
  ts: string;
  messages: Message[];
}

export function groupMessages(msgs: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const m of msgs) {
    const last = groups[groups.length - 1];
    if (last && last.author_id === m.author_id && last.channel_id === m.channel_id) {
      last.messages.push(m);
    } else {
      groups.push({
        author_id: m.author_id,
        author_name: m.author_name || m.author_id,
        author_avatar: m.author_avatar,
        channel_id: m.channel_id,
        channel_name: m.channel_name,
        ts: m.ts,
        messages: [m],
      });
    }
  }
  return groups;
}

export function MessageGroupRow({ group, showMedia = true, onUserClick }: { group: MessageGroup; showMedia?: boolean; onUserClick?: (p: UserClickPayload) => void }) {
  function handleUserClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (!onUserClick) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onUserClick({
      userId: group.author_id,
      userName: group.author_name,
      avatarHash: group.author_avatar,
      anchor: { x: rect.right, y: rect.top },
    });
  }

  return (
    <div className="msgrow msgrow-group">
      <MsgAvatar
        authorId={group.author_id}
        authorName={group.author_name}
        authorAvatar={group.author_avatar}
        size={40}
        onClick={onUserClick ? handleUserClick : undefined}
      />
      <div className="msgrow-body">
        <div className="msgrow-meta">
          <span
            className="msgrow-author"
            onClick={onUserClick ? handleUserClick : undefined}
            style={onUserClick ? { cursor: "pointer" } : undefined}
          >{group.author_name}</span>
          <ChannelBadge channelId={group.channel_id} channelName={group.channel_name} />
          <span className="msgrow-ts" data-tip={fmtUtcDate(group.ts)}>
            {fmtFullDate(group.ts)}
          </span>
        </div>
        {group.messages.map((m) => (
          <div key={m.message_id}>
            {m.content ? (
              <div className="msgrow-text">{m.content}</div>
            ) : (
              <div className="msgrow-text msgrow-text-empty">İçerik yok</div>
            )}
            {showMedia &&
              m.media_urls
                ?.filter((u: string) => /\.(png|jpg|jpeg|gif|webp)$/i.test(u))
                .slice(0, 2)
                .map((url: string, i: number) => (
                  <img
                    key={i}
                    src={url}
                    alt=""
                    loading="lazy"
                    className="msgrow-media"
                    onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                  />
                ))}
          </div>
        ))}
      </div>
    </div>
  );
}
