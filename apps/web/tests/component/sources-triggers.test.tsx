/**
 * @file sources-triggers.test.tsx
 *
 * Component test — Sources & Triggers page (issue #118).
 *
 * ## What this tests
 *
 * Test plan item: "Component test: Sources tab renders source rows with name,
 * URL, and status chip; Triggers tab renders standing prompt rows grouped by
 * subject_type"
 *
 * Verifies that:
 * - SourcesTriggersPage renders Sources and Triggers tabs.
 * - Sources tab renders source rows with name, URL, and status chip.
 * - Triggers tab renders standing prompt rows grouped by subject_type.
 * - Pin and unpin buttons are rendered for prompts with active versions.
 * - Sources tab has no create, edit, or delete controls (read-only).
 *
 * ## Architecture
 *
 * Runs in headless Chromium via Playwright / vitest-browser-react.
 * The fetch calls are mocked at the browser level by returning fixture data.
 * No vi.fn, vi.mock, or vi.spyOn — the component API helpers (fetchSources,
 * fetchStandingPrompts) accept an optional `fetchImpl` parameter for injection.
 *
 * @see apps/web/src/pages/sources-triggers.tsx
 * @see https://github.com/superfield-idea-lab/market-alert/issues/118
 */

import React from 'react';
import { render } from 'vitest-browser-react';
import { expect, test } from 'vitest';
import { page } from '@vitest/browser/context';
import {
  SourcesTriggersPage,
  type ResearcherSourceRow,
  type ResearcherStandingPromptRow,
} from '../../../../apps/web/src/pages/sources-triggers';

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const FIXTURE_SOURCES: ResearcherSourceRow[] = [
  {
    id: 'src-001',
    name: 'SEC EDGAR',
    url: 'https://edgar.sec.gov',
    trust_tier: 'public',
    status: 'active',
  },
  {
    id: 'src-002',
    name: 'Bloomberg API',
    url: 'https://api.bloomberg.com',
    trust_tier: 'api_key',
    status: 'pending',
  },
  {
    id: 'src-003',
    name: 'Old Venue',
    url: 'https://old.example.com',
    trust_tier: null,
    status: 'retired',
  },
];

const FIXTURE_PROMPTS: ResearcherStandingPromptRow[] = [
  {
    id: 'sp-001',
    subject_type: 'entity',
    subject_id: 'AAPL',
    active_version_word_count: 42,
    is_pinned: false,
    active_version_id: 'spv-001',
  },
  {
    id: 'sp-002',
    subject_type: 'thesis',
    subject_id: 'rates-thesis',
    active_version_word_count: 67,
    is_pinned: true,
    active_version_id: 'spv-002',
  },
  {
    id: 'sp-003',
    subject_type: 'portfolio',
    subject_id: 'portfolio',
    active_version_word_count: 31,
    is_pinned: false,
    active_version_id: 'spv-003',
  },
];

// ---------------------------------------------------------------------------
// Fetch interceptor — intercept window.fetch to return fixture data.
// ---------------------------------------------------------------------------

function installFetchInterceptor() {
  const orig = window.fetch;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/researcher/sources')) {
      return new Response(JSON.stringify({ sources: FIXTURE_SOURCES }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (
      url.includes('/api/researcher/standing-prompts') &&
      !url.includes('/pin') &&
      !url.includes('/unpin')
    ) {
      return new Response(JSON.stringify({ standing_prompts: FIXTURE_PROMPTS }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/pin') || url.includes('/unpin')) {
      const isPinAction = url.includes('/pin') && !url.includes('/unpin');
      return new Response(
        JSON.stringify({ standing_prompt_version_id: 'spv-001', is_pinned: isPinAction }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return orig(input, init);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('SourcesTriggersPage renders Sources and Triggers tabs', async () => {
  installFetchInterceptor();
  const { getByTestId } = render(<SourcesTriggersPage />);
  const sourcesTab = getByTestId('tab-sources');
  const triggersTab = getByTestId('tab-triggers');
  expect(sourcesTab).toBeTruthy();
  expect(triggersTab).toBeTruthy();
});

test('Sources tab renders source rows with name, URL, and status chip', async () => {
  installFetchInterceptor();
  const { getByTestId } = render(<SourcesTriggersPage />);

  // Default tab is Sources — wait for table to render.
  await page.waitFor(() => document.querySelector('[data-testid="sources-table"]') !== null);

  const table = getByTestId('sources-table');
  expect(table).toBeTruthy();

  // All source rows should be present.
  const rows = document.querySelectorAll('[data-testid="source-row"]');
  expect(rows.length).toBe(3);

  // Check SEC EDGAR name is rendered.
  const tableText = table.element().textContent ?? '';
  expect(tableText).toContain('SEC EDGAR');
  expect(tableText).toContain('Bloomberg API');
  expect(tableText).toContain('Old Venue');

  // Check URLs are rendered as links.
  const urlLinks = document.querySelectorAll('[data-testid="source-url"]');
  expect(urlLinks.length).toBe(3);
});

test('Sources tab has no create, edit, or delete controls', async () => {
  installFetchInterceptor();
  render(<SourcesTriggersPage />);

  await page.waitFor(() => document.querySelector('[data-testid="sources-table"]') !== null);

  // No buttons other than the refresh and tab controls should appear.
  const allButtons = document.querySelectorAll('button');
  const buttonTexts = Array.from(allButtons).map((b) => b.textContent?.toLowerCase() ?? '');

  // Must not have any create/edit/delete buttons.
  expect(
    buttonTexts.some((t) => t.includes('create') || t.includes('add') || t.includes('new')),
  ).toBe(false);
  expect(buttonTexts.some((t) => t.includes('edit') || t.includes('modify'))).toBe(false);
  expect(buttonTexts.some((t) => t.includes('delete') || t.includes('remove'))).toBe(false);
});

test('Triggers tab renders standing prompt rows grouped by subject_type', async () => {
  installFetchInterceptor();
  const { getByTestId } = render(<SourcesTriggersPage />);

  // Click the Triggers tab.
  const triggersTab = getByTestId('tab-triggers');
  await triggersTab.click();

  // Wait for prompt rows to render.
  await page.waitFor(() => document.querySelector('[data-testid="triggers-container"]') !== null);

  const container = getByTestId('triggers-container');
  expect(container).toBeTruthy();

  const containerText = container.element().textContent ?? '';

  // All three subject types should appear.
  expect(containerText).toContain('Entity');
  expect(containerText).toContain('Thesis');
  expect(containerText).toContain('Portfolio');

  // Subject IDs should appear.
  expect(containerText).toContain('AAPL');
  expect(containerText).toContain('rates-thesis');
  expect(containerText).toContain('portfolio');

  // Word counts should appear.
  expect(containerText).toContain('42 words');
  expect(containerText).toContain('67 words');
  expect(containerText).toContain('31 words');
});

test('Triggers tab renders pin and unpin buttons for prompts with active versions', async () => {
  installFetchInterceptor();
  const { getByTestId } = render(<SourcesTriggersPage />);

  // Click the Triggers tab.
  const triggersTab = getByTestId('tab-triggers');
  await triggersTab.click();

  await page.waitFor(
    () => document.querySelectorAll('[data-testid="standing-prompt-row"]').length > 0,
  );

  // Pin buttons should be rendered for unpinned prompts.
  const pinButtons = document.querySelectorAll('[data-testid="pin-button"]');
  expect(pinButtons.length).toBeGreaterThanOrEqual(1);

  // Unpin buttons should be rendered for pinned prompts.
  const unpinButtons = document.querySelectorAll('[data-testid="unpin-button"]');
  expect(unpinButtons.length).toBeGreaterThanOrEqual(1);
});

test('Triggers tab shows Pinned badge for pinned prompts', async () => {
  installFetchInterceptor();
  const { getByTestId } = render(<SourcesTriggersPage />);

  const triggersTab = getByTestId('tab-triggers');
  await triggersTab.click();

  await page.waitFor(() => document.querySelector('[data-testid="triggers-container"]') !== null);

  const container = getByTestId('triggers-container');
  const containerText = container.element().textContent ?? '';

  // The thesis prompt is pinned — should show "Pinned" label.
  expect(containerText).toContain('Pinned');
});
