/**
 * @file tests/fixtures/edgar/msw-handler.ts
 *
 * MSW v2 handlers for EDGAR ATOM feed requests — Phase 2 (issues #14, #15).
 *
 * ## Overview
 *
 * Provides two factory functions:
 *
 * 1. `createEdgarFeedHandler()` — single-form-type handler (issue #14).
 *    Replays the committed 8-K ATOM fixture for any GET to efts.sec.gov/*.
 *    Used by the legacy edgar-ingest.spec.ts integration test.
 *
 * 2. `createMultiFormEdgarHandlers()` — multi-form-type handler set (issue #15).
 *    Replays per-form-type ATOM fixtures from multi-form-atom-feed.json.
 *    The `forms` query parameter is inspected to route to the correct fixture.
 *    Falls back to an empty feed for form types not in the fixture file.
 *    Used by edgar-multi-form.spec.ts integration test.
 *
 * ## Fixture files
 *
 * - tests/fixtures/edgar/8k-atom-feed.json — single 8-K entry (issue #14)
 * - tests/fixtures/edgar/multi-form-atom-feed.json — per-form-type entries (issue #15)
 *
 * ## Canonical docs
 *
 * - blueprint: test.yaml § TEST-D-001 (golden-fixture-recording)
 * - docs/architecture.md — ingestion pipeline overview
 * - apps/worker/src/edgar-ingest-job.ts — EDGAR_POLL job
 * - tests/integration/edgar-ingest.spec.ts — issue #14 test
 * - tests/integration/edgar-multi-form.spec.ts — issue #15 test
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { http, HttpResponse } from 'msw';
import type { HttpHandler } from 'msw';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fixture loaders
// ---------------------------------------------------------------------------

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
 * Multi-form-type fixture type definition.
 */
interface MultiFormFixture {
  form_type_feeds: Record<string, { status: number; content_type: string; body: string }>;
}

/**
 * Loads the multi-form-type EDGAR ATOM feed fixture from disk.
 */
function loadMultiFormFixture(): MultiFormFixture {
  const fixturePath = join(__dirname, 'multi-form-atom-feed.json');
  return JSON.parse(readFileSync(fixturePath, 'utf-8')) as MultiFormFixture;
}

/**
 * Returns an empty EDGAR ATOM feed XML for form types not in the fixture.
 */
function emptyFeed(formType: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n  <title>EDGAR Full-Text Search RSS Feed — ${formType}</title>\n  <updated>${new Date().toISOString()}</updated>\n</feed>`;
}

// ---------------------------------------------------------------------------
// Legacy handler (issue #14)
// ---------------------------------------------------------------------------

/**
 * Creates an MSW v2 handler that intercepts all GET requests to
 * `https://efts.sec.gov/*` and replays the EDGAR 8-K ATOM feed fixture.
 *
 * Tracks whether the handler was actually called so tests can assert the
 * intercept count (zero live network calls to sec.gov).
 *
 * Used by: tests/integration/edgar-ingest.spec.ts
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

// ---------------------------------------------------------------------------
// Multi-form-type handler (issue #15)
// ---------------------------------------------------------------------------

/**
 * Result type returned by createMultiFormEdgarHandlers.
 */
export interface MultiFormHandlerSet {
  /** All MSW handlers to register with setupServer(). */
  handlers: HttpHandler[];
  /** Total number of times any EDGAR feed was intercepted. */
  readonly totalCallCount: number;
  /** Per-form-type call counts keyed by the `forms` query parameter value. */
  callCountByFormType: Record<string, number>;
}

/**
 * Creates a set of MSW v2 handlers for multi-form-type EDGAR feed interception.
 *
 * Inspects the `forms` query parameter of incoming requests and routes to the
 * correct per-form-type fixture body. Returns an empty feed for unknown types.
 *
 * The returned object exposes `totalCallCount` and `callCountByFormType`
 * properties for test assertions.
 *
 * Used by: tests/integration/edgar-multi-form.spec.ts
 */
export function createMultiFormEdgarHandlers(): MultiFormHandlerSet {
  const fixture = loadMultiFormFixture();
  let totalCallCount = 0;
  const callCountByFormType: Record<string, number> = {};

  const handler = http.get('https://efts.sec.gov/*', ({ request }) => {
    const url = new URL(request.url);
    const formsParam = url.searchParams.get('forms') ?? '';

    totalCallCount++;
    callCountByFormType[formsParam] = (callCountByFormType[formsParam] ?? 0) + 1;

    const formFeed = fixture.form_type_feeds[formsParam];
    const body = formFeed ? formFeed.body : emptyFeed(formsParam);
    const contentType = formFeed ? formFeed.content_type : 'application/atom+xml; charset=UTF-8';

    return new HttpResponse(body, {
      status: 200,
      headers: { 'content-type': contentType },
    });
  });

  const result: MultiFormHandlerSet = {
    handlers: [handler],
    get totalCallCount() {
      return totalCallCount;
    },
    callCountByFormType,
  };

  return result;
}
