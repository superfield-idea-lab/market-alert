/**
 * Unit tests for GET /api/admin/findings — admin findings endpoint.
 *
 * Validates auth enforcement, finding extraction from task results, summary
 * aggregation, and query parameters without a live database connection.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockGetAuthenticatedUser } = vi.hoisted(() => ({
  mockGetAuthenticatedUser: vi.fn(),
}));

const mockSql = vi.fn();

// Provide a minimal tagged-template sql function that records calls and
// returns whatever the test configures via mockSql.
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

async function jsonBody(res: Response): Promise<unknown> {
  return res.json();
}

// ---------------------------------------------------------------------------
// Sample task rows returned by DB
// ---------------------------------------------------------------------------

const taskWithFindings = {
  id: 'task-sec-1',
  agent_type: 'security',
  result: {
    findings: [
      {
        severity: 'high',
        file_path: 'src/auth.ts',
        description: 'SQL injection risk',
        remediation: 'Use parameterised queries',
      },
      {
        severity: 'medium',
        file_path: 'src/api.ts',
        description: 'Missing input validation',
        remediation: 'Add Zod schema validation',
      },
    ],
  },
  completed_at: new Date('2026-03-27T10:00:00Z'),
  updated_at: new Date('2026-03-27T10:00:00Z'),
};

const taskWithNoFindings = {
  id: 'task-cleanup-1',
  agent_type: 'code_cleanup',
  result: { findings: [] },
  completed_at: new Date('2026-03-27T09:00:00Z'),
  updated_at: new Date('2026-03-27T09:00:00Z'),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/admin/findings', () => {
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

  // ── Auth / authorisation ────────────────────────────────────────────────

  test('returns 401 for unauthenticated caller', async () => {
    mockGetAuthenticatedUser.mockResolvedValue(null);
    const { req, url } = makeRequest('/api/admin/findings');
    const appState = makeAppState();
    const res = await handleAdminRequest(req, url, appState);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    const body = await jsonBody(res!);
    expect(body).toEqual({ error: 'Unauthorized' });
  });

  test('returns 403 for non-superadmin caller', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ id: 'regular-user', username: 'bob' });
    const { req, url } = makeRequest('/api/admin/findings');
    const appState = makeAppState();
    const res = await handleAdminRequest(req, url, appState);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await jsonBody(res!);
    expect(body).toEqual({ error: 'Forbidden' });
  });

  // ── Happy path ──────────────────────────────────────────────────────────

  test('returns 200 with findings extracted from completed tasks', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ id: 'superuser-id', username: 'admin' });
    const { req, url } = makeRequest('/api/admin/findings');
    const appState = makeAppState([taskWithFindings]);

    const res = await handleAdminRequest(req, url, appState);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const body = (await jsonBody(res!)) as {
      findings: unknown[];
      summary: Record<string, Record<string, number>>;
      limit: number;
      offset: number;
    };

    expect(body.findings).toHaveLength(2);
    expect(body.limit).toBe(200);
    expect(body.offset).toBe(0);
  });

  test('each finding has task_id, agent_type, severity, file_path, description, remediation, scanned_at', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ id: 'superuser-id', username: 'admin' });
    const { req, url } = makeRequest('/api/admin/findings');
    const appState = makeAppState([taskWithFindings]);

    const res = await handleAdminRequest(req, url, appState);
    const body = (await jsonBody(res!)) as { findings: Record<string, unknown>[] };
    const f = body.findings[0];

    expect(f).toHaveProperty('task_id', 'task-sec-1');
    expect(f).toHaveProperty('agent_type', 'security');
    expect(f).toHaveProperty('severity', 'high');
    expect(f).toHaveProperty('file_path', 'src/auth.ts');
    expect(f).toHaveProperty('description', 'SQL injection risk');
    expect(f).toHaveProperty('remediation', 'Use parameterised queries');
    expect(f).toHaveProperty('scanned_at', '2026-03-27T10:00:00.000Z');
  });

  test('returns empty findings array when no completed tasks exist', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ id: 'superuser-id', username: 'admin' });
    const { req, url } = makeRequest('/api/admin/findings');
    const appState = makeAppState([]);

    const res = await handleAdminRequest(req, url, appState);
    const body = (await jsonBody(res!)) as { findings: unknown[]; summary: unknown };
    expect(body.findings).toHaveLength(0);
    expect(body.summary).toBeDefined();
  });

  test('returns empty findings for tasks with empty findings array', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ id: 'superuser-id', username: 'admin' });
    const { req, url } = makeRequest('/api/admin/findings');
    const appState = makeAppState([taskWithNoFindings]);

    const res = await handleAdminRequest(req, url, appState);
    const body = (await jsonBody(res!)) as { findings: unknown[] };
    expect(body.findings).toHaveLength(0);
  });

  // ── Summary aggregation ─────────────────────────────────────────────────

  test('summary contains counts grouped by agent type and severity', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ id: 'superuser-id', username: 'admin' });
    const { req, url } = makeRequest('/api/admin/findings');
    const appState = makeAppState([taskWithFindings]);

    const res = await handleAdminRequest(req, url, appState);
    const body = (await jsonBody(res!)) as {
      summary: Record<string, Record<string, number>>;
    };

    expect(body.summary['security']).toBeDefined();
    expect(body.summary['security']['high']).toBe(1);
    expect(body.summary['security']['medium']).toBe(1);
  });

  test('summary includes all known agent type keys even when empty', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ id: 'superuser-id', username: 'admin' });
    const { req, url } = makeRequest('/api/admin/findings');
    const appState = makeAppState([]);

    const res = await handleAdminRequest(req, url, appState);
    const body = (await jsonBody(res!)) as {
      summary: Record<string, Record<string, number>>;
    };

    // All four known agent types should be present in summary
    expect(body.summary).toHaveProperty('security');
    expect(body.summary).toHaveProperty('soc_compliance');
    expect(body.summary).toHaveProperty('runtime_errors');
    expect(body.summary).toHaveProperty('code_cleanup');
  });

  // ── Pagination ──────────────────────────────────────────────────────────

  test('defaults to limit=200 offset=0', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ id: 'superuser-id', username: 'admin' });
    const { req, url } = makeRequest('/api/admin/findings');
    const appState = makeAppState([]);

    const res = await handleAdminRequest(req, url, appState);
    const body = (await jsonBody(res!)) as { limit: number; offset: number };
    expect(body.limit).toBe(200);
    expect(body.offset).toBe(0);
  });

  test('respects custom limit and offset', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ id: 'superuser-id', username: 'admin' });
    const { req, url } = makeRequest('/api/admin/findings?limit=50&offset=10');
    const appState = makeAppState([]);

    const res = await handleAdminRequest(req, url, appState);
    const body = (await jsonBody(res!)) as { limit: number; offset: number };
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(10);
  });

  test('caps limit at 500', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ id: 'superuser-id', username: 'admin' });
    const { req, url } = makeRequest('/api/admin/findings?limit=9999');
    const appState = makeAppState([]);

    const res = await handleAdminRequest(req, url, appState);
    const body = (await jsonBody(res!)) as { limit: number };
    expect(body.limit).toBe(500);
  });
});
