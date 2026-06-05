/**
 * @file admin-source-scope.spec.ts
 *
 * End-to-end tests verifying that the demo admin persona can reach admin
 * endpoints and that the seeded fixture data is visible through those endpoints.
 *
 * These tests are API-level (no browser) and complement the integration tests
 * under tests/integration/. The key additional guarantee here is that the
 * canonical demo seed data is visible to the admin role — confirming that the
 * demo and the test suite start from identical state.
 *
 * Test coverage:
 *   - GET  /api/admin/pipeline-health   — admin reaches 501 stub, not 401/403
 *   - GET  /api/admin/pipeline-health/sources/:id — same
 *   - GET  /api/cost/status             — returns seeded budget for researcher
 *   - PATCH /api/admin/cost-budget      — admin can update researcher budget
 *   - Auth gate: non-admin gets 403; unauthenticated gets 401
 *
 * No mocks — real Bun server + Postgres via the shared E2E environment.
 *
 * @see packages/db/demo-seed.ts          — fixture definitions
 * @see tests/e2e/fixtures.ts             — getFixtureSession helper
 * @see apps/server/src/api/pipeline-health-api.ts
 * @see apps/server/src/api/cost-telemetry-api.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startE2EServer, stopE2EServer, type E2EEnvironment } from './environment';
import { DEMO_FIXTURES, getFixtureSession } from './fixtures';

let env: E2EEnvironment;

beforeAll(async () => {
  env = await startE2EServer();
});

afterAll(async () => {
  await stopE2EServer(env);
});

// ---------------------------------------------------------------------------
// Pipeline health
// ---------------------------------------------------------------------------

describe('pipeline health — auth gates', () => {
  test('unauthenticated request returns 401', async () => {
    const res = await fetch(`${env.baseUrl}/api/admin/pipeline-health`);
    expect(res.status).toBe(401);
  });

  test('researcher (non-admin) gets 403', async () => {
    const session = await getFixtureSession(env.baseUrl, 'researcher');
    const res = await fetch(`${env.baseUrl}/api/admin/pipeline-health`, {
      headers: { Cookie: session.cookie.split(';')[0] },
    });
    expect(res.status).toBe(403);
  });

  test('admin role reaches the endpoint (returns 501 stub, not 401/403)', async () => {
    const session = await getFixtureSession(env.baseUrl, 'admin');
    const res = await fetch(`${env.baseUrl}/api/admin/pipeline-health`, {
      headers: { Cookie: session.cookie.split(';')[0] },
    });
    // The endpoint is a 501 stub — the auth gate must have passed.
    expect([200, 501]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  test('GET /api/admin/pipeline-health/sources/:id — admin passes auth', async () => {
    const session = await getFixtureSession(env.baseUrl, 'admin');
    const res = await fetch(
      `${env.baseUrl}/api/admin/pipeline-health/sources/${DEMO_FIXTURES.source.id}`,
      { headers: { Cookie: session.cookie.split(';')[0] } },
    );
    expect([200, 501]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Cost telemetry
// ---------------------------------------------------------------------------

describe('cost telemetry — fixture budget', () => {
  test('researcher can GET /api/cost/status and sees seeded budget', async () => {
    const session = await getFixtureSession(env.baseUrl, 'researcher');
    const res = await fetch(`${env.baseUrl}/api/cost/status`, {
      headers: { Cookie: session.cookie.split(';')[0] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      researcher_id: string;
      period_start: string;
      monthly_limit_usd: string;
      total_spent_usd: string;
    };
    expect(body.researcher_id).toBe(DEMO_FIXTURES.users.researcher.id);
    expect(body.period_start).toBe(DEMO_FIXTURES.budget.periodStart);
    expect(body.monthly_limit_usd).toBe(DEMO_FIXTURES.budget.monthlyLimitUsd);
  });

  test('admin can PATCH /api/admin/cost-budget to update researcher budget', async () => {
    const session = await getFixtureSession(env.baseUrl, 'admin');
    const res = await fetch(`${env.baseUrl}/api/admin/cost-budget`, {
      method: 'PATCH',
      headers: {
        Cookie: session.cookie.split(';')[0],
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        researcherId: DEMO_FIXTURES.users.researcher.id,
        periodStart: DEMO_FIXTURES.budget.periodStart,
        monthlyLimitUsd: 600,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { monthly_limit_usd: string };
    expect(parseFloat(body.monthly_limit_usd)).toBe(600);
  });

  test('non-admin cannot PATCH /api/admin/cost-budget', async () => {
    const session = await getFixtureSession(env.baseUrl, 'researcher');
    const res = await fetch(`${env.baseUrl}/api/admin/cost-budget`, {
      method: 'PATCH',
      headers: {
        Cookie: session.cookie.split(';')[0],
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        researcherId: DEMO_FIXTURES.users.researcher.id,
        periodStart: DEMO_FIXTURES.budget.periodStart,
        monthlyLimitUsd: 1,
      }),
    });
    expect(res.status).toBe(403);
  });

  test('unauthenticated GET /api/cost/status returns 401', async () => {
    const res = await fetch(`${env.baseUrl}/api/cost/status`);
    expect(res.status).toBe(401);
  });
});
