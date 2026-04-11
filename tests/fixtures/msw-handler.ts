/**
 * @file tests/fixtures/msw-handler.ts
 *
 * Root-level MSW v2 handler factory for loading golden fixtures from disk and
 * replaying them in integration tests. This module is the single place where
 * test suites wire recorded fixtures to MSW network interception.
 *
 * ## Usage
 *
 *   import { createFixtureHandlerFromDir, createFixtureHandlerFromFile } from
 *     '../fixtures/msw-handler';
 *   import { setupServer } from 'msw/node';
 *
 *   const { handler } = createFixtureHandlerFromDir('tests/fixtures/anthropic');
 *   const server = setupServer(handler);
 *
 *   beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
 *   afterAll(() => server.close());
 *   afterEach(() => server.resetHandlers());
 *
 * ## Fixture format
 *
 * Each fixture file must conform to GoldenFixture (see scripts/record-fixture.ts):
 *   {
 *     "recorded_at": "<ISO-8601>",
 *     "service": "<name>",
 *     "request":  { "method", "url", "headers", "body" },
 *     "response": { "status", "statusText", "headers", "body" }
 *   }
 *
 * ## Staleness check
 *
 * Fixtures older than 30 days (TEST-C-025) will trigger a console warning
 * when loaded. Use `assertFixturesFresh()` in CI to turn this into a hard
 * failure.
 *
 * ## Blueprint refs
 *
 * - TEST-D-001: golden-fixture-recording
 * - TEST-A-003: fixture-refresh-pipeline
 * - TEST-C-003: golden-fixture-recorded
 * - TEST-C-019: fixture-refresh-pipeline
 * - TEST-C-025: fixtures-refreshed (recorded_at < 30 days)
 *
 * Canonical doc: docs/implementation-plan-v1.md § Phase 0
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { http, HttpResponse } from 'msw';
import type { HttpHandler } from 'msw';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoldenFixture {
  recorded_at: string;
  request: {
    body: unknown;
    headers: Record<string, string>;
    method: string;
    url: string;
  };
  response: {
    body: unknown;
    headers: Record<string, string>;
    status: number;
    statusText: string;
  };
  service: string;
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

const STALE_THRESHOLD_DAYS = 30;

/**
 * Returns true if the fixture was recorded more than 30 days ago.
 */
export function isFixtureStale(fixture: GoldenFixture, now = new Date()): boolean {
  const recorded = new Date(fixture.recorded_at);
  const ageMs = now.getTime() - recorded.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays > STALE_THRESHOLD_DAYS;
}

/**
 * Throws if any fixture in the array is stale (older than 30 days).
 * Intended for use in CI to enforce TEST-C-025.
 */
export function assertFixturesFresh(fixtures: GoldenFixture[], now = new Date()): void {
  for (const fixture of fixtures) {
    if (isFixtureStale(fixture, now)) {
      const ageDays = Math.floor(
        (now.getTime() - new Date(fixture.recorded_at).getTime()) / (1000 * 60 * 60 * 24),
      );
      throw new Error(
        `Stale fixture detected (TEST-C-025): service="${fixture.service}" ` +
          `recorded_at="${fixture.recorded_at}" is ${ageDays} days old ` +
          `(threshold: ${STALE_THRESHOLD_DAYS} days). ` +
          `Run: bun run scripts/record-fixture.ts --service ${fixture.service}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/**
 * Loads a single GoldenFixture from a JSON file.
 */
export function loadFixtureFile(filePath: string): GoldenFixture {
  const raw = readFileSync(filePath, 'utf-8');
  const fixture = JSON.parse(raw) as GoldenFixture;

  if (!fixture.recorded_at) {
    throw new Error(`Fixture at ${filePath} is missing required "recorded_at" field (TEST-C-025)`);
  }

  if (isFixtureStale(fixture)) {
    const ageDays = Math.floor(
      (Date.now() - new Date(fixture.recorded_at).getTime()) / (1000 * 60 * 60 * 24),
    );
    console.warn(
      `[msw-handler] Stale fixture loaded: ${filePath} (${ageDays} days old, threshold ${STALE_THRESHOLD_DAYS})`,
    );
  }

  return fixture;
}

/**
 * Loads all GoldenFixture files from a directory, sorted by filename.
 */
export function loadFixturesFromDir(fixtureDir: string): GoldenFixture[] {
  const absDir = resolve(fixtureDir);
  const files = readdirSync(absDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  return files.map((f) => loadFixtureFile(join(absDir, f)));
}

// ---------------------------------------------------------------------------
// Handler factories
// ---------------------------------------------------------------------------

function buildResponseFromFixture(fixture: GoldenFixture): HttpResponse<string> {
  // Strip content-encoding — fixtures store decoded body but may retain
  // the original gzip/br header from the real API recording.
  const headers = { ...fixture.response.headers };
  delete headers['content-encoding'];
  delete headers['transfer-encoding'];

  const body =
    fixture.response.body === null || fixture.response.body === undefined
      ? undefined
      : JSON.stringify(fixture.response.body);

  return new HttpResponse(body, {
    headers,
    status: fixture.response.status,
    statusText: fixture.response.statusText,
  });
}

/**
 * Creates an MSW handler that replays a single fixture unconditionally.
 * The handler matches any request to the fixture's URL and method.
 */
export function createFixtureHandlerFromFile(filePath: string): {
  fixture: GoldenFixture;
  handler: HttpHandler;
} {
  const fixture = loadFixtureFile(filePath);

  const handler = http[fixture.request.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete'](
    fixture.request.url,
    () => buildResponseFromFixture(fixture),
  );

  return { fixture, handler };
}

/**
 * Creates an MSW handler that replays fixtures from a directory in sequence.
 * Each request consumes the next fixture in alphabetical order.
 * If all fixtures are exhausted, the handler returns a 500 error.
 *
 * Reset between tests by calling `reset()`.
 */
export function createFixtureHandlerFromDir(fixtureDir: string): {
  fixtures: GoldenFixture[];
  handler: HttpHandler;
  reset: () => void;
} {
  const fixtures = loadFixturesFromDir(fixtureDir);
  let nextIndex = 0;

  const handler = http.all('*', ({ request }) => {
    if (nextIndex >= fixtures.length) {
      return HttpResponse.json(
        {
          error: `No fixture remains at index ${nextIndex} for ${request.method} ${request.url} in ${fixtureDir}`,
        },
        { status: 500 },
      );
    }

    const fixture = fixtures[nextIndex];
    nextIndex++;
    return buildResponseFromFixture(fixture);
  });

  const reset = () => {
    nextIndex = 0;
  };

  return { fixtures, handler, reset };
}

/**
 * Creates an MSW handler that replays fixtures by matching request URL
 * and method exactly (non-sequential). Useful when tests may fire requests
 * in non-deterministic order.
 */
export function createMatchingFixtureHandler(fixtures: GoldenFixture[]): {
  handler: HttpHandler;
} {
  const handler = http.all('*', ({ request }) => {
    const match = fixtures.find((f) => {
      const fUrl = new URL(f.request.url);
      const rUrl = new URL(request.url);
      return (
        f.request.method === request.method &&
        fUrl.origin + fUrl.pathname === rUrl.origin + rUrl.pathname
      );
    });

    if (!match) {
      return HttpResponse.json(
        { error: `No fixture matched ${request.method} ${request.url}` },
        { status: 500 },
      );
    }

    return buildResponseFromFixture(match);
  });

  return { handler };
}
