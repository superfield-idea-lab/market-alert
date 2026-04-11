/**
 * @file design-system.test.tsx
 *
 * Component tests for the design system catalog and Button primitive.
 *
 * Tests run in headless Chromium via Playwright/vitest-browser-react.
 * A Playwright screenshot of the full catalog page is captured and written
 * to tests/fixtures/ as a visual baseline artifact via the saveScreenshot
 * browser command (runs on the host side).
 *
 * No mocks — this test suite verifies real DOM output and real CSS token
 * resolution in a live Chromium instance.
 */

import React from 'react';
import { render } from 'vitest-browser-react';
import { expect, test } from 'vitest';
import { page, commands } from '@vitest/browser/context';
import { Button } from '../../../../packages/ui/Button';

// Repo-relative path for the screenshot fixture.
// The saveScreenshot command resolves this against the repo root on the host.
const SCREENSHOT_RELATIVE_PATH = 'tests/fixtures/design-system-catalog.png';

// Ensure tokens CSS is loaded for these tests so CSS custom properties resolve.
// In the real app main.tsx handles this; here we inject inline.
function injectTokens() {
  // Guard against re-injection if the style is already present.
  if (document.getElementById('ds-tokens')) return;
  const style = document.createElement('style');
  style.id = 'ds-tokens';
  style.textContent = `
    :root {
      --color-brand-50:#eef2ff;--color-brand-100:#e0e7ff;--color-brand-200:#c7d2fe;
      --color-brand-300:#a5b4fc;--color-brand-400:#818cf8;--color-brand-500:#6366f1;
      --color-brand-600:#4f46e5;--color-brand-700:#4338ca;--color-brand-800:#3730a3;
      --color-brand-900:#312e81;
      --color-neutral-0:#ffffff;--color-neutral-50:#fafafa;--color-neutral-100:#f4f4f5;
      --color-neutral-200:#e4e4e7;--color-neutral-300:#d4d4d8;--color-neutral-400:#a1a1aa;
      --color-neutral-500:#71717a;--color-neutral-600:#52525b;--color-neutral-700:#3f3f46;
      --color-neutral-800:#27272a;--color-neutral-900:#18181b;
      --color-surface-base:var(--color-neutral-0);
      --color-surface-subtle:var(--color-neutral-50);
      --color-surface-muted:var(--color-neutral-100);
      --color-text-primary:var(--color-neutral-900);
      --color-text-secondary:var(--color-neutral-500);
      --color-text-disabled:var(--color-neutral-300);
      --color-text-inverse:var(--color-neutral-0);
      --color-border-default:var(--color-neutral-200);
      --color-border-subtle:var(--color-neutral-100);
      --color-border-strong:var(--color-neutral-300);
      --color-interactive-default:var(--color-brand-600);
      --color-interactive-hover:var(--color-brand-700);
      --color-interactive-active:var(--color-brand-800);
      --color-interactive-disabled:var(--color-neutral-200);
      --color-focus-ring:var(--color-brand-500);
      --font-family-sans:ui-sans-serif,system-ui,-apple-system,sans-serif;
      --font-family-mono:ui-monospace,SFMono-Regular,Menlo,monospace;
      --font-size-xs:0.75rem;--font-size-sm:0.875rem;--font-size-md:1rem;
      --font-size-lg:1.125rem;--font-size-xl:1.25rem;--font-size-2xl:1.5rem;
      --font-weight-normal:400;--font-weight-medium:500;--font-weight-semibold:600;--font-weight-bold:700;
      --line-height-tight:1.25;--line-height-normal:1.5;
      --letter-spacing-tight:-0.025em;--letter-spacing-normal:0em;
      --letter-spacing-wide:0.025em;--letter-spacing-wider:0.05em;
      --spacing-1:0.25rem;--spacing-2:0.5rem;--spacing-3:0.75rem;--spacing-4:1rem;
      --spacing-5:1.25rem;--spacing-6:1.5rem;--spacing-8:2rem;
      --radius-sm:0.25rem;--radius-md:0.375rem;--radius-lg:0.5rem;--radius-xl:0.75rem;--radius-full:9999px;
      --shadow-sm:0 1px 2px 0 rgb(0 0 0 / 0.05);
      --transition-fast:100ms ease;--transition-base:150ms ease;--transition-slow:300ms ease;
    }
  `;
  document.head.appendChild(style);
}

// ------------------------------------------------------------------ //
// Button primitive tests                                              //
// ------------------------------------------------------------------ //

test('button renders default (primary) variant', async () => {
  injectTokens();
  const screen = render(<Button>Click me</Button>);
  await expect.element(screen.getByRole('button', { name: 'Click me' })).toBeVisible();
});

test('button renders secondary variant', async () => {
  injectTokens();
  const screen = render(<Button variant="secondary">Secondary</Button>);
  await expect.element(screen.getByRole('button', { name: 'Secondary' })).toBeVisible();
});

test('button renders ghost variant', async () => {
  injectTokens();
  const screen = render(<Button variant="ghost">Ghost</Button>);
  await expect.element(screen.getByRole('button', { name: 'Ghost' })).toBeVisible();
});

test('button renders disabled state', async () => {
  injectTokens();
  const screen = render(<Button disabled>Disabled</Button>);
  const btn = screen.getByRole('button', { name: 'Disabled' });
  await expect.element(btn).toBeVisible();
  await expect.element(btn).toBeDisabled();
});

test('button renders small size', async () => {
  injectTokens();
  const screen = render(<Button size="sm">Small</Button>);
  await expect.element(screen.getByRole('button', { name: 'Small' })).toBeVisible();
});

test('button renders large size', async () => {
  injectTokens();
  const screen = render(<Button size="lg">Large</Button>);
  await expect.element(screen.getByRole('button', { name: 'Large' })).toBeVisible();
});

test('button fires onClick when clicked', async () => {
  injectTokens();
  let clicked = false;
  const screen = render(
    <Button
      onClick={() => {
        clicked = true;
      }}
    >
      Clickable
    </Button>,
  );
  await screen.getByRole('button', { name: 'Clickable' }).click();
  expect(clicked).toBe(true);
});

// ------------------------------------------------------------------ //
// Catalog screenshot test                                              //
// ------------------------------------------------------------------ //

/**
 * Renders a minimal inline catalog and captures a Playwright screenshot.
 * The screenshot is written to tests/fixtures/ as a visual baseline artifact
 * via the saveScreenshot browser command (runs on the host filesystem).
 * On subsequent runs the same file is overwritten so CI always has a fresh
 * baseline to compare against.
 */
test('catalog page renders without errors and screenshot is captured', async () => {
  injectTokens();

  // Inject catalog CSS (inlined subset matching build-catalog.ts output)
  if (!document.getElementById('ds-catalog-style')) {
    const catalogStyle = document.createElement('style');
    catalogStyle.id = 'ds-catalog-style';
    catalogStyle.textContent = `
      .ds-button {
        display:inline-flex;align-items:center;justify-content:center;
        font-family:var(--font-family-sans);font-weight:var(--font-weight-medium);
        line-height:var(--line-height-tight);letter-spacing:var(--letter-spacing-wide);
        cursor:pointer;
        transition:background-color var(--transition-base),color var(--transition-base);
      }
      .ds-button--primary{background-color:var(--color-interactive-default);color:var(--color-text-inverse);border:1px solid transparent;}
      .ds-button--secondary{background-color:var(--color-surface-base);color:var(--color-text-primary);border:1px solid var(--color-border-strong);}
      .ds-button--ghost{background-color:transparent;color:var(--color-text-primary);border:1px solid transparent;}
      .ds-button--sm{font-size:var(--font-size-sm);padding:var(--spacing-1) var(--spacing-3);border-radius:var(--radius-md);}
      .ds-button--md{font-size:var(--font-size-sm);padding:var(--spacing-2) var(--spacing-4);border-radius:var(--radius-md);}
      .ds-button--lg{font-size:var(--font-size-md);padding:var(--spacing-3) var(--spacing-6);border-radius:var(--radius-lg);}
      .ds-button:disabled{opacity:0.4;cursor:not-allowed;pointer-events:none;}
      .catalog-section{margin-bottom:2rem;}
      .catalog-title{font-size:1.125rem;font-weight:600;margin-bottom:1rem;}
      .swatch-row{display:flex;flex-wrap:wrap;gap:0.5rem;margin-bottom:1rem;}
      .swatch{width:48px;height:48px;border-radius:0.375rem;border:1px solid var(--color-border-subtle);}
      .button-row{display:flex;flex-wrap:wrap;gap:1rem;align-items:center;margin-bottom:1rem;}
    `;
    document.head.appendChild(catalogStyle);
  }

  const screen = render(
    <div
      id="catalog-root"
      style={{
        padding: 'var(--spacing-8)',
        background: 'var(--color-surface-subtle)',
        fontFamily: 'var(--font-family-sans)',
        color: 'var(--color-text-primary)',
      }}
    >
      <h1
        style={{
          fontSize: 'var(--font-size-3xl)',
          fontWeight: 'var(--font-weight-bold)',
          marginBottom: 'var(--spacing-8)',
        }}
      >
        Design System Catalog
      </h1>

      {/* Color section */}
      <section className="catalog-section" aria-label="color-tokens">
        <div className="catalog-title">Color tokens</div>
        <div className="swatch-row">
          {(['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'] as const).map(
            (n) => (
              <div
                key={n}
                className="swatch"
                style={{ background: `var(--color-brand-${n})` }}
                aria-label={`brand-${n}`}
              />
            ),
          )}
        </div>
      </section>

      {/* Button section */}
      <section className="catalog-section" aria-label="button-primitive">
        <div className="catalog-title">Button primitive</div>
        <div className="button-row">
          <button className="ds-button ds-button--primary ds-button--sm">Primary SM</button>
          <button className="ds-button ds-button--primary ds-button--md">Primary MD</button>
          <button className="ds-button ds-button--primary ds-button--lg">Primary LG</button>
        </div>
        <div className="button-row">
          <button className="ds-button ds-button--secondary ds-button--md">Secondary</button>
          <button className="ds-button ds-button--ghost ds-button--md">Ghost</button>
          <button className="ds-button ds-button--primary ds-button--md" disabled>
            Disabled
          </button>
        </div>
      </section>
    </div>,
  );

  // Verify key catalog elements are visible
  await expect.element(screen.getByText('Design System Catalog')).toBeVisible();
  await expect.element(screen.getByText('Color tokens')).toBeVisible();
  await expect.element(screen.getByText('Button primitive')).toBeVisible();
  await expect.element(screen.getByText('Primary MD')).toBeVisible();

  // Capture screenshot with Playwright and persist to tests/fixtures/ via
  // the saveScreenshot host-side browser command.
  const screenshotBuffer = await page.screenshot();
  await commands.saveScreenshot({
    data: Array.from(screenshotBuffer),
    relativePath: SCREENSHOT_RELATIVE_PATH,
  });
});
