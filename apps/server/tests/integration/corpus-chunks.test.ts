/**
 * Integration tests for the CorpusChunk ingestion API.
 *
 * Covers:
 *   - POST /api/corpus-chunks returns 401 when unauthenticated
 *   - POST /api/corpus-chunks returns 400 when source_id is missing
 *   - POST /api/corpus-chunks returns 400 when text is missing
 *   - POST /api/corpus-chunks returns 422 when source entity does not exist
 *   - Chunks a fixture email and asserts boundary rules and source linkage
 *   - Chunks a long email and asserts every chunk is under the ceiling
 *   - POST /api/corpus-chunks accepts a Bearer API key (ingestion token)
 *   - POST /api/corpus-chunks with blank text returns empty chunk array
 *
 * No mocks — real Postgres, real HTTP, real encryption paths.
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/29
 */

import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';
import postgres from 'postgres';

const PORT = 31427;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let sql: ReturnType<typeof postgres>;
let authCookie = '';
let superuserCookie = '';
let superuserId = '';

// ---- ids of seeded entities ----
let emailEntityId = ''; // a valid source entity for chunk tests
let apiKeyRaw = ''; // raw API key for Bearer tests

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5, idle_timeout: 10 });

  // Start with placeholder SUPERUSER_ID to create users, then restart with real one.
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

  // Create test sessions
  const regular = await createTestSession(BASE, { username: `reg_${Date.now()}` });
  authCookie = regular.cookie;

  const su = await createTestSession(BASE, { username: `su_${Date.now()}` });
  superuserId = su.userId;
  superuserCookie = su.cookie;

  // Restart with real SUPERUSER_ID
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

  // Seed a source entity directly via SQL so we have a valid source_id.
  // The /api/tasks CRUD handler was removed in issue #210 (template cleanup).
  // The chunker only requires that the source entity exists — it does not
  // enforce a specific entity type.
  // email is registered by registerPhase1EntityTypesWithDb on server start,
  // but we ensure it exists here in case the server hasn't finished booting.
  await sql.unsafe(`
    INSERT INTO entity_types (type, schema) VALUES ('email', '{}')
    ON CONFLICT (type) DO NOTHING
  `);
  emailEntityId = `email-${Date.now()}`;
  await sql.unsafe(`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES ('${emailEntityId}', 'email', '{"name":"corpus-chunk-source-email"}', null)
  `);

  // Create an API key for Bearer token tests
  const keyRes = await fetch(`${BASE}/api/admin/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: superuserCookie },
    body: JSON.stringify({ label: 'ingestion-test-key' }),
  });
  expect(keyRes.status).toBe(201);
  const keyBody = await keyRes.json();
  apiKeyRaw = keyBody.key;
}, 120_000);

afterAll(async () => {
  server?.kill();
  await sql?.end();
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

test('POST /api/corpus-chunks returns 401 when unauthenticated', async () => {
  const res = await fetch(`${BASE}/api/corpus-chunks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id: 'x', text: 'Hello world.' }),
  });
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('POST /api/corpus-chunks returns 400 when source_id is missing', async () => {
  const res = await fetch(`${BASE}/api/corpus-chunks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ text: 'Hello world.' }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toMatch(/source_id/);
});

test('POST /api/corpus-chunks returns 400 when text is missing', async () => {
  const res = await fetch(`${BASE}/api/corpus-chunks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ source_id: emailEntityId }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toMatch(/text/);
});

test('POST /api/corpus-chunks returns 422 when source entity does not exist', async () => {
  const res = await fetch(`${BASE}/api/corpus-chunks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ source_id: 'nonexistent-id', text: 'Hello world.' }),
  });
  expect(res.status).toBe(422);
});

// ---------------------------------------------------------------------------
// Blank text
// ---------------------------------------------------------------------------

test('POST /api/corpus-chunks with blank text returns empty chunk array', async () => {
  const res = await fetch(`${BASE}/api/corpus-chunks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ source_id: emailEntityId, text: '   ' }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(Array.isArray(body.chunks)).toBe(true);
  expect(body.chunks).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Chunk boundaries and source linkage
// ---------------------------------------------------------------------------

test('chunks a fixture email: boundary rules and source linkage', async () => {
  const fixtureText = [
    'The quick brown fox jumped over the lazy dog.',
    'This is a second sentence in the first paragraph.',
    'Here comes a third sentence for good measure.',
    'And one more sentence to round things off.',
  ].join(' ');

  const res = await fetch(`${BASE}/api/corpus-chunks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ source_id: emailEntityId, text: fixtureText, max_tokens: 32 }),
  });

  expect(res.status).toBe(201);
  const body = await res.json();
  const chunks = body.chunks as Array<{
    id: string;
    source_id: string;
    index: number;
    token_count: number;
  }>;

  // At least one chunk must be produced
  expect(chunks.length).toBeGreaterThan(0);

  // All chunks must point to the source entity
  for (const chunk of chunks) {
    expect(chunk.source_id).toBe(emailEntityId);
    expect(typeof chunk.id).toBe('string');
    expect(chunk.id.length).toBeGreaterThan(0);
  }

  // Chunks must be ordered by index starting at 0
  for (let i = 0; i < chunks.length; i++) {
    expect(chunks[i].index).toBe(i);
  }

  // Each chunk must be within the ceiling
  for (const chunk of chunks) {
    expect(chunk.token_count).toBeLessThanOrEqual(32);
    expect(chunk.token_count).toBeGreaterThan(0);
  }
});

// ---------------------------------------------------------------------------
// Max-tokens ceiling — long email
// ---------------------------------------------------------------------------

test('chunks a long email: every chunk is under the ceiling', async () => {
  // Build a text that is long enough to force multiple chunks at max_tokens=20
  const sentences: string[] = [];
  for (let i = 0; i < 40; i++) {
    sentences.push(`This is sentence number ${i + 1} in the long fixture email body.`);
  }
  const longText = sentences.join(' ');

  const maxTokens = 20;

  const res = await fetch(`${BASE}/api/corpus-chunks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ source_id: emailEntityId, text: longText, max_tokens: maxTokens }),
  });

  expect(res.status).toBe(201);
  const body = await res.json();
  const chunks = body.chunks as Array<{
    id: string;
    source_id: string;
    index: number;
    token_count: number;
  }>;

  expect(chunks.length).toBeGreaterThan(1);

  // No chunk may exceed the ceiling
  for (const chunk of chunks) {
    expect(chunk.token_count).toBeLessThanOrEqual(maxTokens);
    expect(chunk.token_count).toBeGreaterThan(0);
    expect(chunk.source_id).toBe(emailEntityId);
  }

  // Indices are contiguous from 0
  for (let i = 0; i < chunks.length; i++) {
    expect(chunks[i].index).toBe(i);
  }
});

// ---------------------------------------------------------------------------
// Bearer API key (ingestion token)
// ---------------------------------------------------------------------------

test('POST /api/corpus-chunks accepts a Bearer API key', async () => {
  const res = await fetch(`${BASE}/api/corpus-chunks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKeyRaw}`,
    },
    body: JSON.stringify({
      source_id: emailEntityId,
      text: 'Ingested via API key. This confirms machine-to-machine ingestion works.',
    }),
  });

  expect(res.status).toBe(201);
  const body = await res.json();
  expect(Array.isArray(body.chunks)).toBe(true);
  expect(body.chunks.length).toBeGreaterThan(0);

  // Source linkage is preserved
  for (const chunk of body.chunks as Array<{ source_id: string }>) {
    expect(chunk.source_id).toBe(emailEntityId);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/api/auth/me`);
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}
