/**
 * @file bdm-campaign-export.test.ts
 *
 * Integration tests for the audited BDM campaign CSV export endpoint (issue #77).
 *
 * Test plan items:
 *  TP-1  Integration: trigger export and assert CSV content and audit event.
 *  TP-2  Integration: assert the CSV contains no customer identifiers.
 *  TP-3  Integration: non-BDM roles cannot call the export endpoint (403).
 *
 * Architecture:
 *  - Real Postgres container (single DB for app + audit + analytics in tests).
 *  - Real Bun server started with TEST_MODE=true, ANALYTICS_DATABASE_URL=pg.url.
 *  - Session events seeded directly into session_events via the admin pool.
 *  - Audit events verified by reading audit_events via the admin pool.
 *
 * No mocks.
 */

import { afterAll, beforeAll, expect, test } from 'vitest';
import type { Subprocess } from 'bun';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31480;
const BASE = `http://localhost:${PORT}`;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let adminSql: ReturnType<typeof postgres>;
let bdmCookie = '';
let bdmUserId = '';
let regularCookie = '';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pg = await startPostgres();
  adminSql = postgres(pg.url, { max: 3 });

  // Create the session_events table (normally created by init-remote.ts in production;
  // in this test container we co-locate analytics with the app DB for simplicity).
  await adminSql.unsafe(`
    CREATE TABLE IF NOT EXISTS session_events (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id         TEXT NOT NULL,
      session_id        TEXT NOT NULL,
      asset_manager_id  TEXT NOT NULL,
      fund_id           TEXT NOT NULL,
      chunk_excerpt_hash TEXT NOT NULL,
      event_type        TEXT NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await adminSql.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_session_events_tenant ON session_events (tenant_id, created_at DESC)`,
  );

  // Ensure the audit_events table exists (normally created by audit-schema.sql / init-remote.ts).
  await adminSql.unsafe(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_id        TEXT NOT NULL,
      action          TEXT NOT NULL,
      entity_type     TEXT NOT NULL,
      entity_id       TEXT NOT NULL,
      before          JSONB,
      after           JSONB,
      ip              TEXT,
      user_agent      TEXT,
      correlation_id  TEXT,
      ts              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      prev_hash       TEXT NOT NULL,
      hash            TEXT NOT NULL
    )
  `);

  // Start the server.
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

  // Create a BDM user and assign the role.
  const bdmSession = await createTestSession(BASE, { username: `bdm_${Date.now()}` });
  bdmUserId = bdmSession.userId;
  bdmCookie = bdmSession.cookie;

  await adminSql`
    UPDATE entities
    SET properties = ${adminSql.json({ username: bdmSession.username, role: 'bdm' }) as never}
    WHERE id = ${bdmUserId}
  `;

  // Create a regular (non-BDM) user.
  const regularSession = await createTestSession(BASE, { username: `reg_${Date.now()}` });
  regularCookie = regularSession.cookie;
}, 120_000);

afterAll(async () => {
  server?.kill();
  await adminSql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForServer(base: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/health/live`);
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Server at ${base} did not become ready within ${timeoutMs}ms`);
}

const TENANT_ID = `tenant-export-test-${Date.now()}`;

/** Seed a session event directly into the DB for the test tenant. */
async function seedSessionEvent(
  assetManagerId: string,
  fundId: string,
  chunkHash: string,
  eventType: 'chunk_indexed' | 'wiki_published',
): Promise<void> {
  await adminSql`
    INSERT INTO session_events (tenant_id, session_id, asset_manager_id, fund_id, chunk_excerpt_hash, event_type)
    VALUES (
      ${TENANT_ID},
      ${'pseudonym-' + assetManagerId},
      ${assetManagerId},
      ${fundId},
      ${chunkHash},
      ${eventType}
    )
  `;
}

// ---------------------------------------------------------------------------
// TP-1: trigger export, assert CSV content and audit event
// ---------------------------------------------------------------------------

test('TP-1: BDM can export campaign data as CSV and an audit event is written', async () => {
  await seedSessionEvent('am-001', 'fund-001', 'hash-abc', 'chunk_indexed');
  await seedSessionEvent('am-002', 'fund-002', 'hash-def', 'wiki_published');

  const res = await fetch(
    `${BASE}/api/bdm/campaign/export?tenant_id=${encodeURIComponent(TENANT_ID)}`,
    { headers: { Cookie: bdmCookie } },
  );

  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/csv');
  expect(res.headers.get('content-disposition')).toMatch(/attachment; filename=/);

  const body = await res.text();

  // CSV must have a header row.
  expect(body).toContain(
    'id,tenant_id,session_id,asset_manager_id,fund_id,chunk_excerpt_hash,event_type,created_at',
  );

  // The CSV must include the seeded asset_manager_ids.
  expect(body).toContain('am-001');
  expect(body).toContain('am-002');

  // Verify the audit event was written.
  const auditRows = await adminSql<{ action: string; entity_id: string; after: unknown }[]>`
    SELECT action, entity_id, after
    FROM audit_events
    WHERE action = 'bdm_campaign.export'
      AND entity_id = ${TENANT_ID}
    ORDER BY ts DESC
    LIMIT 1
  `;

  expect(auditRows.length).toBe(1);
  expect(auditRows[0].action).toBe('bdm_campaign.export');
  expect(auditRows[0].entity_id).toBe(TENANT_ID);
  const afterRaw = auditRows[0].after;
  const afterPayload: Record<string, unknown> =
    typeof afterRaw === 'string'
      ? (JSON.parse(afterRaw) as Record<string, unknown>)
      : (afterRaw as Record<string, unknown>);
  expect(afterPayload).not.toBeNull();
  expect(afterPayload.format).toBe('csv');
}, 60_000);

// ---------------------------------------------------------------------------
// TP-2: assert the CSV contains no customer identifiers
// ---------------------------------------------------------------------------

test('TP-2: the exported CSV contains no customer identifiers', async () => {
  const res = await fetch(
    `${BASE}/api/bdm/campaign/export?tenant_id=${encodeURIComponent(TENANT_ID)}`,
    { headers: { Cookie: bdmCookie } },
  );

  expect(res.status).toBe(200);
  const body = await res.text();

  // The CSV must contain pseudonymised session_ids, not real UUIDs of users.
  // The real customer UUID format would match raw entity IDs from kb_app.
  // session_id values stored in session_events are HMAC pseudonyms (our seeded
  // rows use 'pseudonym-<am-id>' to simulate this). Importantly the CSV must
  // contain no raw customer entity IDs.
  //
  // Verify none of the column values match the pattern "customer-*" (which would
  // indicate a customer entity UUID leaked through).
  const lines = body.split('\r\n').filter((l) => l.trim() !== '' && !l.startsWith('id,'));
  for (const line of lines) {
    expect(line.toLowerCase()).not.toMatch(/customer/);
  }

  // Chunk excerpt hashes — the CSV must contain only hex-like or test hashes,
  // not any raw text content.
  expect(body).toContain('hash-abc');
  expect(body).toContain('hash-def');
  // No raw chunk text should appear.
  expect(body).not.toContain('Sample chunk content');
}, 60_000);

// ---------------------------------------------------------------------------
// TP-3: non-BDM roles cannot call the export endpoint
// ---------------------------------------------------------------------------

test('TP-3: non-BDM user receives 403 on the export endpoint', async () => {
  const res = await fetch(
    `${BASE}/api/bdm/campaign/export?tenant_id=${encodeURIComponent(TENANT_ID)}`,
    { headers: { Cookie: regularCookie } },
  );

  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe('Forbidden');
}, 30_000);

test('TP-3b: unauthenticated request to export returns 401', async () => {
  const res = await fetch(
    `${BASE}/api/bdm/campaign/export?tenant_id=${encodeURIComponent(TENANT_ID)}`,
  );

  expect(res.status).toBe(401);
}, 30_000);
