/**
 * Design system package — public API.
 *
 * Consumers should also import `ui/design-system/tokens.css` once at the
 * app root to ensure CSS custom properties are available.
 *
 * The backwards-compatible `ui/tokens.css` path continues to work.
 */

export { Button } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';
export {
  brandColors,
  neutralColors,
  semanticColors,
  colorTokens,
  fontSizeTokens,
  spacingTokens,
  borderRadiusTokens,
  fontWeightTokens,
} from './design-system/tokens';
