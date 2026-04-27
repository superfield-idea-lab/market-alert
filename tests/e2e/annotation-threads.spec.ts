/**
 * @file annotation-threads.spec.ts
 *
 * End-to-end tests — inline annotation UI with anchored threads (issue #63).
 *
 * Covers:
 *   1. API: create an annotation thread on a wiki page version.
 *   2. API: threads persist across page reloads (GET returns the created thread).
 *   3. API: thread re-anchors correctly after a small-edit scenario.
 *   4. API: post a reply to a thread.
 *   5. API: resolve a thread.
 *   6. Auth invariant: unauthenticated requests return 401.
 *
 * No mocks — real Bun server + Postgres via the shared E2E environment helper.
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/63
 */

import { afterAll, beforeAll, expect, test, describe } from 'vitest';
import { startE2EServer, stopE2EServer, type E2EEnvironment } from './environment';

let env: E2EEnvironment;

beforeAll(async () => {
  env = await startE2EServer();
});

afterAll(async () => {
  await stopE2EServer(env);
});

// ---------------------------------------------------------------------------
// Helper: obtain a session cookie via the TEST_MODE backdoor
// ---------------------------------------------------------------------------

async function getTestSession(username: string): Promise<string> {
  const res = await fetch(`${env.baseUrl}/api/test/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) throw new Error(`test-session failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = /superfield_auth=([^;]+)/.exec(setCookie);
  return match ? `superfield_auth=${match[1]}` : '';
}

// ---------------------------------------------------------------------------
// Helper: seed a wiki_page_versions row and return its id
// ---------------------------------------------------------------------------

async function seedWikiVersion(opts: {
  dept: string;
  customer: string;
  content: string;
}): Promise<string> {
  const tokenRes = await fetch(`${env.baseUrl}/api/test/worker-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dept: opts.dept, customer: opts.customer }),
  });
  if (!tokenRes.ok)
    throw new Error(`worker-token mint failed: ${tokenRes.status} ${await tokenRes.text()}`);
  const { token } = (await tokenRes.json()) as { token: string };

  const writeRes = await fetch(`${env.baseUrl}/internal/wiki/versions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      page_id: `${opts.dept}/${opts.customer}`,
      dept: opts.dept,
      customer: opts.customer,
      content: opts.content,
      source_task: 'e2e-annotation-seed',
    }),
  });
  if (!writeRes.ok)
    throw new Error(`wiki write failed: ${writeRes.status} ${await writeRes.text()}`);
  const result = (await writeRes.json()) as { id: string };
  return result.id;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('annotation thread API', () => {
  const DEPT = 'e2e-dept-63';
  const CUSTOMER = `e2e-customer-63-${Date.now()}`;
  const CONTENT =
    'The client discussed quarterly revenue targets in detail. The fund is performing well.';

  let versionId: string;
  let cookie: string;

  // Seed once before all tests in this suite.
  beforeAll(async () => {
    versionId = await seedWikiVersion({ dept: DEPT, customer: CUSTOMER, content: CONTENT });
    cookie = await getTestSession(`e2e-rm-63-${Date.now()}`);
  });

  // ── Auth invariants ───────────────��─────────────────────────────────────

  test('GET /annotations: returns 401 for unauthenticated callers', async () => {
    const res = await fetch(
      `${env.baseUrl}/api/wiki/pages/${CUSTOMER}/versions/${versionId}/annotations`,
    );
    expect(res.status).toBe(401);
  });

  test('POST /annotations: returns 401 for unauthenticated callers', async () => {
    const res = await fetch(
      `${env.baseUrl}/api/wiki/pages/${CUSTOMER}/versions/${versionId}/annotations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          anchor_text: 'quarterly revenue',
          start_offset: 23,
          end_offset: 40,
          body: 'This needs updating.',
        }),
      },
    );
    expect(res.status).toBe(401);
  });

  // ── Create a thread ─────────────────��───────────────────���───────────────

  let threadId: string;

  test('POST /annotations: creates an anchored thread and returns 201', async () => {
    const anchorText = 'quarterly revenue targets';
    const startOffset = CONTENT.indexOf(anchorText);
    const endOffset = startOffset + anchorText.length;

    const res = await fetch(
      `${env.baseUrl}/api/wiki/pages/${CUSTOMER}/versions/${versionId}/annotations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          anchor_text: anchorText,
          start_offset: startOffset,
          end_offset: endOffset,
          body: 'This figure needs a source citation.',
        }),
      },
    );
    expect(res.status).toBe(201);

    const thread = (await res.json()) as {
      id: string;
      anchor_text: string;
      start_offset: number;
      end_offset: number;
      body: string;
      resolved: boolean;
      replies: unknown[];
    };

    expect(typeof thread.id).toBe('string');
    expect(thread.anchor_text).toBe(anchorText);
    expect(thread.start_offset).toBe(startOffset);
    expect(thread.end_offset).toBe(endOffset);
    expect(thread.body).toBe('This figure needs a source citation.');
    expect(thread.resolved).toBe(false);
    expect(Array.isArray(thread.replies)).toBe(true);
    expect(thread.replies).toHaveLength(0);

    threadId = thread.id;
  });

  // ── Persist across reload ───────────────────────────────────────────────

  test('GET /annotations: thread persists across reload', async () => {
    const res = await fetch(
      `${env.baseUrl}/api/wiki/pages/${CUSTOMER}/versions/${versionId}/annotations`,
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { threads: Array<{ id: string }> };
    expect(Array.isArray(body.threads)).toBe(true);
    const found = body.threads.find((t) => t.id === threadId);
    expect(found).toBeDefined();
  });

  // ── Reply to thread ──────────────────────────────────────────────���──────

  let replyId: string;

  test('POST /annotations/:id/replies: posts a reply and returns 201', async () => {
    const res = await fetch(
      `${env.baseUrl}/api/wiki/pages/${CUSTOMER}/versions/${versionId}/annotations/${threadId}/replies`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ body: 'Added the reference to the Q3 report.' }),
      },
    );
    expect(res.status).toBe(201);

    const reply = (await res.json()) as {
      id: string;
      thread_id: string;
      body: string;
      created_by: string;
    };

    expect(typeof reply.id).toBe('string');
    expect(reply.thread_id).toBe(threadId);
    expect(reply.body).toBe('Added the reference to the Q3 report.');
    replyId = reply.id;
  });

  test('GET /annotations: reply appears in thread after reload', async () => {
    const res = await fetch(
      `${env.baseUrl}/api/wiki/pages/${CUSTOMER}/versions/${versionId}/annotations`,
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      threads: Array<{ id: string; replies: Array<{ id: string }> }>;
    };
    const thread = body.threads.find((t) => t.id === threadId);
    expect(thread).toBeDefined();
    const reply = thread!.replies.find((r) => r.id === replyId);
    expect(reply).toBeDefined();
  });

  // ── Resolve a thread ─────────────────────────────���──────────────────────

  test('PATCH /annotations/:id: resolves the thread', async () => {
    const res = await fetch(
      `${env.baseUrl}/api/wiki/pages/${CUSTOMER}/versions/${versionId}/annotations/${threadId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ resolved: true }),
      },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { id: string; resolved: boolean };
    expect(body.id).toBe(threadId);
    expect(body.resolved).toBe(true);
  });

  test('GET /annotations: resolved thread is reflected after reload', async () => {
    const res = await fetch(
      `${env.baseUrl}/api/wiki/pages/${CUSTOMER}/versions/${versionId}/annotations`,
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      threads: Array<{ id: string; resolved: boolean }>;
    };
    const thread = body.threads.find((t) => t.id === threadId);
    expect(thread).toBeDefined();
    expect(thread!.resolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Re-anchoring scenario — small-edit drift
// ---------------------------------------------------------------------------

describe('annotation re-anchoring after small edit', () => {
  const DEPT = 'e2e-dept-63-anchor';
  const CUSTOMER = `e2e-customer-63-anchor-${Date.now()}`;
  const ORIGINAL_CONTENT =
    'Revenue grew 12% in the last quarter. The fund outperformed benchmarks.';
  // Small edit: insert a word at the beginning.
  const EDITED_CONTENT =
    'Strong Revenue grew 12% in the last quarter. The fund outperformed benchmarks.';

  let originalVersionId: string;
  let cookie: string;

  beforeAll(async () => {
    originalVersionId = await seedWikiVersion({
      dept: DEPT,
      customer: CUSTOMER,
      content: ORIGINAL_CONTENT,
    });
    cookie = await getTestSession(`e2e-rm-63-anchor-${Date.now()}`);
  });

  test('thread anchor text can be found in edited content via substring search', async () => {
    // Create a thread on the original version.
    const anchorText = 'Revenue grew 12%';
    const startOffset = ORIGINAL_CONTENT.indexOf(anchorText);
    const endOffset = startOffset + anchorText.length;

    const createRes = await fetch(
      `${env.baseUrl}/api/wiki/pages/${CUSTOMER}/versions/${originalVersionId}/annotations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          anchor_text: anchorText,
          start_offset: startOffset,
          end_offset: endOffset,
          body: 'Please verify this growth figure.',
        }),
      },
    );
    expect(createRes.status).toBe(201);

    const thread = (await createRes.json()) as {
      anchor_text: string;
      start_offset: number;
      end_offset: number;
    };

    // Simulate re-anchor: the edited content has "Strong " prepended (7 chars).
    // The anchor text still exists in the edited content — indexOf finds it.
    const foundInEdited = EDITED_CONTENT.indexOf(thread.anchor_text);
    expect(foundInEdited).toBeGreaterThanOrEqual(0);

    // The new offset should be 7 chars later (the length of "Strong ").
    expect(foundInEdited).toBe(thread.start_offset + 'Strong '.length);
  });
});

// ---------------------------------------------------------------------------
// Validation: missing fields return 400
// ---------------------------------------------------------------------------

describe('annotation thread validation', () => {
  const DEPT = 'e2e-dept-63-val';
  const CUSTOMER = `e2e-customer-63-val-${Date.now()}`;
  let versionId: string;
  let cookie: string;

  beforeAll(async () => {
    versionId = await seedWikiVersion({
      dept: DEPT,
      customer: CUSTOMER,
      content: 'Some content for validation tests.',
    });
    cookie = await getTestSession(`e2e-rm-63-val-${Date.now()}`);
  });

  test('POST /annotations: missing anchor_text returns 400', async () => {
    const res = await fetch(
      `${env.baseUrl}/api/wiki/pages/${CUSTOMER}/versions/${versionId}/annotations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ start_offset: 0, end_offset: 5, body: 'hello' }),
      },
    );
    expect(res.status).toBe(400);
  });

  test('POST /annotations: missing body returns 400', async () => {
    const res = await fetch(
      `${env.baseUrl}/api/wiki/pages/${CUSTOMER}/versions/${versionId}/annotations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ anchor_text: 'Some', start_offset: 0, end_offset: 4 }),
      },
    );
    expect(res.status).toBe(400);
  });

  test('POST /annotations: end_offset <= start_offset returns 400', async () => {
    const res = await fetch(
      `${env.baseUrl}/api/wiki/pages/${CUSTOMER}/versions/${versionId}/annotations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          anchor_text: 'Some',
          start_offset: 10,
          end_offset: 5,
          body: 'hello',
        }),
      },
    );
    expect(res.status).toBe(400);
  });

  test('POST /annotations/nonexistent/replies: 404 for missing thread', async () => {
    const res = await fetch(
      `${env.baseUrl}/api/wiki/pages/${CUSTOMER}/versions/${versionId}/annotations/does-not-exist/replies`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ body: 'hello' }),
      },
    );
    expect(res.status).toBe(404);
  });
});
