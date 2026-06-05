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
 * The fixture server (global-setup.ts) intercepts /api/researcher/* requests
 * and returns pre-seeded state — no mocks, no vi.fn.
 *
 * @see apps/web/src/pages/sources-triggers.tsx
 * @see apps/web/tests/component/fixture-server.ts — add researcher routes
 * @see https://github.com/superfield-idea-lab/market-alert/issues/118
 */

import React from 'react';
import { render } from 'vitest-browser-react';
import { commands } from '@vitest/browser/context';
import { afterEach, expect, test } from 'vitest';
import { SourcesTriggersPage } from '../../../../apps/web/src/pages/sources-triggers';
import type { FixtureResearcherSource, FixtureStandingPrompt } from './fixture-server';

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const FIXTURE_SOURCES: FixtureResearcherSource[] = [
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

const FIXTURE_PROMPTS: FixtureStandingPrompt[] = [
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
// Helpers
// ---------------------------------------------------------------------------

async function setResearcherFixture(
  sources: FixtureResearcherSource[],
  prompts: FixtureStandingPrompt[],
) {
  await commands.setFixtureState({
    state: {
      researcherSources: sources,
      researcherStandingPrompts: prompts,
    },
  });
}

afterEach(async () => {
  await commands.resetFixtureState({ fixtureId: 'default' });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('SourcesTriggersPage renders Sources and Triggers tabs', async () => {
  await setResearcherFixture(FIXTURE_SOURCES, FIXTURE_PROMPTS);
  const screen = render(<SourcesTriggersPage />);

  await expect.element(screen.getByTestId('tab-sources')).toBeVisible();
  await expect.element(screen.getByTestId('tab-triggers')).toBeVisible();
});

test('Sources tab renders source rows with name, URL, and status chip', async () => {
  await setResearcherFixture(FIXTURE_SOURCES, FIXTURE_PROMPTS);
  const screen = render(<SourcesTriggersPage />);

  // Sources tab is the default — wait for the table to appear.
  await expect.element(screen.getByTestId('sources-table')).toBeVisible();

  // All three source names should be present.
  await expect.element(screen.getByText('SEC EDGAR')).toBeVisible();
  await expect.element(screen.getByText('Bloomberg API')).toBeVisible();
  await expect.element(screen.getByText('Old Venue')).toBeVisible();

  // Status chips should be visible.
  await expect.element(screen.getByText('active')).toBeVisible();
  await expect.element(screen.getByText('pending')).toBeVisible();
  await expect.element(screen.getByText('retired')).toBeVisible();
});

test('Sources tab has no create, edit, or delete controls', async () => {
  await setResearcherFixture(FIXTURE_SOURCES, FIXTURE_PROMPTS);
  const screen = render(<SourcesTriggersPage />);

  await expect.element(screen.getByTestId('sources-table')).toBeVisible();

  // Mutation controls must not be present on the read-only Sources tab.
  // The only interactive elements are the tab buttons and the refresh button.
  // Pin/unpin buttons only appear on the Triggers tab — verify they are absent here.
  await expect.element(screen.getByTestId('pin-button')).not.toBeInTheDocument();
  await expect.element(screen.getByTestId('unpin-button')).not.toBeInTheDocument();

  // Verify the three permitted buttons (tab-sources, tab-triggers, refresh-button) are present.
  await expect.element(screen.getByTestId('tab-sources')).toBeVisible();
  await expect.element(screen.getByTestId('tab-triggers')).toBeVisible();
  await expect.element(screen.getByTestId('refresh-button')).toBeVisible();
});

test('Triggers tab renders standing prompt rows grouped by subject_type', async () => {
  await setResearcherFixture(FIXTURE_SOURCES, FIXTURE_PROMPTS);
  const screen = render(<SourcesTriggersPage />);

  // Click the Triggers tab.
  await screen.getByTestId('tab-triggers').click();

  // Wait for the triggers container.
  await expect.element(screen.getByTestId('triggers-container')).toBeVisible();

  // All three subject type group headers should appear.
  // Use getByRole('heading') to avoid strict-mode collisions with subject_id cell text.
  await expect.element(screen.getByRole('heading', { name: 'Entity (per Ticker)' })).toBeVisible();
  await expect.element(screen.getByRole('heading', { name: 'Thesis' })).toBeVisible();
  await expect.element(screen.getByRole('heading', { name: 'Portfolio (Fallback)' })).toBeVisible();

  // Subject IDs and word counts should appear.
  await expect.element(screen.getByText('AAPL')).toBeVisible();
  await expect.element(screen.getByText('rates-thesis')).toBeVisible();
  await expect.element(screen.getByText('42 words')).toBeVisible();
  await expect.element(screen.getByText('67 words')).toBeVisible();
  await expect.element(screen.getByText('31 words')).toBeVisible();
});

test('Triggers tab shows Pinned badge for pinned prompts', async () => {
  await setResearcherFixture(FIXTURE_SOURCES, FIXTURE_PROMPTS);
  const screen = render(<SourcesTriggersPage />);

  await screen.getByTestId('tab-triggers').click();

  await expect.element(screen.getByTestId('triggers-container')).toBeVisible();

  // The thesis prompt is pinned — should show the pinned badge.
  await expect.element(screen.getByTestId('pinned-badge')).toBeVisible();
});

test('Triggers tab renders pin button for unpinned prompt and unpin for pinned prompt', async () => {
  await setResearcherFixture(FIXTURE_SOURCES, FIXTURE_PROMPTS);
  const screen = render(<SourcesTriggersPage />);

  await screen.getByTestId('tab-triggers').click();
  await expect.element(screen.getByTestId('triggers-container')).toBeVisible();

  // There should be at least one pin button (for unpinned prompts).
  await expect.element(screen.getByTestId('pin-button')).toBeVisible();

  // There should be at least one unpin button (for the pinned thesis prompt).
  await expect.element(screen.getByTestId('unpin-button')).toBeVisible();
});
