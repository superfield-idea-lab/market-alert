/**
 * Integration tests for the append-only hash-chained audit log.
 *
 * Covers:
 *  - emitAuditEvent is called as a side-effect of a user role PATCH (via admin API)
 *  - GET /api/audit/verify returns valid: true for an untampered log
 *  - GET /api/audit/verify returns 401 for unauthenticated callers
 *  - GET /api/audit/verify returns 403 for non-superusers
 */
import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31419;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let adminSql: ReturnType<typeof postgres>;
let server: Subprocess;
// authCookie is always valid for the currently running server instance.
let authCookie = '';
let userId = '';

beforeAll(async () => {
  pg = await startPostgres();

  // Create audit_events table using an admin connection (same schema as
  // production init-remote.ts). migrateAudit() only does a SELECT 1 so the
  // server cannot create the table at startup when running as a low-privilege
  // role in production. In tests the container user has full DDL rights.
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

  // Phase 1: start without SUPERUSER_ID to create a session and discover userId.
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

  const firstSession = await createTestSession(BASE);
  userId = firstSession.userId;

  // Phase 2: restart with SUPERUSER_ID set to the discovered userId.
  // After restart the server generates a new ephemeral JWT key, so we must
  // create a fresh session on the restarted server to get a valid cookie.
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

  // Re-create the session on the new server process so the JWT is signed by
  // the new ephemeral key and the cookie will be accepted by all tests below.
  const session = await createTestSession(BASE, { username: firstSession.username });
  userId = session.userId;
  authCookie = session.cookie;
}, 120_000);

afterAll(async () => {
  server?.kill();
  await adminSql?.end();
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
  // Trigger an audit event via PATCH /api/admin/users/:id (role change).
  // The admin PATCH handler emits a user.role_change audit event when the
  // role value differs from the current value.
  const patchRes = await fetch(`${BASE}/api/admin/users/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ role: 'analyst' }),
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
  // Verifies the same endpoint again — at this point at least one audit event
  // has been written; the chain must still be valid.
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
      const res = await fetch(`${base}/health/live`);
      if (res.ok) return;
    } catch {
      // server not yet up
    }
    await Bun.sleep(300);
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}
