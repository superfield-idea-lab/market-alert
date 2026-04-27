/**
 * @file build-catalog.ts
 *
 * Generates a static HTML design system catalog from the token definitions.
 *
 * Run via: bun packages/ui/build-catalog.ts
 *
 * Output: packages/ui/dist/catalog/index.html
 *
 * No dev server is required to read the catalog — open the HTML file directly
 * in any browser or use headless Chromium for screenshot review.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const dir = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
const tokensPath = join(dir, 'tokens.css');
const tokensCSS = readFileSync(tokensPath, 'utf8');

const outDir = join(dir, 'dist', 'catalog');
mkdirSync(outDir, { recursive: true });

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Design System Catalog — Superfield</title>
  <style>
${tokensCSS}

/* Catalog-specific layout styles */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--font-family-sans);
  background: var(--color-surface-subtle);
  color: var(--color-text-primary);
  font-size: var(--font-size-md);
  line-height: var(--line-height-normal);
  padding: var(--spacing-8);
}

h1 {
  font-size: var(--font-size-3xl);
  font-weight: var(--font-weight-bold);
  letter-spacing: var(--letter-spacing-tight);
  margin-bottom: var(--spacing-2);
}

h2 {
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-semibold);
  margin-bottom: var(--spacing-4);
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: var(--letter-spacing-wider);
  font-size: var(--font-size-xs);
}

.catalog-header {
  margin-bottom: var(--spacing-10);
  border-bottom: 1px solid var(--color-border-default);
  padding-bottom: var(--spacing-6);
}

.catalog-header p {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  margin-top: var(--spacing-1);
}

.section {
  margin-bottom: var(--spacing-12);
}

.section-title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  margin-bottom: var(--spacing-6);
  padding-bottom: var(--spacing-2);
  border-bottom: 1px solid var(--color-border-default);
}

/* Token swatches */
.token-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--spacing-3);
}

.token-swatch {
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 1px solid var(--color-border-subtle);
  box-shadow: var(--shadow-sm);
}

.swatch-color {
  height: 56px;
}

.swatch-info {
  padding: var(--spacing-2);
  background: var(--color-surface-base);
}

.swatch-name {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  margin-bottom: var(--spacing-1);
  word-break: break-all;
}

.swatch-value {
  font-family: var(--font-family-mono);
  font-size: 10px;
  color: var(--color-text-secondary);
}

/* Typography scale */
.type-scale-row {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-4);
  margin-bottom: var(--spacing-4);
  padding: var(--spacing-3);
  background: var(--color-surface-base);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border-subtle);
}

.type-scale-meta {
  min-width: 140px;
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  font-family: var(--font-family-mono);
}

/* Spacing scale */
.spacing-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-4);
  margin-bottom: var(--spacing-2);
}

.spacing-bar-wrap {
  flex: 1;
  height: 24px;
  display: flex;
  align-items: center;
}

.spacing-bar {
  height: 16px;
  background: var(--color-brand-200);
  border: 1px solid var(--color-brand-300);
  border-radius: var(--radius-sm);
  min-width: 2px;
}

.spacing-label {
  font-size: var(--font-size-xs);
  font-family: var(--font-family-mono);
  color: var(--color-text-secondary);
  min-width: 180px;
}

/* Button primitives */
.button-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-4);
  margin-bottom: var(--spacing-6);
}

.button-label {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-secondary);
  min-width: 80px;
}

/* Base button reset and shared styles */
.ds-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-family-sans);
  font-weight: var(--font-weight-medium);
  line-height: var(--line-height-tight);
  letter-spacing: var(--letter-spacing-wide);
  cursor: pointer;
  transition: background-color var(--transition-base), color var(--transition-base), border-color var(--transition-base);
  outline: none;
  white-space: nowrap;
  border: none;
}

.ds-button:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

/* Variants */
.ds-button--primary {
  background-color: var(--color-interactive-default);
  color: var(--color-text-inverse);
  border: 1px solid transparent;
}

.ds-button--primary:hover {
  background-color: var(--color-interactive-hover);
}

.ds-button--primary:active {
  background-color: var(--color-interactive-active);
}

.ds-button--secondary {
  background-color: var(--color-surface-base);
  color: var(--color-text-primary);
  border: 1px solid var(--color-border-strong);
}

.ds-button--secondary:hover {
  background-color: var(--color-surface-muted);
}

.ds-button--ghost {
  background-color: transparent;
  color: var(--color-text-primary);
  border: 1px solid transparent;
}

.ds-button--ghost:hover {
  background-color: var(--color-surface-muted);
}

/* Disabled state (all variants) */
.ds-button:disabled,
.ds-button--disabled {
  opacity: 0.4;
  cursor: not-allowed;
  pointer-events: none;
}

/* Sizes */
.ds-button--sm {
  font-size: var(--font-size-sm);
  padding: var(--spacing-1) var(--spacing-3);
  border-radius: var(--radius-md);
}

.ds-button--md {
  font-size: var(--font-size-sm);
  padding: var(--spacing-2) var(--spacing-4);
  border-radius: var(--radius-md);
}

.ds-button--lg {
  font-size: var(--font-size-md);
  padding: var(--spacing-3) var(--spacing-6);
  border-radius: var(--radius-lg);
}
  </style>
</head>
<body>

<div class="catalog-header">
  <h1>Design System Catalog</h1>
  <p>Superfield — Phase 0 token foundation and Button primitive</p>
</div>

<!-- ================================================================ -->
<!-- Color tokens                                                       -->
<!-- ================================================================ -->
<section class="section" id="colors">
  <h2>Section</h2>
  <div class="section-title">Color tokens</div>

  <h3 style="font-size:var(--font-size-sm);font-weight:var(--font-weight-semibold);color:var(--color-text-secondary);margin-bottom:var(--spacing-3)">Brand</h3>
  <div class="token-grid" style="margin-bottom:var(--spacing-6)">
    ${['50', '100', '200', '300', '400', '500', '600', '700', '800', '900']
      .map(
        (n) => `
    <div class="token-swatch">
      <div class="swatch-color" style="background:var(--color-brand-${n})"></div>
      <div class="swatch-info">
        <div class="swatch-name">brand-${n}</div>
        <div class="swatch-value">--color-brand-${n}</div>
      </div>
    </div>`,
      )
      .join('')}
  </div>

  <h3 style="font-size:var(--font-size-sm);font-weight:var(--font-weight-semibold);color:var(--color-text-secondary);margin-bottom:var(--spacing-3)">Neutral</h3>
  <div class="token-grid" style="margin-bottom:var(--spacing-6)">
    ${['0', '50', '100', '200', '300', '400', '500', '600', '700', '800', '900']
      .map(
        (n) => `
    <div class="token-swatch">
      <div class="swatch-color" style="background:var(--color-neutral-${n});border-bottom:1px solid var(--color-border-subtle)"></div>
      <div class="swatch-info">
        <div class="swatch-name">neutral-${n}</div>
        <div class="swatch-value">--color-neutral-${n}</div>
      </div>
    </div>`,
      )
      .join('')}
  </div>

  <h3 style="font-size:var(--font-size-sm);font-weight:var(--font-weight-semibold);color:var(--color-text-secondary);margin-bottom:var(--spacing-3)">Semantic</h3>
  <div class="token-grid" style="margin-bottom:var(--spacing-6)">
    ${[
      ['success-500', 'var(--color-success-500)'],
      ['warning-500', 'var(--color-warning-500)'],
      ['error-500', 'var(--color-error-500)'],
      ['info-500', 'var(--color-info-500)'],
    ]
      .map(
        ([name, val]) => `
    <div class="token-swatch">
      <div class="swatch-color" style="background:${val}"></div>
      <div class="swatch-info">
        <div class="swatch-name">${name}</div>
        <div class="swatch-value">--color-${name}</div>
      </div>
    </div>`,
      )
      .join('')}
  </div>
</section>

<!-- ================================================================ -->
<!-- Typography scale                                                   -->
<!-- ================================================================ -->
<section class="section" id="typography">
  <h2>Section</h2>
  <div class="section-title">Typography scale</div>

  ${[
    ['xs', '0.75rem / 12 px'],
    ['sm', '0.875rem / 14 px'],
    ['md', '1rem / 16 px'],
    ['lg', '1.125rem / 18 px'],
    ['xl', '1.25rem / 20 px'],
    ['2xl', '1.5rem / 24 px'],
    ['3xl', '1.875rem / 30 px'],
    ['4xl', '2.25rem / 36 px'],
  ]
    .map(
      ([step, hint]) => `
  <div class="type-scale-row">
    <div class="type-scale-meta">--font-size-${step}<br/>${hint}</div>
    <span style="font-size:var(--font-size-${step})">The quick brown fox</span>
  </div>`,
    )
    .join('')}
</section>

<!-- ================================================================ -->
<!-- Spacing scale                                                      -->
<!-- ================================================================ -->
<section class="section" id="spacing">
  <h2>Section</h2>
  <div class="section-title">Spacing scale</div>

  ${[
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
  ]
    .map(
      ([step, hint, px]) => `
  <div class="spacing-row">
    <div class="spacing-label">--spacing-${step} — ${hint}</div>
    <div class="spacing-bar-wrap">
      <div class="spacing-bar" style="width:${px}"></div>
    </div>
  </div>`,
    )
    .join('')}
</section>

<!-- ================================================================ -->
<!-- Button primitive                                                   -->
<!-- ================================================================ -->
<section class="section" id="button">
  <h2>Section</h2>
  <div class="section-title">Button primitive</div>

  <!-- Primary -->
  <div class="button-row">
    <div class="button-label">Primary</div>
    <button class="ds-button ds-button--primary ds-button--sm" data-state="default">Small</button>
    <button class="ds-button ds-button--primary ds-button--md" data-state="default">Medium</button>
    <button class="ds-button ds-button--primary ds-button--lg" data-state="default">Large</button>
  </div>

  <!-- Secondary -->
  <div class="button-row">
    <div class="button-label">Secondary</div>
    <button class="ds-button ds-button--secondary ds-button--sm">Small</button>
    <button class="ds-button ds-button--secondary ds-button--md">Medium</button>
    <button class="ds-button ds-button--secondary ds-button--lg">Large</button>
  </div>

  <!-- Ghost -->
  <div class="button-row">
    <div class="button-label">Ghost</div>
    <button class="ds-button ds-button--ghost ds-button--sm">Small</button>
    <button class="ds-button ds-button--ghost ds-button--md">Medium</button>
    <button class="ds-button ds-button--ghost ds-button--lg">Large</button>
  </div>

  <!-- Disabled -->
  <div class="button-row">
    <div class="button-label">Disabled</div>
    <button class="ds-button ds-button--primary ds-button--md ds-button--disabled" disabled>Primary</button>
    <button class="ds-button ds-button--secondary ds-button--md ds-button--disabled" disabled>Secondary</button>
    <button class="ds-button ds-button--ghost ds-button--md ds-button--disabled" disabled>Ghost</button>
  </div>
</section>

</body>
</html>`;

writeFileSync(join(outDir, 'index.html'), html, 'utf8');
console.log(`Catalog written to ${join(outDir, 'index.html')}`);
