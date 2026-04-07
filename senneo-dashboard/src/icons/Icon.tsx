import React from "react";
import { CUSTOM_ICONS, type CustomIconName } from "./custom";
import { LUCIDE_MAP, type LucideIconName } from "./lucide";

export type IconName = CustomIconName | LucideIconName;

/* Stroke width scale: keeps visual weight consistent across sizes */
function strokeForSize(size: number): number {
  if (size <= 14) return 1.3;
  if (size <= 16) return 1.4;
  if (size <= 20) return 1.5;
  if (size <= 24) return 1.6;
  return 1.8;
}

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  /** Decorative icons get aria-hidden; meaningful ones need a label */
  "aria-label"?: string;
  onClick?: React.MouseEventHandler;
}

/**
 * Unified icon component.
 * - Custom SVGs (brand / hand-drawn) from `./custom`
 * - Lucide icons (standard UI) from `./lucide`
 * - Consistent stroke width, viewBox, and sizing
 */
export function Icon({ name, size = 16, className, style, "aria-label": ariaLabel, onClick }: IconProps) {
  const customSvg = CUSTOM_ICONS[name as CustomIconName];
  if (customSvg) {
    const sw = strokeForSize(size);
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={sw}
        width={size}
        height={size}
        className={className}
        style={style}
        onClick={onClick}
        role={ariaLabel ? "img" : undefined}
        aria-label={ariaLabel}
        aria-hidden={!ariaLabel ? true : undefined}
      >
        {customSvg}
      </svg>
    );
  }

  const LucideComponent = LUCIDE_MAP[name as LucideIconName];
  if (LucideComponent) {
    return (
      <LucideComponent
        size={size}
        strokeWidth={strokeForSize(size)}
        className={className}
        style={style}
        onClick={onClick}
        role={ariaLabel ? "img" : undefined}
        aria-label={ariaLabel}
        aria-hidden={!ariaLabel ? true : undefined}
      />
    );
  }

  // Fallback: render nothing rather than crash
  if (import.meta.env.DEV) {
    console.warn(`[Icon] Unknown icon name: "${name}"`);
  }
  return null;
}
