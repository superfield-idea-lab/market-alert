/**
 * Regression tests confirming that GET /api/admin/findings has been removed
 * and is no longer handled by the admin router.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockGetAuthenticatedUser } = vi.hoisted(() => ({
  mockGetAuthenticatedUser: vi.fn(),
}));

const mockSql = vi.fn();

function makeSqlTag() {
  const tag = Object.assign(
    function sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
      return mockSql(strings, ...values);
    },
    {
      array: (arr: unknown[]) => arr,
    },
  );
  return tag;
}

vi.mock('db/api-keys', () => ({
  createApiKey: vi.fn(),
  listApiKeys: vi.fn(),
  deleteApiKey: vi.fn(),
  authenticateApiKey: vi.fn(),
}));

vi.mock('db/task-queue', () => ({
  listTasksForAdmin: vi.fn(),
}));

vi.mock('../../src/policies/audit-service', () => ({
  emitAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/api/auth', () => ({
  getAuthenticatedUser: mockGetAuthenticatedUser,
  getCorsHeaders: () => ({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Credentials': 'true',
  }),
}));

vi.mock('../../src/lib/response', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/lib/response')>('../../src/lib/response');
  return {
    ...actual,
    isSuperuser: (id: string) => id === 'superuser-id',
  };
});

vi.mock('db/tenant-config', () => ({
  getTenantConfig: vi.fn().mockResolvedValue({}),
  setTenantRegulated: vi.fn().mockResolvedValue(undefined),
  setAssemblyAiLegacyEnabled: vi.fn().mockResolvedValue(undefined),
  RegulatedTenantError: class RegulatedTenantError extends Error {},
}));

import { handleAdminRequest } from '../../src/api/admin';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAppState(rows: unknown[] = []) {
  const sql = makeSqlTag();
  mockSql.mockResolvedValue(rows);
  return { sql } as never;
}

function makeRequest(path: string, method = 'GET'): { req: Request; url: URL } {
  const fullUrl = `http://localhost:31415${path}`;
  const req = new Request(fullUrl, { method });
  const url = new URL(fullUrl);
  return { req, url };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/admin/findings — endpoint removed', () => {
  const originalEnv = process.env.SUPERUSER_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPERUSER_ID = 'superuser-id';
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SUPERUSER_ID;
    } else {
      process.env.SUPERUSER_ID = originalEnv;
    }
  });

  test('superuser does not receive findings data — endpoint no longer exists', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ id: 'superuser-id', username: 'admin' });
    const { req, url } = makeRequest('/api/admin/findings');
    const appState = makeAppState([]);

    const res = await handleAdminRequest(req, url, appState);
    // The endpoint is removed — either null (route unhandled) or a non-200 error response
    // is acceptable. The important invariant is that no findings payload is returned.
    if (res !== null) {
      // If a response is returned, it must NOT be a 200 with findings data
      expect(res.status).not.toBe(200);
    }
    // Either outcome confirms the findings route is gone
    const routeGone = res === null || res.status !== 200;
    expect(routeGone).toBe(true);
  });

  test('unauthenticated caller gets 401 — auth guard fires before route lookup', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(null);
    const { req, url } = makeRequest('/api/admin/findings');
    const appState = makeAppState([]);

    const res = await handleAdminRequest(req, url, appState);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });
});
