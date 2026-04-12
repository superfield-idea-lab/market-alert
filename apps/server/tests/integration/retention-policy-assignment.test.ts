/**
 * Integration tests for the retention policy assignment API (issue #79).
 *
 * Acceptance criteria covered:
 *   AC-1  Policies can be defined with per-entity retention periods.
 *   AC-2  Compliance Officers can assign a policy to a tenant.
 *   AC-3  Assignments are audited.
 *   AC-4  Non-Compliance roles cannot assign policies.
 *
 * Test plan:
 *   TP-1  Assign a policy as Compliance Officer and assert audit event.
 *   TP-2  Attempt assignment as another role (regular user) and assert rejection.
 *
 * No mocks — real Postgres + real Bun server.
 */

import { afterAll, beforeAll, describe, test, expect } from 'vitest';
import type { Subprocess } from 'bun';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31450;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 60_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let sql: ReturnType<typeof postgres>;
let complianceCookie = '';
let complianceUserId = '';
let complianceCsrf = '';
let regularCookie = '';
let regularCsrf = '';

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 3 });

  // Ensure the audit_events table exists — normally created by init-remote.ts;
  // here we share a single Postgres container for all databases.
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

  // Create a compliance officer session.
  const coSession = await createTestSession(BASE, { username: `co_${Date.now()}` });
  complianceUserId = coSession.userId;
  complianceCookie = coSession.cookie;
  complianceCsrf = coSession.csrfToken;

  // Elevate the user to compliance_officer role directly in the DB.
  await sql`
    UPDATE entities
    SET properties = jsonb_set(properties, '{role}', '"compliance_officer"'::jsonb)
    WHERE id = ${complianceUserId}
  `;

  // Create a regular (non-Compliance) user session.
  const regSession = await createTestSession(BASE, { username: `reg_${Date.now()}` });
  regularCookie = regSession.cookie;
  regularCsrf = regSession.csrfToken;
}, 120_000);

afterAll(async () => {
  server?.kill();
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// AC-1: Policy library exists and is retrievable
// ---------------------------------------------------------------------------

describe('GET /api/compliance/retention-policies', () => {
  test('returns 200 with mifid2-5yr and sec17a4-6yr policies seeded', async () => {
    const res = await fetch(`${BASE}/api/compliance/retention-policies`, {
      headers: { Cookie: complianceCookie },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { policies: { name: string; retentionFloorDays: number }[] };
    const names = body.policies.map((p) => p.name);
    expect(names).toContain('mifid2-5yr');
    expect(names).toContain('sec17a4-6yr');

    const mifid = body.policies.find((p) => p.name === 'mifid2-5yr')!;
    expect(mifid.retentionFloorDays).toBe(1826);

    const sec = body.policies.find((p) => p.name === 'sec17a4-6yr')!;
    expect(sec.retentionFloorDays).toBe(2192);
  });

  test('returns 401 without authentication', async () => {
    const res = await fetch(`${BASE}/api/compliance/retention-policies`);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// AC-2 + AC-3 + TP-1: Compliance Officer can assign, assignment is audited
// ---------------------------------------------------------------------------

describe('POST /api/compliance/tenants/:id/retention-policy as compliance_officer', () => {
  test('TP-1: assigns policy and returns 200, records assignment in audit table', async () => {
    const tenantId = `tenant-co-test-${Date.now()}`;
    const policyName = 'mifid2-5yr';

    const res = await fetch(`${BASE}/api/compliance/tenants/${tenantId}/retention-policy`, {
      method: 'POST',
      headers: {
        Cookie: complianceCookie,
        'X-CSRF-Token': complianceCsrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ policyName }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenantId: string; policyName: string; assigned: boolean };
    expect(body.assigned).toBe(true);
    expect(body.tenantId).toBe(tenantId);
    expect(body.policyName).toBe(policyName);

    // AC-2: Verify the tenant_retention_policies row was written.
    const policyRows = await sql<{ tenant_id: string; retention_class: string }[]>`
      SELECT tenant_id, retention_class
      FROM tenant_retention_policies
      WHERE tenant_id = ${tenantId}
    `;
    expect(policyRows).toHaveLength(1);
    expect(policyRows[0].retention_class).toBe(policyName);

    // AC-3: Verify the assignment was recorded in the audit table.
    const assignmentRows = await sql<
      {
        tenant_id: string;
        policy_name: string;
        actor_id: string;
      }[]
    >`
      SELECT tenant_id, policy_name, actor_id
      FROM tenant_retention_policy_assignments
      WHERE tenant_id = ${tenantId}
      ORDER BY assigned_at DESC
      LIMIT 1
    `;
    expect(assignmentRows).toHaveLength(1);
    expect(assignmentRows[0].policy_name).toBe(policyName);
    expect(assignmentRows[0].actor_id).toBe(complianceUserId);
  });

  test('reassignment records the previous policy in the audit table', async () => {
    const tenantId = `tenant-reassign-${Date.now()}`;

    // First assignment.
    await fetch(`${BASE}/api/compliance/tenants/${tenantId}/retention-policy`, {
      method: 'POST',
      headers: {
        Cookie: complianceCookie,
        'X-CSRF-Token': complianceCsrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ policyName: 'mifid2-5yr' }),
    });

    // Second assignment — changes the policy.
    const res2 = await fetch(`${BASE}/api/compliance/tenants/${tenantId}/retention-policy`, {
      method: 'POST',
      headers: {
        Cookie: complianceCookie,
        'X-CSRF-Token': complianceCsrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ policyName: 'sec17a4-6yr' }),
    });
    expect(res2.status).toBe(200);

    // Verify both assignment rows exist and the second records the previous policy.
    const rows = await sql<{ policy_name: string; previous_policy: string | null }[]>`
      SELECT policy_name, previous_policy
      FROM tenant_retention_policy_assignments
      WHERE tenant_id = ${tenantId}
      ORDER BY assigned_at
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0].policy_name).toBe('mifid2-5yr');
    expect(rows[0].previous_policy).toBeNull();
    expect(rows[1].policy_name).toBe('sec17a4-6yr');
    expect(rows[1].previous_policy).toBe('mifid2-5yr');
  });

  test('returns 422 for an unknown policy name', async () => {
    const tenantId = `tenant-bad-policy-${Date.now()}`;

    const res = await fetch(`${BASE}/api/compliance/tenants/${tenantId}/retention-policy`, {
      method: 'POST',
      headers: {
        Cookie: complianceCookie,
        'X-CSRF-Token': complianceCsrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ policyName: 'nonexistent-policy' }),
    });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// AC-4 + TP-2: Non-Compliance roles cannot assign policies
// ---------------------------------------------------------------------------

describe('POST /api/compliance/tenants/:id/retention-policy as regular user', () => {
  test('TP-2: returns 403 Forbidden for a regular (non-compliance_officer) user', async () => {
    const tenantId = `tenant-regular-${Date.now()}`;

    const res = await fetch(`${BASE}/api/compliance/tenants/${tenantId}/retention-policy`, {
      method: 'POST',
      headers: {
        Cookie: regularCookie,
        'X-CSRF-Token': regularCsrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ policyName: 'mifid2-5yr' }),
    });

    expect(res.status).toBe(403);

    // Verify NO row was written to tenant_retention_policies.
    const policyRows = await sql<{ tenant_id: string }[]>`
      SELECT tenant_id
      FROM tenant_retention_policies
      WHERE tenant_id = ${tenantId}
    `;
    expect(policyRows).toHaveLength(0);
  });

  test('returns 401 without authentication', async () => {
    const tenantId = `tenant-no-auth-${Date.now()}`;

    const res = await fetch(`${BASE}/api/compliance/tenants/${tenantId}/retention-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policyName: 'mifid2-5yr' }),
    });

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Helpers
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
