/**
 * @file annotation-audit-events.test.ts
 *
 * Integration tests for issue #69 — audit events across annotation and
 * publication-gate flows.
 *
 * ## Test plan
 *
 * TP-1  annotation create → reply → accept emits three audit events:
 *         annotation.opened, annotation.reply, annotation.accepted
 *       Each event must include actor_id, entity_type, entity_id, and the
 *       before/after state transition.
 *
 * TP-2  annotation create → reply → reject emits two annotation audit events
 *       plus one rejection event: annotation.opened, annotation.reply,
 *       annotation.rejected.
 *
 * TP-3  publication-gate approve emits wiki_draft.approved with actor, target,
 *       and state transition in the append-only audit store.
 *
 * TP-4  publication-gate reject emits wiki_draft.rejected with actor, target,
 *       and state transition in the append-only audit store.
 *
 * No mocks — real Postgres, real Bun server, real node:http fixture server for
 * the Anthropic API.
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/69
 */

import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { createServer, type Server as HttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31469;
const FIXTURE_PORT = 31470;
const APPROVER_PORT = 31471;
const BASE = `http://localhost:${PORT}`;
const APPROVER_BASE = `http://localhost:${APPROVER_PORT}`;
const SERVER_READY_TIMEOUT_MS = 30_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';
const FIXTURE_PATH = join(
  REPO_ROOT,
  'tests/fixtures/anthropic/annotation-reply_2026-04-12T00-00-00-000Z.json',
);

let pg: PgContainer;
let adminSql: ReturnType<typeof postgres>;
let server: Subprocess;
let approverServer: Subprocess;
let fixtureServer: HttpServer;
let authCookie = '';
let csrfToken = '';
let approverCookie = '';
let approverUserId = '';

// ---------------------------------------------------------------------------
// Fixture server — real node:http server replaying the Anthropic API fixture
// ---------------------------------------------------------------------------

function startFixtureServer(port: number): HttpServer {
  const raw = readFileSync(FIXTURE_PATH, 'utf-8');
  const fixture = JSON.parse(raw) as {
    response: { status: number; headers: Record<string, string>; body: unknown };
  };

  const httpServer = createServer((_req, res) => {
    const responseBody = JSON.stringify(fixture.response.body);
    res.writeHead(fixture.response.status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(responseBody),
    });
    res.end(responseBody);
  });

  httpServer.listen(port);
  return httpServer;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pg = await startPostgres();

  // Create audit_events table (same schema as production init-remote.ts).
  adminSql = postgres(pg.url, { max: 5, idle_timeout: 10 });
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

  // Start the fixture server that replays the Anthropic API response.
  fixtureServer = startFixtureServer(FIXTURE_PORT);

  // Start the main app server.
  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      PORT: String(PORT),
      TEST_MODE: 'true',
      CSRF_DISABLED: 'true',
      ANTHROPIC_BASE_URL: `http://localhost:${FIXTURE_PORT}`,
      ANTHROPIC_API_KEY: 'test-placeholder-key',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);

  const session = await createTestSession(BASE);
  authCookie = session.cookie;
  csrfToken = session.csrfToken;

  // Create an approver session: first get the userId, then start an approver
  // server with SUPERUSER_ID set so approval authority is granted.
  const approverSess = await createTestSession(BASE, { username: `approver-audit-69` });
  approverUserId = approverSess.userId;

  approverServer = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      PORT: String(APPROVER_PORT),
      TEST_MODE: 'true',
      CSRF_DISABLED: 'true',
      ANTHROPIC_BASE_URL: `http://localhost:${FIXTURE_PORT}`,
      ANTHROPIC_API_KEY: 'test-placeholder-key',
      SUPERUSER_ID: approverUserId,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(APPROVER_BASE);

  // Establish session on the approver server.
  const approverSess2 = await createTestSession(APPROVER_BASE, {
    username: `approver-audit-69`,
  });
  approverCookie = approverSess2.cookie;
}, 120_000);

afterAll(async () => {
  server?.kill();
  approverServer?.kill();
  await adminSql?.end();
  await pg?.stop();
  await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
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

async function openAnnotation(base: string, cookie: string, csrf: string): Promise<{ id: string }> {
  const res = await fetch(`${base}/api/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf },
    body: JSON.stringify({
      wiki_page_version_id: `version-audit-test-${Date.now()}`,
      passage_ref: 'The fund was established in 2018.',
      comment: 'I believe this should be 2019.',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`openAnnotation failed ${res.status}: ${text}`);
  }
  return res.json() as Promise<{ id: string }>;
}

async function mintWorkerToken(base: string, dept: string, customer: string): Promise<string> {
  const res = await fetch(`${base}/api/test/worker-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dept, customer }),
  });
  if (!res.ok) throw new Error(`worker-token mint failed: ${res.status}`);
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function seedDraft(opts: {
  pageId: string;
  dept: string;
  customer: string;
  content: string;
}): Promise<{ id: string }> {
  const token = await mintWorkerToken(APPROVER_BASE, opts.dept, opts.customer);
  const res = await fetch(`${APPROVER_BASE}/internal/wiki/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      page_id: opts.pageId,
      dept: opts.dept,
      customer: opts.customer,
      content: opts.content,
      source_task: 'test-task-69',
    }),
  });
  if (!res.ok) throw new Error(`wiki write failed: ${res.status}`);
  return res.json() as Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// TP-1 — annotation create → reply → accept: three audit events
// ---------------------------------------------------------------------------

test('TP-1: annotation.opened, annotation.reply, and annotation.accepted land in audit store', async () => {
  const { id: annotationId } = await openAnnotation(BASE, authCookie, csrfToken);

  // Verify annotation.opened was emitted.
  const openedRows = await adminSql<
    { action: string; entity_id: string; after: Record<string, unknown> }[]
  >`
    SELECT action, entity_id, after
    FROM audit_events
    WHERE entity_id = ${annotationId} AND action = 'annotation.opened'
  `;
  expect(openedRows.length).toBe(1);
  expect(openedRows[0].entity_id).toBe(annotationId);
  expect(openedRows[0].after).toBeTruthy();

  // Verify annotation.reply was emitted.
  const replyRows = await adminSql<
    { action: string; entity_id: string; after: Record<string, unknown> }[]
  >`
    SELECT action, entity_id, after
    FROM audit_events
    WHERE entity_id = ${annotationId} AND action = 'annotation.reply'
  `;
  expect(replyRows.length).toBe(1);
  expect(replyRows[0].entity_id).toBe(annotationId);
  expect(replyRows[0].after).toBeTruthy();

  // Accept the annotation.
  const acceptRes = await fetch(`${BASE}/api/annotations/${annotationId}/accept`, {
    method: 'POST',
    headers: { Cookie: authCookie, 'X-CSRF-Token': csrfToken },
  });
  expect(acceptRes.status).toBe(200);

  // Verify annotation.accepted was emitted.
  const acceptedRows = await adminSql<
    {
      action: string;
      entity_id: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      actor_id: string;
    }[]
  >`
    SELECT action, entity_id, before, after, actor_id
    FROM audit_events
    WHERE entity_id = ${annotationId} AND action = 'annotation.accepted'
  `;
  expect(acceptedRows.length).toBe(1);
  const accepted = acceptedRows[0];
  expect(accepted.entity_id).toBe(annotationId);
  // before must carry the prior state
  expect(accepted.before).toMatchObject({ state: 'AGENT_REPLIED' });
  // after must carry the new state
  expect(accepted.after).toMatchObject({ state: 'ACCEPTED' });
  // actor must be set
  expect(typeof accepted.actor_id).toBe('string');
  expect(accepted.actor_id.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// TP-2 — annotation create → reply → reject: annotation.rejected in audit store
// ---------------------------------------------------------------------------

test('TP-2: annotation.rejected lands in audit store with actor, target, and transition', async () => {
  const { id: annotationId } = await openAnnotation(BASE, authCookie, csrfToken);

  // Reject the annotation.
  const rejectRes = await fetch(`${BASE}/api/annotations/${annotationId}/reject`, {
    method: 'POST',
    headers: { Cookie: authCookie, 'X-CSRF-Token': csrfToken },
  });
  expect(rejectRes.status).toBe(200);

  // Verify annotation.rejected was emitted with full actor/target/transition.
  const rows = await adminSql<
    {
      action: string;
      entity_id: string;
      entity_type: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      actor_id: string;
    }[]
  >`
    SELECT action, entity_id, entity_type, before, after, actor_id
    FROM audit_events
    WHERE entity_id = ${annotationId} AND action = 'annotation.rejected'
  `;
  expect(rows.length).toBe(1);
  const row = rows[0];
  // target (entity)
  expect(row.entity_id).toBe(annotationId);
  expect(row.entity_type).toBe('wiki_annotation');
  // transition
  expect(row.before).toMatchObject({ state: 'AGENT_REPLIED' });
  expect(row.after).toMatchObject({ state: 'REJECTED' });
  // actor
  expect(typeof row.actor_id).toBe('string');
  expect(row.actor_id.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// TP-3 — publication-gate approve emits wiki_draft.approved in audit store
// ---------------------------------------------------------------------------

test('TP-3: wiki_draft.approved lands in audit store with actor, target, and transition', async () => {
  const customer = `audit-69-approve-${Date.now()}`;
  const dept = 'e2e-dept';
  const pageId = `page-${customer}`;

  const { id: draftId } = await seedDraft({
    pageId,
    dept,
    customer,
    content: '# Test publication gate\n\nSome content.',
  });

  const approveRes = await fetch(`${APPROVER_BASE}/api/wiki/drafts/${draftId}/approve`, {
    method: 'POST',
    headers: { Cookie: approverCookie },
  });
  expect(approveRes.status).toBe(200);

  // Verify wiki_draft.approved was emitted with full actor/target/transition.
  const rows = await adminSql<
    {
      action: string;
      entity_id: string;
      entity_type: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      actor_id: string;
    }[]
  >`
    SELECT action, entity_id, entity_type, before, after, actor_id
    FROM audit_events
    WHERE entity_id = ${draftId} AND action = 'wiki_draft.approved'
  `;
  expect(rows.length).toBe(1);
  const row = rows[0];
  // target
  expect(row.entity_id).toBe(draftId);
  expect(row.entity_type).toBe('wiki_page_version');
  // transition
  expect(row.before).toMatchObject({ state: 'draft' });
  expect(row.after).toMatchObject({ state: 'published' });
  // actor
  expect(typeof row.actor_id).toBe('string');
  expect(row.actor_id.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// TP-4 — publication-gate reject emits wiki_draft.rejected in audit store
// ---------------------------------------------------------------------------

test('TP-4: wiki_draft.rejected lands in audit store with actor, target, and transition', async () => {
  const customer = `audit-69-reject-${Date.now()}`;
  const dept = 'e2e-dept';
  const pageId = `page-${customer}`;

  const { id: draftId } = await seedDraft({
    pageId,
    dept,
    customer,
    content: '# Test publication gate reject\n\nSome content.',
  });

  const rejectRes = await fetch(`${APPROVER_BASE}/api/wiki/drafts/${draftId}/reject`, {
    method: 'POST',
    headers: { Cookie: approverCookie },
  });
  expect(rejectRes.status).toBe(200);

  // Verify wiki_draft.rejected was emitted with full actor/target/transition.
  const rows = await adminSql<
    {
      action: string;
      entity_id: string;
      entity_type: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      actor_id: string;
    }[]
  >`
    SELECT action, entity_id, entity_type, before, after, actor_id
    FROM audit_events
    WHERE entity_id = ${draftId} AND action = 'wiki_draft.rejected'
  `;
  expect(rows.length).toBe(1);
  const row = rows[0];
  // target
  expect(row.entity_id).toBe(draftId);
  expect(row.entity_type).toBe('wiki_page_version');
  // transition
  expect(row.before).toMatchObject({ state: 'draft' });
  expect(row.after).toMatchObject({ state: 'archived' });
  // actor
  expect(typeof row.actor_id).toBe('string');
  expect(row.actor_id.length).toBeGreaterThan(0);
});
