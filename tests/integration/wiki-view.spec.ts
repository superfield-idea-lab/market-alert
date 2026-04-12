/**
 * @file wiki-view.spec.ts
 *
 * Integration test stub — read-only wiki view API (issue #45).
 *
 * ## Scout stub (Phase 4)
 *
 * The routes under test are no-op stubs that return 501 Not Implemented.
 * These tests assert the stub contract:
 *   - 401 when the caller is unauthenticated (auth invariant lives in stub).
 *   - 501 when authenticated (stub signals follow-on implementation required).
 *   - Response body contains `expected_response_shape` with the planned shape.
 *
 * Once the real Phase 4 implementation lands, these tests should be replaced
 * with assertions against the actual response data.
 *
 * No mocks — real Postgres + real Bun server via the shared E2E environment
 * helper. TEST_MODE=true must be set (done by startE2EServer in environment.ts).
 *
 * Test plan items (issue #45):
 *   TP-2  Integration: fetch the wiki for a customer via the API and assert
 *         version and metadata shape.
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/45
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
  const match = /calypso_auth=([^;]+)/.exec(setCookie);
  return match ? `calypso_auth=${match[1]}` : '';
}

// ---------------------------------------------------------------------------
// Wiki page view — stub contract tests
// ---------------------------------------------------------------------------

describe('GET /api/wiki/pages/:customerId (scout stub)', () => {
  it('returns 401 when the caller is not authenticated', async () => {
    const res = await fetch(`${env.baseUrl}/api/wiki/pages/customer-123`);
    expect(res.status).toBe(401);
  });

  it('returns 501 when the caller is authenticated (stub signals not implemented)', async () => {
    const cookie = await getTestSession(env.baseUrl, 'test-rm');
    const res = await fetch(`${env.baseUrl}/api/wiki/pages/customer-123`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body).toHaveProperty('error');
    // The stub must encode the planned response shape for follow-on issues.
    expect(body).toHaveProperty('expected_response_shape');
    expect(body.expected_response_shape).toHaveProperty('versions');
    expect(Array.isArray(body.expected_response_shape.versions)).toBe(true);
  });

  it('stub response shape includes required metadata fields on each version', async () => {
    const cookie = await getTestSession(env.baseUrl, 'test-rm');
    const res = await fetch(`${env.baseUrl}/api/wiki/pages/customer-123`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(501);
    const body = await res.json();
    const shape = body.expected_response_shape;
    expect(shape).toHaveProperty('customer_id');
    const firstVersion = shape.versions[0];
    expect(firstVersion).toHaveProperty('id');
    expect(firstVersion).toHaveProperty('content');
    expect(firstVersion).toHaveProperty('created_by');
    expect(firstVersion).toHaveProperty('source');
    expect(firstVersion).toHaveProperty('created_at');
    expect(firstVersion).toHaveProperty('published');
  });
});

describe('GET /api/wiki/pages/:customerId/versions/:versionId (scout stub)', () => {
  it('returns 401 when the caller is not authenticated', async () => {
    const res = await fetch(`${env.baseUrl}/api/wiki/pages/customer-123/versions/version-456`);
    expect(res.status).toBe(401);
  });

  it('returns 501 when the caller is authenticated (stub signals not implemented)', async () => {
    const cookie = await getTestSession(env.baseUrl, 'test-rm');
    const res = await fetch(`${env.baseUrl}/api/wiki/pages/customer-123/versions/version-456`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body).toHaveProperty('expected_response_shape');
    const shape = body.expected_response_shape;
    expect(shape).toHaveProperty('id');
    expect(shape).toHaveProperty('content');
    expect(shape).toHaveProperty('created_by');
    expect(shape).toHaveProperty('source');
    expect(shape).toHaveProperty('published');
  });
});

describe('GET /api/wiki/pages/:customerId/versions/:versionId/citations/:token (scout stub)', () => {
  it('returns 401 when the caller is not authenticated', async () => {
    const res = await fetch(
      `${env.baseUrl}/api/wiki/pages/customer-123/versions/version-456/citations/token-abc`,
    );
    expect(res.status).toBe(401);
  });

  it('returns 501 when the caller is authenticated (stub signals not implemented)', async () => {
    const cookie = await getTestSession(env.baseUrl, 'test-rm');
    const res = await fetch(
      `${env.baseUrl}/api/wiki/pages/customer-123/versions/version-456/citations/token-abc`,
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body).toHaveProperty('expected_response_shape');
    const shape = body.expected_response_shape;
    expect(shape).toHaveProperty('token');
    expect(shape).toHaveProperty('entity_id');
    expect(shape).toHaveProperty('excerpt');
    expect(shape).toHaveProperty('source_id');
  });
});
