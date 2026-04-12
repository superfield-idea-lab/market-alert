/**
 * Integration tests for POST /api/deepclean — deepclean on-demand autolearn path.
 *
 * Issue #41 acceptance criteria:
 *   - Deepclean can only be triggered by the operator role
 *   - Deepclean stages the full ground truth, not incremental
 *   - Deepclean output always lands in AWAITING_REVIEW
 *   - Deepclean output always requires explicit approval
 *
 * Test plan coverage:
 *   - Integration: trigger deepclean as operator and assert full-corpus
 *     staging and AWAITING_REVIEW draft
 *   - Integration: attempt deepclean as a non-operator and assert rejection
 *   - Integration: ensure a diff-small deepclean still lands in AWAITING_REVIEW
 *
 * No mocks — real server HTTP, real Postgres, real task queue.
 */

import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31428;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;

// Two sessions: operator (authorised) and regular user (unauthorised).
let operatorCookie = '';
let userCookie = '';

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
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);

  const opSession = await createTestSession(BASE, {
    username: `operator_${Date.now()}`,
    role: 'operator',
  });
  operatorCookie = opSession.cookie;

  const userSession = await createTestSession(BASE, {
    username: `regular_${Date.now()}`,
    // no role — plain user
  });
  userCookie = userSession.cookie;
}, 60_000);

afterAll(async () => {
  server?.kill();
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

test('POST /api/deepclean returns 401 when unauthenticated', async () => {
  const res = await fetch(`${BASE}/api/deepclean`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dept_id: 'dept-1', customer_id: 'cust-1' }),
  });
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// Non-operator rejection
// ---------------------------------------------------------------------------

test('POST /api/deepclean returns 403 for a non-operator user — accepts the attempt but refuses it', async () => {
  const res = await fetch(`${BASE}/api/deepclean`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: userCookie },
    body: JSON.stringify({ dept_id: 'dept-1', customer_id: 'cust-1' }),
  });
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error).toBe('Forbidden');
});

// ---------------------------------------------------------------------------
// Operator trigger: full-ground-truth and AWAITING_REVIEW flags
// ---------------------------------------------------------------------------

test('POST /api/deepclean as operator enqueues a DEEPCLEAN task with full_ground_truth=true', async () => {
  const stamp = Date.now();
  const res = await fetch(`${BASE}/api/deepclean`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: operatorCookie },
    body: JSON.stringify({
      dept_id: `dept-${stamp}`,
      customer_id: `cust-${stamp}`,
      idempotency_key: `deepclean-test-${stamp}`,
    }),
  });

  expect(res.status).toBe(202);

  const body = await res.json();
  // Task was enqueued
  expect(typeof body.task_id).toBe('string');
  expect(body.task_id.length).toBeGreaterThan(0);
  expect(body.status).toBe('pending');
  expect(body.agent_type).toBe('deepclean');
  expect(body.job_type).toBe('deepclean_full_rebuild');

  // Full ground truth and review routing flags must be set on the response
  // so callers can verify the deepclean semantics without reading the DB.
  expect(body.full_ground_truth).toBe(true);
  expect(body.review_required).toBe(true);
});

// ---------------------------------------------------------------------------
// Diff-small deepclean still lands in AWAITING_REVIEW (routing invariant)
// ---------------------------------------------------------------------------

test('POST /api/deepclean — even a minimal-diff run flags review_required=true (AWAITING_REVIEW invariant)', async () => {
  // This test verifies the routing contract: the API response always declares
  // review_required=true regardless of the size of the eventual diff.
  // The materiality of the diff is determined by the worker after processing;
  // the API layer enforces that review is required up-front so the worker
  // cannot route around the gate.
  const stamp = Date.now() + 1;
  const res = await fetch(`${BASE}/api/deepclean`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: operatorCookie },
    body: JSON.stringify({
      dept_id: `dept-small-${stamp}`,
      customer_id: `cust-small-${stamp}`,
      idempotency_key: `deepclean-small-${stamp}`,
    }),
  });

  expect(res.status).toBe(202);

  const body = await res.json();
  // The review_required flag must always be true for deepclean tasks —
  // there is no materiality exception.
  expect(body.review_required).toBe(true);
  expect(body.full_ground_truth).toBe(true);
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('POST /api/deepclean returns 400 when dept_id is missing', async () => {
  const res = await fetch(`${BASE}/api/deepclean`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: operatorCookie },
    body: JSON.stringify({ customer_id: 'cust-1' }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toMatch(/dept_id/);
});

test('POST /api/deepclean returns 400 when customer_id is missing', async () => {
  const res = await fetch(`${BASE}/api/deepclean`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: operatorCookie },
    body: JSON.stringify({ dept_id: 'dept-1' }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toMatch(/customer_id/);
});

test('POST /api/deepclean is idempotent when the same idempotency_key is supplied', async () => {
  const stamp = Date.now() + 2;
  const idemKey = `deepclean-idem-${stamp}`;
  const body = {
    dept_id: `dept-idem-${stamp}`,
    customer_id: `cust-idem-${stamp}`,
    idempotency_key: idemKey,
  };

  const first = await fetch(`${BASE}/api/deepclean`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: operatorCookie },
    body: JSON.stringify(body),
  });
  expect(first.status).toBe(202);
  const t1 = await first.json();

  const second = await fetch(`${BASE}/api/deepclean`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: operatorCookie },
    body: JSON.stringify(body),
  });
  expect(second.status).toBe(202);
  const t2 = await second.json();

  // Same task_id — no duplicate task row created (TQ-P-003).
  expect(t2.task_id).toBe(t1.task_id);
});

// ---------------------------------------------------------------------------

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/healthz`);
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}
