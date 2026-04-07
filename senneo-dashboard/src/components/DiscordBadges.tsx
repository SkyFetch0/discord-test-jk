import React from "react";

/**
 * Discord User Flags (bitfield) + custom high bits for Nitro/Boost.
 *
 * Bits 0–22: Official Discord public_flags from message payload.
 * Bits 24–25: Custom flags set by the scraper:
 *   24 = Nitro (animated avatar heuristic)
 *   25 = Server Boost (member.premiumSince)
 */
export interface BadgeDef {
  id: string;
  bit: number;
  label: string;
  color: string;
  abbr: string;
  tier: "legendary" | "rare" | "uncommon" | "common";
}

export const FLAGS: BadgeDef[] = [
  { id: "staff",            bit: 1 << 0,  label: "Discord Staff",               color: "#5865F2", abbr: "ST", tier: "legendary" },
  { id: "partner",          bit: 1 << 1,  label: "Partnered Server Owner",       color: "#5865F2", abbr: "PA", tier: "rare"      },
  { id: "hypesquad_events", bit: 1 << 2,  label: "HypeSquad Events",             color: "#F5A623", abbr: "HS", tier: "rare"      },
  { id: "bug_hunter_1",     bit: 1 << 3,  label: "Bug Hunter",                   color: "#3BA55D", abbr: "BH", tier: "legendary" },
  { id: "house_bravery",    bit: 1 << 6,  label: "HypeSquad Bravery",            color: "#9B59B6", abbr: "HB", tier: "common"    },
  { id: "house_brilliance", bit: 1 << 7,  label: "HypeSquad Brilliance",         color: "#F47B67", abbr: "HI", tier: "common"    },
  { id: "house_balance",    bit: 1 << 8,  label: "HypeSquad Balance",            color: "#45DDC0", abbr: "HL", tier: "common"    },
  { id: "early_supporter",  bit: 1 << 9,  label: "Early Nitro Supporter",        color: "#F472B6", abbr: "ES", tier: "uncommon"  },
  { id: "bug_hunter_2",     bit: 1 << 14, label: "Bug Hunter Gold",              color: "#E8A62A", abbr: "BG", tier: "legendary" },
  { id: "verified_bot_dev", bit: 1 << 17, label: "Early Verified Bot Developer", color: "#5865F2", abbr: "BD", tier: "rare"      },
  { id: "mod_alumni",       bit: 1 << 18, label: "Moderator Programs Alumni",    color: "#F5A623", abbr: "MA", tier: "legendary" },
  { id: "nitro",            bit: 1 << 24, label: "Nitro Subscriber",             color: "#FF73FA", abbr: "N",  tier: "common"    },
  { id: "server_boost",     bit: 1 << 25, label: "Server Booster",               color: "#F47FFF", abbr: "SB", tier: "common"    },
];

export function decodePublicUserFlags(mask: number): BadgeDef[] {
  if (!mask || mask === 0) return [];
  return FLAGS.filter(f => (mask & f.bit) !== 0);
}

const BADGE_EXT: Record<string, string> = {
  early_supporter: "png",
};

export function BadgeIcon({ badge, size = 20 }: { badge: BadgeDef; size?: number }) {
  const ext = BADGE_EXT[badge.id] ?? "svg";
  const src = `/badges/${badge.id}.${ext}`;
  return (
    <div className="discord-badge" title={badge.label} style={{
      width: size, height: size, display: "inline-flex", alignItems: "center",
      justifyContent: "center", flexShrink: 0, cursor: "default",
    }}>
      <img
        src={src}
        alt={badge.label}
        width={size}
        height={size}
        style={{ objectFit: "contain", display: "block" }}
        onError={e => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
          const fb = e.currentTarget.nextSibling as HTMLElement | null;
          if (fb) fb.style.display = "flex";
        }}
      />
      <div style={{
        display: "none", width: size, height: size, borderRadius: "50%",
        alignItems: "center", justifyContent: "center", fontWeight: 800,
        fontSize: size * 0.42, background: badge.color, color: "#fff",
      }}>{badge.abbr}</div>
    </div>
  );
}

export function DiscordUserBadges({ mask, size = 20, showEmpty = false }: {
  mask: number | undefined | null;
  size?: number;
  showEmpty?: boolean;
}) {
  const badges = decodePublicUserFlags(Number(mask ?? 0));
  if (badges.length === 0) {
    if (!showEmpty) return null;
    return <span style={{ fontSize: 10, color: "var(--t5)", fontStyle: "italic" }}>Rozet yok</span>;
  }
  return (
    <div className="discord-badges-row" style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
      {badges.map(b => <BadgeIcon key={b.id} badge={b} size={size} />)}
    </div>
  );
}

export function BotBadge() {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      padding: "2px 8px", borderRadius: 4,
      background: "var(--blurple-d2)", color: "var(--blurple-l)",
      fontSize: 10, fontWeight: 700, letterSpacing: ".3px",
      border: "1px solid rgba(88,101,242,.2)",
    }}>
      BOT
    </span>
  );
}
