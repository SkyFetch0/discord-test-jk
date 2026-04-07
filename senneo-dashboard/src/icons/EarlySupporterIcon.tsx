import React from "react";

interface Props {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  "aria-label"?: string;
}

export function EarlySupporterIcon({ size = 24, className, style, "aria-label": ariaLabel }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      style={style}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
      aria-hidden={!ariaLabel ? true : undefined}
    >
      {/* Pavilion (lower half) — slightly deeper magenta */}
      <polygon points="3,12 21,12 12,21" fill="#C026D3" />
      {/* Crown (upper half) — main fuchsia pink */}
      <polygon points="12,3 21,12 3,12" fill="#E879F9" />
      {/* Center crown facet — lighter highlight */}
      <polygon points="12,3 16.5,10.5 12,10 7.5,10.5" fill="#F0ABFC" />
      {/* White diagonal highlight stripe 1 */}
      <line x1="6" y1="8" x2="9" y2="5" stroke="white" strokeWidth="1.5" strokeLinecap="round" opacity="0.8" />
      {/* White diagonal highlight stripe 2 */}
      <line x1="5.5" y1="11" x2="7.5" y2="8.5" stroke="white" strokeWidth="1" strokeLinecap="round" opacity="0.55" />
      {/* Large yellow 4-pointed star — top right */}
      <path d="M21 1 L21.5 2.5 L23 3 L21.5 3.5 L21 5 L20.5 3.5 L19 3 L20.5 2.5 Z" fill="#FBBF24" />
      {/* Small yellow 4-pointed star — top left */}
      <path d="M3 2.5 L3.35 3.65 L4.5 4 L3.35 4.35 L3 5.5 L2.65 4.35 L1.5 4 L2.65 3.65 Z" fill="#FBBF24" />
      {/* Blue-gray sparkle — mid right */}
      <path d="M22 8 L22.3 8.7 L23 9 L22.3 9.3 L22 10 L21.7 9.3 L21 9 L21.7 8.7 Z" fill="#CBD5E1" />
      {/* Blue-gray sparkle — left */}
      <path d="M1.5 7.5 L1.8 8.2 L2.5 8.5 L1.8 8.8 L1.5 9.5 L1.2 8.8 L0.5 8.5 L1.2 8.2 Z" fill="#CBD5E1" />
    </svg>
  );
}
