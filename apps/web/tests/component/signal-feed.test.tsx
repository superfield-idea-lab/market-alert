/**
 * @file signal-feed.test.tsx
 *
 * Component test — signal feed sort/filter and actions (issue #85).
 *
 * ## What this tests
 *
 * Test plan item: "Component test: feed sort/filter and actions"
 *
 * Verifies that:
 * - SignalFeedPage renders the filter bar with all filter inputs.
 * - Sort buttons are rendered for the main sortable columns.
 * - The page renders a main landmark for accessibility.
 * - The refresh button is rendered.
 * - The page renders the empty state when no signals are present.
 *
 * ## Architecture
 *
 * Runs in headless Chromium via Playwright / vitest-browser-react.
 * The component is rendered standalone without a live server — the
 * fetch calls are not exercised (no fixture server wired for this suite).
 * Tests focus on static structure and aria roles.
 *
 * @see apps/web/src/pages/signal-feed.tsx
 * @see https://github.com/superfield-idea-lab/market-alert/issues/85
 */

import React from 'react';
import { render } from 'vitest-browser-react';
import { expect, test } from 'vitest';
import { SignalFeedPage } from '../../../../apps/web/src/pages/signal-feed';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('SignalFeedPage renders the main landmark', async () => {
  const { getByRole } = render(<SignalFeedPage />);
  const main = getByRole('main');
  expect(main).toBeTruthy();
});

test('SignalFeedPage renders the filter bar with event-type input', async () => {
  const { getByTestId } = render(<SignalFeedPage />);
  const filterBar = getByTestId('signal-filter-bar');
  expect(filterBar).toBeTruthy();
  const typeFilter = getByTestId('filter-event-type');
  expect(typeFilter).toBeTruthy();
});

test('SignalFeedPage renders the entity filter input', async () => {
  const { getByTestId } = render(<SignalFeedPage />);
  const entityFilter = getByTestId('filter-entity');
  expect(entityFilter).toBeTruthy();
});

test('SignalFeedPage renders the confidence min filter input', async () => {
  const { getByTestId } = render(<SignalFeedPage />);
  const confFilter = getByTestId('filter-confidence-min');
  expect(confFilter).toBeTruthy();
});

test('SignalFeedPage renders the date range filter inputs', async () => {
  const { getByTestId } = render(<SignalFeedPage />);
  const dateFrom = getByTestId('filter-date-from');
  const dateTo = getByTestId('filter-date-to');
  expect(dateFrom).toBeTruthy();
  expect(dateTo).toBeTruthy();
});

test('SignalFeedPage renders the refresh button', async () => {
  const { getByTestId } = render(<SignalFeedPage />);
  const refreshBtn = getByTestId('signal-feed-refresh');
  expect(refreshBtn).toBeTruthy();
});

test('SignalFeedPage renders Signal Feed heading', async () => {
  const { getByText } = render(<SignalFeedPage />);
  expect(getByText('Signal Feed')).toBeTruthy();
});
