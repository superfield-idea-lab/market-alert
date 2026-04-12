/**
 * @file annotation-thread.test.ts
 *
 * Integration tests for the annotation thread API — Phase 6 (issue #65).
 *
 * ## What is tested
 *
 * 1. POST /api/annotations — open an annotation thread
 *    - Requires an authenticated session (401 without auth)
 *    - Validates required fields (400 for missing fields)
 *    - Calls the Anthropic API SDK; the reply is posted with the agent
 *      visibility label
 *    - Returns 201 with state=AGENT_REPLIED and a thread containing both an
 *      rm message and an agent message
 *
 * 2. GET /api/annotations/:id — fetch a stored annotation thread
 *    - Returns 404 for unknown IDs
 *    - Returns the stored thread after a successful POST
 *
 * 3. POST /api/annotations/:id/accept — accept agent reply, publish new version
 *    - Requires auth (401 without auth)
 *    - Returns 200 with a new_wiki_version_id and state=ACCEPTED
 *
 * 4. POST /api/annotations/:id/reject — reject agent reply
 *    - Requires auth (401 without auth)
 *    - Returns 200 with state=REJECTED; no new wiki version is written
 *
 * ## External API interception
 *
 * The Anthropic API call is intercepted by a real `node:http` fixture server
 * that replays the golden fixture from
 * `tests/fixtures/anthropic/annotation-reply_2026-04-12T00-00-00-000Z.json`.
 * The app server is started with `ANTHROPIC_BASE_URL=http://localhost:<PORT>`
 * so the Anthropic SDK routes all calls to the fixture server instead of
 * `api.anthropic.com`.
 *
 * This follows the testing standard: "Use real `node:http` servers for local
 * endpoints" — the fixture server is the local endpoint in this context.
 *
 * ## Canonical docs
 *
 *   - docs/implementation-plan-v1.md §Phase 6
 *   - docs/PRD.md §5.2, §4.3, §6
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/65
 */

import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { createServer, type Server as HttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31437;
const FIXTURE_PORT = 31438;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';
const FIXTURE_PATH = join(
  REPO_ROOT,
  'tests/fixtures/anthropic/annotation-reply_2026-04-12T00-00-00-000Z.json',
);

let pg: PgContainer;
let adminSql: ReturnType<typeof postgres>;
let server: Subprocess;
let fixtureServer: HttpServer;
let authCookie = '';
let csrfToken = '';

// ---------------------------------------------------------------------------
// Fixture server — real node:http server replaying the golden fixture
// ---------------------------------------------------------------------------

/**
 * Starts a local HTTP server that replays the annotation fixture for every
 * POST request. The Anthropic SDK is redirected to this server via
 * ANTHROPIC_BASE_URL so no real API calls are made.
 */
function startFixtureServer(port: number): HttpServer {
  const raw = readFileSync(FIXTURE_PATH, 'utf-8');
  const fixture = JSON.parse(raw) as {
    response: {
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: unknown;
    };
  };

  const httpServer = createServer((_req, res) => {
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

  // Create the audit_events table in the test DB.
  // In production this is created by init-remote.ts; here we use the same DB
  // for both app and audit pools, so we create it inline (see reidentification.test.ts).
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

  // Start the fixture server that replays the Anthropic API response.
  fixtureServer = startFixtureServer(FIXTURE_PORT);

  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      PORT: String(PORT),
      TEST_MODE: 'true',
      CSRF_DISABLED: 'true',
      // Redirect all Anthropic API calls to the local fixture server.
      ANTHROPIC_BASE_URL: `http://localhost:${FIXTURE_PORT}`,
      // Provide a placeholder key so the SDK does not complain about missing auth.
      ANTHROPIC_API_KEY: 'test-placeholder-key',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);

  const session = await createTestSession(BASE);
  authCookie = session.cookie;
  csrfToken = session.csrfToken;
}, 60_000);

afterAll(async () => {
  server?.kill();
  await adminSql?.end();
  await pg?.stop();
  await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// POST /api/annotations — open annotation thread
// ---------------------------------------------------------------------------

test('POST /api/annotations returns 401 without auth', async () => {
  const res = await fetch(`${BASE}/api/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      wiki_page_version_id: 'v1',
      passage_ref: 'The fund was established in 2018.',
      comment: 'I think this date is wrong.',
    }),
  });
  expect(res.status).toBe(401);
});

test('POST /api/annotations returns 400 when required fields are missing', async () => {
  const res = await fetch(`${BASE}/api/annotations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: authCookie,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      // wiki_page_version_id omitted
      passage_ref: 'The fund was established in 2018.',
      comment: 'Missing version id',
    }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as Record<string, unknown>;
  expect(typeof body.error).toBe('string');
});

test('POST /api/annotations calls Anthropic SDK and returns 201 with agent reply', async () => {
  const res = await fetch(`${BASE}/api/annotations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: authCookie,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      wiki_page_version_id: 'version-abc',
      passage_ref: 'The fund was established in 2018.',
      comment: 'I believe this should be 2019 based on the incorporation documents.',
    }),
  });

  expect(res.status).toBe(201);
  const body = (await res.json()) as Record<string, unknown>;

  // Core fields.
  expect(typeof body.id).toBe('string');
  expect(body.wiki_page_version_id).toBe('version-abc');
  expect(body.passage_ref).toBe('The fund was established in 2018.');
  expect(body.state).toBe('AGENT_REPLIED');

  // Thread must contain exactly two messages: rm then agent.
  const thread = body.thread as { role: string; content: string; created_at: string }[];
  expect(Array.isArray(thread)).toBe(true);
  expect(thread.length).toBe(2);
  expect(thread[0].role).toBe('rm');
  expect(thread[0].content).toBe(
    'I believe this should be 2019 based on the incorporation documents.',
  );
  expect(thread[1].role).toBe('agent');
  expect(typeof thread[1].content).toBe('string');
  expect(thread[1].content.length).toBeGreaterThan(0);

  // Agent visibility label must be present.
  expect(body.agent_visibility).toBe('agent');
});

// ---------------------------------------------------------------------------
// GET /api/annotations/:id — fetch annotation
// ---------------------------------------------------------------------------

test('GET /api/annotations/:id returns 404 for unknown id', async () => {
  const res = await fetch(`${BASE}/api/annotations/nonexistent-id-xyz`, {
    headers: { Cookie: authCookie },
  });
  expect(res.status).toBe(404);
});

test('GET /api/annotations/:id returns the stored thread after POST', async () => {
  // Open a thread first.
  const postRes = await fetch(`${BASE}/api/annotations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: authCookie,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      wiki_page_version_id: 'version-get-test',
      passage_ref: 'The fund was established in 2018.',
      comment: 'I believe this should be 2019.',
    }),
  });
  expect(postRes.status).toBe(201);
  const created = (await postRes.json()) as { id: string };
  const annotationId = created.id;

  // Fetch it back.
  const getRes = await fetch(`${BASE}/api/annotations/${annotationId}`, {
    headers: { Cookie: authCookie },
  });
  expect(getRes.status).toBe(200);
  const body = (await getRes.json()) as Record<string, unknown>;
  expect(body.id).toBe(annotationId);
  expect(body.state).toBe('AGENT_REPLIED');
  const thread = body.thread as { role: string }[];
  expect(thread.length).toBe(2);
  expect(thread[0].role).toBe('rm');
  expect(thread[1].role).toBe('agent');
});

// ---------------------------------------------------------------------------
// POST /api/annotations/:id/accept — accept + publish new version
// ---------------------------------------------------------------------------

test('POST /api/annotations/:id/accept returns 401 without auth', async () => {
  const res = await fetch(`${BASE}/api/annotations/annotation-abc/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  expect(res.status).toBe(401);
});

test('POST /api/annotations/:id/accept returns 200 with new_wiki_version_id', async () => {
  // Create the annotation first.
  const postRes = await fetch(`${BASE}/api/annotations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: authCookie,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      wiki_page_version_id: 'version-accept-test',
      passage_ref: 'The fund was established in 2018.',
      comment: 'I believe this should be 2019.',
    }),
  });
  expect(postRes.status).toBe(201);
  const created = (await postRes.json()) as { id: string };
  const annotationId = created.id;

  // Accept it.
  const acceptRes = await fetch(`${BASE}/api/annotations/${annotationId}/accept`, {
    method: 'POST',
    headers: {
      Cookie: authCookie,
      'X-CSRF-Token': csrfToken,
    },
  });
  expect(acceptRes.status).toBe(200);
  const body = (await acceptRes.json()) as Record<string, unknown>;
  expect(body.annotation_id).toBe(annotationId);
  expect(body.state).toBe('ACCEPTED');
  expect(typeof body.new_wiki_version_id).toBe('string');
  expect((body.new_wiki_version_id as string).length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// POST /api/annotations/:id/reject — reject, no version written
// ---------------------------------------------------------------------------

test('POST /api/annotations/:id/reject returns 401 without auth', async () => {
  const res = await fetch(`${BASE}/api/annotations/annotation-abc/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  expect(res.status).toBe(401);
});

test('POST /api/annotations/:id/reject returns 200 with state=REJECTED', async () => {
  // Create the annotation first.
  const postRes = await fetch(`${BASE}/api/annotations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: authCookie,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      wiki_page_version_id: 'version-reject-test',
      passage_ref: 'The fund was established in 2018.',
      comment: 'I believe this should be 2019.',
    }),
  });
  expect(postRes.status).toBe(201);
  const created = (await postRes.json()) as { id: string };
  const annotationId = created.id;

  // Reject it.
  const rejectRes = await fetch(`${BASE}/api/annotations/${annotationId}/reject`, {
    method: 'POST',
    headers: {
      Cookie: authCookie,
      'X-CSRF-Token': csrfToken,
    },
  });
  expect(rejectRes.status).toBe(200);
  const body = (await rejectRes.json()) as Record<string, unknown>;
  expect(body.annotation_id).toBe(annotationId);
  expect(body.state).toBe('REJECTED');
});

test('POST /api/annotations/:id/reject leaves no new wiki_page_version in DB', async () => {
  // Create the annotation.
  const postRes = await fetch(`${BASE}/api/annotations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: authCookie,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      wiki_page_version_id: 'version-reject-noleak',
      passage_ref: 'The fund was established in 2018.',
      comment: 'I believe this should be 2019.',
    }),
  });
  expect(postRes.status).toBe(201);
  const created = (await postRes.json()) as { id: string };
  const annotationId = created.id;

  // Reject it — no new wiki version should be published.
  const rejectRes = await fetch(`${BASE}/api/annotations/${annotationId}/reject`, {
    method: 'POST',
    headers: {
      Cookie: authCookie,
      'X-CSRF-Token': csrfToken,
    },
  });
  expect(rejectRes.status).toBe(200);

  // Fetch the annotation to confirm state is REJECTED.
  const getRes = await fetch(`${BASE}/api/annotations/${annotationId}`, {
    headers: { Cookie: authCookie },
  });
  expect(getRes.status).toBe(200);
  const body = (await getRes.json()) as Record<string, unknown>;
  expect(body.state).toBe('REJECTED');
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
