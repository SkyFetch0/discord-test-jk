import React from "react";
import { useCountUp, fmt } from "../hooks";

/* ── 6 Stat SVG Icons (consistent stroke style, 24x24 viewBox, currentColor) ── */
export const StatIcons = {
  satellite: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 7L9 3 3 9l4 4" /><path d="M17 11l4 4-6 6-4-4" />
      <path d="M8 12l4 4" /><circle cx="16" cy="8" r="2" />
      <path d="M3 21c3-3 6.5-6.5 10-8" />
    </svg>
  ),
  database: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" />
      <path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
    </svg>
  ),
  zap: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
  monitor: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8" /><path d="M12 17v4" />
    </svg>
  ),
  users: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 00-3-3.87" />
      <path d="M16 3.13a4 4 0 010 7.75" />
    </svg>
  ),
  bot: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="8" width="18" height="12" rx="3" />
      <circle cx="9" cy="14" r="1.5" fill="currentColor" /><circle cx="15" cy="14" r="1.5" fill="currentColor" />
      <path d="M12 2v4" /><path d="M8 6h8" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  ),
  radio: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="12" cy="12" r="2" fill="currentColor" />
      <path d="M16.24 7.76a6 6 0 010 8.49" /><path d="M19.07 4.93a10 10 0 010 14.14" />
      <path d="M7.76 16.24a6 6 0 010-8.49" /><path d="M4.93 19.07a10 10 0 010-14.14" />
    </svg>
  ),
  clock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" />
    </svg>
  ),
} as const;

export type StatIconName = keyof typeof StatIcons;

/* ── StatCardV2 — Premium animated stat card with SVG icon + glow ── */
interface StatCardV2Props {
  label: string;
  value: number;
  sub?: string;
  color: string;
  icon: StatIconName | React.ReactNode;
  delay?: number;
}

export function StatCardV2({ label, value, sub, color, icon, delay = 0 }: StatCardV2Props) {
  const animated = useCountUp(value);

  const iconEl = typeof icon === "string" ? StatIcons[icon as StatIconName] : icon;

  return (
    <div
      className="stat-card-v2"
      style={{
        "--accent": color,
        animationDelay: `${delay}ms`,
      } as React.CSSProperties}
    >
      {/* Glow background */}
      <div className="stat-card-v2-glow" />

      {/* Icon */}
      <div className="stat-card-v2-icon" style={{ color }}>
        {iconEl}
      </div>

      {/* Text */}
      <div className="stat-card-v2-label">{label}</div>
      <div className="stat-card-v2-value" style={{ color }}>
        {animated.toLocaleString("tr-TR")}
      </div>
      {sub && <div className="stat-card-v2-sub">{sub}</div>}
    </div>
  );
}

/* ── GlowCard — reusable premium panel with glow border ── */
interface GlowCardProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  accent?: string;
}

export function GlowCard({ children, className, style, accent }: GlowCardProps) {
  return (
    <div
      className={`glow-card ${className ?? ""}`}
      style={{ "--accent": accent ?? "var(--blurple)", ...style } as React.CSSProperties}
    >
      {children}
    </div>
  );
}
