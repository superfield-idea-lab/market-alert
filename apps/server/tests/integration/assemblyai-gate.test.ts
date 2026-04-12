/**
 * Integration tests for the AssemblyAI legacy transcription gate (issue #60).
 *
 * Acceptance criteria tested:
 *   - The `assemblyai_legacy_enabled` flag defaults off for all tenants
 *   - Regulated tenants cannot enable the flag (422 at the config layer)
 *   - Non-regulated tenants can enable the flag (200 response)
 *   - Setting regulated=true disables assemblyai_legacy_enabled if previously on
 *   - GET /api/admin/tenants/:id/config returns the current flag snapshot
 *
 * Test plan from issue #60:
 *   - Integration: attempt to enable the flag on a regulated tenant → 422 rejection
 *   - Integration: enable the flag on a non-regulated tenant → routing stub reached
 *
 * No mocks — real Postgres, real HTTP, real config layer.
 */

import { test, expect, describe, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31430;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let superuserCookie = '';
let regularCookie = '';

// ---------------------------------------------------------------------------
// Setup — two-restart pattern to wire SUPERUSER_ID
// (follows corpus-chunks.test.ts pattern)
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pg = await startPostgres();

  // Stable username — test-session looks up the user by username so the same
  // entity ID is returned even across server restarts (ON CONFLICT DO NOTHING
  // + re-query by username in the test-session endpoint).
  const suUsername = 'su-assemblyai-gate-stable';
  const regUsername = 'reg-assemblyai-gate-stable';

  // First start: placeholder SUPERUSER_ID to create the user entities.
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

  // Create user entities with stable usernames.
  const regular = await createTestSession(BASE, { username: regUsername });
  const su = await createTestSession(BASE, { username: suUsername });
  const superuserId = su.userId;

  // Restart with real SUPERUSER_ID = su.userId.
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

  // Re-create sessions on the restarted server using the SAME stable usernames.
  // The test-session endpoint looks up the existing entity by username, so the
  // returned userId matches the pre-restart userId. The JWT is signed with the
  // new server's key pair, so the cookie is valid on this server.
  const regularReauth = await createTestSession(BASE, { username: regUsername });
  const suReauth = await createTestSession(BASE, { username: suUsername });

  regularCookie = regularReauth.cookie;
  superuserCookie = suReauth.cookie;

  // Sanity: suReauth.userId should match superuserId.
  if (suReauth.userId !== superuserId) {
    throw new Error(
      `Superuser ID mismatch: expected ${superuserId}, got ${suReauth.userId}. ` +
        `This means the test-session username lookup did not return the same entity.`,
    );
  }

  // Suppress the unused variable warning for `regular` — used only to ensure
  // the entity exists in the DB before the restart.
  void regular;
}, 120_000);

afterAll(async () => {
  server?.kill();
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/healthz`);
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}

// ---------------------------------------------------------------------------
// Authentication / authorization guards
// ---------------------------------------------------------------------------

describe('authentication guards', () => {
  test('GET /api/admin/tenants/:id/config returns 401 when unauthenticated', async () => {
    const res = await fetch(`${BASE}/api/admin/tenants/any-tenant/config`);
    expect(res.status).toBe(401);
  });

  test('GET /api/admin/tenants/:id/config returns 403 for non-superuser', async () => {
    const res = await fetch(`${BASE}/api/admin/tenants/any-tenant/config`, {
      headers: { Cookie: regularCookie },
    });
    expect(res.status).toBe(403);
  });

  test('PUT regulated returns 401 when unauthenticated', async () => {
    const res = await fetch(`${BASE}/api/admin/tenants/any-tenant/config/regulated`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regulated: true }),
    });
    expect(res.status).toBe(401);
  });

  test('PUT assemblyai-legacy returns 401 when unauthenticated', async () => {
    const res = await fetch(`${BASE}/api/admin/tenants/any-tenant/config/assemblyai-legacy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe('tenant config defaults', () => {
  test('assemblyai_legacy_enabled defaults off for a new tenant', async () => {
    const tenantId = `tenant-default-${Date.now()}`;
    const res = await fetch(`${BASE}/api/admin/tenants/${tenantId}/config`, {
      headers: { Cookie: superuserCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe(tenantId);
    expect(body.regulated).toBe(false);
    expect(body.assemblyai_legacy_enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regulated tenant gate (issue #60 — integration test plan)
// ---------------------------------------------------------------------------

describe('regulated tenant: attempt to enable assemblyai_legacy is rejected', () => {
  test('enabling assemblyai_legacy on a regulated tenant returns 422', async () => {
    const tenantId = `tenant-regulated-${Date.now()}`;

    // Mark as regulated first.
    const regRes = await fetch(`${BASE}/api/admin/tenants/${tenantId}/config/regulated`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: superuserCookie },
      body: JSON.stringify({ regulated: true }),
    });
    expect(regRes.status).toBe(200);
    const regBody = await regRes.json();
    expect(regBody.regulated).toBe(true);

    // Attempt to enable AssemblyAI — must be rejected at the config layer.
    const enableRes = await fetch(
      `${BASE}/api/admin/tenants/${tenantId}/config/assemblyai-legacy`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: superuserCookie },
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(enableRes.status).toBe(422);
    const enableBody = await enableRes.json();
    expect(enableBody.error).toContain('regulated');
  });

  test('assemblyai_legacy_enabled remains false after rejected attempt on regulated tenant', async () => {
    const tenantId = `tenant-regulated-noleak-${Date.now()}`;

    await fetch(`${BASE}/api/admin/tenants/${tenantId}/config/regulated`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: superuserCookie },
      body: JSON.stringify({ regulated: true }),
    });

    // Attempt (ignored) — flag must still be off.
    await fetch(`${BASE}/api/admin/tenants/${tenantId}/config/assemblyai-legacy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: superuserCookie },
      body: JSON.stringify({ enabled: true }),
    });

    const configRes = await fetch(`${BASE}/api/admin/tenants/${tenantId}/config`, {
      headers: { Cookie: superuserCookie },
    });
    const config = await configRes.json();
    expect(config.regulated).toBe(true);
    expect(config.assemblyai_legacy_enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Non-regulated tenant: enable path reaches stub (issue #60 — integration test plan)
// ---------------------------------------------------------------------------

describe('non-regulated tenant: assemblyai_legacy_enabled can be toggled', () => {
  test('enable on non-regulated tenant returns 200 with flag on', async () => {
    const tenantId = `tenant-unreg-enable-${Date.now()}`;

    const enableRes = await fetch(
      `${BASE}/api/admin/tenants/${tenantId}/config/assemblyai-legacy`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: superuserCookie },
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(enableRes.status).toBe(200);
    const body = await enableRes.json();
    expect(body.assemblyai_legacy_enabled).toBe(true);
    expect(body.regulated).toBe(false);
  });

  test('config snapshot reflects enabled flag via GET', async () => {
    const tenantId = `tenant-unreg-get-${Date.now()}`;

    await fetch(`${BASE}/api/admin/tenants/${tenantId}/config/assemblyai-legacy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: superuserCookie },
      body: JSON.stringify({ enabled: true }),
    });

    const configRes = await fetch(`${BASE}/api/admin/tenants/${tenantId}/config`, {
      headers: { Cookie: superuserCookie },
    });
    expect(configRes.status).toBe(200);
    const config = await configRes.json();
    expect(config.assemblyai_legacy_enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auto-disable when marking regulated
// ---------------------------------------------------------------------------

describe('marking regulated auto-disables assemblyai_legacy_enabled', () => {
  test('previously-enabled flag is disabled when tenant is marked regulated', async () => {
    const tenantId = `tenant-autooff-${Date.now()}`;

    // Enable first.
    const enableRes = await fetch(
      `${BASE}/api/admin/tenants/${tenantId}/config/assemblyai-legacy`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: superuserCookie },
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(enableRes.status).toBe(200);

    // Mark as regulated — should auto-disable assemblyai_legacy.
    const regRes = await fetch(`${BASE}/api/admin/tenants/${tenantId}/config/regulated`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: superuserCookie },
      body: JSON.stringify({ regulated: true }),
    });
    expect(regRes.status).toBe(200);
    const regBody = await regRes.json();
    expect(regBody.regulated).toBe(true);
    expect(regBody.assemblyai_legacy_enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('input validation', () => {
  test('PUT regulated with non-boolean value returns 400', async () => {
    const tenantId = `tenant-val-reg-${Date.now()}`;
    const res = await fetch(`${BASE}/api/admin/tenants/${tenantId}/config/regulated`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: superuserCookie },
      body: JSON.stringify({ regulated: 'yes' }),
    });
    expect(res.status).toBe(400);
  });

  test('PUT assemblyai-legacy with non-boolean value returns 400', async () => {
    const tenantId = `tenant-val-aai-${Date.now()}`;
    const res = await fetch(`${BASE}/api/admin/tenants/${tenantId}/config/assemblyai-legacy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: superuserCookie },
      body: JSON.stringify({ enabled: 1 }),
    });
    expect(res.status).toBe(400);
  });
});
