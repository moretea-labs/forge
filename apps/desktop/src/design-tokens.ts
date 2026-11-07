import type { CSSProperties } from 'react';
import designTokens from '../../../.design-harness/tokens.json';

// Forge Design's Git-tracked tokens are the sole source of visual variables.
export const desktopThemeStyle = {
  '--ink': designTokens.color.textPrimary,
  '--muted': designTokens.color.textSecondary,
  '--subtle': designTokens.color.textTertiary,
  '--accent': designTokens.color.accent,
  '--accent-soft': designTokens.color.accentSoft,
  '--line': designTokens.color.border,
  '--border-strong': designTokens.color.borderStrong,
  '--surface': designTokens.color.surface,
  '--surface-muted': designTokens.color.surfaceMuted,
  '--panel': designTokens.color.surfaceGlass,
  '--glass': designTokens.color.sidebarGlass,
  '--popover': designTokens.color.popoverGlass,
  '--canvas': designTokens.color.canvas,
  '--canvas-raised': designTokens.color.canvasRaised,
  '--composer-bg': designTokens.color.composerGlass,
  '--hover': designTokens.color.hover,
  '--focus': designTokens.color.focus,
  '--shadow-popover': designTokens.shadow.popover,
  '--shadow-composer': designTokens.shadow.composer,
  '--radius-control': `${designTokens.radius.control}px`,
  '--radius-surface': `${designTokens.radius.surface}px`,
} as CSSProperties;
