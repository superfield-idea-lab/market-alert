/**
 * Integration sanity test for issue #66.
 *
 * Regression guard: an audit-emitting admin action must INSERT a row into the
 * `audit_events` table in the test database. This exercises the path that was
 * silently failing before issue #66 — when the table did not exist (or audit_w
 * lacked the privileges required for SELECT ... FOR UPDATE) the audit-write was
 * logged as a `.catch` warning while the API still returned a success status,
 * hiding the regression.
 *
 * The action used here is `POST /api/admin/keys` (API key creation), a kept
 * PRD-aligned admin endpoint whose handler emits an `api_key.create` audit
 * event. The endpoint requires a superuser, so the server is started in the
 * same two-phase way as audit.test.ts: first to discover the session userId,
 * then restarted with SUPERUSER_ID set to that userId.
 *
 * No mocks. Real Postgres container, real Bun server, real audit_events row
 * read back via SQL.
 */

import { afterAll, beforeAll, test, expect } from 'vitest';
import type { Subprocess } from 'bun';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31430;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 60_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let sql: ReturnType<typeof postgres>;
let authCookie = '';
let userId = '';

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 3 });

  // Phase 1: start without SUPERUSER_ID to create a session and discover userId.
  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      ANALYTICS_DATABASE_URL: pg.url,
      PORT: String(PORT),
      TEST_MODE: 'true',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });

  await waitForServer(BASE);

  const firstSession = await createTestSession(BASE, { username: `audit_boot_${Date.now()}` });
  userId = firstSession.userId;

  // Phase 2: restart with SUPERUSER_ID set to the discovered userId so the
  // admin keys endpoint authorizes this user. The restart rotates the ephemeral
  // JWT key, so a fresh session must be created on the new process.
  server.kill();
  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      ANALYTICS_DATABASE_URL: pg.url,
      PORT: String(PORT),
      TEST_MODE: 'true',
      SUPERUSER_ID: userId,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });

  await waitForServer(BASE);

  const session = await createTestSession(BASE, { username: firstSession.username });
  userId = session.userId;
  authCookie = session.cookie;
}, 120_000);

afterAll(async () => {
  server?.kill();
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

test('audit_events table exists in the test database', async () => {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'audit_events'
    ) AS exists
  `;
  expect(rows[0].exists).toBe(true);
});

test('api_key.create writes an audit_events row with action=api_key.create', async () => {
  const res = await fetch(`${BASE}/api/admin/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ label: `audit-regression-guard-${Date.now()}` }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  const keyId = body.id;

  // The audit emit is fire-and-forget via .catch in the handler — poll briefly
  // for the row to appear so the assertion is robust to scheduling latency.
  const deadline = Date.now() + 5_000;
  let auditRows: { action: string; entity_type: string; entity_id: string; actor_id: string }[] =
    [];
  while (Date.now() < deadline) {
    auditRows = await sql<
      { action: string; entity_type: string; entity_id: string; actor_id: string }[]
    >`
      SELECT action, entity_type, entity_id, actor_id
      FROM audit_events
      WHERE entity_id = ${keyId}
        AND action = 'api_key.create'
    `;
    if (auditRows.length > 0) break;
    await Bun.sleep(100);
  }

  expect(auditRows).toHaveLength(1);
  expect(auditRows[0].action).toBe('api_key.create');
  expect(auditRows[0].entity_type).toBe('api_key');
  expect(auditRows[0].entity_id).toBe(keyId);
  expect(auditRows[0].actor_id).toBe(userId);
});

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health/live`);
      if (res.status < 500) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(300);
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}
