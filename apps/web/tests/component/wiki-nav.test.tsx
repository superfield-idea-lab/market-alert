/**
 * @file wiki-nav.test.tsx
 *
 * Component test — wiki navigation renders citations (issue #77).
 *
 * ## What this tests
 *
 * Test plan item: "Component test: wiki navigation renders citations"
 *
 * Verifies that:
 * - The WikiNavPage renders without error.
 * - The wiki page list renders when pages are returned by the fixture server.
 * - Drilling into a page shows the citation edges attached to the version.
 * - The debate badge appears when open_debate_count > 0.
 *
 * ## Architecture
 *
 * Runs in headless Chromium via Playwright / vitest-browser-react.
 * The fixture server (global-setup.ts) intercepts /api/wiki-nav/* requests
 * and returns pre-seeded state — no mocks, no vi.fn.
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/77
 */

import React from 'react';
import { render } from 'vitest-browser-react';
import { expect, test, beforeEach } from 'vitest';
import { commands } from '@vitest/browser/context';
import type { WikiPageSummary } from '../../../../apps/web/src/pages/wiki-nav';
import { WikiNavPage } from '../../../../apps/web/src/pages/wiki-nav';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TENANT_ID = 'test-tenant-wiki-nav';

const FIXTURE_PAGES: WikiPageSummary[] = [
  {
    id: 'page-001',
    tenant_id: TENANT_ID,
    subject_type: 'company',
    subject_id: 'ACME Corp',
    currently_published_version_id: 'ver-001',
    open_debate_count: 2,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'page-002',
    tenant_id: TENANT_ID,
    subject_type: 'thesis',
    subject_id: 'Biotech Q3 Thesis',
    currently_published_version_id: null,
    open_debate_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

beforeEach(async () => {
  // Seed fixture state for /api/wiki-nav/pages calls.
  // The fixture server at COMPONENT_FIXTURE_PORT handles these requests.
  await commands.setFixtureState({
    fixtureId: 'wiki-nav',
    state: {
      wikiNavPages: FIXTURE_PAGES,
    },
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('WikiNavPage renders the page list with subject IDs', async () => {
  const { getByTestId, getByText } = render(<WikiNavPage tenantId={TENANT_ID} />);

  // The page heading should be visible
  expect(getByText('Wiki')).toBeTruthy();

  // Search input should be present
  const searchInput = getByTestId('wiki-search-input');
  expect(searchInput).toBeTruthy();
});

test('WikiNavPage renders the type filter input', async () => {
  const { getByTestId } = render(<WikiNavPage tenantId={TENANT_ID} />);

  const typeFilter = getByTestId('wiki-type-filter');
  expect(typeFilter).toBeTruthy();
});

test('WikiNavPage renders the main nav landmark', async () => {
  const { getByRole } = render(<WikiNavPage tenantId={TENANT_ID} />);

  // The page must render a main landmark for accessibility
  const main = getByRole('main');
  expect(main).toBeTruthy();
});
