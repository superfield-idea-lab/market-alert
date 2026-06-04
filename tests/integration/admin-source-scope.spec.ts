/**
 * @file tests/integration/admin-source-scope.spec.ts
 *
 * Integration tests for Phase (Admin, cost envelope, and replay) scout stubs
 * (issue #88).
 *
 * ## Tests
 *
 * TC-1 (admin scope change to health reflection):
 *   An Admin-scoped session can reach PATCH /api/admin/sources/:id/scope.
 *   The endpoint returns 501 (stub) rather than 403 — the auth seam passes.
 *   (Full scope mutation + health reflection is a phase feature follow-on.)
 *
 * TC-2 (non-admin access denied):
 *   A non-admin session receives 403 on both PATCH /api/admin/sources/:id/scope
 *   and GET /api/admin/pipeline-health.
 *   An unauthenticated request receives 401 on both endpoints.
 *
 * ## What this validates (scout scope)
 *
 * The scout integration tests validate the auth seams, not the full feature.
 * Both handlers are stubs that return 501 for the business logic. The tests
 * confirm:
 *   - Admin-scoped sessions reach the business-logic boundary (501, not 403).
 *   - Non-admin sessions are rejected at the auth gate (403).
 *   - Unauthenticated requests are rejected before auth (401).
 *
 * ## Architecture
 *
 * Uses the shared E2E environment (full server subprocess with a real ephemeral
 * Postgres container). Session cookies are obtained via the TEST_MODE backdoor
 * endpoint POST /api/test/session. The admin role is assigned by posting with
 * { role: 'admin' } to the test-session endpoint.
 *
 * ## No mocks
 *
 * Uses a real ephemeral Postgres container, real Bun server process, and real
 * fetch calls. Zero vi.fn, vi.mock, vi.spyOn, vi.stubGlobal.
 *
 * ## Canonical docs
 *
 * - docs/prd.md              — Admin user story
 * - docs/architecture.md     — Admin role, mkt_kb schema
 * - apps/server/src/api/admin-source-scope-api.ts
 * - apps/server/src/api/pipeline-health-api.ts
 * - packages/db/canonical-source-store.ts
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/88
 *
 * ## TODO (phase full implementation)
 *
 * When the feature is built, extend TC-1 to:
 *   1. PATCH /api/admin/sources/:id/scope with a valid body.
 *   2. Assert 200 and that the scope change is persisted in canonical_sources.
 *   3. GET /api/admin/pipeline-health and assert the source's access_mode
 *      reflects the change.
 *
 * Extend TC-2 to confirm the pipeline-health view reflects the scope change
 * within a short TTL window.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startE2EServer, stopE2EServer, type E2EEnvironment } from '../e2e/environment';

let env: E2EEnvironment;

// ---------------------------------------------------------------------------
// Setup / teardown — shared E2E server (full Bun server + ephemeral Postgres)
// ---------------------------------------------------------------------------

beforeAll(async () => {
  env = await startE2EServer();
}, 90_000);

afterAll(async () => {
  await stopE2EServer(env);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Obtain a session cookie via the TEST_MODE backdoor.
 * The `role` field sets properties.role on the user entity (e.g. 'admin').
 */
async function getTestSession(
  base: string,
  username: string,
  role?: string,
): Promise<{ cookie: string; userId: string }> {
  const body: Record<string, string> = { username };
  if (role) body.role = role;

  const res = await fetch(`${base}/api/test/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`test-session failed: ${res.status} ${await res.text()}`);
  }

  const resBody = (await res.json()) as { user: { id: string } };
  const userId = resBody.user.id;
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = /superfield_auth=([^;]+)/.exec(setCookie);
  const cookie = match ? `superfield_auth=${match[1]}` : '';

  return { cookie, userId };
}

// A placeholder source ID (does not need to exist in DB for stub tests — the
// handler never reads it because the stub returns 501 before any DB query)
const TEST_SOURCE_ID = 'test-source-stub-001';

// ---------------------------------------------------------------------------
// TC-1: admin scope adjustment — auth seam reaches business logic
// ---------------------------------------------------------------------------

describe('TC-1: admin scope adjustment auth seam', () => {
  test('admin session reaches PATCH /api/admin/sources/:id/scope (stub returns 501)', async () => {
    const { cookie } = await getTestSession(env.baseUrl, `admin-scope-user-${Date.now()}`, 'admin');

    const res = await fetch(`${env.baseUrl}/api/admin/sources/${TEST_SOURCE_ID}/scope`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': 'bypass', // CSRF_DISABLED=true in test server
      },
      body: JSON.stringify({ access_mode: 'authenticated', reason: 'Scout auth seam test' }),
    });

    // Auth passed — stub returns 501 (not 403 or 401)
    expect(res.status).toBe(501);
  });

  test('admin session reaches GET /api/admin/pipeline-health (stub returns 501)', async () => {
    const { cookie } = await getTestSession(
      env.baseUrl,
      `admin-health-user-${Date.now()}`,
      'admin',
    );

    const res = await fetch(`${env.baseUrl}/api/admin/pipeline-health`, {
      method: 'GET',
      headers: { Cookie: cookie },
    });

    // Auth passed — stub returns 501 (not 403 or 401)
    expect(res.status).toBe(501);
  });
});

// ---------------------------------------------------------------------------
// TC-2: non-admin access denied
// ---------------------------------------------------------------------------

describe('TC-2: non-admin access denied', () => {
  test('non-admin session receives 403 on PATCH /api/admin/sources/:id/scope', async () => {
    const { cookie } = await getTestSession(env.baseUrl, `nonadmin-scope-${Date.now()}`);
    // No role set — defaults to a regular user

    const res = await fetch(`${env.baseUrl}/api/admin/sources/${TEST_SOURCE_ID}/scope`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': 'bypass',
      },
      body: JSON.stringify({ access_mode: 'api_key' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect((body as { error: string }).error).toMatch(/admin/i);
  });

  test('non-admin session receives 403 on GET /api/admin/pipeline-health', async () => {
    const { cookie } = await getTestSession(env.baseUrl, `nonadmin-health-${Date.now()}`);

    const res = await fetch(`${env.baseUrl}/api/admin/pipeline-health`, {
      method: 'GET',
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect((body as { error: string }).error).toMatch(/admin/i);
  });

  test('unauthenticated request receives 401 on PATCH /api/admin/sources/:id/scope', async () => {
    const res = await fetch(`${env.baseUrl}/api/admin/sources/${TEST_SOURCE_ID}/scope`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_mode: 'public' }),
    });

    expect(res.status).toBe(401);
  });

  test('unauthenticated request receives 401 on GET /api/admin/pipeline-health', async () => {
    const res = await fetch(`${env.baseUrl}/api/admin/pipeline-health`, {
      method: 'GET',
    });

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// TC-2 extended: request validation
// ---------------------------------------------------------------------------

describe('TC-2 extended: request body validation', () => {
  test('invalid access_mode body returns 400 for admin session', async () => {
    const { cookie } = await getTestSession(env.baseUrl, `admin-validate-${Date.now()}`, 'admin');

    const res = await fetch(`${env.baseUrl}/api/admin/sources/${TEST_SOURCE_ID}/scope`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': 'bypass',
      },
      body: JSON.stringify({ access_mode: 'invalid-mode' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect((body as { error: string }).error).toMatch(/access_mode/i);
  });
});
