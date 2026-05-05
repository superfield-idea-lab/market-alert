import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { startPostgres, type PgContainer } from '../helpers/pg-container';

// Each test run gets its own isolated postgres container + server process.
// No external infrastructure required — just Docker.

const PORT = 31416; // separate from dev server (31415) to allow parallel use
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
// Path relative to repo root — Bun needs to run from there to resolve workspace packages.
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;

beforeAll(async () => {
  // 1. Start an isolated postgres container
  pg = await startPostgres();

  // 2. Start the server as a subprocess, pointed at the container
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

  // 3. Wait until the server is accepting requests
  await waitForServer(BASE);
}, 60_000);

afterAll(async () => {
  server?.kill();
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Health endpoint integration tests — Phase 0 dev-scout (DEPLOY-C-030/031/032)
// Boots the real server (same commands CI uses) and asserts all three health
// routes return 200 with well-formed JSON. No mocks.
// ---------------------------------------------------------------------------

test('GET /health/live returns 200 with status ok and version', async () => {
  const res = await fetch(`${BASE}/health/live`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string; version: string };
  expect(body.status).toBe('ok');
  expect(typeof body.version).toBe('string');
});

test('GET /health returns 200 (liveness alias)', async () => {
  const res = await fetch(`${BASE}/health`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string };
  expect(body.status).toBe('ok');
});

test('GET /healthz returns 200 (k8s liveness alias)', async () => {
  const res = await fetch(`${BASE}/healthz`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string };
  expect(body.status).toBe('ok');
});

test('GET /health/ready returns 200 with status ok and db check', async () => {
  const res = await fetch(`${BASE}/health/ready`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string; checks?: Record<string, string> };
  expect(body.status).toBe('ok');
  expect(body.checks?.db).toBe('ok');
});

test('GET /health/deep returns 200 with status ok and all subsystem checks', async () => {
  const res = await fetch(`${BASE}/health/deep`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string; checks?: Record<string, string> };
  expect(body.status).toBe('ok');
  expect(body.checks?.db_app).toBe('ok');
  expect(body.checks?.db_audit).toBe('ok');
  expect(body.checks?.db_analytics).toBe('ok');
  expect(body.checks?.task_queue).toBe('ok');
});

// ---------------------------------------------------------------------------

/** Poll the server's health until it responds or we time out. */
async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/health/live`);
      return; // any response means the server is up
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}
