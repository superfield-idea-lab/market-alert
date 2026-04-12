/**
 * Integration tests for claim-citation coverage check on autolearn drafts (issue #43).
 *
 * Validates:
 *   - Feed a fixture draft with uncited claims → P1 marking + publication block
 *   - Feed a fixture draft with full citations → coverage check passes
 *   - Attempt to publish a P1 draft → 422 rejection
 *
 * Test plan items covered:
 *   - Integration: feed a fixture draft with uncited claims and assert P1 + publication block
 *   - Integration: feed a fixture draft with full citations and assert pass
 *   - Integration: attempt to publish a P1 draft and assert rejection
 *
 * No mocks — real Postgres + real Bun server via the shared pg-container helper.
 */

import { test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31429;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 20_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

// Fixture paths (relative to repo root)
const FIXTURES_DIR = join(REPO_ROOT, 'tests/fixtures/wiki-drafts');
const UNCITED_DRAFT = readFileSync(join(FIXTURES_DIR, 'uncited-draft.md'), 'utf8');
const FULLY_CITED_DRAFT = readFileSync(join(FIXTURES_DIR, 'fully-cited-draft.md'), 'utf8');

let pg: PgContainer;
let server: Subprocess;
let sessionCookie = '';

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
      CSRF_DISABLED: 'true',
      // Set the SLA threshold explicitly for deterministic tests.
      CITATION_COVERAGE_THRESHOLD: '0.99',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);

  const session = await createTestSession(BASE, { username: `wiki_user_${Date.now()}` });
  sessionCookie = session.cookie;
}, 60_000);

afterAll(async () => {
  server?.kill();
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Test: uncited draft → P1 + publication block
// ---------------------------------------------------------------------------

test('draft with uncited claims is marked P1 and publication_blocked', async () => {
  const res = await fetch(`${BASE}/api/wiki/versions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ content: UNCITED_DRAFT }),
  });

  expect(res.status).toBe(201);
  const body = (await res.json()) as Record<string, unknown>;

  // The coverage check must have flagged this draft as failing.
  const check = body.coverage_check as Record<string, unknown>;
  expect(check.passes).toBe(false);
  expect(check.marked_p1).toBe(true);
  expect(Number(check.uncited_claims)).toBeGreaterThan(0);

  // The entity properties must reflect the P1 marking.
  const props = body.properties as Record<string, unknown>;
  expect(props.priority).toBe('P1');
  expect(props.publication_blocked).toBe(true);
});

// ---------------------------------------------------------------------------
// Test: fully cited draft → passes coverage check
// ---------------------------------------------------------------------------

test('draft with full citations passes the coverage check', async () => {
  const res = await fetch(`${BASE}/api/wiki/versions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ content: FULLY_CITED_DRAFT }),
  });

  expect(res.status).toBe(201);
  const body = (await res.json()) as Record<string, unknown>;

  const check = body.coverage_check as Record<string, unknown>;
  expect(check.passes).toBe(true);
  expect(check.marked_p1).toBe(false);
  expect(Number(check.coverage)).toBeGreaterThanOrEqual(0.99);

  const props = body.properties as Record<string, unknown>;
  expect(props.publication_blocked).toBe(false);
});

// ---------------------------------------------------------------------------
// Test: attempt to publish a P1 draft → 422 rejection
// ---------------------------------------------------------------------------

test('publishing a P1 draft is rejected with 422', async () => {
  // Create a P1 draft (uncited).
  const createRes = await fetch(`${BASE}/api/wiki/versions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ content: UNCITED_DRAFT }),
  });

  expect(createRes.status).toBe(201);
  const created = (await createRes.json()) as {
    id: string;
    coverage_check: Record<string, unknown>;
  };
  expect(created.coverage_check.marked_p1).toBe(true);

  // Attempt to publish the P1 draft.
  const publishRes = await fetch(`${BASE}/api/wiki/versions/${created.id}/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
  });

  expect(publishRes.status).toBe(422);
  const err = (await publishRes.json()) as Record<string, unknown>;
  expect(typeof err.error).toBe('string');
  expect(String(err.error).toLowerCase()).toContain('publication blocked');
});

// ---------------------------------------------------------------------------
// Test: coverage threshold is configurable (≥99% passes)
// ---------------------------------------------------------------------------

test('a draft at 99%+ coverage passes the check', async () => {
  const res = await fetch(`${BASE}/api/wiki/versions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ content: FULLY_CITED_DRAFT }),
  });

  expect(res.status).toBe(201);
  const body = (await res.json()) as Record<string, unknown>;
  const check = body.coverage_check as Record<string, unknown>;

  expect(check.sla_threshold).toBe(0.99);
  expect(Number(check.coverage)).toBeGreaterThanOrEqual(0.99);
  expect(check.passes).toBe(true);
});

// ---------------------------------------------------------------------------
// Helper — wait for the server to be ready
// ---------------------------------------------------------------------------

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/health/live`);
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}
