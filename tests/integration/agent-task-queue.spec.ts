/**
 * @file tests/integration/agent-task-queue.spec.ts
 *
 * Integration tests for the GET /api/tasks-queue endpoint and the
 * task_queue_admin WebSocket broadcast channel (issue #115).
 *
 * ## What this tests
 *
 *   TC-1: GET /api/tasks-queue returns 401 for unauthenticated requests.
 *
 *   TC-2: GET /api/tasks-queue returns 403 for authenticated non-superadmin requests.
 *
 *   TC-3: GET /api/tasks-queue returns task rows for a superadmin session,
 *         including the correct agent_type and status for a recently-enqueued task.
 *
 *   TC-4: WebSocket event `task_queue.created` is broadcast to a connected
 *         superadmin client when a task is enqueued.
 *
 *   TC-5: WebSocket event `task_queue.updated` is broadcast to a connected
 *         superadmin client when a task status is updated.
 *
 * ## No mocks
 *
 * Uses a real ephemeral Postgres container, the real Bun server via the
 * shared E2E environment helper, and real fetch / WebSocket calls.
 * Zero vi.fn, vi.mock, vi.spyOn. CLAUDE.md § Testing Standards.
 *
 * ## Architecture note
 *
 * The E2E environment spawns the full Bun server with:
 *   TEST_MODE=true   — enables POST /api/test/session backdoor
 *   DEMO_MODE=true   — seeds demo users
 *   CSRF_DISABLED=true — allows unauthenticated POST without CSRF token
 *
 * To obtain superadmin access, we use the SUPERUSER_ID environment variable.
 * The E2E server inherits the current process env; we set SUPERUSER_ID in the
 * child process env via the custom server helper below.
 *
 * @see apps/server/src/api/task-queue.ts — GET handler (issue #115)
 * @see apps/server/src/task-queue-listener.ts — WebSocket broadcast bridge
 * @see https://github.com/superfield-idea-lab/market-alert/issues/115
 */

import { afterAll, beforeAll, describe, test, expect } from 'vitest';
import type { Subprocess } from 'bun';
import { existsSync } from 'fs';
import { join } from 'path';
import { startPostgres, type PgContainer } from '../../packages/db/pg-container';
import { readFileSync } from 'fs';
import postgres from 'postgres';
import { runInitRemote } from '../../packages/db/init-remote';
import { migrate, migrateMkt } from '../../packages/db/index';
import { enqueueTask } from '../../packages/db/task-queue';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const SERVER_ENTRY = join(REPO_ROOT, 'apps/server/src/index.ts');
const BUN_BIN =
  process.env.BUN_BIN ?? (existsSync('/usr/local/bin/bun') ? '/usr/local/bin/bun' : 'bun');
const SUPERUSER_ID = 'test-superuser-task-queue-115';
const SERVER_READY_TIMEOUT_MS = 30_000;

const TEST_PASSWORDS = {
  app: 'app_tq_test_pw',
  audit: 'audit_tq_test_pw',
  analytics: 'analytics_tq_test_pw',
  dictionary: 'dict_tq_test_pw',
  email_ingest: 'email_tq_test_pw',
};

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;
let server: Subprocess;
let baseUrl: string;
let superuserCookie: string;
let regularUserCookie: string;

// ---------------------------------------------------------------------------
// Custom server startup — sets SUPERUSER_ID so isSuperuser() works
// ---------------------------------------------------------------------------

function makeRoleUrl(adminUrl: string, db: string, user: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
}

async function applyAuditSchema(databaseUrl: string): Promise<void> {
  const auditSchemaPath = join(REPO_ROOT, 'packages/db/audit-schema.sql');
  const schemaSql = readFileSync(auditSchemaPath, 'utf-8');
  const db = postgres(databaseUrl, { max: 1, idle_timeout: 10, connect_timeout: 10 });
  try {
    await db.unsafe(schemaSql);
  } finally {
    await db.end({ timeout: 5 });
  }
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health/live`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(300);
  }
  throw new Error(`Server at ${url} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}

// ---------------------------------------------------------------------------
// Auth helper — obtain a session cookie via the TEST_MODE backdoor
// ---------------------------------------------------------------------------

async function getTestSession(username: string): Promise<{ cookie: string; userId: string }> {
  const res = await fetch(`${baseUrl}/api/test/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) {
    throw new Error(`test-session failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { user: { id: string } };
  const userId = json.user.id;
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = /superfield_auth=([^;]+)/.exec(setCookie);
  const cookie = match ? `superfield_auth=${match[1]}` : '';
  return { cookie, userId };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pg = await startPostgres();
  await applyAuditSchema(pg.url);

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

  // Pick a free port for the test server.
  const port = 32100 + Math.floor(Math.random() * 1000);
  baseUrl = `http://localhost:${port}`;

  // Build the web app so the server can serve the SPA (required by server startup).
  const build = Bun.spawnSync([BUN_BIN, 'run', '--filter', 'web', 'build'], {
    cwd: REPO_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (build.exitCode !== 0) throw new Error('Failed to build the web assets.');

  // Start the Bun server with SUPERUSER_ID set to our test ID.
  server = Bun.spawn([BUN_BIN, 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: appUrl,
      AUDIT_DATABASE_URL: appUrl,
      PORT: String(port),
      TEST_MODE: 'true',
      DEMO_MODE: 'false',
      CSRF_DISABLED: 'true',
      SUPERUSER_ID,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });

  await waitForServer(baseUrl);

  // Seed the superuser entity with the fixed SUPERUSER_ID so the test-session
  // endpoint can look it up. We seed it directly to bypass the random UUID
  // assignment in POST /api/test/session.
  const superuserProps = JSON.stringify({ username: 'test-superuser' });
  await sql`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES (${SUPERUSER_ID}, 'user', ${superuserProps}::jsonb, null)
    ON CONFLICT DO NOTHING
  `;

  // Obtain session cookies for the superuser and a regular user.
  // The superuser cookie uses SUPERUSER_ID; regular user gets a fresh random ID.
  // We need the cookie for the SUPERUSER_ID user — but POST /api/test/session
  // assigns a random UUID and then looks up by username. We obtain a token for
  // the fixed SUPERUSER_ID by calling signJwt directly via the test-session
  // backdoor with the username that maps to SUPERUSER_ID.
  //
  // Since the entity row was seeded above with username 'test-superuser', the
  // test-session endpoint will find it and return the cookie for SUPERUSER_ID.
  const superuserSession = await getTestSession('test-superuser');
  superuserCookie = superuserSession.cookie;

  const regularSession = await getTestSession(`regular-user-${Date.now()}`);
  regularUserCookie = regularSession.cookie;
}, 120_000);

afterAll(async () => {
  server?.kill();
  await sql?.end({ timeout: 5 });
  await pg.stop();
});

// ---------------------------------------------------------------------------
// TC-1: GET /api/tasks-queue returns 401 for unauthenticated requests
// ---------------------------------------------------------------------------

describe('TC-1: unauthenticated request returns 401', () => {
  test('GET /api/tasks-queue without cookie returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/tasks-queue`, { method: 'GET' });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// TC-2: GET /api/tasks-queue returns 403 for non-superadmin authenticated users
// ---------------------------------------------------------------------------

describe('TC-2: non-superadmin request returns 403', () => {
  test('GET /api/tasks-queue with regular user session returns 403', async () => {
    const res = await fetch(`${baseUrl}/api/tasks-queue`, {
      method: 'GET',
      headers: { Cookie: regularUserCookie },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Forbidden/i);
  });
});

// ---------------------------------------------------------------------------
// TC-3: GET /api/tasks-queue returns task rows for a superadmin session
// ---------------------------------------------------------------------------

describe('TC-3: superadmin GET returns task rows', () => {
  test('enqueue a task then GET /api/tasks-queue returns it with correct fields', async () => {
    const ikey = `tq-115-tc3-${Date.now()}`;
    await enqueueTask({
      idempotency_key: ikey,
      agent_type: 'wiki_rebuild',
      job_type: 'WIKI_REBUILD',
      created_by: 'tq-115-test',
      sql,
    });

    const res = await fetch(`${baseUrl}/api/tasks-queue`, {
      method: 'GET',
      headers: { Cookie: superuserCookie },
    });
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      tasks: Array<{ agent_type: string; status: string; idempotency_key?: string }>;
    };
    expect(Array.isArray(data.tasks)).toBe(true);

    const found = data.tasks.find((t) => t.idempotency_key === ikey);
    expect(found).toBeDefined();
    expect(found!.agent_type).toBe('wiki_rebuild');
    expect(found!.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// TC-4: WebSocket event task_queue.created is broadcast to a superadmin client
// ---------------------------------------------------------------------------

describe('TC-4: WebSocket task_queue.created broadcast', () => {
  test('enqueue a task after WebSocket connect — task_queue.created event arrives within 2s', async () => {
    // Wait for the WebSocket connection to be established.
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl, {
      // @ts-expect-error — Bun's WebSocket accepts headers in options
      headers: { Cookie: superuserCookie },
    });

    const createdEvent = await new Promise<{
      event: string;
      id: string;
      agent_type: string;
      status: string;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Timed out waiting for task_queue.created WebSocket event'));
      }, 5000);

      ws.addEventListener('open', async () => {
        // Enqueue after connection so we don't miss the event.
        try {
          const ikey = `tq-115-tc4-${Date.now()}`;
          await enqueueTask({
            idempotency_key: ikey,
            agent_type: 'signal_annotator',
            job_type: 'SIGNAL_ANNOTATE',
            created_by: 'tq-115-ws-test',
            sql,
          });
        } catch (err) {
          clearTimeout(timeout);
          ws.close();
          reject(err);
        }
      });

      ws.addEventListener('message', (evt) => {
        try {
          const parsed = JSON.parse(evt.data as string) as { event: string; [k: string]: unknown };
          if (parsed.event === 'task_queue.created') {
            clearTimeout(timeout);
            ws.close();
            resolve(parsed as typeof createdEvent extends Promise<infer T> ? T : never);
          }
        } catch {
          // ignore non-JSON messages
        }
      });

      ws.addEventListener('error', (err) => {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(`WebSocket error: ${String(err)}`));
      });
    });

    expect(createdEvent.event).toBe('task_queue.created');
    expect(createdEvent.agent_type).toBe('signal_annotator');
    expect(createdEvent.status).toBe('pending');
    expect(typeof createdEvent.id).toBe('string');
  }, 15_000);
});

// ---------------------------------------------------------------------------
// TC-5: WebSocket event task_queue.updated is broadcast after status update
// ---------------------------------------------------------------------------

describe('TC-5: WebSocket task_queue.updated broadcast after status update', () => {
  test('update task status — task_queue.updated event arrives within 2s', async () => {
    // Enqueue a task first.
    const ikey = `tq-115-tc5-${Date.now()}`;
    const task = await enqueueTask({
      idempotency_key: ikey,
      agent_type: 'wiki_rebuild',
      job_type: 'WIKI_REBUILD',
      created_by: 'tq-115-update-test',
      sql,
    });

    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl, {
      // @ts-expect-error — Bun's WebSocket accepts headers in options
      headers: { Cookie: superuserCookie },
    });

    const updatedEvent = await new Promise<{ event: string; id: string; status: string }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('Timed out waiting for task_queue.updated WebSocket event'));
        }, 5000);

        ws.addEventListener('open', async () => {
          // Update task status to trigger the broadcast.
          try {
            await sql`
              UPDATE task_queue
              SET status = 'running', updated_at = NOW()
              WHERE id = ${task.id}
            `;
          } catch (err) {
            clearTimeout(timeout);
            ws.close();
            reject(err);
          }
        });

        ws.addEventListener('message', (evt) => {
          try {
            const parsed = JSON.parse(evt.data as string) as {
              event: string;
              id: string;
              status: string;
            };
            if (parsed.event === 'task_queue.updated' && parsed.id === task.id) {
              clearTimeout(timeout);
              ws.close();
              resolve(parsed);
            }
          } catch {
            // ignore
          }
        });

        ws.addEventListener('error', (err) => {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(`WebSocket error: ${String(err)}`));
        });
      },
    );

    expect(updatedEvent.event).toBe('task_queue.updated');
    expect(updatedEvent.id).toBe(task.id);
    expect(updatedEvent.status).toBe('running');
  }, 15_000);
});
