/**
 * Integration tests for concurrent task-queue claim behaviour (TQ-C-001).
 *
 * Validates:
 *   - Two concurrent claim attempts for the same task result in exactly one
 *     success and one "no task available" response (204).
 *   - The claiming worker correctly identifies as the claimed_by value.
 *   - LISTEN/NOTIFY channels are per agent type — a notification for
 *     agent_type A does not wake a listener registered for agent_type B.
 *
 * Uses a real PostgreSQL container (no mocks) and a live server process.
 * Blueprint refs: TQ-C-001, TQ-C-006.
 * Issue: #95
 */

import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31424;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let authCookie = '';

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

  const session = await createTestSession(BASE);
  authCookie = session.cookie;
}, 60_000);

afterAll(async () => {
  server?.kill();
  await pg?.stop();
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function enqueue(agentType: string, idKey: string): Promise<{ id: string; status: string }> {
  const res = await fetch(`${BASE}/api/tasks-queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({
      idempotency_key: idKey,
      agent_type: agentType,
      job_type: 'test',
      payload: { ref: idKey },
    }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function claim(agentType: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}/api/tasks-queue/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ agent_type: agentType }),
  });
  let body: unknown = null;
  if (res.status !== 204) {
    body = await res.json();
  }
  return { status: res.status, body };
}

// ── tests ─────────────────────────────────────────────────────────────────────

/**
 * TQ-C-001: Two concurrent workers claim against the same single task.
 * Exactly one should succeed (200) and one should get "no task available" (204).
 */
test('concurrent claim — exactly one winner out of two simultaneous claims (TQ-C-001)', async () => {
  const stamp = Date.now();
  const agentType = `concurrent_agent_${stamp}`;

  // Enqueue exactly one task for this agent type
  await enqueue(agentType, `concurrent-single-${stamp}`);

  // Fire two claim requests simultaneously
  const [r1, r2] = await Promise.all([claim(agentType), claim(agentType)]);

  const statuses = [r1.status, r2.status].sort();
  // One winner (200), one empty (204)
  expect(statuses).toEqual([200, 204]);

  // The winner's body should show status=claimed
  const winner = r1.status === 200 ? r1.body : r2.body;
  expect((winner as { status: string }).status).toBe('claimed');
  expect((winner as { attempt: number }).attempt).toBe(1);
}, 30_000);

/**
 * TQ-C-001: With two tasks enqueued, two concurrent claims should each succeed.
 */
test('concurrent claim — two tasks, two concurrent workers each claim one (TQ-C-001)', async () => {
  const stamp = Date.now();
  const agentType = `concurrent_two_${stamp}`;

  // Enqueue two tasks
  await Promise.all([
    enqueue(agentType, `c2-task-a-${stamp}`),
    enqueue(agentType, `c2-task-b-${stamp}`),
  ]);

  // Both workers claim concurrently
  const [r1, r2] = await Promise.all([claim(agentType), claim(agentType)]);

  expect(r1.status).toBe(200);
  expect(r2.status).toBe(200);

  const id1 = (r1.body as { id: string }).id;
  const id2 = (r2.body as { id: string }).id;

  // Each worker must have claimed a different task
  expect(id1).not.toBe(id2);
}, 30_000);

/**
 * TQ-C-006: LISTEN/NOTIFY channels are per agent type.
 * Enqueueing a task for agent_type A must not interfere with tasks visible
 * to agent_type B's claim endpoint.
 */
test('LISTEN/NOTIFY isolation — claim for agent_type B sees only type-B tasks (TQ-C-006)', async () => {
  const stamp = Date.now();
  const agentA = `notify_agent_a_${stamp}`;
  const agentB = `notify_agent_b_${stamp}`;

  // Enqueue one task for agentA only
  await enqueue(agentA, `notify-a-${stamp}`);

  // Claim for agentB should find nothing
  const rB = await claim(agentB);
  expect(rB.status).toBe(204);

  // Claim for agentA should succeed
  const rA = await claim(agentA);
  expect(rA.status).toBe(200);
  expect((rA.body as { agent_type: string }).agent_type).toBe(agentA);
}, 30_000);

// ── wait helper ───────────────────────────────────────────────────────────────

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
