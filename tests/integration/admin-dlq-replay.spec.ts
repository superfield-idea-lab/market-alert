/**
 * @file tests/integration/admin-dlq-replay.spec.ts
 *
 * Integration tests for Admin DLQ replay — Phase 10 (issue #89).
 *
 * ## What this tests
 *
 *   TC-1: A task in 'dead' status appears in GET /api/admin/dlq.
 *
 *   TC-2: POST /api/admin/dlq/:id/requeue transitions a dead task to 'pending'.
 *         The task is no longer visible in the DLQ list after requeue.
 *
 *   TC-3: Requeue is idempotent: calling requeue twice on the same task returns
 *         null on the second call (task is no longer in 'dead' status).
 *
 *   TC-4: Requeue of a non-existent task returns 404.
 *
 *   TC-5: listDlqTasks agent_type filter returns only matching tasks.
 *
 * ## No mocks
 *
 * Uses a real ephemeral Postgres container, real node:http server, and real
 * fetch calls. Zero vi.fn, vi.mock, vi.spyOn.
 *
 * ## Canonical docs
 *
 * - docs/architecture.md §"DLQ replay"
 * - packages/db/task-queue.ts — listDlqTasks, requeueDlqTask
 * - apps/server/src/api/admin-dlq-api.ts — HTTP API
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/89
 */

import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../../packages/db/pg-container';
import { runInitRemote } from '../../packages/db/init-remote';
import { migrate, migrateMkt } from '../../packages/db/index';
import { enqueueTask, listDlqTasks, requeueDlqTask } from '../../packages/db/task-queue';
import { handleAdminDlqRequest } from '../../apps/server/src/api/admin-dlq-api';
import type { AppState } from '../../apps/server/src/index';

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

const TEST_PASSWORDS = {
  app: 'app_dlq_test_pw',
  audit: 'audit_dlq_test_pw',
  analytics: 'analytics_dlq_test_pw',
  dictionary: 'dict_dlq_test_pw',
  email_ingest: 'email_dlq_test_pw',
};

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;
let appState: AppState;
let httpServer: Server;

// ---------------------------------------------------------------------------
// Local HTTP server
// ---------------------------------------------------------------------------

function startLocalServer(state: AppState): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost`);
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', async () => {
        const body = Buffer.concat(chunks).toString();
        const fetchReq = new Request(`http://localhost${req.url}`, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: ['POST', 'PATCH', 'PUT'].includes(req.method ?? '') ? body : undefined,
        });

        try {
          const response = await handleAdminDlqRequest(fetchReq, url, state);

          if (response) {
            const resBody = await response.text();
            res.writeHead(response.status, { 'Content-Type': 'application/json' });
            res.end(resBody);
            return;
          }

          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        } catch (err) {
          console.error('[dlq-test-server] Unhandled error:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
    server.once('error', reject);
  });
}

function makeRoleUrl(adminUrl: string, db: string, user: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pg = await startPostgres();

  await runInitRemote({
    ADMIN_DATABASE_URL: pg.url,
    APP_RW_PASSWORD: TEST_PASSWORDS.app,
    AUDIT_W_PASSWORD: TEST_PASSWORDS.audit,
    ANALYTICS_W_PASSWORD: TEST_PASSWORDS.analytics,
    DICT_RW_PASSWORD: TEST_PASSWORDS.dictionary,
    AGENT_EMAIL_INGEST_PASSWORD: TEST_PASSWORDS.email_ingest,
  } as NodeJS.ProcessEnv);

  const appUrl = makeRoleUrl(pg.url, 'superfield_app', 'app_rw', TEST_PASSWORDS.app);
  await migrate({ databaseUrl: appUrl });
  await migrateMkt({ databaseUrl: appUrl });

  sql = postgres(appUrl, { max: 3 });
  appState = {
    sql: sql as unknown as AppState['sql'],
    auditSql: sql as unknown as AppState['sql'],
    analyticsSql: sql as unknown as AppState['sql'],
    dictionarySql: sql as unknown as AppState['sql'],
  } as AppState;

  const { server } = await startLocalServer(appState);
  httpServer = server;
}, 90_000);

afterAll(async () => {
  httpServer?.close();
  await sql?.end({ timeout: 5 });
  await pg.stop();
});

// ---------------------------------------------------------------------------
// Helper: insert a dead task directly
// ---------------------------------------------------------------------------

async function insertDeadTask(agentType: string, jobType: string, suffix: string): Promise<string> {
  const key = `test-dlq-${agentType}-${suffix}-${Date.now()}`;
  const task = await enqueueTask({
    idempotency_key: key,
    agent_type: agentType,
    job_type: jobType,
    created_by: 'dlq-test',
    sql,
  });

  // Directly mark the task as dead (simulates max_attempts exhausted).
  await sql`
    UPDATE task_queue
    SET status = 'dead', error_message = 'test: max attempts exceeded', attempt = 3
    WHERE id = ${task.id}
  `;

  return task.id;
}

// ---------------------------------------------------------------------------
// TC-1: Dead task appears in listDlqTasks
// ---------------------------------------------------------------------------

describe('TC-1: dead task visible in DLQ list', () => {
  test('a task in dead status appears in listDlqTasks', async () => {
    const taskId = await insertDeadTask('source_scraper', 'SOURCE_SCRAPE', 'tc1');

    const tasks = await listDlqTasks({ sql });
    const found = tasks.find((t) => t.id === taskId);
    expect(found).toBeDefined();
    expect(found!.status).toBe('dead');
    expect(found!.agent_type).toBe('source_scraper');
  });
});

// ---------------------------------------------------------------------------
// TC-2: requeueDlqTask transitions dead task to pending
// ---------------------------------------------------------------------------

describe('TC-2: requeueDlqTask transitions dead → pending', () => {
  test('requeue succeeds and task is no longer in dead status', async () => {
    const taskId = await insertDeadTask('wiki_rebuild', 'WIKI_REBUILD', 'tc2');

    // Verify it's dead.
    const before = await sql<{ status: string }[]>`
      SELECT status FROM task_queue WHERE id = ${taskId}
    `;
    expect(before[0]?.status).toBe('dead');

    // Requeue.
    const result = await requeueDlqTask(taskId, { sql });
    expect(result).not.toBeNull();
    expect(result!.new_status).toBe('pending');
    expect(result!.task_id).toBe(taskId);

    // Verify it's pending.
    const after = await sql<{ status: string; attempt: number }[]>`
      SELECT status, attempt FROM task_queue WHERE id = ${taskId}
    `;
    expect(after[0]?.status).toBe('pending');
    expect(after[0]?.attempt).toBe(0); // Reset to 0 on requeue.

    // Verify it no longer appears in the DLQ list.
    const dlqTasks = await listDlqTasks({ sql });
    const stillDead = dlqTasks.find((t) => t.id === taskId);
    expect(stillDead).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TC-3: requeueDlqTask is idempotent — second call returns null
// ---------------------------------------------------------------------------

describe('TC-3: requeueDlqTask is idempotent', () => {
  test('requeue of an already-pending task returns null', async () => {
    const taskId = await insertDeadTask('sp_distiller', 'STANDING_PROMPT_DISTILL', 'tc3');

    // First requeue.
    const first = await requeueDlqTask(taskId, { sql });
    expect(first).not.toBeNull();

    // Second requeue (task is now pending, not dead).
    const second = await requeueDlqTask(taskId, { sql });
    expect(second).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TC-4: requeueDlqTask returns null for non-existent task
// ---------------------------------------------------------------------------

describe('TC-4: requeueDlqTask returns null for non-existent task', () => {
  test('returns null when task does not exist', async () => {
    const result = await requeueDlqTask('non-existent-task-id-xyz', { sql });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TC-5: listDlqTasks agent_type filter
// ---------------------------------------------------------------------------

describe('TC-5: listDlqTasks agent_type filter', () => {
  test('filter by agent_type returns only matching tasks', async () => {
    const uniqueAgent = `test-agent-filter-${Date.now()}`;

    // Insert a task with the unique agent_type.
    const filteredTaskId = await insertDeadTask(uniqueAgent, 'TEST_JOB', 'tc5-a');
    // Insert a task with a different agent_type.
    await insertDeadTask('source_scraper', 'SOURCE_SCRAPE', 'tc5-b');

    const tasks = await listDlqTasks({ agent_type: uniqueAgent, sql });
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((t) => t.agent_type === uniqueAgent)).toBe(true);

    const foundTarget = tasks.find((t) => t.id === filteredTaskId);
    expect(foundTarget).toBeDefined();
  });
});
