/**
 * Integration tests for DELETE /api/users/:id authorisation.
 *
 * Covers:
 *  - Unauthenticated DELETE returns 401
 *  - Authenticated non-superuser deleting a different user returns 403
 *  - Authenticated user deleting their own account returns 200
 *  - Superuser deleting any user returns 200
 *
 * Session setup uses the test backdoor (TEST_MODE=true) since all HTTP auth
 * is passkey-only (issue #14, AUTH blueprint). No password-based endpoints.
 */
import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31424;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let superuserId = '';
let superuserCookie = '';
let userACookie = '';
let userBId = '';

beforeAll(async () => {
  pg = await startPostgres();

  // Start server with TEST_MODE and a placeholder SUPERUSER_ID so we can
  // create sessions before we know the superuser's id.
  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      PORT: String(PORT),
      SUPERUSER_ID: '__placeholder__',
      TEST_MODE: 'true',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);

  // Create superuser session
  const suSession = await createTestSession(BASE, { username: `su_${Date.now()}` });
  superuserId = suSession.userId;
  superuserCookie = suSession.cookie;

  // Create user A session
  const aSession = await createTestSession(BASE, { username: `usera_${Date.now()}` });
  userACookie = aSession.cookie;

  // Create user B (only need the id for the delete target)
  const bSession = await createTestSession(BASE, { username: `userb_${Date.now()}` });
  userBId = bSession.userId;

  // Restart server with SUPERUSER_ID set to the created superuser
  server.kill();
  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      PORT: String(PORT),
      SUPERUSER_ID: superuserId,
      TEST_MODE: 'true',
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

test('DELETE /api/users/:id returns 401 when unauthenticated', async () => {
  const res = await fetch(`${BASE}/api/users/${userBId}`, {
    method: 'DELETE',
  });
  expect(res.status).toBe(401);
});

test('DELETE /api/users/:id returns 403 when a non-superuser tries to delete another user', async () => {
  // User A tries to delete User B
  const res = await fetch(`${BASE}/api/users/${userBId}`, {
    method: 'DELETE',
    headers: { Cookie: userACookie },
  });
  expect(res.status).toBe(403);
});

test('DELETE /api/users/:id returns 200 when user deletes their own account', async () => {
  // Create a fresh user for self-deletion so other tests are unaffected
  const selfSession = await createTestSession(BASE, { username: `self_${Date.now()}` });

  const res = await fetch(`${BASE}/api/users/${selfSession.userId}`, {
    method: 'DELETE',
    headers: { Cookie: selfSession.cookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
});

test('DELETE /api/users/:id returns 200 when superuser deletes another user', async () => {
  // Create a target user for the superuser to delete
  const targetSession = await createTestSession(BASE, { username: `target_${Date.now()}` });

  const res = await fetch(`${BASE}/api/users/${targetSession.userId}`, {
    method: 'DELETE',
    headers: { Cookie: superuserCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
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
