/**
 * Integration sanity test for issue #66.
 *
 * Regression guard: a `crm_entity.create` call from an authenticated CRM admin
 * must INSERT a row into the `audit_events` table in the test database. This
 * exercises the path that was silently failing before issue #66 — when the
 * table did not exist (or audit_w lacked the privileges required for
 * SELECT ... FOR UPDATE) the audit-write was logged as a `.catch` warning
 * while the API still returned 201, hiding the regression.
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
let crmCookie = '';
let crmUserId = '';

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 3 });

  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      ANALYTICS_DATABASE_URL: pg.url,
      PORT: String(PORT),
      TEST_MODE: 'true',
      SUPERUSER_ID: '__placeholder__',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });

  await waitForServer(BASE);

  const crmSession = await createTestSession(BASE, { username: `crm_audit_${Date.now()}` });
  crmUserId = crmSession.userId;
  crmCookie = crmSession.cookie;

  await sql`
    UPDATE entities
    SET properties = ${sql.json({ username: crmSession.username, role: 'crm_admin' }) as never}
    WHERE id = ${crmUserId}
  `;
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

test('crm_entity.create writes an audit_events row with action=crm_entity.create', async () => {
  const uniqueName = `Sanity Atlas ${Date.now()}`;

  const res = await fetch(`${BASE}/api/admin/crm/entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: crmCookie },
    body: JSON.stringify({
      type: 'asset_manager',
      properties: { name: uniqueName, notes: 'audit regression guard' },
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { entity: { id: string } };
  const entityId = body.entity.id;

  // The audit emit is fire-and-forget via .catch in the handler — poll briefly
  // for the row to appear so the assertion is robust to scheduling latency.
  const deadline = Date.now() + 5_000;
  let auditRows: { action: string; entity_id: string; actor_id: string }[] = [];
  while (Date.now() < deadline) {
    auditRows = await sql<{ action: string; entity_id: string; actor_id: string }[]>`
      SELECT action, entity_id, actor_id
      FROM audit_events
      WHERE entity_id = ${entityId}
        AND action = 'crm_entity.create'
    `;
    if (auditRows.length > 0) break;
    await Bun.sleep(100);
  }

  expect(auditRows).toHaveLength(1);
  expect(auditRows[0].action).toBe('crm_entity.create');
  expect(auditRows[0].entity_id).toBe(entityId);
  expect(auditRows[0].actor_id).toBe(crmUserId);
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
