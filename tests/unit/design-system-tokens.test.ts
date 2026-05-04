/**
 * @file design-system-tokens.test.ts
 *
 * Unit tests asserting that the design system token values exported from
 * packages/ui/design-system/tokens match the expected design specification.
 *
 * These tests do not import from apps/ — they verify the source-of-truth
 * token module directly so any accidental value drift is caught immediately.
 *
 * No mocks — this test imports real values and asserts them against a
 * fixed specification. If the spec changes, update both the tokens module
 * and this test.
 *
 * Canonical docs: docs/plan.md § "Design system skeleton"
 * Blueprint ref: blueprint/rules/blueprints/ux.yaml § UX-D-001
 */

import { describe, it, expect } from 'vitest';
import {
  brandColors,
  neutralColors,
  semanticColors,
  colorTokens,
  fontSizeTokens,
  spacingTokens,
  borderRadiusTokens,
  fontWeightTokens,
} from '../../packages/ui/design-system/tokens';

// ---------------------------------------------------------------------------
// Brand color palette — indigo-based
// ---------------------------------------------------------------------------

describe('brandColors', () => {
  it('has all 10 scale steps', () => {
    const expected = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'] as const;
    for (const step of expected) {
      expect(brandColors).toHaveProperty(step);
    }
  });

  it('uses the correct indigo hex values', () => {
    expect(brandColors[50]).toBe('#eef2ff');
    expect(brandColors[100]).toBe('#e0e7ff');
    expect(brandColors[500]).toBe('#6366f1');
    expect(brandColors[600]).toBe('#4f46e5');
    expect(brandColors[700]).toBe('#4338ca');
    expect(brandColors[900]).toBe('#312e81');
  });
});

// ---------------------------------------------------------------------------
// Neutral color palette — zinc-based
// ---------------------------------------------------------------------------

describe('neutralColors', () => {
  it('has all 11 scale steps including 0 (white)', () => {
    const expected = [
      '0',
      '50',
      '100',
      '200',
      '300',
      '400',
      '500',
      '600',
      '700',
      '800',
      '900',
    ] as const;
    for (const step of expected) {
      expect(neutralColors).toHaveProperty(step);
    }
  });

  it('uses the correct zinc hex values', () => {
    expect(neutralColors[0]).toBe('#ffffff');
    expect(neutralColors[50]).toBe('#fafafa');
    expect(neutralColors[900]).toBe('#18181b');
  });
});

// ---------------------------------------------------------------------------
// Semantic colors
// ---------------------------------------------------------------------------

describe('semanticColors', () => {
  it('defines success, warning, error, info', () => {
    expect(semanticColors.success).toBe('#22c55e');
    expect(semanticColors.warning).toBe('#f59e0b');
    expect(semanticColors.error).toBe('#ef4444');
    expect(semanticColors.info).toBe('#3b82f6');
  });
});

// ---------------------------------------------------------------------------
// Color tokens (Tailwind theme extension)
// ---------------------------------------------------------------------------

describe('colorTokens', () => {
  it('exposes brand and neutral sub-objects', () => {
    expect(colorTokens.brand).toEqual(brandColors);
    expect(colorTokens.neutral).toEqual(neutralColors);
  });

  it('exposes semantic colors at top level', () => {
    expect(colorTokens.success).toBe(semanticColors.success);
    expect(colorTokens.warning).toBe(semanticColors.warning);
    expect(colorTokens.error).toBe(semanticColors.error);
    expect(colorTokens.info).toBe(semanticColors.info);
  });
});

// ---------------------------------------------------------------------------
// Font size scale — rem units, base 16 px
// ---------------------------------------------------------------------------

describe('fontSizeTokens', () => {
  it('has xs through 4xl', () => {
    const expected = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl'] as const;
    for (const step of expected) {
      expect(fontSizeTokens).toHaveProperty(step);
    }
  });

  it('xs is 0.75rem (12 px)', () => {
    expect(fontSizeTokens.xs).toBe('0.75rem');
  });

  it('sm is 0.875rem (14 px)', () => {
    expect(fontSizeTokens.sm).toBe('0.875rem');
  });

  it('md is 1rem (16 px)', () => {
    expect(fontSizeTokens.md).toBe('1rem');
  });

  it('lg is 1.125rem (18 px)', () => {
    expect(fontSizeTokens.lg).toBe('1.125rem');
  });

  it('2xl is 1.5rem (24 px)', () => {
    expect(fontSizeTokens['2xl']).toBe('1.5rem');
  });

  it('4xl is 2.25rem (36 px)', () => {
    expect(fontSizeTokens['4xl']).toBe('2.25rem');
  });
});

// ---------------------------------------------------------------------------
// Spacing scale — rem units, base 4 px
// ---------------------------------------------------------------------------

describe('spacingTokens', () => {
  it('spacing-1 is 0.25rem (4 px)', () => {
    expect(spacingTokens[1]).toBe('0.25rem');
  });

  it('spacing-2 is 0.5rem (8 px)', () => {
    expect(spacingTokens[2]).toBe('0.5rem');
  });

  it('spacing-4 is 1rem (16 px)', () => {
    expect(spacingTokens[4]).toBe('1rem');
  });

  it('spacing-8 is 2rem (32 px)', () => {
    expect(spacingTokens[8]).toBe('2rem');
  });

  it('spacing-16 is 4rem (64 px)', () => {
    expect(spacingTokens[16]).toBe('4rem');
  });
});

// ---------------------------------------------------------------------------
// Border radius scale
// ---------------------------------------------------------------------------

describe('borderRadiusTokens', () => {
  it('sm is 0.25rem (4 px)', () => {
    expect(borderRadiusTokens.sm).toBe('0.25rem');
  });

  it('md is 0.375rem (6 px)', () => {
    expect(borderRadiusTokens.md).toBe('0.375rem');
  });

  it('lg is 0.5rem (8 px)', () => {
    expect(borderRadiusTokens.lg).toBe('0.5rem');
  });

  it('full is 9999px', () => {
    expect(borderRadiusTokens.full).toBe('9999px');
  });
});

// ---------------------------------------------------------------------------
// Font weight scale
// ---------------------------------------------------------------------------

describe('fontWeightTokens', () => {
  it('normal is 400', () => {
    expect(fontWeightTokens.normal).toBe('400');
  });

  it('medium is 500', () => {
    expect(fontWeightTokens.medium).toBe('500');
  });

  it('semibold is 600', () => {
    expect(fontWeightTokens.semibold).toBe('600');
  });

  it('bold is 700', () => {
    expect(fontWeightTokens.bold).toBe('700');
  });
});
