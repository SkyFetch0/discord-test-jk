import React from "react";

/**
 * Custom hand-drawn / brand-specific SVG icon paths.
 * All designed for viewBox="0 0 16 16", stroke="currentColor", fill="none".
 * Used by Icon.tsx — do NOT render these standalone.
 */

export const CUSTOM_ICONS = {
  grid: <>
    <rect x="1" y="1" width="6" height="6" rx="1.5"/>
    <rect x="9" y="1" width="6" height="6" rx="1.5"/>
    <rect x="1" y="9" width="6" height="6" rx="1.5"/>
    <rect x="9" y="9" width="6" height="6" rx="1.5"/>
  </>,
  clock: <>
    <circle cx="8" cy="8" r="5.5"/>
    <path d="M8 5.5V8l1.5 1.5"/>
  </>,
  "search-custom": <>
    <circle cx="7" cy="7" r="4.5"/>
    <path d="M10.5 10.5l3 3"/>
  </>,
  db: <>
    <ellipse cx="8" cy="4.5" rx="5.5" ry="2"/>
    <path d="M2.5 4.5v3c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2v-3"/>
    <path d="M2.5 7.5v3c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2v-3"/>
  </>,
  account: <>
    <circle cx="8" cy="6" r="3"/>
    <path d="M2 14c0-3.3 2.7-5 6-5s6 1.7 6 5"/>
  </>,
  live: <>
    <path d="M3 8a5 5 0 0110 0"/>
    <path d="M5.5 8a2.5 2.5 0 015 0"/>
    <circle cx="8" cy="8" r="1" fill="currentColor"/>
  </>,
  chart: <>
    <path d="M2 12l3.5-4 3 2.5L12 5l2 2"/>
    <rect x="1" y="1" width="14" height="14" rx="1.5"/>
  </>,
  "close-x": <>
    <path d="M4 4l8 8M12 4l-8 8" strokeWidth="1.5"/>
  </>,
  "plus-icon": <>
    <path d="M8 3v10M3 8h10" strokeWidth="1.5"/>
  </>,
  trash: <>
    <path d="M3 4h10M5 4V3a1 1 0 011-1h4a1 1 0 011 1v1M6 7v5M10 7v5M4 4l1 9h6l1-9"/>
  </>,
  "refresh-cw": <>
    <path d="M13.5 8A5.5 5.5 0 112.5 5"/>
    <path d="M2.5 2v3h3"/>
  </>,
  "users-custom": <>
    <circle cx="6" cy="5" r="2.5"/>
    <path d="M1 13c0-3 2-4.5 5-4.5s5 1.5 5 4.5"/>
    <circle cx="12" cy="5" r="2"/>
    <path d="M14 13c0-2-1.2-3.5-3-4"/>
  </>,
  hash: <>
    <path d="M6 3L4 13M12 3l-2 10M2 6h12M2 10h12"/>
  </>,
  widget: <>
    <rect x="1" y="1" width="6" height="6" rx="1"/>
    <rect x="9" y="1" width="6" height="4" rx="1"/>
    <rect x="9" y="7" width="6" height="8" rx="1"/>
    <rect x="1" y="9" width="6" height="6" rx="1"/>
  </>,
  bot: <>
    <rect x="3" y="4" width="10" height="8" rx="2"/>
    <circle cx="6" cy="8" r="1" fill="currentColor"/>
    <circle cx="10" cy="8" r="1" fill="currentColor"/>
    <path d="M8 4V2"/>
    <circle cx="8" cy="1.5" r=".8" fill="currentColor"/>
    <path d="M1 8h2M13 8h2"/>
  </>,
  target: <>
    <circle cx="8" cy="8" r="6"/>
    <circle cx="8" cy="8" r="3"/>
    <circle cx="8" cy="8" r=".8" fill="currentColor"/>
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2"/>
  </>,
  speed: <>
    <path d="M2.5 11A6.5 6.5 0 0113.5 11"/>
    <path d="M8 11V6" strokeLinecap="round"/>
    <circle cx="8" cy="11" r="1.2" fill="currentColor"/>
  </>,
  channel: <>
    <path d="M6 2L4.5 14M11.5 2L10 14M2 5.5h12M2 10.5h12"/>
  </>,
  server: <>
    <rect x="2" y="1.5" width="12" height="4" rx="1"/>
    <rect x="2" y="7" width="12" height="4" rx="1"/>
    <circle cx="5" cy="3.5" r=".7" fill="currentColor"/>
    <circle cx="5" cy="9" r=".7" fill="currentColor"/>
    <path d="M8 11v2.5M5 13.5h6"/>
  </>,
} as const;

export type CustomIconName = keyof typeof CUSTOM_ICONS;
