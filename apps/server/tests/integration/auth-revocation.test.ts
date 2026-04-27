import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

/**
 * Integration tests for PostgreSQL-backed JTI revocation.
 *
 * Validates:
 * - A valid session cookie grants access to authenticated endpoints
 * - POST /api/auth/logout revokes the session token in the database
 * - Subsequent authenticated requests using the revoked token are rejected (401)
 * - A new session issued after logout is valid (not revoked)
 *
 * Session setup uses the test backdoor (TEST_MODE=true) since all HTTP auth
 * is passkey-only (issue #14, AUTH blueprint). No password-based endpoints.
 */

const PORT = 31418;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;

beforeAll(async () => {
  pg = await startPostgres();
  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      PORT: String(PORT),
      TEST_MODE: 'true',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await waitForServer(BASE);
}, 60_000);

afterAll(async () => {
  server?.kill();
  await pg?.stop();
});

// ---------------------------------------------------------------------------

test('test session backdoor issues a session cookie', async () => {
  const session = await createTestSession(BASE);
  expect(session.cookie).toContain('superfield_auth=');
  expect(session.userId).toBeTruthy();
  expect(session.username).toBeTruthy();
});

test('session cookie grants access to GET /api/auth/me', async () => {
  const session = await createTestSession(BASE);
  const res = await fetch(`${BASE}/api/auth/me`, {
    headers: { Cookie: session.cookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.user.id).toBe(session.userId);
});

test('logout revokes the token so subsequent requests return 401', async () => {
  // 1. Create a fresh session
  const session = await createTestSession(BASE);
  const cookie = session.cookie.split(';')[0]; // just superfield_auth=<token>

  // 2. Verify the token is valid before logout
  const meBeforeRes = await fetch(`${BASE}/api/auth/me`, {
    headers: { Cookie: cookie },
  });
  expect(meBeforeRes.status).toBe(200);

  // 3. Logout — server should revoke the JTI
  const logoutRes = await fetch(`${BASE}/api/auth/logout`, {
    method: 'POST',
    headers: {
      Cookie: session.cookie,
      'X-CSRF-Token': session.csrfToken,
    },
  });
  expect(logoutRes.status).toBe(200);

  // 4. The same token must now be rejected
  const meAfterRes = await fetch(`${BASE}/api/auth/me`, {
    headers: { Cookie: cookie },
  });
  expect(meAfterRes.status).toBe(401);
});

test('new session after logout issues a fresh valid token', async () => {
  // Create a completely new session (simulates "log in again" after logout)
  const session = await createTestSession(BASE);

  const meRes = await fetch(`${BASE}/api/auth/me`, {
    headers: { Cookie: session.cookie },
  });
  expect(meRes.status).toBe(200);
  const body = await meRes.json();
  expect(body.user.id).toBe(session.userId);
});

// ---------------------------------------------------------------------------

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/api/auth/me`);
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}
