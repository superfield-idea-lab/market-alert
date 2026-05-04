/**
 * Design system tokens — JavaScript/TypeScript values.
 *
 * Exports token values for use in Tailwind configs so both apps/web and
 * apps/admin can extend their Tailwind themes from a single source of truth.
 *
 * Import in tailwind.config.ts:
 *   import { colorTokens, spacingTokens, fontSizeTokens } from 'ui/design-system/tokens';
 *
 * Canonical docs: calypso-blueprint/rules/blueprints/ux.yaml
 */

/** Brand color palette — indigo-based */
export const brandColors = {
  50: '#eef2ff',
  100: '#e0e7ff',
  200: '#c7d2fe',
  300: '#a5b4fc',
  400: '#818cf8',
  500: '#6366f1',
  600: '#4f46e5',
  700: '#4338ca',
  800: '#3730a3',
  900: '#312e81',
} as const;

/** Neutral color palette — zinc-based */
export const neutralColors = {
  0: '#ffffff',
  50: '#fafafa',
  100: '#f4f4f5',
  200: '#e4e4e7',
  300: '#d4d4d8',
  400: '#a1a1aa',
  500: '#71717a',
  600: '#52525b',
  700: '#3f3f46',
  800: '#27272a',
  900: '#18181b',
} as const;

/** Semantic status colors */
export const semanticColors = {
  success: '#22c55e',
  warning: '#f59e0b',
  error: '#ef4444',
  info: '#3b82f6',
} as const;

/** All color tokens for Tailwind theme extension */
export const colorTokens = {
  brand: brandColors,
  neutral: neutralColors,
  success: semanticColors.success,
  warning: semanticColors.warning,
  error: semanticColors.error,
  info: semanticColors.info,
} as const;

/** Font size scale — rem units, base 16 px */
export const fontSizeTokens = {
  xs: '0.75rem', // 12 px
  sm: '0.875rem', // 14 px
  md: '1rem', // 16 px
  lg: '1.125rem', // 18 px
  xl: '1.25rem', // 20 px
  '2xl': '1.5rem', // 24 px
  '3xl': '1.875rem', // 30 px
  '4xl': '2.25rem', // 36 px
} as const;

/** Spacing scale — rem units, base 4 px */
export const spacingTokens = {
  0: '0',
  1: '0.25rem', // 4 px
  2: '0.5rem', // 8 px
  3: '0.75rem', // 12 px
  4: '1rem', // 16 px
  5: '1.25rem', // 20 px
  6: '1.5rem', // 24 px
  8: '2rem', // 32 px
  10: '2.5rem', // 40 px
  12: '3rem', // 48 px
  16: '4rem', // 64 px
  20: '5rem', // 80 px
  24: '6rem', // 96 px
} as const;

/** Border radius scale */
export const borderRadiusTokens = {
  sm: '0.25rem', // 4 px
  md: '0.375rem', // 6 px
  lg: '0.5rem', // 8 px
  xl: '0.75rem', // 12 px
  full: '9999px',
} as const;

/** Font weight scale */
export const fontWeightTokens = {
  normal: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;
