/**
 * Integration tests for stale-claim recovery (TQ-D-003).
 *
 * Validates:
 *   - recoverStaleClaims() resets expired claimed tasks to 'pending' when
 *     attempt < max_attempts (exponential backoff applied)
 *   - recoverStaleClaims() promotes expired claimed tasks to 'dead' when
 *     attempt >= max_attempts
 *   - next_retry_at is set for pending resets, NULL for dead transitions
 *   - claimed_by and claim_expires_at are cleared on recovery
 *   - Tasks with unexpired claims are not recovered
 *
 * Uses a real PostgreSQL container and a running server process.
 * Direct DB manipulation via psql is used to force claim expiry.
 */

import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { startPostgres, type PgContainer } from '../helpers/pg-container';

const PORT = 31423;
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
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);

  const username = `stale_test_${Date.now()}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'testpass123' }),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  authCookie = setCookie.split(';')[0];
}, 60_000);

afterAll(async () => {
  server?.kill();
  await pg?.stop();
});

// ── helpers ──────────────────────────────────────────────────────────────────

/** Enqueue a task and return its id. */
async function enqueue(stamp: string): Promise<string> {
  const res = await fetch(`${BASE}/api/tasks-queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({
      idempotency_key: `stale-${stamp}`,
      agent_type: `stale_agent_${stamp}`,
      job_type: 'test',
      payload: { ref: stamp },
    }),
  });
  const task = await res.json();
  return task.id as string;
}

/** Claim the task with a very short TTL (1 second) so it expires quickly. */
async function claimTask(agentType: string): Promise<string> {
  // Claim using the API (default TTL); we'll expire it manually via psql below
  const res = await fetch(`${BASE}/api/tasks-queue/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({ agent_type: agentType }),
  });
  const claimed = await res.json();
  return claimed.id as string;
}

/** Force a task's claim_expires_at to the past via psql. */
function expireClaim(taskId: string): void {
  Bun.spawnSync([
    'docker',
    'exec',
    pg.containerId,
    'psql',
    '-U',
    'calypso',
    '-d',
    'calypso',
    '-c',
    `UPDATE task_queue SET claim_expires_at = NOW() - INTERVAL '1 second' WHERE id = '${taskId}'`,
  ]);
}

/** Force attempt count for a task via psql. */
function setAttempt(taskId: string, attempt: number, maxAttempts: number): void {
  Bun.spawnSync([
    'docker',
    'exec',
    pg.containerId,
    'psql',
    '-U',
    'calypso',
    '-d',
    'calypso',
    '-c',
    `UPDATE task_queue SET attempt = ${attempt}, max_attempts = ${maxAttempts} WHERE id = '${taskId}'`,
  ]);
}

/** Read a task row via psql. Returns JSON. */
function readTask(taskId: string): {
  status: string;
  claimed_by: string | null;
  claim_expires_at: string | null;
  next_retry_at: string | null;
} {
  const result = Bun.spawnSync([
    'docker',
    'exec',
    pg.containerId,
    'psql',
    '-U',
    'calypso',
    '-d',
    'calypso',
    '-t',
    '-c',
    `SELECT row_to_json(r) FROM (SELECT status, claimed_by, claim_expires_at::TEXT, next_retry_at::TEXT FROM task_queue WHERE id = '${taskId}') r`,
  ]);
  const raw = new TextDecoder().decode(result.stdout).trim();
  return JSON.parse(raw);
}

/** Trigger a single stale-recovery sweep via a helper endpoint, or wait for scheduler. */
async function triggerRecovery(): Promise<void> {
  // The server runs recoverStaleClaims on a 60s interval, which is too slow
  // for tests. We trigger it by calling the recovery directly through a bun
  // script that uses the same DATABASE_URL.
  const proc = Bun.spawnSync(
    [
      'bun',
      '-e',
      `
import { recoverStaleClaims } from 'db/task-queue';
const rows = await recoverStaleClaims();
console.log(JSON.stringify(rows));
process.exit(0);
      `.trim(),
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: pg.url,
        AUDIT_DATABASE_URL: pg.url,
      },
    },
  );
  if (proc.exitCode !== 0) {
    throw new Error(`recoverStaleClaims script failed: ${new TextDecoder().decode(proc.stderr)}`);
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('expired claimed task (attempt < max_attempts) is reset to pending (TQ-D-003)', async () => {
  const stamp = `${Date.now()}-a`;
  const id = await enqueue(stamp);
  await claimTask(`stale_agent_${stamp}`);

  // Force expiry and set attempt=1, max_attempts=3
  setAttempt(id, 1, 3);
  expireClaim(id);

  await triggerRecovery();

  const row = readTask(id);
  expect(row.status).toBe('pending');
  expect(row.claimed_by).toBeNull();
  expect(row.claim_expires_at).toBeNull();
  expect(row.next_retry_at).not.toBeNull();
}, 30_000);

test('expired claimed task (attempt >= max_attempts) is promoted to dead (TQ-D-003)', async () => {
  const stamp = `${Date.now()}-b`;
  const id = await enqueue(stamp);
  await claimTask(`stale_agent_${stamp}`);

  // Force expiry and set attempt=3, max_attempts=3
  setAttempt(id, 3, 3);
  expireClaim(id);

  await triggerRecovery();

  const row = readTask(id);
  expect(row.status).toBe('dead');
  expect(row.claimed_by).toBeNull();
  expect(row.claim_expires_at).toBeNull();
  expect(row.next_retry_at).toBeNull();
}, 30_000);

test('unexpired claimed task is left intact (TQ-D-003)', async () => {
  const stamp = `${Date.now()}-c`;
  const id = await enqueue(stamp);
  await claimTask(`stale_agent_${stamp}`);

  // Do NOT expire the claim — default TTL is 300s, well in the future
  await triggerRecovery();

  const row = readTask(id);
  expect(row.status).toBe('claimed');
  expect(row.claimed_by).not.toBeNull();
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
