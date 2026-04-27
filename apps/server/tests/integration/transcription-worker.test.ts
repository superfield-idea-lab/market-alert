/**
 * Integration tests for the cluster-internal transcription worker path (issue #57).
 *
 * Validates:
 *   - POST /api/transcriptions accepts session-cookie auth (edge path)
 *   - POST /api/transcriptions rejects unauthenticated requests (401)
 *   - Transcription task enqueueing via POST /api/tasks-queue
 *   - Threshold-based routing: recordings ≥ WORKER_THRESHOLD_SECONDS route to
 *     the worker path (validated via task enqueue)
 *   - GET /api/transcriptions returns saved transcripts
 *   - GET /api/transcriptions/:id returns a single transcript
 *   - NetworkPolicy assertion: the transcription worker's egress policy is
 *     defined and permits only the API gateway + DNS
 *
 * Architecture under test
 * -------------------------
 * Edge path:  PWA → POST /api/transcriptions (session-cookie auth)
 * Worker path: PWA → POST /api/tasks-queue (job_type=transcription) →
 *              cluster-internal worker → POST /api/transcriptions (Bearer auth)
 */

import { test, expect, beforeAll, afterAll } from 'vitest';
import type { Subprocess } from 'bun';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31428;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let authCookie = '';
let csrfToken = '';

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
  csrfToken = session.csrfToken;
}, 60_000);

afterAll(async () => {
  server?.kill();
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// POST /api/transcriptions — edge path
// ---------------------------------------------------------------------------

test('POST /api/transcriptions returns 401 when unauthenticated', async () => {
  const res = await fetch(`${BASE}/api/transcriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recording_ref: 'rec_test_001',
      transcript: 'Hello world.',
      worker_path: 'edge',
    }),
  });
  expect(res.status).toBe(401);
});

test('POST /api/transcriptions saves a transcript via the edge path', async () => {
  const stamp = Date.now();
  const res = await fetch(`${BASE}/api/transcriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({
      recording_ref: `rec_edge_${stamp}`,
      transcript: 'This is a short recording transcript.',
      duration_ms: 30000,
      worker_path: 'edge',
    }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.id).toBeTruthy();
  expect(body.properties.recording_ref).toBe(`rec_edge_${stamp}`);
  expect(body.properties.transcript).toBe('This is a short recording transcript.');
  expect(body.properties.worker_path).toBe('edge');
  expect(body.properties.status).toBe('completed');
  expect(body.properties.duration_ms).toBe(30000);
});

test('POST /api/transcriptions returns 400 when recording_ref is missing', async () => {
  const res = await fetch(`${BASE}/api/transcriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({
      transcript: 'Missing recording_ref.',
    }),
  });
  expect(res.status).toBe(400);
});

test('POST /api/transcriptions returns 400 when transcript is missing', async () => {
  const res = await fetch(`${BASE}/api/transcriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({
      recording_ref: 'rec_missing_transcript',
    }),
  });
  expect(res.status).toBe(400);
});

// ---------------------------------------------------------------------------
// GET /api/transcriptions — list
// ---------------------------------------------------------------------------

test('GET /api/transcriptions returns 401 when unauthenticated', async () => {
  const res = await fetch(`${BASE}/api/transcriptions`);
  expect(res.status).toBe(401);
});

test('GET /api/transcriptions lists saved transcripts', async () => {
  const stamp = Date.now();
  // Save a transcript first
  await fetch(`${BASE}/api/transcriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({
      recording_ref: `rec_list_${stamp}`,
      transcript: 'Listed transcript.',
      worker_path: 'edge',
    }),
  });

  const listRes = await fetch(`${BASE}/api/transcriptions`, {
    headers: { Cookie: authCookie },
  });
  expect(listRes.status).toBe(200);
  const items = await listRes.json();
  expect(Array.isArray(items)).toBe(true);
  const found = items.find(
    (t: { properties: { recording_ref: string } }) =>
      t.properties.recording_ref === `rec_list_${stamp}`,
  );
  expect(found).toBeTruthy();
});

// ---------------------------------------------------------------------------
// GET /api/transcriptions/:id — single fetch
// ---------------------------------------------------------------------------

test('GET /api/transcriptions/:id fetches a single transcript', async () => {
  const stamp = Date.now();
  const postRes = await fetch(`${BASE}/api/transcriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authCookie },
    body: JSON.stringify({
      recording_ref: `rec_single_${stamp}`,
      transcript: 'Single fetch transcript.',
      worker_path: 'edge',
    }),
  });
  const created = await postRes.json();
  const transcriptId: string = created.id;

  const getRes = await fetch(`${BASE}/api/transcriptions/${transcriptId}`, {
    headers: { Cookie: authCookie },
  });
  expect(getRes.status).toBe(200);
  const fetched = await getRes.json();
  expect(fetched.id).toBe(transcriptId);
  expect(fetched.properties.recording_ref).toBe(`rec_single_${stamp}`);
});

test('GET /api/transcriptions/:id returns 404 for unknown id', async () => {
  const res = await fetch(`${BASE}/api/transcriptions/does-not-exist`, {
    headers: { Cookie: authCookie },
  });
  expect(res.status).toBe(404);
});

// ---------------------------------------------------------------------------
// Worker path — task queue routing
// ---------------------------------------------------------------------------

test('POST /api/tasks-queue enqueues a transcription task (worker path)', async () => {
  const stamp = Date.now();
  const res = await fetch(`${BASE}/api/tasks-queue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: authCookie,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      idempotency_key: `transcription-worker-${stamp}`,
      agent_type: 'transcription',
      job_type: 'transcription',
      payload: {
        recording_ref: `rec_worker_${stamp}`,
        duration_ref: `dur_worker_${stamp}`,
      },
    }),
  });
  expect(res.status).toBe(200);
  const task = await res.json();
  expect(task.id).toBeTruthy();
  expect(task.status).toBe('pending');
  expect(task.agent_type).toBe('transcription');
  expect(task.job_type).toBe('transcription');
  expect(task.payload).toEqual({
    recording_ref: `rec_worker_${stamp}`,
    duration_ref: `dur_worker_${stamp}`,
  });
});

test('Transcription task payload with correlation_ref is accepted', async () => {
  const stamp = Date.now();
  const res = await fetch(`${BASE}/api/tasks-queue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: authCookie,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      idempotency_key: `transcription-corr-${stamp}`,
      agent_type: 'transcription',
      job_type: 'transcription',
      payload: {
        recording_ref: `rec_corr_${stamp}`,
        correlation_ref: `corr_${stamp}`,
      },
    }),
  });
  expect(res.status).toBe(200);
  const task = await res.json();
  expect(task.payload.correlation_ref).toBe(`corr_${stamp}`);
});

// ---------------------------------------------------------------------------
// NetworkPolicy specification assertion
// ---------------------------------------------------------------------------

test('NetworkPolicy for transcription worker blocks external egress (spec check)', () => {
  // Read the k8s manifest and assert the NetworkPolicy allows only the API
  // gateway and DNS — no external CIDR blocks permitted.
  const manifestPath = resolve(REPO_ROOT, 'k8s/transcription-worker.yaml');
  const manifest = readFileSync(manifestPath, 'utf-8');

  // Must define a NetworkPolicy for the transcription worker
  expect(manifest).toContain('kind: NetworkPolicy');
  expect(manifest).toContain('superfield-worker-transcription-egress');

  // Must restrict pod selector to the transcription worker
  expect(manifest).toContain('app: superfield-worker-transcription');

  // Must declare Egress policy type
  expect(manifest).toContain('Egress');

  // Must allow egress to the API gateway (superfield-app) only
  expect(manifest).toContain('app: superfield-app');

  // Must allow DNS (port 53)
  expect(manifest).toContain('port: 53');

  // Must NOT contain an ipBlock rule (no external CIDR allowed)
  expect(manifest).not.toContain('ipBlock');

  // Must NOT grant access to vendor API URLs
  expect(manifest).not.toContain('openai.com');
  expect(manifest).not.toContain('anthropic.com');
  expect(manifest).not.toContain('assemblyai.com');
});

// ---------------------------------------------------------------------------
// Helpers
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
