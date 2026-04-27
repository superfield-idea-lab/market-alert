/**
 * @file wiki-view.spec.ts
 *
 * Integration tests — wiki version history API (issue #47) and citation hover
 * with re-identification lookup (issue #49).
 *
 * Tests cover:
 *   - 401 when unauthenticated
 *   - Empty list when no versions exist for a customer
 *   - Returns versions in reverse-chronological order
 *   - Each entry has created_by, source, created_at, published metadata
 *   - RLS: versions for customer-A are not visible under customer-B's path
 *   - GET single version by ID
 *   - 404 for unknown version or cross-customer access
 *   - Citation endpoint: 401, 404, 200 with excerpt, resolved_name null for non-superuser
 *
 * No mocks — real Postgres + real Bun server via the shared E2E environment
 * helper. TEST_MODE=true is set by startE2EServer.
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/49
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startE2EServer, stopE2EServer, type E2EEnvironment } from '../e2e/environment';

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

async function getTestSession(base: string, username: string): Promise<string> {
  const res = await fetch(`${base}/api/test/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) {
    throw new Error(`test-session failed: ${res.status} ${await res.text()}`);
  }
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = /superfield_auth=([^;]+)/.exec(setCookie);
  return match ? `superfield_auth=${match[1]}` : '';
}

// ---------------------------------------------------------------------------
// Helper: seed a wiki_page_versions row directly via the internal API
// ---------------------------------------------------------------------------

async function seedWikiVersion(
  base: string,
  opts: {
    customer: string;
    dept: string;
    content: string;
    state?: string;
    created_by?: string;
  },
): Promise<{ id: string }> {
  const tokenRes = await fetch(`${base}/api/test/worker-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dept: opts.dept,
      customer: opts.customer,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`worker-token mint failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const { token } = (await tokenRes.json()) as { token: string };

  const writeRes = await fetch(`${base}/internal/wiki/versions`, {
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
      source_task: 'test-task-001',
    }),
  });
  if (!writeRes.ok) {
    throw new Error(`wiki write failed: ${writeRes.status} ${await writeRes.text()}`);
  }
  return writeRes.json() as Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// Helper: seed a corpus_chunk entity via the corpus-chunks API
// ---------------------------------------------------------------------------

async function seedCorpusChunk(
  base: string,
  cookie: string,
  body: string,
): Promise<{ chunkId: string; sourceId: string }> {
  const sourceRes = await fetch(`${base}/api/test/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `source-entity-${Date.now()}` }),
  });
  if (!sourceRes.ok) throw new Error('Failed to create source entity via test-session');
  const sourceBody = (await sourceRes.json()) as { user: { id: string } };
  const sourceId = sourceBody.user.id;

  const ingRes = await fetch(`${base}/api/corpus-chunks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ source_id: sourceId, text: body }),
  });
  if (!ingRes.ok) throw new Error(`corpus-chunks POST failed: ${ingRes.status}`);
  const ingBody = (await ingRes.json()) as { chunks: Array<{ id: string }> };
  if (!ingBody.chunks[0]) throw new Error('No chunk returned from corpus-chunks POST');
  return { chunkId: ingBody.chunks[0].id, sourceId };
}

// ---------------------------------------------------------------------------
// GET /api/wiki/pages/:customerId
// ---------------------------------------------------------------------------

describe('GET /api/wiki/pages/:customerId', () => {
  it('returns 401 when the caller is not authenticated', async () => {
    const res = await fetch(`${env.baseUrl}/api/wiki/pages/customer-rls-test`);
    expect(res.status).toBe(401);
  });

  it('returns an empty versions array when no versions exist for the customer', async () => {
    const cookie = await getTestSession(env.baseUrl, 'test-rm');
    const customerId = `customer-empty-${Date.now()}`;
    const res = await fetch(`${env.baseUrl}/api/wiki/pages/${customerId}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('customer_id', customerId);
    expect(body).toHaveProperty('versions');
    expect(Array.isArray(body.versions)).toBe(true);
    expect(body.versions).toHaveLength(0);
  });

  it('returns versions in reverse-chronological order with required metadata', async () => {
    const cookie = await getTestSession(env.baseUrl, 'test-rm');
    const customerId = `customer-order-${Date.now()}`;

    const v1 = await seedWikiVersion(env.baseUrl, {
      customer: customerId,
      dept: 'test-dept',
      content: 'Version one content',
    });
    await Bun.sleep(10);
    const v2 = await seedWikiVersion(env.baseUrl, {
      customer: customerId,
      dept: 'test-dept',
      content: 'Version two content',
    });

    const res = await fetch(`${env.baseUrl}/api/wiki/pages/${customerId}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.customer_id).toBe(customerId);
    expect(body.versions.length).toBeGreaterThanOrEqual(2);

    const ids = body.versions.map((v: { id: string }) => v.id);
    expect(ids[0]).toBe(v2.id);
    expect(ids).toContain(v1.id);

    for (const v of body.versions as {
      id: string;
      content: string;
      created_by: string;
      source: string | null;
      created_at: string;
      published: boolean;
    }[]) {
      expect(typeof v.id).toBe('string');
      expect(typeof v.content).toBe('string');
      expect(typeof v.created_by).toBe('string');
      expect(v.source === null || typeof v.source === 'string').toBe(true);
      expect(typeof v.created_at).toBe('string');
      expect(typeof v.published).toBe('boolean');
    }
  });

  it('RLS: versions for customer-A are not listed under customer-B path', async () => {
    const cookie = await getTestSession(env.baseUrl, 'test-rm');
    const customerA = `customer-rls-a-${Date.now()}`;
    const customerB = `customer-rls-b-${Date.now()}`;

    await seedWikiVersion(env.baseUrl, {
      customer: customerA,
      dept: 'test-dept',
      content: 'Customer A secret',
    });

    const res = await fetch(`${env.baseUrl}/api/wiki/pages/${customerB}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/wiki/pages/:customerId/versions/:versionId
// ---------------------------------------------------------------------------

describe('GET /api/wiki/pages/:customerId/versions/:versionId', () => {
  it('returns 401 when the caller is not authenticated', async () => {
    const res = await fetch(`${env.baseUrl}/api/wiki/pages/customer-123/versions/version-456`);
    expect(res.status).toBe(401);
  });

  it('returns the full version content when authenticated and version exists', async () => {
    const cookie = await getTestSession(env.baseUrl, 'test-rm');
    const customerId = `customer-version-${Date.now()}`;
    const content = 'Full markdown content for version test';

    const seeded = await seedWikiVersion(env.baseUrl, {
      customer: customerId,
      dept: 'test-dept',
      content,
    });

    const res = await fetch(`${env.baseUrl}/api/wiki/pages/${customerId}/versions/${seeded.id}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(seeded.id);
    expect(body.customer_id).toBe(customerId);
    expect(body.content).toBe(content);
    expect(typeof body.created_by).toBe('string');
    expect(typeof body.created_at).toBe('string');
    expect(typeof body.published).toBe('boolean');
  });

  it('returns 404 for an unknown version ID', async () => {
    const cookie = await getTestSession(env.baseUrl, 'test-rm');
    const res = await fetch(
      `${env.baseUrl}/api/wiki/pages/some-customer/versions/non-existent-id`,
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when the version exists but belongs to a different customer (RLS)', async () => {
    const cookie = await getTestSession(env.baseUrl, 'test-rm');
    const customerOwner = `customer-own-${Date.now()}`;
    const customerOther = `customer-other-${Date.now()}`;

    const seeded = await seedWikiVersion(env.baseUrl, {
      customer: customerOwner,
      dept: 'test-dept',
      content: 'Owned by customerOwner',
    });

    const res = await fetch(
      `${env.baseUrl}/api/wiki/pages/${customerOther}/versions/${seeded.id}`,
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/wiki/pages/:customerId/versions/:versionId/citations/:token
// (issue #49 — live implementation)
// ---------------------------------------------------------------------------

describe('GET .../citations/:token', () => {
  it('returns 401 when the caller is not authenticated', async () => {
    const res = await fetch(
      `${env.baseUrl}/api/wiki/pages/customer-123/versions/version-456/citations/token-abc`,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when the corpus chunk does not exist', async () => {
    const cookie = await getTestSession(env.baseUrl, `test-rm-404-${Date.now()}`);
    const res = await fetch(
      `${env.baseUrl}/api/wiki/pages/customer-123/versions/version-456/citations/nonexistent-chunk-id`,
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('returns 200 with excerpt for an authenticated user with a valid corpus chunk id', async () => {
    const cookie = await getTestSession(env.baseUrl, `test-rm-excerpt-${Date.now()}`);
    const chunkText = 'The customer expressed concern about Q3 delivery timelines.';
    const { chunkId } = await seedCorpusChunk(env.baseUrl, cookie, chunkText);

    const res = await fetch(
      `${env.baseUrl}/api/wiki/pages/customer-123/versions/version-456/citations/${chunkId}`,
      { headers: { Cookie: cookie } },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('token', chunkId);
    expect(body).toHaveProperty('entity_id', chunkId);
    expect(body).toHaveProperty('excerpt');
    expect(typeof body.excerpt).toBe('string');
    expect(body.excerpt).toContain('customer');
    // Non-superuser: resolved_name must be null (re-id gated by role).
    expect(body).toHaveProperty('resolved_name', null);
  });

  it('returns resolved_name: null for a non-superuser (re-id gated by role)', async () => {
    const cookie = await getTestSession(env.baseUrl, `test-rm-noreid-${Date.now()}`);
    const { chunkId } = await seedCorpusChunk(
      env.baseUrl,
      cookie,
      'Another relevant passage about project scope.',
    );

    const res = await fetch(
      `${env.baseUrl}/api/wiki/pages/customer-abc/versions/version-xyz/citations/${chunkId}`,
      { headers: { Cookie: cookie } },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // Non-superuser should NOT receive resolved identity.
    expect(body.resolved_name).toBeNull();
  });
});
