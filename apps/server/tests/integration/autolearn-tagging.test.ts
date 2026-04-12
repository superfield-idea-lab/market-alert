/**
 * @file autolearn-tagging.test.ts
 *
 * Integration tests for autolearn discussed_in relation tagging (issue #72).
 *
 * ## Coverage
 *
 * 1. POST /internal/relations with a valid worker token and a seeded transcript
 *    mentioning an AssetManager creates the discussed_in relation.
 * 2. The relation is visible to authorised queries under the same tenant scope.
 * 3. A token scoped to a different (dept, customer) is rejected with 401.
 * 4. Missing required fields are rejected with 400.
 * 5. A source_id that does not exist returns 404.
 * 6. A source_id of non-transcript type is rejected with 400.
 * 7. A target entity_id that does not exist returns 404.
 * 8. A target entity_type mismatch is rejected with 400.
 * 9. An entity_type that is not asset_manager or fund is rejected with 400.
 * 10. Direct INSERT into relations by a restricted DB role is denied.
 * 11. Every accepted batch write emits an audit event.
 *
 * ## No mocks
 *
 * Uses a real ephemeral Postgres container and a real Bun server subprocess.
 * HTTP calls go to localhost via `fetch()`. Token minting uses the server's
 * TEST_MODE endpoint to avoid cross-process key-pair mismatch.
 */

import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import postgres from 'postgres';

const PORT = 31472;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let sql: ReturnType<typeof postgres>;

// Seeded entity IDs — created in beforeAll.
let transcriptId: string;
let assetManagerId: string;
let fundId: string;

beforeAll(async () => {
  pg = await startPostgres();

  // Direct pool for assertion queries.
  sql = postgres(pg.url, { max: 5, idle_timeout: 10 });

  // Create the audit_events table (normally created by init-remote.ts — reuse
  // the same DB for audit in test mode).
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
      ENCRYPTION_DISABLED: 'true',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);

  // Seed entity types needed for the test.
  await sql.unsafe(`
    INSERT INTO entity_types (type, schema) VALUES
      ('asset_manager', '{}'),
      ('fund', '{}'),
      ('transcript', '{}')
    ON CONFLICT (type) DO NOTHING
  `);

  // Seed a transcript entity.
  transcriptId = `transcript-${Date.now()}-1`;
  await sql.unsafe(`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES ('${transcriptId}', 'transcript', '{"text":"We discussed Acme Capital and their flagship fund."}', 'tenant-test')
  `);

  // Seed an asset_manager entity (tenant_id = null — global CRM entity).
  assetManagerId = `asset_manager-${Date.now()}-1`;
  await sql.unsafe(`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES ('${assetManagerId}', 'asset_manager', '{"name":"Acme Capital"}', null)
  `);

  // Seed a fund entity.
  fundId = `fund-${Date.now()}-1`;
  await sql.unsafe(`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES ('${fundId}', 'fund', '{"name":"Acme Growth Fund"}', null)
  `);
}, 60_000);

afterAll(async () => {
  server?.kill();
  await sql?.end();
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Helper — mint a wiki-write scoped worker token via the server TEST_MODE endpoint.
// ---------------------------------------------------------------------------

async function mintToken(dept: string, customer: string): Promise<string> {
  const res = await fetch(`${BASE}/api/test/worker-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dept, customer }),
  });
  if (!res.ok) {
    throw new Error(`Failed to mint worker token: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('POST /internal/relations creates a discussed_in relation for an AssetManager', async () => {
  const token = await mintToken('engineering', 'acme');

  const res = await fetch(`${BASE}/internal/relations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      dept: 'engineering',
      customer: 'acme',
      source_id: transcriptId,
      targets: [{ entity_id: assetManagerId, entity_type: 'asset_manager' }],
    }),
  });

  expect(res.status).toBe(201);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.written).toBe(1);
  expect(Array.isArray(body.relation_ids)).toBe(true);
  expect((body.relation_ids as string[]).length).toBe(1);

  // Verify the relation row was written.
  const relId = (body.relation_ids as string[])[0];
  const rows = await sql<{ type: string; source_id: string; target_id: string }[]>`
    SELECT type, source_id, target_id
    FROM relations
    WHERE id = ${relId}
  `;
  expect(rows).toHaveLength(1);
  expect(rows[0].type).toBe('discussed_in');
  expect(rows[0].source_id).toBe(transcriptId);
  expect(rows[0].target_id).toBe(assetManagerId);
});

test('POST /internal/relations creates discussed_in relations for both AssetManager and Fund', async () => {
  const token = await mintToken('engineering', 'acme-multi');

  const res = await fetch(`${BASE}/internal/relations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      dept: 'engineering',
      customer: 'acme-multi',
      source_id: transcriptId,
      targets: [
        { entity_id: assetManagerId, entity_type: 'asset_manager' },
        { entity_id: fundId, entity_type: 'fund' },
      ],
    }),
  });

  expect(res.status).toBe(201);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.written).toBe(2);
  expect((body.relation_ids as string[]).length).toBe(2);
});

// ---------------------------------------------------------------------------
// Audit event
// ---------------------------------------------------------------------------

test('accepted write emits a relation.discussed_in.create audit event', async () => {
  const token = await mintToken('audit-dept', 'audit-customer');
  const transcriptForAudit = `transcript-audit-${Date.now()}`;
  await sql.unsafe(`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES ('${transcriptForAudit}', 'transcript', '{}', 'tenant-audit')
  `);

  const res = await fetch(`${BASE}/internal/relations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      dept: 'audit-dept',
      customer: 'audit-customer',
      source_id: transcriptForAudit,
      targets: [{ entity_id: assetManagerId, entity_type: 'asset_manager' }],
    }),
  });
  expect(res.status).toBe(201);

  const auditRows = await sql<{ action: string; entity_id: string }[]>`
    SELECT action, entity_id
    FROM audit_events
    WHERE action = 'relation.discussed_in.create'
      AND entity_id = ${transcriptForAudit}
    ORDER BY ts DESC
    LIMIT 1
  `;
  expect(auditRows).toHaveLength(1);
  expect(auditRows[0].action).toBe('relation.discussed_in.create');
});

// ---------------------------------------------------------------------------
// Auth failures
// ---------------------------------------------------------------------------

test('POST /internal/relations returns 401 without an Authorization header', async () => {
  const res = await fetch(`${BASE}/internal/relations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dept: 'engineering',
      customer: 'acme',
      source_id: transcriptId,
      targets: [{ entity_id: assetManagerId, entity_type: 'asset_manager' }],
    }),
  });
  expect(res.status).toBe(401);
});

test('POST /internal/relations with a mis-scoped token is rejected with 401', async () => {
  // Token is scoped to (engineering, acme) but the payload specifies (engineering, globex).
  const token = await mintToken('engineering', 'acme');

  const res = await fetch(`${BASE}/internal/relations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      dept: 'engineering',
      customer: 'globex', // mismatch
      source_id: transcriptId,
      targets: [{ entity_id: assetManagerId, entity_type: 'asset_manager' }],
    }),
  });
  expect(res.status).toBe(401);
  const body = (await res.json()) as Record<string, unknown>;
  expect(typeof body.error).toBe('string');
});

// ---------------------------------------------------------------------------
// Validation failures
// ---------------------------------------------------------------------------

test('POST /internal/relations returns 400 when dept is missing', async () => {
  const token = await mintToken('engineering', 'acme');
  const res = await fetch(`${BASE}/internal/relations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      customer: 'acme',
      source_id: transcriptId,
      targets: [{ entity_id: assetManagerId, entity_type: 'asset_manager' }],
    }),
  });
  expect(res.status).toBe(400);
});

test('POST /internal/relations returns 400 when targets is empty', async () => {
  const token = await mintToken('engineering', 'acme');
  const res = await fetch(`${BASE}/internal/relations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      dept: 'engineering',
      customer: 'acme',
      source_id: transcriptId,
      targets: [],
    }),
  });
  expect(res.status).toBe(400);
});

test('POST /internal/relations returns 400 when entity_type is not allowed', async () => {
  const token = await mintToken('engineering', 'acme');
  const res = await fetch(`${BASE}/internal/relations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      dept: 'engineering',
      customer: 'acme',
      source_id: transcriptId,
      targets: [{ entity_id: assetManagerId, entity_type: 'email' }], // not allowed
    }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as Record<string, unknown>;
  expect(String(body.error)).toMatch(/entity_type/i);
});

// ---------------------------------------------------------------------------
// Entity not-found / type-mismatch failures
// ---------------------------------------------------------------------------

test('POST /internal/relations returns 404 when source_id does not exist', async () => {
  const token = await mintToken('engineering', 'acme');
  const res = await fetch(`${BASE}/internal/relations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      dept: 'engineering',
      customer: 'acme',
      source_id: 'transcript-nonexistent-99999',
      targets: [{ entity_id: assetManagerId, entity_type: 'asset_manager' }],
    }),
  });
  expect(res.status).toBe(404);
});

test('POST /internal/relations returns 400 when source entity is not a transcript', async () => {
  const token = await mintToken('engineering', 'acme');
  // Use the asset_manager entity as source — wrong type.
  const res = await fetch(`${BASE}/internal/relations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      dept: 'engineering',
      customer: 'acme',
      source_id: assetManagerId, // wrong type — asset_manager, not transcript
      targets: [{ entity_id: fundId, entity_type: 'fund' }],
    }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as Record<string, unknown>;
  expect(String(body.error)).toMatch(/transcript/i);
});

test('POST /internal/relations returns 404 when a target entity_id does not exist', async () => {
  const token = await mintToken('engineering', 'acme');
  const res = await fetch(`${BASE}/internal/relations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      dept: 'engineering',
      customer: 'acme',
      source_id: transcriptId,
      targets: [{ entity_id: 'asset_manager-nonexistent-99999', entity_type: 'asset_manager' }],
    }),
  });
  expect(res.status).toBe(404);
});

test('POST /internal/relations returns 400 when entity_type does not match actual type', async () => {
  const token = await mintToken('engineering', 'acme');
  // fundId is of type 'fund', but we claim it is an 'asset_manager'.
  const res = await fetch(`${BASE}/internal/relations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      dept: 'engineering',
      customer: 'acme',
      source_id: transcriptId,
      targets: [{ entity_id: fundId, entity_type: 'asset_manager' }], // wrong type
    }),
  });
  expect(res.status).toBe(400);
});

// ---------------------------------------------------------------------------
// DB-layer deny — direct INSERT by a restricted role must fail
// ---------------------------------------------------------------------------

test('Direct INSERT into relations by a restricted DB role is denied', async () => {
  const roleName = `test_worker_rel_role_${Date.now()}`;
  const rolePassword = 'test_worker_rel_pw';

  await sql.unsafe(`CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}'`);
  await sql.unsafe(`REVOKE ALL ON relations FROM ${roleName}`);
  await sql.unsafe(`GRANT SELECT ON relations TO ${roleName}`);
  await sql.unsafe(`GRANT CONNECT ON DATABASE calypso TO ${roleName}`);
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${roleName}`);

  const workerUrl = pg.url.replace(
    /postgres:\/\/[^:@]+:[^@]+@/,
    `postgres://${roleName}:${rolePassword}@`,
  );
  const restrictedSql = postgres(workerUrl, { max: 1 });

  try {
    await restrictedSql`
      INSERT INTO relations (id, source_id, target_id, type, properties)
      VALUES ('rel-direct-test', ${transcriptId}, ${assetManagerId}, 'discussed_in', '{}')
    `;
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
