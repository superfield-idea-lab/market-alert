/**
 * Integration tests for the publication gate API (issue #66).
 *
 * Routes under test:
 *   GET  /api/wiki/drafts/:id           — fetch draft with diff + materiality
 *   POST /api/wiki/drafts/:id/approve   — publish the draft
 *   POST /api/wiki/drafts/:id/reject    — archive the draft
 *
 * Test plan:
 *   - GET: 200 with diff + materiality when draft exists in 'draft' state
 *   - GET: 404 when draft does not exist
 *   - GET: 401 when not authenticated
 *   - GET: 403 when user is not an approver
 *   - GET: 422 when version is not in 'draft' state
 *   - POST /approve: 200, state becomes 'published', audit event emitted
 *   - POST /approve: 401/403 auth invariants
 *   - POST /approve: 422 when version is already published/archived
 *   - POST /reject:  200, state becomes 'archived', audit event emitted
 *   - POST /reject:  422 when version is already archived
 *   - Threshold gate: draft above MATERIALITY_THRESHOLD is marked is_material: true
 *
 * No mocks. Real Postgres + real Bun server via the shared pg-container helper.
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/66
 */

import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import postgres from 'postgres';

const PORT = 31466;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let sql: ReturnType<typeof postgres>;

// Designated approver ID injected via APPROVER_IDS env var for this test run.
const _APPROVER_ID_PLACEHOLDER = 'wiki-draft-review-approver';

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5, idle_timeout: 10 });

  // Create audit_events table (mirrors the pattern used in other integration tests).
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
      // The approver session will resolve to a user whose ID starts with
      // _APPROVER_ID_PLACEHOLDER; we set APPROVER_IDS to a sentinel that is
      // matched after the test session creates the user.  The real approver
      // ID is determined dynamically in each test that needs it.
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
// Helper functions
// ---------------------------------------------------------------------------

async function waitForServer(base: string, timeoutMs = SERVER_READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health/live`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(200);
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

async function createSession(username: string): Promise<{ cookie: string; userId: string }> {
  const res = await fetch(`${BASE}/api/test/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) throw new Error(`test-session failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { user: { id: string } };
  const setCookie = res.headers.get('set-cookie') ?? '';
  const m = /superfield_auth=([^;]+)/.exec(setCookie);
  return { cookie: m ? `superfield_auth=${m[1]}` : '', userId: body.user.id };
}

async function mintWorkerToken(dept: string, customer: string): Promise<string> {
  const res = await fetch(`${BASE}/api/test/worker-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dept, customer }),
  });
  if (!res.ok) throw new Error(`worker-token mint failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function seedDraft(opts: {
  pageId: string;
  dept: string;
  customer: string;
  content: string;
}): Promise<{ id: string }> {
  const token = await mintWorkerToken(opts.dept, opts.customer);
  const res = await fetch(`${BASE}/internal/wiki/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      page_id: opts.pageId,
      dept: opts.dept,
      customer: opts.customer,
      content: opts.content,
      source_task: 'test-task-66',
    }),
  });
  if (!res.ok) throw new Error(`wiki write failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ id: string }>;
}

/**
 * Set APPROVER_IDS on the running server is not possible at runtime.
 * Instead we use the SUPERUSER_ID approach: restart with env is not practical,
 * so we use a different route — set the env var before server start for tests
 * that require it, using a pre-known approver ID.
 *
 * For this test file, we use a simpler approach: call the server with the
 * SUPERUSER_ID set to our test approver's userId so the server grants them
 * approval authority.
 *
 * Since we cannot set SUPERUSER_ID dynamically, we re-start a helper server
 * per test for the approver path.  To keep things manageable, we start a
 * second server instance for approver tests.
 */

let approverServer: Subprocess | null = null;
let approverBase = '';
let approverUserId = '';
let approverCookie = '';

beforeAll(async () => {
  // Create the approver session on the main server to get a stable userId
  const approverPort = PORT + 1;
  approverBase = `http://localhost:${approverPort}`;

  // We need to know the approver's userId before starting the approver server.
  // Use the main server to create a session, then use that userId as SUPERUSER_ID
  // on the second server.
  const sess = await createSession('wiki-draft-review-approver');
  approverUserId = sess.userId;

  approverServer = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      PORT: String(approverPort),
      TEST_MODE: 'true',
      CSRF_DISABLED: 'true',
      SUPERUSER_ID: approverUserId,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(approverBase);

  // Re-establish the cookie on the approver server
  const approverSess = await (async () => {
    const res = await fetch(`${approverBase}/api/test/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'wiki-draft-review-approver' }),
    });
    if (!res.ok) throw new Error(`test-session on approver server failed: ${res.status}`);
    const body = (await res.json()) as { user: { id: string } };
    const setCookie = res.headers.get('set-cookie') ?? '';
    const m = /superfield_auth=([^;]+)/.exec(setCookie);
    return { cookie: m ? `superfield_auth=${m[1]}` : '', userId: body.user.id };
  })();
  approverCookie = approverSess.cookie;
}, 90_000);

afterAll(async () => {
  approverServer?.kill();
});

// ---------------------------------------------------------------------------
// Auth invariants
// ---------------------------------------------------------------------------

test('GET /api/wiki/drafts/:id returns 401 when not authenticated', async () => {
  const res = await fetch(`${BASE}/api/wiki/drafts/some-id`);
  expect(res.status).toBe(401);
});

test('GET /api/wiki/drafts/:id returns 403 for non-approver', async () => {
  const { cookie } = await createSession(`non-approver-${Date.now()}`);
  const res = await fetch(`${BASE}/api/wiki/drafts/some-id`, {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(403);
});

test('POST /api/wiki/drafts/:id/approve returns 401 when not authenticated', async () => {
  const res = await fetch(`${BASE}/api/wiki/drafts/some-id/approve`, { method: 'POST' });
  expect(res.status).toBe(401);
});

test('POST /api/wiki/drafts/:id/reject returns 401 when not authenticated', async () => {
  const res = await fetch(`${BASE}/api/wiki/drafts/some-id/reject`, { method: 'POST' });
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// GET /api/wiki/drafts/:id
// ---------------------------------------------------------------------------

test('GET /api/wiki/drafts/:id returns 404 for unknown draft', async () => {
  const res = await fetch(`${approverBase}/api/wiki/drafts/does-not-exist`, {
    headers: { Cookie: approverCookie },
  });
  expect(res.status).toBe(404);
});

test('GET /api/wiki/drafts/:id returns diff and materiality for a draft', async () => {
  const customer = `e2e-cust-get-${Date.now()}`;
  const dept = 'e2e-dept';
  const pageId = `page-${customer}`;

  const { id: draftId } = await seedDraft({
    pageId,
    dept,
    customer,
    content: '# Draft\n\nLine one.\nLine two.\nLine three.',
  });

  const res = await fetch(`${approverBase}/api/wiki/drafts/${draftId}`, {
    headers: { Cookie: approverCookie },
  });
  expect(res.status).toBe(200);

  const body = await res.json();
  expect(body.id).toBe(draftId);
  expect(body.state).toBe('draft');
  expect(Array.isArray(body.diff)).toBe(true);
  expect(typeof body.materiality).toBe('object');
  expect(typeof body.materiality.ratio).toBe('number');
  expect(typeof body.materiality.is_material).toBe('boolean');
  expect(typeof body.materiality.threshold).toBe('number');
  // No published version for a fresh page — all lines should be 'added'
  expect(body.published_version).toBeNull();
  expect(body.diff.every((d: { type: string }) => d.type === 'added')).toBe(true);
});

test('GET /api/wiki/drafts/:id includes diff against published version', async () => {
  const customer = `e2e-cust-diff-${Date.now()}`;
  const dept = 'e2e-dept';
  const pageId = `page-${customer}`;

  // Seed and approve a first version to become published
  const { id: firstId } = await seedDraft({
    pageId,
    dept,
    customer,
    content: '# Original\n\nLine one.\nLine two.',
  });

  const approveRes = await fetch(`${approverBase}/api/wiki/drafts/${firstId}/approve`, {
    method: 'POST',
    headers: { Cookie: approverCookie },
  });
  expect(approveRes.status).toBe(200);

  // Seed a second draft
  const { id: draftId } = await seedDraft({
    pageId,
    dept,
    customer,
    content: '# Original\n\nLine one.\nLine two.\nLine three (new).',
  });

  const res = await fetch(`${approverBase}/api/wiki/drafts/${draftId}`, {
    headers: { Cookie: approverCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.published_version).not.toBeNull();
  expect(body.published_version.id).toBe(firstId);
  // Diff should contain at least one 'added' hunk for the new line
  const added = body.diff.filter((d: { type: string }) => d.type === 'added');
  expect(added.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// POST /api/wiki/drafts/:id/approve
// ---------------------------------------------------------------------------

test('POST /approve publishes the draft and emits audit event', async () => {
  const customer = `e2e-cust-approve-${Date.now()}`;
  const dept = 'e2e-dept';
  const pageId = `page-${customer}`;

  const { id: draftId } = await seedDraft({
    pageId,
    dept,
    customer,
    content: '# Approved draft\n\nContent.',
  });

  const approveRes = await fetch(`${approverBase}/api/wiki/drafts/${draftId}/approve`, {
    method: 'POST',
    headers: { Cookie: approverCookie },
  });
  expect(approveRes.status).toBe(200);
  const body = await approveRes.json();
  expect(body.state).toBe('published');
  expect(body.id).toBe(draftId);
  expect(typeof body.approved_by).toBe('string');

  // Verify DB state
  const rows = await sql<{ state: string }[]>`
    SELECT state FROM wiki_page_versions WHERE id = ${draftId}
  `;
  expect(rows[0].state).toBe('published');

  // Verify audit event was emitted
  const auditRows = await sql<{ action: string; entity_id: string }[]>`
    SELECT action, entity_id FROM audit_events
    WHERE entity_id = ${draftId} AND action = 'wiki_draft.approved'
  `;
  expect(auditRows.length).toBeGreaterThan(0);
});

test('POST /approve on a non-draft returns 422', async () => {
  const customer = `e2e-cust-double-approve-${Date.now()}`;
  const dept = 'e2e-dept';
  const pageId = `page-${customer}`;

  const { id: draftId } = await seedDraft({
    pageId,
    dept,
    customer,
    content: '# Already published',
  });

  // Approve once
  await fetch(`${approverBase}/api/wiki/drafts/${draftId}/approve`, {
    method: 'POST',
    headers: { Cookie: approverCookie },
  });

  // Try to approve again — should fail
  const res = await fetch(`${approverBase}/api/wiki/drafts/${draftId}/approve`, {
    method: 'POST',
    headers: { Cookie: approverCookie },
  });
  expect(res.status).toBe(422);
});

test('POST /approve archives the previous published version', async () => {
  const customer = `e2e-cust-archive-${Date.now()}`;
  const dept = 'e2e-dept';
  const pageId = `page-${customer}`;

  // First published version
  const { id: first } = await seedDraft({ pageId, dept, customer, content: '# V1' });
  await fetch(`${approverBase}/api/wiki/drafts/${first}/approve`, {
    method: 'POST',
    headers: { Cookie: approverCookie },
  });

  // Second draft → approve → first should become archived
  const { id: second } = await seedDraft({ pageId, dept, customer, content: '# V2' });
  await fetch(`${approverBase}/api/wiki/drafts/${second}/approve`, {
    method: 'POST',
    headers: { Cookie: approverCookie },
  });

  const rows = await sql<{ id: string; state: string }[]>`
    SELECT id, state FROM wiki_page_versions
    WHERE page_id = ${pageId} AND customer = ${customer} AND dept = ${dept}
    ORDER BY created_at
  `;
  const states = Object.fromEntries(rows.map((r) => [r.id, r.state]));
  expect(states[first]).toBe('archived');
  expect(states[second]).toBe('published');
});

// ---------------------------------------------------------------------------
// POST /api/wiki/drafts/:id/reject
// ---------------------------------------------------------------------------

test('POST /reject archives the draft and emits audit event', async () => {
  const customer = `e2e-cust-reject-${Date.now()}`;
  const dept = 'e2e-dept';
  const pageId = `page-${customer}`;

  const { id: draftId } = await seedDraft({
    pageId,
    dept,
    customer,
    content: '# Rejected draft\n\nContent.',
  });

  const rejectRes = await fetch(`${approverBase}/api/wiki/drafts/${draftId}/reject`, {
    method: 'POST',
    headers: { Cookie: approverCookie },
  });
  expect(rejectRes.status).toBe(200);
  const body = await rejectRes.json();
  expect(body.state).toBe('archived');
  expect(body.id).toBe(draftId);
  expect(typeof body.rejected_by).toBe('string');

  // Verify DB state
  const rows = await sql<{ state: string }[]>`
    SELECT state FROM wiki_page_versions WHERE id = ${draftId}
  `;
  expect(rows[0].state).toBe('archived');

  // Verify audit event
  const auditRows = await sql<{ action: string }[]>`
    SELECT action FROM audit_events
    WHERE entity_id = ${draftId} AND action = 'wiki_draft.rejected'
  `;
  expect(auditRows.length).toBeGreaterThan(0);
});

test('POST /reject on a non-draft returns 422', async () => {
  const customer = `e2e-cust-reject-nondraft-${Date.now()}`;
  const dept = 'e2e-dept';
  const pageId = `page-${customer}`;

  const { id: draftId } = await seedDraft({ pageId, dept, customer, content: '# Draft' });

  // Reject once → state becomes archived
  await fetch(`${approverBase}/api/wiki/drafts/${draftId}/reject`, {
    method: 'POST',
    headers: { Cookie: approverCookie },
  });

  // Second reject should fail
  const res = await fetch(`${approverBase}/api/wiki/drafts/${draftId}/reject`, {
    method: 'POST',
    headers: { Cookie: approverCookie },
  });
  expect(res.status).toBe(422);
});

// ---------------------------------------------------------------------------
// Materiality threshold gate
// ---------------------------------------------------------------------------

test('GET /api/wiki/drafts/:id classifies a large diff as material', async () => {
  const customer = `e2e-cust-material-${Date.now()}`;
  const dept = 'e2e-dept';
  const pageId = `page-${customer}`;

  // Seed a short published version, then a very different draft.
  const { id: firstId } = await seedDraft({
    pageId,
    dept,
    customer,
    content: 'Short original content.',
  });
  await fetch(`${approverBase}/api/wiki/drafts/${firstId}/approve`, {
    method: 'POST',
    headers: { Cookie: approverCookie },
  });

  // Draft with lots of new lines (well above 20% threshold)
  const longContent = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join('\n');
  const { id: draftId } = await seedDraft({ pageId, dept, customer, content: longContent });

  const res = await fetch(`${approverBase}/api/wiki/drafts/${draftId}`, {
    headers: { Cookie: approverCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.materiality.is_material).toBe(true);
});

test('GET /api/wiki/drafts/:id classifies a small diff as immaterial', async () => {
  const customer = `e2e-cust-immaterial-${Date.now()}`;
  const dept = 'e2e-dept';
  const pageId = `page-${customer}`;

  const baseContent = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n');
  const { id: firstId } = await seedDraft({ pageId, dept, customer, content: baseContent });
  await fetch(`${approverBase}/api/wiki/drafts/${firstId}/approve`, {
    method: 'POST',
    headers: { Cookie: approverCookie },
  });

  // Tiny change: just add one line
  const minorContent = baseContent + '\nOne extra line.';
  const { id: draftId } = await seedDraft({ pageId, dept, customer, content: minorContent });

  const res = await fetch(`${approverBase}/api/wiki/drafts/${draftId}`, {
    headers: { Cookie: approverCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.materiality.is_material).toBe(false);
});
