/**
 * Integration tests for trace ID propagation across backend boundary hops.
 *
 * Canonical doc: docs/implementation-plan-v1.md Phase 0
 * Issue: #9 — feat: propagate trace IDs across backend boundary hops
 *
 * ## What is tested
 * - Inbound request without X-Trace-Id gets assigned one (response echoes it back)
 * - Inbound request with X-Trace-Id reuses it unchanged in the response header
 * - Every response carries X-Trace-Id regardless of route
 *
 * ## No mocks
 * All tests use a real in-process HTTP server backed by an isolated Postgres container.
 */

import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31425;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let authCookie = '';
let csrfToken = '';

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health/live`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(300);
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}

beforeAll(async () => {
  pg = await startPostgres();

  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      PORT: String(PORT),
      LOG_DIR: `/tmp/trace-test-logs-${PORT}`,
      TEST_MODE: 'true',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);

  // Create a test session (passkey-only auth, issue #14 — no password endpoint)
  const session = await createTestSession(BASE);
  authCookie = session.cookie;
  csrfToken = session.csrfToken;
}, 60_000);

afterAll(async () => {
  server?.kill();
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Boundary hop 1: inbound HTTP → server (unauthenticated health endpoint)
// ---------------------------------------------------------------------------

test('GET /health/live — assigns a trace ID when none is provided', async () => {
  const res = await fetch(`${BASE}/health/live`);
  expect(res.status).toBe(200);

  const traceId = res.headers.get('X-Trace-Id');
  expect(traceId).toBeTruthy();
  // Should be a UUID or UUID-prefixed composite
  expect(traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

test('GET /health/live — reuses the provided X-Trace-Id unchanged', async () => {
  const myTraceId = 'test-trace-00000000-0000-0000-0000-000000000001';
  const res = await fetch(`${BASE}/health/live`, {
    headers: { 'X-Trace-Id': myTraceId },
  });
  expect(res.status).toBe(200);

  const echoed = res.headers.get('X-Trace-Id');
  expect(echoed).toBe(myTraceId);
});

// ---------------------------------------------------------------------------
// Boundary hop 2: inbound HTTP → server (authenticated API endpoint)
// ---------------------------------------------------------------------------

test('GET /api/tasks — X-Trace-Id is echoed back when provided', async () => {
  const myTraceId = 'test-trace-00000000-0000-0000-0000-000000000002';
  const res = await fetch(`${BASE}/api/tasks`, {
    headers: {
      Cookie: authCookie,
      'X-Trace-Id': myTraceId,
    },
  });
  expect(res.status).toBe(200);

  const echoed = res.headers.get('X-Trace-Id');
  expect(echoed).toBe(myTraceId);
});

test('GET /api/tasks — assigns a trace ID when none is provided', async () => {
  const res = await fetch(`${BASE}/api/tasks`, {
    headers: { Cookie: authCookie },
  });
  expect(res.status).toBe(200);

  const traceId = res.headers.get('X-Trace-Id');
  expect(traceId).toBeTruthy();
  expect(traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

// ---------------------------------------------------------------------------
// Boundary hop 3: each request gets a distinct trace ID (no cross-request bleed)
// ---------------------------------------------------------------------------

test('two concurrent requests receive distinct trace IDs', async () => {
  const [res1, res2] = await Promise.all([
    fetch(`${BASE}/health/live`),
    fetch(`${BASE}/health/live`),
  ]);

  const id1 = res1.headers.get('X-Trace-Id');
  const id2 = res2.headers.get('X-Trace-Id');

  expect(id1).toBeTruthy();
  expect(id2).toBeTruthy();
  expect(id1).not.toBe(id2);
});

// ---------------------------------------------------------------------------
// Boundary hop 4: POST endpoint — trace ID survives a state-mutating request
// ---------------------------------------------------------------------------

test('POST /api/tasks — trace ID is echoed back on creation', async () => {
  const myTraceId = 'test-trace-00000000-0000-0000-0000-000000000004';
  const res = await fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: authCookie,
      'X-CSRF-Token': csrfToken,
      'X-Trace-Id': myTraceId,
    },
    body: JSON.stringify({ name: 'Trace propagation test task' }),
  });
  // 201 or 200 depending on create semantics
  expect(res.status).toBeLessThan(300);

  const echoed = res.headers.get('X-Trace-Id');
  expect(echoed).toBe(myTraceId);
});
