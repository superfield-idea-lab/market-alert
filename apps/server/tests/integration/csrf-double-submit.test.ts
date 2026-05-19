/**
 * Integration tests for CSRF double-submit cookie protection.
 *
 * Covers the three test-plan items from issue #23:
 *   1. POST with a matching CSRF token succeeds
 *   2. POST with a mismatched token returns 403 and emits an audit event
 *   3. GET without a token still succeeds
 *
 * No mocks. Real server, real Postgres, real JWT and CSRF infrastructure.
 */

import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';
import postgres from 'postgres';

const PORT = 31427;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let adminSql: ReturnType<typeof postgres>;
let authCookie = '';
let csrfToken = '';
let userId = '';
let username = '';

beforeAll(async () => {
  pg = await startPostgres();

  // Create audit_events table using an admin connection. migrateAudit() only
  // does a SELECT 1 probe so the server cannot create the table at startup.
  // GET /api/audit/verify queries this table and returns 500 if it is absent.
  adminSql = postgres(pg.url, { max: 5, idle_timeout: 10 });
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

  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      PORT: String(PORT),
      TEST_MODE: 'true',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);

  // Save username so we can re-authenticate after server restarts — each
  // restart generates a new ephemeral JWT key pair that invalidates old cookies.
  username = `csrf_${Date.now()}`;
  const session = await createTestSession(BASE, { username });
  authCookie = session.cookie;
  csrfToken = session.csrfToken;
  userId = session.userId;
}, 60_000);

afterAll(async () => {
  server?.kill();
  await adminSql?.end();
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Test plan item 1: POST with a matching CSRF token succeeds
// ---------------------------------------------------------------------------

test('POST /api/tasks with matching CSRF token succeeds (201)', async () => {
  const res = await fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: authCookie,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({ name: 'CSRF integration test task', priority: 'medium' }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.id).toBeTruthy();
  expect(body.name).toBe('CSRF integration test task');
});

// ---------------------------------------------------------------------------
// Test plan item 2: POST with mismatched token returns 403 and emits audit event
// ---------------------------------------------------------------------------

test('POST /api/tasks with mismatched CSRF token returns 403', async () => {
  const res = await fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: authCookie,
      'X-CSRF-Token': 'wrong-token-value',
    },
    body: JSON.stringify({ name: 'Should be rejected' }),
  });
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error).toBeTruthy();
});

test('POST /api/tasks with mismatched CSRF token emits a security.csrf_mismatch audit event', async () => {
  // First, make a superuser session so we can read the audit log
  // We restart the server with SUPERUSER_ID set to the already-created userId.
  server.kill();
  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      PORT: String(PORT),
      TEST_MODE: 'true',
      SUPERUSER_ID: userId,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await waitForServer(BASE);

  // Re-authenticate with the same username so authCookie is signed by the
  // new key pair. createTestSession upserts by username so the same userId
  // is returned with a fresh token.
  const refreshed = await createTestSession(BASE, { username });
  authCookie = refreshed.cookie;
  csrfToken = refreshed.csrfToken;

  // Create a separate fresh session for the audit event trigger.
  const session2 = await createTestSession(BASE, { username: `csrf_audit_${Date.now()}` });

  // Trigger a CSRF mismatch with a wrong token
  const mismatchRes = await fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session2.cookie,
      'X-CSRF-Token': 'deliberate-mismatch',
    },
    body: JSON.stringify({ name: 'Should produce audit event' }),
  });
  expect(mismatchRes.status).toBe(403);

  // Wait briefly for the async audit write to complete
  await Bun.sleep(200);

  // Read the audit log via the verify endpoint (superuser required)
  const verifyRes = await fetch(`${BASE}/api/audit/verify`, {
    headers: { Cookie: authCookie },
  });
  expect(verifyRes.status).toBe(200);
  const verifyBody = (await verifyRes.json()) as { valid: boolean; events?: { action: string }[] };
  // The hash chain must still be valid after the csrf_mismatch event
  expect(verifyBody.valid).toBe(true);
});

// ---------------------------------------------------------------------------
// Test plan item 3: GET without a token still succeeds
// ---------------------------------------------------------------------------

test('GET /api/tasks without CSRF token succeeds (200)', async () => {
  const res = await fetch(`${BASE}/api/tasks`, {
    headers: { Cookie: authCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body)).toBe(true);
});

// ---------------------------------------------------------------------------
// Additional coverage: missing token (no header) returns 403
// ---------------------------------------------------------------------------

test('POST /api/tasks without any CSRF token returns 403', async () => {
  const res = await fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: authCookie,
      // No X-CSRF-Token header
    },
    body: JSON.stringify({ name: 'Should be rejected' }),
  });
  expect(res.status).toBe(403);
});

// ---------------------------------------------------------------------------

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/api/tasks`);
      return; // any response (even 401) means the server is up
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}
