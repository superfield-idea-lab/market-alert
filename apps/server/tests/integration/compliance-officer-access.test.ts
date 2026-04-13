/**
 * Integration tests for the Compliance Officer role visibility and read
 * access (issue #85).
 *
 * Covers:
 *  - /api/auth/me surfaces isComplianceOfficer for users with role =
 *    'compliance_officer'
 *  - Compliance Officers can read compliance listing endpoints
 *  - Non-Compliance users are rejected from the compliance read surfaces
 *
 * No mocks. Real Postgres + real Bun server.
 */

import { afterAll, beforeAll, test, expect } from 'vitest';
import type { Subprocess } from 'bun';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31451;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 60_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let sql: ReturnType<typeof postgres>;
let complianceCookie = '';
let regularCookie = '';

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 3 });

  await sql.unsafe(`
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

  const complianceSession = await createTestSession(BASE, {
    username: `co_${Date.now()}`,
    role: 'compliance_officer',
  });
  complianceCookie = complianceSession.cookie;

  const regularSession = await createTestSession(BASE, { username: `reg_${Date.now()}` });
  regularCookie = regularSession.cookie;
}, 120_000);

afterAll(async () => {
  server?.kill();
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

test('/api/auth/me exposes isComplianceOfficer for compliance_officer users', async () => {
  const res = await fetch(`${BASE}/api/auth/me`, {
    headers: { Cookie: complianceCookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    user: { isComplianceOfficer?: boolean; isSuperadmin?: boolean; isCrmAdmin?: boolean };
  };
  expect(body.user.isComplianceOfficer).toBe(true);
  expect(body.user.isSuperadmin).toBe(false);
  expect(body.user.isCrmAdmin).toBe(false);
});

test('compliance_officer can read compliance listing endpoints', async () => {
  const retentionRes = await fetch(`${BASE}/api/compliance/retention-policies`, {
    headers: { Cookie: complianceCookie },
  });
  expect(retentionRes.status).toBe(200);

  const holdRes = await fetch(`${BASE}/api/legal-holds?limit=5`, {
    headers: { Cookie: complianceCookie },
  });
  expect(holdRes.status).toBe(200);

  const auditRes = await fetch(`${BASE}/api/compliance/audit?limit=5`, {
    headers: { Cookie: complianceCookie },
  });
  expect(auditRes.status).toBe(200);
  const auditBody = (await auditRes.json()) as { events: unknown[] };
  expect(Array.isArray(auditBody.events)).toBe(true);
});

test('non-compliance users are rejected from compliance listing endpoints', async () => {
  const retentionRes = await fetch(`${BASE}/api/compliance/retention-policies`, {
    headers: { Cookie: regularCookie },
  });
  expect(retentionRes.status).toBe(403);

  const holdRes = await fetch(`${BASE}/api/legal-holds?limit=5`, {
    headers: { Cookie: regularCookie },
  });
  expect(holdRes.status).toBe(403);

  const auditRes = await fetch(`${BASE}/api/compliance/audit?limit=5`, {
    headers: { Cookie: regularCookie },
  });
  expect(auditRes.status).toBe(403);
});

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
