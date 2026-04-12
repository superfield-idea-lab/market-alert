/**
 * @file annotation-thread.test.ts
 *
 * Integration tests for the annotation thread API — Phase 6 scout (issue #62).
 *
 * ## Scout stub assertions
 *
 * The real implementation is a Phase 6 follow-on. These tests assert the stub
 * contract (401 without auth, 400 for bad input, 501 with the expected response
 * shape) so that follow-on issues can upgrade them to real assertions without
 * changing the test structure.
 *
 * ## Integration points verified
 *
 * 1. POST /api/annotations — open an annotation thread
 *    - Requires an authenticated session
 *    - Validates required fields (wiki_page_version_id, passage_ref, comment)
 *    - Returns 501 with expected_response_shape encoding the agent reply contract
 *
 * 2. POST /api/annotations/:id/accept — accept agent reply, publish new version
 *    - Requires an authenticated session
 *    - Returns 501 with expected_response_shape encoding new_wiki_version_id
 *
 * 3. POST /api/annotations/:id/reject — reject agent reply
 *    - Requires an authenticated session
 *    - Returns 501; no version should be written
 *
 * ## Canonical docs
 *
 *   - docs/implementation-plan-v1.md §Phase 6
 *   - docs/PRD.md §5.2, §4.3, §6
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/62
 */

import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31437;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let authCookie = '';
let csrfToken = '';

beforeAll(async () => {
  pg = await startPostgres();

  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      PORT: String(PORT),
      TEST_MODE: 'true',
      CSRF_DISABLED: 'true',
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
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// POST /api/annotations — open annotation thread (scout stub)
// ---------------------------------------------------------------------------

test('POST /api/annotations returns 401 without auth', async () => {
  const res = await fetch(`${BASE}/api/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      wiki_page_version_id: 'v1',
      passage_ref: 'para-1',
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
      passage_ref: 'para-1',
      comment: 'Missing version id',
    }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as Record<string, unknown>;
  expect(typeof body.error).toBe('string');
});

test('POST /api/annotations (stub) returns 501 with expected response shape', async () => {
  const res = await fetch(`${BASE}/api/annotations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: authCookie,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      wiki_page_version_id: 'version-abc',
      passage_ref: 'para-3',
      comment: 'I believe this should be 2019.',
    }),
  });
  expect(res.status).toBe(501);
  const body = (await res.json()) as Record<string, unknown>;
  expect(typeof body.error).toBe('string');

  // Assert the expected_response_shape encodes the agent reply contract.
  const shape = body.expected_response_shape as Record<string, unknown>;
  expect(shape).toBeDefined();
  expect(shape.wiki_page_version_id).toBe('version-abc');
  expect(shape.passage_ref).toBe('para-3');
  expect(shape.state).toBe('AGENT_REPLIED');
  expect(Array.isArray(shape.thread)).toBe(true);
  const thread = shape.thread as { role: string }[];
  expect(thread[0].role).toBe('rm');
  expect(thread[1].role).toBe('agent');
});

// ---------------------------------------------------------------------------
// POST /api/annotations/:id/accept — accept + publish new version (scout stub)
// ---------------------------------------------------------------------------

test('POST /api/annotations/:id/accept returns 401 without auth', async () => {
  const res = await fetch(`${BASE}/api/annotations/annotation-abc/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  expect(res.status).toBe(401);
});

test('POST /api/annotations/:id/accept (stub) returns 501 with expected response shape', async () => {
  const annotationId = 'annotation-xyz';
  const res = await fetch(`${BASE}/api/annotations/${annotationId}/accept`, {
    method: 'POST',
    headers: {
      Cookie: authCookie,
      'X-CSRF-Token': csrfToken,
    },
  });
  expect(res.status).toBe(501);
  const body = (await res.json()) as Record<string, unknown>;
  const shape = body.expected_response_shape as Record<string, unknown>;
  expect(shape).toBeDefined();
  expect(shape.annotation_id).toBe(annotationId);
  expect(shape.state).toBe('ACCEPTED');
  // new_wiki_version_id must be present in the shape for follow-on tests.
  expect(typeof shape.new_wiki_version_id).toBe('string');
});

// ---------------------------------------------------------------------------
// POST /api/annotations/:id/reject — reject, no version written (scout stub)
// ---------------------------------------------------------------------------

test('POST /api/annotations/:id/reject returns 401 without auth', async () => {
  const res = await fetch(`${BASE}/api/annotations/annotation-abc/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  expect(res.status).toBe(401);
});

test('POST /api/annotations/:id/reject (stub) returns 501 with expected response shape', async () => {
  const annotationId = 'annotation-xyz';
  const res = await fetch(`${BASE}/api/annotations/${annotationId}/reject`, {
    method: 'POST',
    headers: {
      Cookie: authCookie,
      'X-CSRF-Token': csrfToken,
    },
  });
  expect(res.status).toBe(501);
  const body = (await res.json()) as Record<string, unknown>;
  const shape = body.expected_response_shape as Record<string, unknown>;
  expect(shape).toBeDefined();
  expect(shape.annotation_id).toBe(annotationId);
  expect(shape.state).toBe('REJECTED');
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
