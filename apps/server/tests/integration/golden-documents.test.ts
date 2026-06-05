/**
 * @file golden-documents.test.ts
 *
 * Integration tests for the golden-document API routes (issue #73, #117).
 *
 * Routes under test:
 *   POST   /api/golden-documents            — researcher creates a golden document
 *   GET    /api/golden-documents            — researcher lists their documents
 *   GET    /api/golden-documents/:id        — researcher reads a document by id
 *   PATCH  /api/golden-documents/:id/state  — researcher changes document state
 *   POST   /api/golden-documents/:id/sections — researcher upserts a section
 *   GET    /api/golden-documents/:id/sections — researcher reads sections
 *   GET    /api/golden-documents/active/:kind — unified retrieval
 *
 * Test plan (AC coverage):
 *   AC1 — Researcher can author and revise golden documents:
 *     - POST returns 201 with the new document
 *     - PATCH /state activates then retires correctly
 *
 *   AC2 — No agent or worker path can write golden-doc rows:
 *     - POST with Bearer token returns 403
 *     - POST without auth returns 401
 *
 *   AC3 — Unified retrieval returns active doc + sections:
 *     - GET /active/:kind returns active document with sections
 *
 *   Issue #117 — RLS-enforced endpoint correctness:
 *     - GET /:id/sections returns 200 after configureGoldenDocumentsRls
 *     - POST /:id/sections returns 200 after configureGoldenDocumentsRls
 *     - PATCH /:id/state returns 200 after configureGoldenDocumentsRls
 *     - GET /:id returns 200 after configureGoldenDocumentsRls
 *
 * No mocks. Real Postgres + real Bun server.
 */

import { test, describe, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';
import { configureGoldenDocumentsRls, makePool } from '../../../../packages/db/init-remote';

const PORT = 31473;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let authCookie = '';
let userId = '';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pg = await startPostgres();

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

  const session = await createTestSession(BASE, { username: 'researcher-alice' });
  authCookie = session.cookie;
  userId = session.userId;
}, 60_000);

afterAll(async () => {
  server?.kill();
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// AC2: Auth enforcement
// ---------------------------------------------------------------------------

test('POST /api/golden-documents with Bearer token returns 403', async () => {
  const res = await fetch(`${BASE}/api/golden-documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer fake-worker-token',
    },
    body: JSON.stringify({ kind: 'industry_definition', title: 'Test' }),
  });
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error).toMatch(/forbidden|worker/i);
});

test('POST /api/golden-documents without auth returns 401', async () => {
  const res = await fetch(`${BASE}/api/golden-documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'industry_definition', title: 'Test' }),
  });
  expect(res.status).toBe(401);
});

test('GET /api/golden-documents without auth returns 401', async () => {
  const res = await fetch(`${BASE}/api/golden-documents`);
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// AC1: Researcher write path
// ---------------------------------------------------------------------------

test('POST /api/golden-documents returns 201 with a new document', async () => {
  const res = await fetch(`${BASE}/api/golden-documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: authCookie,
    },
    body: JSON.stringify({
      kind: 'industry_definition',
      title: 'My Industry Definition',
    }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.document).toBeDefined();
  expect(body.document.kind).toBe('industry_definition');
  expect(body.document.title).toBe('My Industry Definition');
  expect(body.document.state).toBe('authored');
  expect(body.document.author_id).toBe(userId);
});

test('POST /api/golden-documents with invalid kind returns 400', async () => {
  const res = await fetch(`${BASE}/api/golden-documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: authCookie,
    },
    body: JSON.stringify({ kind: 'invalid_kind', title: 'Test' }),
  });
  expect(res.status).toBe(400);
});

test('GET /api/golden-documents lists researcher documents', async () => {
  // Create a doc first.
  await fetch(`${BASE}/api/golden-documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ kind: 'research_methodology', title: 'My Methodology' }),
  });

  const res = await fetch(`${BASE}/api/golden-documents`, {
    headers: { Cookie: authCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.documents).toBeDefined();
  expect(Array.isArray(body.documents)).toBe(true);
  expect(body.documents.length).toBeGreaterThan(0);
});

test('GET /api/golden-documents/:id returns the document', async () => {
  // Create a document.
  const createRes = await fetch(`${BASE}/api/golden-documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ kind: 'industry_definition', title: 'For Fetch Test' }),
  });
  const created = await createRes.json();
  const docId = created.document.id;

  const res = await fetch(`${BASE}/api/golden-documents/${docId}`, {
    headers: { Cookie: authCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.document.id).toBe(docId);
  expect(body.document.title).toBe('For Fetch Test');
});

test('GET /api/golden-documents/:id returns 404 for unknown id', async () => {
  const res = await fetch(`${BASE}/api/golden-documents/nonexistent-id-00000`, {
    headers: { Cookie: authCookie },
  });
  expect(res.status).toBe(404);
});

// ---------------------------------------------------------------------------
// AC1: Revision lifecycle
// ---------------------------------------------------------------------------

test('PATCH /api/golden-documents/:id/state activates document and retires previous', async () => {
  // Create two industry_definition docs.
  const doc1Res = await fetch(`${BASE}/api/golden-documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ kind: 'industry_definition', title: 'Industry Def v1' }),
  });
  const doc1 = (await doc1Res.json()).document;

  const doc2Res = await fetch(`${BASE}/api/golden-documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ kind: 'industry_definition', title: 'Industry Def v2' }),
  });
  const doc2 = (await doc2Res.json()).document;

  // Activate doc1.
  const activate1 = await fetch(`${BASE}/api/golden-documents/${doc1.id}/state`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ state: 'active' }),
  });
  expect(activate1.status).toBe(200);

  // Activate doc2 — doc1 should be retired.
  const activate2 = await fetch(`${BASE}/api/golden-documents/${doc2.id}/state`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ state: 'active' }),
  });
  expect(activate2.status).toBe(200);
  const activated = await activate2.json();
  expect(activated.document.state).toBe('active');
  expect(activated.document.id).toBe(doc2.id);

  // Check doc1 is retired.
  const doc1Fetch = await fetch(`${BASE}/api/golden-documents/${doc1.id}`, {
    headers: { Cookie: authCookie },
  });
  const doc1Body = await doc1Fetch.json();
  expect(doc1Body.document.state).toBe('retired');
});

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

test('POST + GET /api/golden-documents/:id/sections round-trip', async () => {
  // Create a doc.
  const docRes = await fetch(`${BASE}/api/golden-documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ kind: 'research_methodology', title: 'Sectioned Doc' }),
  });
  const doc = (await docRes.json()).document;

  // Upsert a section.
  const sectionRes = await fetch(`${BASE}/api/golden-documents/${doc.id}/sections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({
      section_key: 'step_1',
      content: '# Step 1: Data collection...',
      position: 0,
    }),
  });
  expect(sectionRes.status).toBe(200);
  const sectionBody = await sectionRes.json();
  expect(sectionBody.section.section_key).toBe('step_1');

  // List sections.
  const listRes = await fetch(`${BASE}/api/golden-documents/${doc.id}/sections`, {
    headers: { Cookie: authCookie },
  });
  expect(listRes.status).toBe(200);
  const listBody = await listRes.json();
  expect(listBody.sections.length).toBeGreaterThan(0);
  expect(listBody.sections[0].section_key).toBe('step_1');
});

// ---------------------------------------------------------------------------
// AC3: Unified retrieval
// ---------------------------------------------------------------------------

test('GET /api/golden-documents/active/:kind returns active doc with sections', async () => {
  // Create, add section, then activate.
  const docRes = await fetch(`${BASE}/api/golden-documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ kind: 'research_methodology', title: 'Active Methodology' }),
  });
  const doc = (await docRes.json()).document;
  const tenantId = doc.tenant_id;

  // Add a section.
  await fetch(`${BASE}/api/golden-documents/${doc.id}/sections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ section_key: 'approach', content: '# Approach', position: 0 }),
  });

  // Activate.
  await fetch(`${BASE}/api/golden-documents/${doc.id}/state`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ state: 'active' }),
  });

  // Unified retrieval.
  const res = await fetch(
    `${BASE}/api/golden-documents/active/research_methodology?tenant_id=${tenantId}`,
    { headers: { Cookie: authCookie } },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.document).not.toBeNull();
  expect(body.document.state).toBe('active');
  expect(body.sections.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Issue #117: RLS-enforced endpoint correctness
//
// Apply configureGoldenDocumentsRls against the same test Postgres container
// before exercising the section and state endpoints. This verifies that the
// bootstrap SELECT queries no longer use the raw pool (which would fail under
// FORCE ROW LEVEL SECURITY) and instead derive tenant_id from the entities
// table before wrapping golden_documents lookups in withRlsContext.
// ---------------------------------------------------------------------------

describe('golden-documents under RLS enforcement (issue #117)', () => {
  beforeAll(async () => {
    // Apply golden-documents RLS policies to the test Postgres container.
    // makePool opens a connection as the postgres superfield user which can
    // run ALTER TABLE ... FORCE ROW LEVEL SECURITY and CREATE POLICY.
    const adminPool = makePool(pg.url);
    try {
      await configureGoldenDocumentsRls(adminPool);
    } finally {
      await adminPool.end({ timeout: 5 });
    }
  });

  test('GET /api/golden-documents/:id returns 200 in RLS-enforced environment', async () => {
    // Create a document first.
    const createRes = await fetch(`${BASE}/api/golden-documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie },
      body: JSON.stringify({ kind: 'industry_definition', title: 'RLS Test Doc' }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    const docId = created.document.id;

    // GET /:id must succeed (not 404) after RLS is configured.
    const res = await fetch(`${BASE}/api/golden-documents/${docId}`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.document.id).toBe(docId);
  });

  test('GET /api/golden-documents/:id/sections returns 200 in RLS-enforced environment', async () => {
    // Create a document.
    const createRes = await fetch(`${BASE}/api/golden-documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie },
      body: JSON.stringify({ kind: 'research_methodology', title: 'RLS Sections Doc' }),
    });
    expect(createRes.status).toBe(201);
    const doc = (await createRes.json()).document;

    // GET /:id/sections must return 200 (not 404) after RLS is configured.
    const res = await fetch(`${BASE}/api/golden-documents/${doc.id}/sections`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sections)).toBe(true);
  });

  test('POST /api/golden-documents/:id/sections returns 200 in RLS-enforced environment', async () => {
    // Create a document.
    const createRes = await fetch(`${BASE}/api/golden-documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie },
      body: JSON.stringify({ kind: 'industry_definition', title: 'RLS Upsert Doc' }),
    });
    expect(createRes.status).toBe(201);
    const doc = (await createRes.json()).document;

    // POST /:id/sections must return 200 (not 404) after RLS is configured.
    const res = await fetch(`${BASE}/api/golden-documents/${doc.id}/sections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie },
      body: JSON.stringify({ section_key: 'intro', content: '# Introduction', position: 0 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.section.section_key).toBe('intro');
  });

  test('PATCH /api/golden-documents/:id/state returns 200 in RLS-enforced environment', async () => {
    // Create a document.
    const createRes = await fetch(`${BASE}/api/golden-documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie },
      body: JSON.stringify({ kind: 'research_methodology', title: 'RLS State Doc' }),
    });
    expect(createRes.status).toBe(201);
    const doc = (await createRes.json()).document;

    // PATCH /:id/state must return 200 (not 404) after RLS is configured.
    const res = await fetch(`${BASE}/api/golden-documents/${doc.id}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: authCookie },
      body: JSON.stringify({ state: 'active' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.document.state).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/health`);
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}
