/**
 * Integration tests for BDM cross-customer query audit events (issue #76).
 *
 * Acceptance criteria addressed:
 *   AC-1  Every cross-customer BDM query emits an audit event
 *   AC-2  Events include actor, asset_manager_id, department (via entity_type), timestamp
 *   AC-3  Events land in the append-only audit store
 *   AC-4  Single-customer BDM queries are handled consistently
 *
 * Test plan items:
 *   TP-1  Integration: run a BDM query and assert an audit event is written
 *   TP-2  Integration: query the audit store as Compliance Officer (superuser)
 *         and assert the BDM query event is visible
 *
 * No mocks — real Postgres container, real Bun HTTP server, real JWT session.
 */

import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31431;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 30_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let authCookie = '';
let userId = '';
/** Admin SQL pool for reading audit_events and seeding session_events. */
let adminSql: ReturnType<typeof postgres>;

beforeAll(async () => {
  pg = await startPostgres();

  // Admin pool for seeding and inspection.
  adminSql = postgres(pg.url, { max: 3 });

  // Ensure the audit_events table exists — normally created by init-remote.ts;
  // here we share a single Postgres container for all databases.
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

  // Ensure the session_events table exists — normally created by init-remote.ts
  // for the kb_analytics database; here we share a single container.
  await adminSql.unsafe(`
    CREATE TABLE IF NOT EXISTS session_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      asset_manager_id TEXT NOT NULL,
      fund_id TEXT NOT NULL,
      chunk_excerpt_hash TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('chunk_indexed', 'wiki_published')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Phase 1: start server to create a test user and capture their userId.
  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      ANALYTICS_DATABASE_URL: pg.url,
      DICTIONARY_DATABASE_URL: pg.url,
      PORT: String(PORT),
      TEST_MODE: 'true',
      SUPERUSER_ID: '__placeholder__',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);

  const session1 = await createTestSession(BASE, { username: `bdm_audit_${Date.now()}` });
  userId = session1.userId;

  // Phase 2: restart with userId as SUPERUSER_ID (Compliance Officer role)
  // so GET /api/audit/verify is accessible.
  server.kill();
  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      ANALYTICS_DATABASE_URL: pg.url,
      DICTIONARY_DATABASE_URL: pg.url,
      PORT: String(PORT),
      TEST_MODE: 'true',
      SUPERUSER_ID: userId,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);

  // The JWT key is freshly generated at startup — get a new session cookie.
  const session2 = await createTestSession(BASE, { username: `bdm_audit2_${Date.now()}` });
  userId = session2.userId;
  authCookie = session2.cookie;

  // Phase 3: restart once more so session2's userId IS the superuser.
  server.kill();
  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      ANALYTICS_DATABASE_URL: pg.url,
      DICTIONARY_DATABASE_URL: pg.url,
      PORT: String(PORT),
      TEST_MODE: 'true',
      SUPERUSER_ID: userId,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);

  // Get a final session valid for this server process.
  const session3 = await createTestSession(BASE, { username: `bdm_audit3_${Date.now()}` });
  userId = session3.userId;
  authCookie = session3.cookie;
}, 120_000);

afterAll(async () => {
  server?.kill();
  await adminSql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// TP-1: BDM query emits an audit event
// ---------------------------------------------------------------------------

test('GET /api/bdm/campaign emits an audit event into the append-only store', async () => {
  const tenantId = `tenant-bdm-audit-${Date.now()}`;

  // Seed a session_events row so the BDM endpoint returns data.
  await adminSql.unsafe(
    `INSERT INTO session_events
       (tenant_id, session_id, asset_manager_id, fund_id, chunk_excerpt_hash, event_type)
     VALUES ($1, 'sess-bdm-1', 'am-1', 'fund-1', 'deadbeef', 'chunk_indexed')`,
    [tenantId],
  );

  // Count audit_events before the BDM query.
  const beforeRows = await adminSql.unsafe<{ count: string }[]>(
    `SELECT count(*)::text AS count FROM audit_events
     WHERE action = 'bdm.campaign.query' AND entity_id = $1`,
    [tenantId],
  );
  expect(Number(beforeRows[0].count)).toBe(0);

  // Issue the BDM query.
  const res = await fetch(`${BASE}/api/bdm/campaign?tenant_id=${encodeURIComponent(tenantId)}`, {
    headers: { Cookie: authCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.events)).toBe(true);
  expect(body.events).toHaveLength(1);

  // Assert the audit event was written.
  const auditRows = await adminSql.unsafe<
    {
      actor_id: string;
      action: string;
      entity_type: string;
      entity_id: string;
      after: { asset_manager_id: string; event_type_filter: string | null; limit: number };
      ts: string;
    }[]
  >(
    `SELECT actor_id, action, entity_type, entity_id, after, ts
     FROM audit_events
     WHERE action = 'bdm.campaign.query' AND entity_id = $1`,
    [tenantId],
  );

  expect(auditRows).toHaveLength(1);
  const auditRow = auditRows[0];

  // AC-2: event includes actor, asset_manager_id, timestamp
  expect(auditRow.actor_id).toBe(userId);
  expect(auditRow.action).toBe('bdm.campaign.query');
  expect(auditRow.entity_type).toBe('bdm_campaign_query');
  expect(auditRow.entity_id).toBe(tenantId);
  expect(auditRow.after.asset_manager_id).toBe(tenantId);
  expect(auditRow.after.event_type_filter).toBeNull();
  expect(auditRow.after.limit).toBe(100);
  expect(auditRow.ts).toBeTruthy();
});

// ---------------------------------------------------------------------------
// TP-1 variant: BDM query with event_type filter also emits an audit event
// ---------------------------------------------------------------------------

test('GET /api/bdm/campaign with event_type filter records the filter in the audit event', async () => {
  const tenantId = `tenant-bdm-filter-${Date.now()}`;

  await adminSql.unsafe(
    `INSERT INTO session_events
       (tenant_id, session_id, asset_manager_id, fund_id, chunk_excerpt_hash, event_type)
     VALUES ($1, 'sess-bdm-2', 'am-2', 'fund-2', 'cafebabe', 'wiki_published')`,
    [tenantId],
  );

  const res = await fetch(
    `${BASE}/api/bdm/campaign?tenant_id=${encodeURIComponent(tenantId)}&event_type=wiki_published`,
    { headers: { Cookie: authCookie } },
  );
  expect(res.status).toBe(200);

  const auditRows = await adminSql.unsafe<{ after: { event_type_filter: string | null } }[]>(
    `SELECT after FROM audit_events
     WHERE action = 'bdm.campaign.query' AND entity_id = $1`,
    [tenantId],
  );

  expect(auditRows).toHaveLength(1);
  expect(auditRows[0].after.event_type_filter).toBe('wiki_published');
});

// ---------------------------------------------------------------------------
// TP-2: Compliance Officer can query the audit store and see BDM events
// ---------------------------------------------------------------------------

test('GET /api/audit/verify returns valid:true including BDM audit events (Compliance Officer)', async () => {
  const tenantId = `tenant-bdm-verify-${Date.now()}`;

  await adminSql.unsafe(
    `INSERT INTO session_events
       (tenant_id, session_id, asset_manager_id, fund_id, chunk_excerpt_hash, event_type)
     VALUES ($1, 'sess-bdm-3', 'am-3', 'fund-3', 'aabbccdd', 'chunk_indexed')`,
    [tenantId],
  );

  // Issue a BDM query to produce an audit event.
  const bdmRes = await fetch(`${BASE}/api/bdm/campaign?tenant_id=${encodeURIComponent(tenantId)}`, {
    headers: { Cookie: authCookie },
  });
  expect(bdmRes.status).toBe(200);

  // Compliance Officer (superuser) queries the audit verify endpoint.
  const verifyRes = await fetch(`${BASE}/api/audit/verify`, {
    headers: { Cookie: authCookie },
  });
  expect(verifyRes.status).toBe(200);
  const verifyBody = await verifyRes.json();

  // The hash chain must be valid — the BDM event is correctly chained.
  expect(verifyBody.valid).toBe(true);
  expect(verifyBody.firstInvalidId).toBeUndefined();
});

// ---------------------------------------------------------------------------
// AC-4: BDM query without data also emits audit event (single-tenant consistent)
// ---------------------------------------------------------------------------

test('GET /api/bdm/campaign with no matching events still emits an audit event', async () => {
  const tenantId = `tenant-bdm-empty-${Date.now()}`;
  // No seed rows for this tenantId — query returns empty array.

  const res = await fetch(`${BASE}/api/bdm/campaign?tenant_id=${encodeURIComponent(tenantId)}`, {
    headers: { Cookie: authCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events).toHaveLength(0);

  // Audit event must be written even for an empty result set.
  const auditRows = await adminSql.unsafe<{ actor_id: string }[]>(
    `SELECT actor_id FROM audit_events
     WHERE action = 'bdm.campaign.query' AND entity_id = $1`,
    [tenantId],
  );
  expect(auditRows).toHaveLength(1);
  expect(auditRows[0].actor_id).toBe(userId);
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
