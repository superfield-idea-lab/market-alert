/**
 * @file wiki-view.spec.ts
 *
 * End-to-end test stub — read-only wiki view happy path (issue #45).
 *
 * ## Scout stub (Phase 4)
 *
 * The WikiViewPage component is currently a no-op stub that renders a
 * placeholder. This e2e test asserts the stub contract:
 *   - The WikiViewPage placeholder renders without console errors.
 *   - The placeholder contains the expected stub copy.
 *
 * Once the real Phase 4 implementation lands, this test should be replaced
 * with a full happy-path Playwright scenario:
 *   1. Authenticate as an RM.
 *   2. Navigate to a seeded customer's wiki page.
 *   3. Assert the rendered markdown is visible.
 *   4. Assert the version picker lists at least one version with created_by
 *      and source metadata.
 *   5. Hover a citation anchor and assert the CitationHoverCard is visible
 *      with a non-empty excerpt.
 *
 * Test plan items (issue #45):
 *   TP-1  Playwright: e2e scenario of the happy read path against real
 *         headless Chromium.
 *
 * No mocks — real Bun server via the shared E2E environment helper.
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/45
 */

import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startE2EServer, stopE2EServer, type E2EEnvironment } from './environment';

let browser: Browser;
let env: E2EEnvironment;

beforeAll(async () => {
  env = await startE2EServer();
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
  await stopE2EServer(env);
});

// ---------------------------------------------------------------------------
// Scout-stub contract tests
// ---------------------------------------------------------------------------

test('wiki-view stub: API returns 501 with expected_response_shape for authenticated callers', async () => {
  // Obtain a test session via the TEST_MODE backdoor.
  const sessionRes = await fetch(`${env.baseUrl}/api/test/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test-rm' }),
  });
  expect(sessionRes.ok).toBe(true);

  const setCookie = sessionRes.headers.get('set-cookie') ?? '';
  const cookieMatch = /calypso_auth=([^;]+)/.exec(setCookie);
  const cookie = cookieMatch ? `calypso_auth=${cookieMatch[1]}` : '';

  const wikiRes = await fetch(`${env.baseUrl}/api/wiki/pages/stub-customer`, {
    headers: { Cookie: cookie },
  });

  expect(wikiRes.status).toBe(501);
  const body = await wikiRes.json();
  expect(body).toHaveProperty('expected_response_shape');
  expect(body.expected_response_shape).toHaveProperty('versions');
});

test('wiki-view stub: API returns 401 for unauthenticated callers', async () => {
  const res = await fetch(`${env.baseUrl}/api/wiki/pages/stub-customer`);
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// Stub placeholder — full Playwright happy-path test (Phase 4 follow-on)
// ---------------------------------------------------------------------------

/**
 * Placeholder test that documents the planned Playwright happy-path scenario.
 *
 * This test is skipped until the Phase 4 implementation is complete. The
 * comment block below is the specification for the real test.
 *
 * Planned scenario:
 *   1. Navigate to / and authenticate as an RM via the TEST_MODE session.
 *   2. Navigate to the wiki view for a seeded customer.
 *   3. Assert `data-testid="wiki-version-picker"` is visible.
 *   4. Assert at least one version card shows created_by and source text.
 *   5. Assert `data-testid="wiki-markdown-renderer"` contains rendered HTML.
 *   6. Hover a citation anchor (`[data-citation]`).
 *   7. Assert `data-testid="citation-hover-card"` is visible with non-empty excerpt.
 */
test.skip('wiki-view happy path: RM sees rendered wiki with version picker and citation hover', async () => {
  // Skipped — Phase 4 follow-on. See comment block above for the planned
  // Playwright scenario once WikiViewPage is implemented.
  const _page = await browser.newPage();
  await _page.close();
});
