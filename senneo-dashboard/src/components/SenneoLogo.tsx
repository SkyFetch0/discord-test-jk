import React from 'react';

interface SenneoLogoProps {
  size?: number;
  color?: string;
  glowIntensity?: 'none' | 'subtle' | 'normal' | 'strong';
  className?: string;
  style?: React.CSSProperties;
}

export function SenneoLogo({
  size = 24,
  glowIntensity = 'normal',
  className,
  style,
}: SenneoLogoProps) {
  const glowColor = '#3A97C8';
  const glowStyle: React.CSSProperties =
    glowIntensity === 'none'   ? {} :
    glowIntensity === 'subtle' ? { filter: `drop-shadow(0 0 4px ${glowColor}99)` } :
    glowIntensity === 'normal' ? { filter: `drop-shadow(0 0 6px ${glowColor}BB) drop-shadow(0 0 12px ${glowColor}66)` } :
    /* strong */                 { filter: `drop-shadow(0 0 8px ${glowColor}) drop-shadow(0 0 18px ${glowColor}AA) drop-shadow(0 0 30px ${glowColor}55)` };

  return (
    <img
      src="/SenNeo.svg"
      width={size}
      height={size}
      alt="Senneo"
      className={className}
      style={{ display: 'block', objectFit: 'contain', ...glowStyle, ...style }}
    />
  );
}

export default SenneoLogo;
