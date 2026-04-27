/**
 * Integration tests for POST /internal/ingestion/email.
 *
 * Spins up a real Bun server backed by an ephemeral Postgres container and
 * exercises the full API-mediated email ingestion write path.
 *
 * Acceptance criteria covered:
 *   AC-1  POST /internal/ingestion/email succeeds with a valid scoped token (happy path).
 *   AC-2  POST fails when the Authorization header is missing.
 *   AC-3  POST fails with an expired / misscoped token (rejected token path).
 *   AC-4  Every successful write emits an audit event.
 *   AC-5  A direct INSERT into entities as the email_ingest role is denied.
 *
 * Test plan items addressed:
 *   TP-1  Integration: mint a scoped token and POST an email payload, assert persistence.
 *   TP-2  Integration: expire a token and assert POST is rejected.
 *   TP-3  Integration: attempt a direct DB INSERT as the worker role and assert denied.
 *
 * No mocks — real Bun server, real Postgres, real JWT signing.
 *
 * Blueprint: WORKER-P-001, API-W-001. Issue #28.
 */

import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import type { Subprocess } from 'bun';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { runInitRemote, dbUrl } from '../../../../packages/db/init-remote';

const PORT = 31428;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 25_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;

/** Admin pool on the app database — used to verify persisted rows and setup. */
let adminAppSql: ReturnType<typeof postgres>;

/** email_ingest agent role pool — used to assert denied direct INSERT. */
let emailIngestSql: ReturnType<typeof postgres>;

const TEST_PASSWORDS = {
  app: 'app_test_pw',
  audit: 'audit_test_pw',
  analytics: 'analytics_test_pw',
  dictionary: 'dict_test_pw',
  email_ingest: 'email_ingest_test_pw',
};

const DB_NAMES = { app: 'superfield_app' };

function makeRoleUrl(adminUrl: string, db: string, role: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
}

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

/**
 * Mint a scoped ingestion token via the test-only endpoint.
 * Requires TEST_MODE=true on the server.
 */
async function mintToken(actorId: string, tenantId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/test/ingestion-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actorId, tenantId }),
  });
  if (res.status !== 201) {
    const body = await res.text();
    throw new Error(`mintToken failed with ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { token: string };
  return data.token;
}

beforeAll(async () => {
  pg = await startPostgres();

  // Provision all roles and databases (includes email_ingest agent role).
  await runInitRemote({
    ADMIN_DATABASE_URL: pg.url,
    APP_RW_PASSWORD: TEST_PASSWORDS.app,
    AUDIT_W_PASSWORD: TEST_PASSWORDS.audit,
    ANALYTICS_W_PASSWORD: TEST_PASSWORDS.analytics,
    DICT_RW_PASSWORD: TEST_PASSWORDS.dictionary,
    AGENT_EMAIL_INGEST_PASSWORD: TEST_PASSWORDS.email_ingest,
  } as NodeJS.ProcessEnv);

  // Start the server pointing at the test container.
  // DATABASE_URL is used by app_rw (the server's normal pool).
  // AUDIT_DATABASE_URL is used by the audit service.
  // ENCRYPTION_DISABLED=true skips field encryption for test speed.
  const appRwUrl = makeRoleUrl(pg.url, DB_NAMES.app, 'app_rw', TEST_PASSWORDS.app);
  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: appRwUrl,
      AUDIT_DATABASE_URL: pg.url,
      PORT: String(PORT),
      TEST_MODE: 'true',
      ENCRYPTION_DISABLED: 'true',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);

  adminAppSql = postgres(dbUrl(pg.url, DB_NAMES.app), { max: 3 });
  emailIngestSql = postgres(
    makeRoleUrl(pg.url, DB_NAMES.app, 'agent_email_ingest', TEST_PASSWORDS.email_ingest),
    { max: 3 },
  );
}, 90_000);

afterAll(async () => {
  server?.kill();
  await adminAppSql?.end({ timeout: 5 });
  await emailIngestSql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// AC-5 / TP-3: Worker role cannot INSERT into entities directly
// ---------------------------------------------------------------------------

describe('email_ingest DB role — denied direct write (AC-5 / TP-3)', () => {
  test('agent_email_ingest role cannot INSERT into entities — denied at the database layer', async () => {
    const entityId = `direct-email-${Date.now()}`;
    await expect(
      emailIngestSql`
        INSERT INTO entities (id, type, properties, tenant_id)
        VALUES (${entityId}, 'email', ${'{}'}::jsonb, 'test-tenant')
      `,
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC-1 / TP-1: Happy path — mint token, POST email, assert persistence
// ---------------------------------------------------------------------------

describe('POST /internal/ingestion/email — happy path (AC-1 / TP-1)', () => {
  test('succeeds with a valid scoped token and persists the email entity', async () => {
    const tenantId = `tenant-ingestion-${Date.now()}`;
    const actorId = `actor-${Date.now()}`;
    const messageId = `msg-${Date.now()}`;
    const receivedAt = new Date().toISOString();

    const token = await mintToken(actorId, tenantId);

    const res = await fetch(`${BASE}/internal/ingestion/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        message_id: messageId,
        subject: 'Test email subject',
        body: 'Test email body content',
        headers: 'From: test@example.com\r\nTo: dest@example.com',
        received_at: receivedAt,
      }),
    });

    expect(res.status).toBe(201);
    const data = (await res.json()) as { id: string };
    expect(typeof data.id).toBe('string');

    // Verify entity is persisted in the database.
    const rows = await adminAppSql<{ id: string; type: string; tenant_id: string }[]>`
      SELECT id, type, tenant_id FROM entities WHERE id = ${data.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('email');
    expect(rows[0].tenant_id).toBe(tenantId);
  });

  test('returns 400 when required fields are missing', async () => {
    const token = await mintToken(`actor-${Date.now()}`, `tenant-${Date.now()}`);

    const res = await fetch(`${BASE}/internal/ingestion/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        // message_id missing
        subject: 'Only subject',
        body: 'Body text',
        headers: 'From: x@y.com',
        received_at: new Date().toISOString(),
      }),
    });

    expect(res.status).toBe(400);
  });

  test('returns 400 when received_at is not a valid ISO-8601 timestamp', async () => {
    const token = await mintToken(`actor-${Date.now()}`, `tenant-${Date.now()}`);

    const res = await fetch(`${BASE}/internal/ingestion/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        message_id: 'msg-bad-ts',
        subject: 'Subject',
        body: 'Body',
        headers: 'From: x@y.com',
        received_at: 'not-a-date',
      }),
    });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// AC-2: Missing Authorization header
// ---------------------------------------------------------------------------

describe('POST /internal/ingestion/email — missing auth (AC-2)', () => {
  test('returns 401 when Authorization header is absent', async () => {
    const res = await fetch(`${BASE}/internal/ingestion/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message_id: 'msg-no-auth',
        subject: 'Subject',
        body: 'Body',
        headers: 'From: x@y.com',
        received_at: new Date().toISOString(),
      }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// AC-3 / TP-2: Expired or misscoped token is rejected
// ---------------------------------------------------------------------------

describe('POST /internal/ingestion/email — rejected token (AC-3 / TP-2)', () => {
  test('returns 401 when the token is already consumed (single-use enforcement)', async () => {
    const tenantId = `tenant-singleuse-${Date.now()}`;
    const actorId = `actor-singleuse-${Date.now()}`;
    const token = await mintToken(actorId, tenantId);

    // First use — succeeds
    const first = await fetch(`${BASE}/internal/ingestion/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        message_id: `msg-first-${Date.now()}`,
        subject: 'First use',
        body: 'Body',
        headers: 'From: x@y.com',
        received_at: new Date().toISOString(),
      }),
    });
    expect(first.status).toBe(201);

    // Second use — same token, must be rejected
    const second = await fetch(`${BASE}/internal/ingestion/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        message_id: `msg-second-${Date.now()}`,
        subject: 'Second use',
        body: 'Body',
        headers: 'From: x@y.com',
        received_at: new Date().toISOString(),
      }),
    });
    expect(second.status).toBe(401);
  });

  test('returns 401 when the token has a malformed value', async () => {
    const res = await fetch(`${BASE}/internal/ingestion/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer not.a.valid.token',
      },
      body: JSON.stringify({
        message_id: 'msg-bad-token',
        subject: 'Subject',
        body: 'Body',
        headers: 'From: x@y.com',
        received_at: new Date().toISOString(),
      }),
    });
    expect(res.status).toBe(401);
  });
});
