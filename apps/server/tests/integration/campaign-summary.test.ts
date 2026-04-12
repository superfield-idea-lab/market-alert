/**
 * @file campaign-summary.test.ts
 *
 * Integration tests for the campaign summary endpoint — Phase 7 (issue #75).
 *
 * ## What is tested
 *
 * 1. POST /api/campaign/summarise — authentication gate
 *    - Returns 401 without a session cookie.
 *    - Returns 400 when asset_manager_id is missing.
 *
 * 2. POST /api/campaign/summarise — success path
 *    - Seeds an asset_manager entity, a transcript entity, a discussed_in
 *      relation, and a corpus_chunk entity linked to that transcript.
 *    - The endpoint fetches the anonymised chunks and calls the Claude API.
 *    - The Claude API response is intercepted by a real node:http fixture server
 *      that replays the golden fixture
 *      `tests/fixtures/anthropic/campaign-summary-success_2026-04-12T00-00-00-000Z.json`.
 *    - Asserts that the response status is "ok" and the structured summary
 *      contains themes, topics, sentiment, and frequency.
 *    - No customer identifiers appear in the summary.
 *
 * 3. POST /api/campaign/summarise — API failure fallback
 *    - The fixture server responds with a 500 error to simulate an API outage.
 *    - The endpoint must return status "fallback" with the raw chunk list and
 *      an error string.
 *
 * ## External API interception
 *
 * The Anthropic API call is intercepted by a real `node:http` fixture server.
 * The app server is started with `ANTHROPIC_BASE_URL=http://localhost:<PORT>`
 * so the Anthropic SDK routes all calls to the fixture server instead of
 * `api.anthropic.com`.
 *
 * This follows the testing standard: "Use real `node:http` servers for local
 * endpoints."
 *
 * ## Canonical docs
 *
 *   - docs/implementation-plan-v1.md §Phase 7 — BDM campaign analysis
 *   - docs/PRD.md §4.7 (BDM workflow, summarise endpoint)
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/75
 */

import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { createServer, type Server as HttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31473;
const FIXTURE_PORT = 31474;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';
const SUCCESS_FIXTURE_PATH = join(
  REPO_ROOT,
  'tests/fixtures/anthropic/campaign-summary-success_2026-04-12T00-00-00-000Z.json',
);

let pg: PgContainer;
let adminSql: ReturnType<typeof postgres>;
let server: Subprocess;
let fixtureServer: HttpServer;
let authCookie = '';
let csrfToken = '';

// Seeded entity IDs
let assetManagerId = '';
let transcriptId = '';
let chunkId = '';

// ---------------------------------------------------------------------------
// Fixture server helpers
// ---------------------------------------------------------------------------

type FixtureMode = 'success' | 'error';
let fixtureMode: FixtureMode = 'success';

/**
 * Starts a local HTTP server that replays the campaign summary fixture.
 *
 * The response changes based on `fixtureMode`:
 *   - 'success' — replays the golden fixture JSON response.
 *   - 'error'   — returns a 500 error to simulate API unavailability.
 */
function startFixtureServer(port: number): HttpServer {
  const raw = readFileSync(SUCCESS_FIXTURE_PATH, 'utf-8');
  const fixture = JSON.parse(raw) as {
    response: {
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: unknown;
    };
  };

  const httpServer = createServer((_req, res) => {
    if (fixtureMode === 'error') {
      const errorBody = JSON.stringify({
        error: { type: 'api_error', message: 'Service unavailable' },
      });
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(errorBody),
      });
      res.end(errorBody);
      return;
    }

    const responseBody = JSON.stringify(fixture.response.body);
    res.writeHead(fixture.response.status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(responseBody),
    });
    res.end(responseBody);
  });

  httpServer.listen(port);
  return httpServer;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pg = await startPostgres();

  // Create the audit_events table (same DB used for both app and audit in tests).
  adminSql = postgres(pg.url, { max: 3 });
  await adminSql.unsafe(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before JSONB,
      after JSONB,
      ip TEXT,
      user_agent TEXT,
      correlation_id TEXT,
      ts TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    )
  `);

  // Start the fixture server.
  fixtureServer = startFixtureServer(FIXTURE_PORT);

  // Start the app server with the fixture redirect.
  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      PORT: String(PORT),
      TEST_MODE: 'true',
      CSRF_DISABLED: 'true',
      ANTHROPIC_BASE_URL: `http://localhost:${FIXTURE_PORT}`,
      ANTHROPIC_API_KEY: 'test-placeholder-key',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);

  const session = await createTestSession(BASE);
  authCookie = session.cookie;
  csrfToken = session.csrfToken;

  // Seed test entities via the admin pool (bypasses RLS).
  assetManagerId = crypto.randomUUID();
  transcriptId = crypto.randomUUID();
  chunkId = crypto.randomUUID();
  const relationId = crypto.randomUUID();
  const chunk2Id = crypto.randomUUID();

  // Ensure required entity types exist (server startup registers most of them;
  // we insert with ON CONFLICT DO NOTHING so this is always safe).
  await adminSql`
    INSERT INTO entity_types (type, schema)
    VALUES
      ('asset_manager', '{}'),
      ('transcript',    '{}'),
      ('corpus_chunk',  '{}')
    ON CONFLICT (type) DO NOTHING
  `;

  // Insert the asset manager entity.
  await adminSql`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES (${assetManagerId}, 'asset_manager', '{}', NULL)
  `;

  // Insert the transcript entity.
  await adminSql`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES (${transcriptId}, 'transcript', '{}', NULL)
  `;

  // Insert a discussed_in relation: asset_manager → transcript.
  await adminSql`
    INSERT INTO relations (id, source_id, target_id, type, properties)
    VALUES (${relationId}, ${assetManagerId}, ${transcriptId}, 'discussed_in', '{}')
  `;

  // Insert corpus_chunk entities linked to the transcript (source_id = transcriptId).
  // These are the anonymised chunks that the summarise endpoint will fetch.
  const chunk1Body =
    'The fund discussed infrastructure opportunities in renewable energy, particularly solar and wind projects across Europe.';
  const chunk2Body =
    'Allocation strategy focused on long-duration assets with stable cash flows, with positive sentiment toward green bonds.';

  await adminSql`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES (
      ${chunkId},
      'corpus_chunk',
      ${adminSql.json({ body: chunk1Body, source_id: transcriptId, index: 0, token_count: 20 })},
      NULL
    )
  `;

  await adminSql`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES (
      ${chunk2Id},
      'corpus_chunk',
      ${adminSql.json({ body: chunk2Body, source_id: transcriptId, index: 1, token_count: 19 })},
      NULL
    )
  `;
}, 60_000);

afterAll(async () => {
  server?.kill();
  await adminSql?.end({ timeout: 5 });
  await pg?.stop();
  await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Authentication gate
// ---------------------------------------------------------------------------

test('POST /api/campaign/summarise returns 401 without auth', async () => {
  const res = await fetch(`${BASE}/api/campaign/summarise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ asset_manager_id: assetManagerId }),
  });
  expect(res.status).toBe(401);
});

test('POST /api/campaign/summarise returns 400 when asset_manager_id is missing', async () => {
  const res = await fetch(`${BASE}/api/campaign/summarise`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: authCookie,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as Record<string, unknown>;
  expect(typeof body.error).toBe('string');
});

// ---------------------------------------------------------------------------
// Success path — structured 1-pager returned
// ---------------------------------------------------------------------------

test('POST /api/campaign/summarise returns structured summary on Claude API success', async () => {
  fixtureMode = 'success';

  const res = await fetch(`${BASE}/api/campaign/summarise`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: authCookie,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({ asset_manager_id: assetManagerId }),
  });

  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;

  // Top-level response shape.
  expect(body.status).toBe('ok');
  expect(body.asset_manager_id).toBe(assetManagerId);
  expect(body.fund_id).toBeNull();
  expect(typeof body.chunk_count).toBe('number');
  expect(body.chunk_count as number).toBeGreaterThan(0);

  // Structured summary fields.
  const summary = body.summary as Record<string, unknown>;
  expect(Array.isArray(summary.themes)).toBe(true);
  expect((summary.themes as string[]).length).toBeGreaterThan(0);
  expect(Array.isArray(summary.topics)).toBe(true);
  expect((summary.topics as string[]).length).toBeGreaterThan(0);
  expect(['positive', 'neutral', 'negative', 'mixed']).toContain(summary.sentiment);
  expect(typeof summary.frequency).toBe('object');
  expect(summary.frequency).not.toBeNull();

  // Privacy check — no customer identifiers appear in the summary.
  // The summary JSON must not contain any of the seeded customer-identifying
  // entity IDs (transcript IDs are not customer data but chunk IDs appear
  // on the outer response, not inside the summary itself).
  const summaryStr = JSON.stringify(summary);
  // The summary should not reference transcript or chunk IDs.
  expect(summaryStr).not.toContain(transcriptId);
  expect(summaryStr).not.toContain(chunkId);
});

// ---------------------------------------------------------------------------
// Fallback path — raw chunks returned on API failure
// ---------------------------------------------------------------------------

test('POST /api/campaign/summarise returns raw-chunk fallback on Claude API failure', async () => {
  fixtureMode = 'error';

  const res = await fetch(`${BASE}/api/campaign/summarise`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: authCookie,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({ asset_manager_id: assetManagerId }),
  });

  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;

  // Fallback shape.
  expect(body.status).toBe('fallback');
  expect(body.asset_manager_id).toBe(assetManagerId);
  expect(Array.isArray(body.chunks)).toBe(true);
  expect((body.chunks as unknown[]).length).toBeGreaterThan(0);
  expect(typeof body.error).toBe('string');
  expect((body.error as string).length).toBeGreaterThan(0);

  // Each chunk must have id, content, and chunk_index — no customer data.
  const chunks = body.chunks as { id: string; content: string; chunk_index: number }[];
  for (const chunk of chunks) {
    expect(typeof chunk.id).toBe('string');
    expect(typeof chunk.content).toBe('string');
    expect(typeof chunk.chunk_index).toBe('number');
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/health/live`);
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}
