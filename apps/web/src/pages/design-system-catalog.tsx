/**
 * @file design-system-catalog.tsx — apps/web design system catalog page
 *
 * ## Phase 0 — Design system skeleton
 *
 * Static catalog page that renders all design system tokens and the Button
 * primitive. Used as the visual baseline for Playwright screenshot review.
 *
 * ## Canonical docs
 * - docs/plan.md § Phase 0: "Design system skeleton"
 * - blueprint/rules/blueprints/ux.yaml § UX-D-001, UX-C-001
 *
 * ## Integration points
 * - Imports Button from packages/ui (no tree-shaking risk — this is a catalog)
 * - CSS custom properties from packages/ui/design-system/tokens.css must be
 *   loaded at the app root (main.tsx) before this page renders
 */

import React from 'react';
import { Button } from '../../../../packages/ui/Button';

interface SwatchProps {
  variable: string;
  label: string;
  value: string;
}

function ColorSwatch({ variable, label, value }: SwatchProps) {
  return (
    <div
      style={{
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        border: '1px solid var(--color-border-subtle)',
        boxShadow: 'var(--shadow-sm)',
        minWidth: 120,
      }}
    >
      <div style={{ height: 56, background: `var(${variable})` }} />
      <div
        style={{
          padding: 'var(--spacing-2)',
          background: 'var(--color-surface-base)',
        }}
      >
        <div
          style={{
            fontSize: 'var(--font-size-xs)',
            fontWeight: 'var(--font-weight-medium)' as React.CSSProperties['fontWeight'],
            color: 'var(--color-text-primary)',
            marginBottom: 'var(--spacing-1)',
            wordBreak: 'break-all',
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontFamily: 'var(--font-family-mono)',
            fontSize: '10px',
            color: 'var(--color-text-secondary)',
          }}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        fontSize: 'var(--font-size-lg)',
        fontWeight: 'var(--font-weight-semibold)' as React.CSSProperties['fontWeight'],
        marginBottom: 'var(--spacing-6)',
        paddingBottom: 'var(--spacing-2)',
        borderBottom: '1px solid var(--color-border-default)',
        color: 'var(--color-text-primary)',
      }}
    >
      {children}
    </h2>
  );
}

/**
 * DesignSystemCatalogPage — static catalog of all design system primitives.
 *
 * Renders token swatches and Button variants. No data fetching.
 */
export default function DesignSystemCatalogPage(): React.ReactElement {
  const brandSteps = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'] as const;
  const neutralSteps = [
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

  return (
    <main
      aria-label="Design System Catalog"
      style={{
        padding: 'var(--spacing-8)',
        background: 'var(--color-surface-subtle)',
        fontFamily: 'var(--font-family-sans)',
        color: 'var(--color-text-primary)',
        minHeight: '100vh',
      }}
    >
      <header
        style={{
          marginBottom: 'var(--spacing-10)',
          borderBottom: '1px solid var(--color-border-default)',
          paddingBottom: 'var(--spacing-6)',
        }}
      >
        <h1
          style={{
            fontSize: 'var(--font-size-3xl)',
            fontWeight: 'var(--font-weight-bold)' as React.CSSProperties['fontWeight'],
            letterSpacing: 'var(--letter-spacing-tight)',
            marginBottom: 'var(--spacing-2)',
          }}
        >
          Design System Catalog
        </h1>
        <p
          style={{
            color: 'var(--color-text-secondary)',
            fontSize: 'var(--font-size-sm)',
          }}
        >
          Superfield — Phase 0 token foundation and Button primitive
        </p>
      </header>

      {/* ============================================================== */}
      {/* Color tokens                                                     */}
      {/* ============================================================== */}
      <section style={{ marginBottom: 'var(--spacing-12)' }} aria-label="color-tokens">
        <SectionTitle>Color tokens</SectionTitle>

        <h3
          style={{
            fontSize: 'var(--font-size-sm)',
            fontWeight: 'var(--font-weight-semibold)' as React.CSSProperties['fontWeight'],
            color: 'var(--color-text-secondary)',
            marginBottom: 'var(--spacing-3)',
          }}
        >
          Brand
        </h3>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--spacing-3)',
            marginBottom: 'var(--spacing-6)',
          }}
        >
          {brandSteps.map((n) => (
            <ColorSwatch
              key={n}
              variable={`--color-brand-${n}`}
              label={`brand-${n}`}
              value={`--color-brand-${n}`}
            />
          ))}
        </div>

        <h3
          style={{
            fontSize: 'var(--font-size-sm)',
            fontWeight: 'var(--font-weight-semibold)' as React.CSSProperties['fontWeight'],
            color: 'var(--color-text-secondary)',
            marginBottom: 'var(--spacing-3)',
          }}
        >
          Neutral
        </h3>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--spacing-3)',
            marginBottom: 'var(--spacing-6)',
          }}
        >
          {neutralSteps.map((n) => (
            <ColorSwatch
              key={n}
              variable={`--color-neutral-${n}`}
              label={`neutral-${n}`}
              value={`--color-neutral-${n}`}
            />
          ))}
        </div>

        <h3
          style={{
            fontSize: 'var(--font-size-sm)',
            fontWeight: 'var(--font-weight-semibold)' as React.CSSProperties['fontWeight'],
            color: 'var(--color-text-secondary)',
            marginBottom: 'var(--spacing-3)',
          }}
        >
          Semantic
        </h3>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--spacing-3)',
            marginBottom: 'var(--spacing-6)',
          }}
        >
          {(
            [
              ['success-500', '#22c55e'],
              ['warning-500', '#f59e0b'],
              ['error-500', '#ef4444'],
              ['info-500', '#3b82f6'],
            ] as const
          ).map(([name, value]) => (
            <ColorSwatch key={name} variable={`--color-${name}`} label={name} value={value} />
          ))}
        </div>
      </section>

      {/* ============================================================== */}
      {/* Typography scale                                                */}
      {/* ============================================================== */}
      <section style={{ marginBottom: 'var(--spacing-12)' }} aria-label="typography-scale">
        <SectionTitle>Typography scale</SectionTitle>
        {(
          [
            ['xs', '0.75rem / 12 px'],
            ['sm', '0.875rem / 14 px'],
            ['md', '1rem / 16 px'],
            ['lg', '1.125rem / 18 px'],
            ['xl', '1.25rem / 20 px'],
            ['2xl', '1.5rem / 24 px'],
            ['3xl', '1.875rem / 30 px'],
            ['4xl', '2.25rem / 36 px'],
          ] as const
        ).map(([step, hint]) => (
          <div
            key={step}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 'var(--spacing-4)',
              marginBottom: 'var(--spacing-4)',
              padding: 'var(--spacing-3)',
              background: 'var(--color-surface-base)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-border-subtle)',
            }}
          >
            <div
              style={{
                minWidth: 160,
                fontSize: 'var(--font-size-xs)',
                color: 'var(--color-text-secondary)',
                fontFamily: 'var(--font-family-mono)',
              }}
            >
              --font-size-{step}
              <br />
              {hint}
            </div>
            <span style={{ fontSize: `var(--font-size-${step})` }}>The quick brown fox</span>
          </div>
        ))}
      </section>

      {/* ============================================================== */}
      {/* Spacing scale                                                   */}
      {/* ============================================================== */}
      <section style={{ marginBottom: 'var(--spacing-12)' }} aria-label="spacing-scale">
        <SectionTitle>Spacing scale</SectionTitle>
        {(
          [
            ['1', '0.25rem / 4 px', '4px'],
            ['2', '0.5rem / 8 px', '8px'],
            ['3', '0.75rem / 12 px', '12px'],
            ['4', '1rem / 16 px', '16px'],
            ['5', '1.25rem / 20 px', '20px'],
            ['6', '1.5rem / 24 px', '24px'],
            ['8', '2rem / 32 px', '32px'],
            ['10', '2.5rem / 40 px', '40px'],
            ['12', '3rem / 48 px', '48px'],
            ['16', '4rem / 64 px', '64px'],
          ] as const
        ).map(([step, hint, px]) => (
          <div
            key={step}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--spacing-4)',
              marginBottom: 'var(--spacing-2)',
            }}
          >
            <div
              style={{
                fontSize: 'var(--font-size-xs)',
                fontFamily: 'var(--font-family-mono)',
                color: 'var(--color-text-secondary)',
                minWidth: 200,
              }}
            >
              --spacing-{step} — {hint}
            </div>
            <div style={{ flex: 1, height: 24, display: 'flex', alignItems: 'center' }}>
              <div
                style={{
                  height: 16,
                  width: px,
                  background: 'var(--color-brand-200)',
                  border: '1px solid var(--color-brand-300)',
                  borderRadius: 'var(--radius-sm)',
                  minWidth: 2,
                }}
              />
            </div>
          </div>
        ))}
      </section>

      {/* ============================================================== */}
      {/* Button primitive                                                */}
      {/* ============================================================== */}
      <section style={{ marginBottom: 'var(--spacing-12)' }} aria-label="button-primitive">
        <SectionTitle>Button primitive</SectionTitle>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 'var(--spacing-4)',
            marginBottom: 'var(--spacing-6)',
          }}
        >
          <span
            style={{
              fontSize: 'var(--font-size-xs)',
              fontWeight: 'var(--font-weight-medium)' as React.CSSProperties['fontWeight'],
              color: 'var(--color-text-secondary)',
              minWidth: 80,
            }}
          >
            Primary
          </span>
          <Button variant="primary" size="sm">
            Small
          </Button>
          <Button variant="primary" size="md">
            Medium
          </Button>
          <Button variant="primary" size="lg">
            Large
          </Button>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 'var(--spacing-4)',
            marginBottom: 'var(--spacing-6)',
          }}
        >
          <span
            style={{
              fontSize: 'var(--font-size-xs)',
              fontWeight: 'var(--font-weight-medium)' as React.CSSProperties['fontWeight'],
              color: 'var(--color-text-secondary)',
              minWidth: 80,
            }}
          >
            Secondary
          </span>
          <Button variant="secondary" size="sm">
            Small
          </Button>
          <Button variant="secondary" size="md">
            Medium
          </Button>
          <Button variant="secondary" size="lg">
            Large
          </Button>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 'var(--spacing-4)',
            marginBottom: 'var(--spacing-6)',
          }}
        >
          <span
            style={{
              fontSize: 'var(--font-size-xs)',
              fontWeight: 'var(--font-weight-medium)' as React.CSSProperties['fontWeight'],
              color: 'var(--color-text-secondary)',
              minWidth: 80,
            }}
          >
            Ghost
          </span>
          <Button variant="ghost" size="sm">
            Small
          </Button>
          <Button variant="ghost" size="md">
            Medium
          </Button>
          <Button variant="ghost" size="lg">
            Large
          </Button>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 'var(--spacing-4)',
            marginBottom: 'var(--spacing-6)',
          }}
        >
          <span
            style={{
              fontSize: 'var(--font-size-xs)',
              fontWeight: 'var(--font-weight-medium)' as React.CSSProperties['fontWeight'],
              color: 'var(--color-text-secondary)',
              minWidth: 80,
            }}
          >
            Disabled
          </span>
          <Button variant="primary" size="md" disabled>
            Primary
          </Button>
          <Button variant="secondary" size="md" disabled>
            Secondary
          </Button>
          <Button variant="ghost" size="md" disabled>
            Ghost
          </Button>
        </div>
      </section>
    </main>
  );
}
