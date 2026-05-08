/**
 * @file tests/fixtures/edgar/msw-handler.ts
 *
 * MSW v2 handler for EDGAR ATOM feed requests — Phase 2 dev-scout (issue #14).
 *
 * ## Status: dev-scout stub
 *
 * Intercepts all requests to `https://efts.sec.gov/*` and replays the
 * committed EDGAR 8-K ATOM fixture (`tests/fixtures/edgar/8k-atom-feed.json`).
 *
 * This handler ensures zero live network calls reach sec.gov during CI
 * (acceptance criterion: "No live network calls occur: all sec.gov calls are
 * intercepted by MSW v2").
 *
 * ## Usage
 *
 *   import { setupServer } from 'msw/node';
 *   import { createEdgarFeedHandler } from '../fixtures/edgar/msw-handler';
 *
 *   const server = setupServer(createEdgarFeedHandler());
 *   beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
 *   afterAll(() => server.close());
 *
 * ## Seams discovered during scout
 *
 * - The edgar_ingest worker fetches the EDGAR ATOM feed via a plain `fetch()`
 *   call. MSW v2 intercepts this in the Node.js environment via
 *   `setupServer` + `server.listen()`.
 * - The EDGAR_FEED_URL env var (to be added in a follow-on issue) allows tests
 *   to override the feed URL; the MSW handler must intercept that URL too.
 *   Currently this handler uses a broad `efts.sec.gov/*` glob to catch any
 *   variation.
 * - The feed fixture returns XML, not JSON. The `buildResponseFromFixture`
 *   helper in the root-level msw-handler.ts stringifies the body as JSON,
 *   which is inappropriate for XML responses. This handler bypasses that helper
 *   and returns the XML string directly with the correct content-type.
 *
 * ## Risks
 *
 * - The EDGAR feed URL may include query parameters that change per poll
 *   window (startdt/enddt). The handler uses a glob to avoid brittle URL
 *   matching. Follow-on tests should assert the request URL parameters.
 * - The fixture contains exactly one 8-K entry. Multi-entry and pagination
 *   tests require additional fixtures (Phase 2 follow-on).
 *
 * ## Canonical docs
 *
 * - docs/architecture.md — ingestion pipeline overview
 * - tests/fixtures/edgar/8k-atom-feed.json — the committed feed fixture
 * - tests/fixtures/msw-handler.ts — root-level fixture handler factory
 * - blueprint: test.yaml § TEST-D-001 (golden-fixture-recording)
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { http, HttpResponse } from 'msw';
import type { HttpHandler } from 'msw';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Loads the committed EDGAR 8-K ATOM feed fixture from disk.
 * The fixture JSON envelope wraps the raw XML body as a string.
 */
function loadEdgarFeedFixture(): string {
  const fixturePath = join(__dirname, '8k-atom-feed.json');
  const envelope = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
    response: { body: string; status: number; headers: Record<string, string> };
  };
  return envelope.response.body;
}

/**
 * Creates an MSW v2 handler that intercepts all GET requests to
 * `https://efts.sec.gov/*` and replays the EDGAR 8-K ATOM feed fixture.
 *
 * Tracks whether the handler was actually called so tests can assert the
 * intercept count (zero live network calls to sec.gov).
 */
export function createEdgarFeedHandler(): HttpHandler & { callCount: number } {
  let callCount = 0;

  // Use a handler with a mutable callCount property for test assertions.
  const handler = http.get('https://efts.sec.gov/*', () => {
    callCount++;
    const body = loadEdgarFeedFixture();
    return new HttpResponse(body, {
      status: 200,
      headers: {
        'content-type': 'application/atom+xml; charset=UTF-8',
      },
    });
  }) as HttpHandler & { callCount: number };

  // Attach a live getter so tests can read the count after the fact.
  Object.defineProperty(handler, 'callCount', {
    get: () => callCount,
  });

  return handler;
}
