/**
 * @file healthz-golden-path.spec.ts
 *
 * ## Phase 0 — Scaffolding & infrastructure (dev-scout)
 *
 * Golden-path end-to-end test for the /healthz/* probe endpoints introduced
 * in Phase 0. Boots a real Bun HTTP server (no mocks, no k3d required in CI),
 * asserts each k8s-standard probe path, and tears everything down.
 *
 * This file satisfies the Phase 0 acceptance criterion:
 *   "Golden-path e2e test boots the stack, hits /healthz/live, tears down"
 *
 * ## Canonical docs
 * - docs/plan.md § Phase 0 test plan — golden-path e2e
 * - apps/server/src/api/health.ts — handleStartupCheck, handleLivenessCheck,
 *   handleReadinessCheck
 *
 * ## Integration points discovered
 * - All three /healthz/* routes are handled by handleHealthRequest() in
 *   apps/server/src/api/health.ts.
 * - The server routing condition (index.ts) now matches
 *   url.pathname.startsWith('/healthz') so all sub-paths are forwarded.
 * - Phase 1 will update /healthz/ready to perform a real DB connectivity
 *   check. This test will remain valid because the response shape does not
 *   change (status: 'ok' | 'degraded' | 'error').
 *
 * ## No mocks
 * This test uses only real HTTP (fetch). TEST-C-018: zero vi.fn/vi.mock.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startE2EServer, stopE2EServer, type E2EEnvironment } from './environment';

let env: E2EEnvironment;

beforeAll(async () => {
  env = await startE2EServer();
}, 60_000);

afterAll(async () => {
  await stopE2EServer(env);
}, 60_000);

describe('/healthz golden-path (Phase 0)', () => {
  it('GET /healthz/live returns 200 with status ok', async () => {
    const res = await fetch(`${env.baseUrl}/healthz/live`);

    expect(res.status).toBe(200);

    const body: unknown = await res.json();
    expect(body).toMatchObject({ status: 'ok' });
  });

  it('GET /healthz/ready returns 200 with status ok', async () => {
    const res = await fetch(`${env.baseUrl}/healthz/ready`);

    expect(res.status).toBe(200);

    const body: unknown = await res.json();
    expect(body).toMatchObject({ status: 'ok' });
  });

  it('GET /healthz/startup returns 200 with status ok', async () => {
    const res = await fetch(`${env.baseUrl}/healthz/startup`);

    expect(res.status).toBe(200);

    const body: unknown = await res.json();
    expect(body).toMatchObject({ status: 'ok' });
  });

  it('GET /healthz (legacy alias) returns 200 with status ok', async () => {
    const res = await fetch(`${env.baseUrl}/healthz`);

    expect(res.status).toBe(200);

    const body: unknown = await res.json();
    expect(body).toMatchObject({ status: 'ok' });
  });
});
