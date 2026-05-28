/**
 * Unit tests for GET /api/admin/task-queue — admin task queue monitoring endpoint.
 *
 * These tests exercise the admin route handler logic (auth, query parsing,
 * field exclusion) by patching the two upstream functions the route depends on
 * (`getAuthenticatedUser` for the session, `listTasksForAdmin` for the DB
 * query) via `vi.spyOn`. We use `vi.spyOn` rather than `vi.mock` because the
 * `vi.mock` hoisting interacts badly with bun's path-aliased module resolution
 * for `db/task-queue` — see the legacy version of this file for context.
 *
 * The spy pattern is the same one used in users-api.test.ts and keeps the
 * total `vi.*` mock count from increasing versus the pre-change `origin/main`.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as authModule from '../../src/api/auth';
import * as taskQueueModule from 'db/task-queue';
import * as accessModule from '../../src/lib/access';
import { handleAdminRequest } from '../../src/api/admin';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const appState = {} as never;

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
// Sample data — shape mirrors TaskQueueAdminRow from packages/db/task-queue.ts
// ---------------------------------------------------------------------------

const sampleTask = {
  id: 'task-1',
  idempotency_key: 'idem-1',
  agent_type: 'coding',
  job_type: 'run-test',
  // The status field is typed as the literal union TaskQueueStatus exported
  // from db/task-queue; use the literal 'pending' (not a widened string) so
  // TypeScript narrows correctly when feeding the row into the spy.
  status: 'pending' as const,
  correlation_id: null,
  created_by: 'user-abc',
  claimed_by: null,
  claimed_at: null,
  claim_expires_at: null,
  result: null,
  error_message: null,
  attempt: 0,
  max_attempts: 3,
  next_retry_at: null,
  priority: 5,
  created_at: new Date('2026-03-26T00:00:00Z'),
  updated_at: new Date('2026-03-26T00:00:00Z'),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Set the authenticated user for the next handler call. Returns the spy so
 * tests can also assert against it when needed.
 */
function asUser(user: { id: string; username: string } | null) {
  return vi.spyOn(authModule, 'getAuthenticatedUser').mockResolvedValue(user);
}

const SUPERADMIN = { id: 'superuser-id', username: 'admin' } as const;

describe('GET /api/admin/task-queue', () => {
  const originalEnv = process.env.SUPERUSER_ID;

  beforeEach(() => {
    process.env.SUPERUSER_ID = 'superuser-id';
    // canManageCrmEntities reads from the DB; for the admin task-queue route it
    // never gates the response, but admin.ts evaluates it on every request.
    // Stub it to a deterministic `false` so we don't need a live DB.
    vi.spyOn(accessModule, 'canManageCrmEntities').mockResolvedValue(false);
    // Default the task-queue lookup to an empty list. Individual tests
    // override the return value with `.mockResolvedValue(...)` as needed.
    vi.spyOn(taskQueueModule, 'listTasksForAdmin').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnv === undefined) {
      delete process.env.SUPERUSER_ID;
    } else {
      process.env.SUPERUSER_ID = originalEnv;
    }
  });

  // ── Auth / authorisation ────────────────────────────────────────────────

  test('returns 401 for unauthenticated caller', async () => {
    asUser(null);
    const { req, url } = makeRequest('/api/admin/task-queue');
    const res = await handleAdminRequest(req, url, appState);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    const body = await jsonBody(res!);
    expect(body).toEqual({ error: 'Unauthorized' });
  });

  test('returns 403 for non-superadmin caller', async () => {
    asUser({ id: 'regular-user', username: 'bob' });
    const { req, url } = makeRequest('/api/admin/task-queue');
    const res = await handleAdminRequest(req, url, appState);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await jsonBody(res!);
    expect(body).toEqual({ error: 'Forbidden' });
  });

  // ── Happy path ──────────────────────────────────────────────────────────

  test('superadmin can retrieve task queue entries', async () => {
    asUser(SUPERADMIN);
    vi.mocked(taskQueueModule.listTasksForAdmin).mockResolvedValue([sampleTask]);

    const { req, url } = makeRequest('/api/admin/task-queue');
    const res = await handleAdminRequest(req, url, appState);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const body = (await jsonBody(res!)) as {
      tasks: (typeof sampleTask)[];
      limit: number;
      offset: number;
    };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].id).toBe('task-1');
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  test('response does not contain payload or delegated_token fields', async () => {
    asUser(SUPERADMIN);
    vi.mocked(taskQueueModule.listTasksForAdmin).mockResolvedValue([sampleTask]);

    const { req, url } = makeRequest('/api/admin/task-queue');
    const res = await handleAdminRequest(req, url, appState);
    const body = (await jsonBody(res!)) as { tasks: Record<string, unknown>[] };

    expect(body.tasks[0]).not.toHaveProperty('payload');
    expect(body.tasks[0]).not.toHaveProperty('delegated_token');
  });

  // ── Query parameter: status ─────────────────────────────────────────────

  test('status filter is passed to listTasksForAdmin', async () => {
    asUser(SUPERADMIN);

    const { req, url } = makeRequest('/api/admin/task-queue?status=running');
    await handleAdminRequest(req, url, appState);

    expect(taskQueueModule.listTasksForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'running' }),
    );
  });

  test('returns 400 for invalid status value', async () => {
    asUser(SUPERADMIN);

    const { req, url } = makeRequest('/api/admin/task-queue?status=invalid');
    const res = await handleAdminRequest(req, url, appState);
    expect(res!.status).toBe(400);
    const body = await jsonBody(res!);
    expect((body as { error: string }).error).toContain('Invalid status');
  });

  // ── Query parameter: agent_type ─────────────────────────────────────────

  test('agent_type filter is passed to listTasksForAdmin', async () => {
    asUser(SUPERADMIN);

    const { req, url } = makeRequest('/api/admin/task-queue?agent_type=coding');
    await handleAdminRequest(req, url, appState);

    expect(taskQueueModule.listTasksForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ agent_type: 'coding' }),
    );
  });

  // ── Pagination ──────────────────────────────────────────────────────────

  test('pagination works correctly with limit and offset', async () => {
    asUser(SUPERADMIN);

    const { req, url } = makeRequest('/api/admin/task-queue?limit=10&offset=20');
    const res = await handleAdminRequest(req, url, appState);

    expect(taskQueueModule.listTasksForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, offset: 20 }),
    );
    const body = (await jsonBody(res!)) as { limit: number; offset: number };
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(20);
  });

  test('limit is capped at 200', async () => {
    asUser(SUPERADMIN);

    const { req, url } = makeRequest('/api/admin/task-queue?limit=999');
    await handleAdminRequest(req, url, appState);

    expect(taskQueueModule.listTasksForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200 }),
    );
  });

  test('defaults to limit=50 and offset=0 when omitted', async () => {
    asUser(SUPERADMIN);

    const { req, url } = makeRequest('/api/admin/task-queue');
    await handleAdminRequest(req, url, appState);

    expect(taskQueueModule.listTasksForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50, offset: 0 }),
    );
  });

  // ── Combined filters ───────────────────────────────────────────────────

  test('supports combined status and agent_type filters', async () => {
    asUser(SUPERADMIN);

    const { req, url } = makeRequest('/api/admin/task-queue?status=pending&agent_type=analysis');
    await handleAdminRequest(req, url, appState);

    expect(taskQueueModule.listTasksForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', agent_type: 'analysis' }),
    );
  });
});
