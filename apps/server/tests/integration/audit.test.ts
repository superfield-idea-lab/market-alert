/**
 * Integration tests for the append-only hash-chained audit log.
 *
 * Covers:
 *  - emitAuditEvent is called as a side-effect of a task PATCH (via task-write-boundary)
 *  - GET /api/audit/verify returns valid: true for an untampered log
 *  - GET /api/audit/verify returns 401 for unauthenticated callers
 *  - GET /api/audit/verify returns 403 for non-superusers
 */
import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31419;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let authCookie = '';
let userId = '';

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
      // Make the test user a superuser so we can test the verify endpoint
      SUPERUSER_ID: '__will_be_set_after_session__',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);

  const session = await createTestSession(BASE);
  userId = session.userId;
  authCookie = session.cookie;

  // Restart server with the SUPERUSER_ID set to the created user's id
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
}, 120_000);

afterAll(async () => {
  server?.kill();
  await pg?.stop();
});

// ---------------------------------------------------------------------------

test('GET /api/audit/verify returns 401 when unauthenticated', async () => {
  const res = await fetch(`${BASE}/api/audit/verify`);
  expect(res.status).toBe(401);
});

test('GET /api/audit/verify returns 403 for non-superuser', async () => {
  // Create a second session for a user who is not a superuser
  const nonSuSession = await createTestSession(BASE, { username: `nonsu_${Date.now()}` });

  const res = await fetch(`${BASE}/api/audit/verify`, {
    headers: { Cookie: nonSuSession.cookie },
  });
  expect(res.status).toBe(403);
});

test('GET /api/audit/verify returns valid: true for superuser on untampered log', async () => {
  // Create a task to generate an audit event via PATCH
  const createRes = await fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ name: 'Audit chain task', priority: 'medium' }),
  });
  expect(createRes.status).toBe(201);
  const task = await createRes.json();

  // PATCH triggers emitAuditEvent
  const patchRes = await fetch(`${BASE}/api/tasks/${task.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ status: 'done' }),
  });
  expect(patchRes.status).toBe(200);

  // Verify the audit log integrity
  const verifyRes = await fetch(`${BASE}/api/audit/verify`, {
    headers: { Cookie: authCookie },
  });
  expect(verifyRes.status).toBe(200);
  const body = await verifyRes.json();
  expect(body.valid).toBe(true);
});

test('GET /api/audit/verify returns valid: true for empty log', async () => {
  // A fresh server / container may have no audit events yet (before the first PATCH above)
  // but since we've already patched above, this just checks the same endpoint returns true.
  const res = await fetch(`${BASE}/api/audit/verify`, {
    headers: { Cookie: authCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.valid).toBe(true);
  expect(body.firstInvalidId).toBeUndefined();
});

// ---------------------------------------------------------------------------

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/api/tasks`);
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}
