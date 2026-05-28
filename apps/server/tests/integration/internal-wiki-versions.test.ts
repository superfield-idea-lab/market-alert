/**
 * Integration tests for POST /internal/wiki/versions (issue #39).
 *
 * Validates:
 *   - Valid request creates a draft WikiPageVersion
 *   - A token scoped to a different (dept, customer) is rejected
 *   - Re-using a consumed token is rejected (single-use)
 *   - Missing/invalid fields are rejected with 400
 *   - No Authorization header returns 401
 *   - Every accepted write emits an audit event
 *   - Direct INSERT into wiki_page_versions by a restricted DB role is denied
 *
 * No mocks. Real Postgres + real Bun server via the shared pg-container helper.
 * Token issuance uses the production issueWorkerToken function with a test DB
 * pool injected so it writes to the same ephemeral database as the server.
 */

import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import postgres from 'postgres';

const PORT = 31428;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  pg = await startPostgres();

  // Direct pool for assertion queries and token issuance.
  sql = postgres(pg.url, { max: 5, idle_timeout: 10 });

  // Create the audit_events table in the app DB (normally created by
  // init-remote.ts; here we use the same DB for audit, so create it inline).
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
      PORT: String(PORT),
      TEST_MODE: 'true',
      CSRF_DISABLED: 'true',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);
}, 60_000);

afterAll(async () => {
  server?.kill();
  await sql?.end();
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Helper — issue a scoped worker token via the server's TEST_MODE mint
// endpoint (POST /api/test/worker-token).  This avoids cross-process JWT
// key-pair mismatch: the token is signed by the server's own ephemeral key so
// the server's verifyJwt will accept it.
// ---------------------------------------------------------------------------

async function mintToken(dept: string, customer: string, taskId?: string): Promise<string> {
  const res = await fetch(`${BASE}/api/test/worker-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dept, customer, task_id: taskId }),
  });
  if (!res.ok) {
    throw new Error(`Failed to mint worker token: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('POST /internal/wiki/versions creates a draft WikiPageVersion', async () => {
  const token = await mintToken('engineering', 'acme');

  const res = await fetch(`${BASE}/internal/wiki/versions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      page_id: 'acme-onboarding',
      dept: 'engineering',
      customer: 'acme',
      content: '# Onboarding\n\nDraft content.',
      source_task: 'task-001',
    }),
  });

  expect(res.status).toBe(201);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.state).toBe('draft');
  expect(body.page_id).toBe('acme-onboarding');
  expect(body.dept).toBe('engineering');
  expect(body.customer).toBe('acme');
  expect(typeof body.id).toBe('string');

  // Verify the row exists in the database.
  const rows = await sql<{ state: string; created_by: string }[]>`
    SELECT state, created_by
    FROM wiki_page_versions
    WHERE id = ${body.id as string}
  `;
  expect(rows).toHaveLength(1);
  expect(rows[0].state).toBe('draft');
});

test('POST /internal/wiki/versions with a mis-scoped token is rejected', async () => {
  // Token scoped to (engineering, acme) but payload targets (engineering, globex).
  const token = await mintToken('engineering', 'acme');

  const res = await fetch(`${BASE}/internal/wiki/versions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      page_id: 'globex-page',
      dept: 'engineering',
      customer: 'globex', // mismatch — token is scoped to 'acme'
      content: '# Page',
    }),
  });

  expect(res.status).toBe(401);
  const body = (await res.json()) as Record<string, unknown>;
  expect(typeof body.error).toBe('string');
});

test('POST /internal/wiki/versions rejects a consumed token on re-use', async () => {
  const token = await mintToken('sales', 'umbrella');
  const payload = {
    page_id: 'umbrella-sales-guide',
    dept: 'sales',
    customer: 'umbrella',
    content: '# Guide',
  };

  // First use — should succeed.
  const first = await fetch(`${BASE}/internal/wiki/versions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  expect(first.status).toBe(201);

  // Second use — same token, should be rejected.
  const second = await fetch(`${BASE}/internal/wiki/versions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  expect(second.status).toBe(401);
  const body = (await second.json()) as Record<string, unknown>;
  expect(String(body.error).toLowerCase()).toContain('used');
});

test('POST /internal/wiki/versions returns 400 for missing content', async () => {
  const token = await mintToken('hr', 'springfield');

  const res = await fetch(`${BASE}/internal/wiki/versions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      page_id: 'spring-wiki',
      dept: 'hr',
      customer: 'springfield',
      // content omitted
    }),
  });

  expect(res.status).toBe(400);
});

test('POST /internal/wiki/versions returns 401 without a token', async () => {
  const res = await fetch(`${BASE}/internal/wiki/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      page_id: 'p',
      dept: 'd',
      customer: 'c',
      content: 'x',
    }),
  });

  expect(res.status).toBe(401);
});

test('accepted write emits an audit event', async () => {
  const token = await mintToken('legal', 'initech');

  const res = await fetch(`${BASE}/internal/wiki/versions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      page_id: 'initech-policies',
      dept: 'legal',
      customer: 'initech',
      content: '# Policies',
    }),
  });

  expect(res.status).toBe(201);
  const body = (await res.json()) as Record<string, unknown>;

  // Query the audit DB (same pool in test env) for the event.
  const auditRows = await sql<{ action: string; entity_id: string }[]>`
    SELECT action, entity_id
    FROM audit_events
    WHERE action = 'wiki_version.create'
      AND entity_id = 'initech-policies'
    ORDER BY ts DESC
    LIMIT 1
  `;
  expect(auditRows).toHaveLength(1);
  expect(auditRows[0].action).toBe('wiki_version.create');
  void body;
});

test('Direct INSERT into wiki_page_versions by a restricted DB role is denied', async () => {
  // Create a restricted role that mirrors the worker DB role (agent_autolearn).
  // The worker DB role has SELECT-only access to wiki_page_versions — INSERT
  // is denied at the database level.
  const roleName = `test_worker_role_${Date.now()}`;
  const rolePassword = 'test_worker_pw';

  await sql.unsafe(`CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}'`);
  await sql.unsafe(`REVOKE ALL ON wiki_page_versions FROM ${roleName}`);
  await sql.unsafe(`GRANT SELECT ON wiki_page_versions TO ${roleName}`);
  await sql.unsafe(`GRANT CONNECT ON DATABASE superfield TO ${roleName}`);
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${roleName}`);

  // Connect as the restricted role.
  const workerUrl = pg.url.replace(
    /postgres:\/\/[^:@]+:[^@]+@/,
    `postgres://${roleName}:${rolePassword}@`,
  );
  const restrictedSql = postgres(workerUrl, { max: 1 });

  try {
    await restrictedSql`
      INSERT INTO wiki_page_versions (page_id, dept, customer, content, state, created_by)
      VALUES ('direct-insert', 'test', 'test', 'body', 'draft', 'worker')
    `;
    // If we reach here, the INSERT was not denied — fail the test.
    expect.fail('Expected INSERT to be denied for restricted role');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect(message.toLowerCase()).toMatch(/permission denied|insufficient privilege/i);
  } finally {
    await restrictedSql.end();
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/health/live`);
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}
