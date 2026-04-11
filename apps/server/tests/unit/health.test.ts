/**
 * @file health.test.ts
 *
 * Unit tests for the three-tier health endpoint (Phase 0 — dev-scout).
 *
 * ## What is tested
 * - /health/live  → 200 with { status: 'ok', version }
 * - /health/ready → 200 with { status: 'ok', version, checks.db: 'ok' } (stub)
 * - /health/deep  → 200 with { status: 'ok', version, checks.* }
 * - /health       → liveness alias
 * - /healthz      → liveness alias
 * - unknown path  → handleHealthRequest returns null
 *
 * ## No mocks
 * All tests use the real handleHealthRequest function with no mock DB.
 * The readiness and deep checks are stubs in Phase 0 and do not require a
 * live database connection. Real DB connectivity is tested in the integration
 * suite (apps/server/tests/integration/) added in Phase 1.
 *
 * Canonical doc: docs/implementation-plan-v1.md § Phase 0 (scout)
 * Blueprint ref: calypso-blueprint/rules/blueprints/test.yaml
 */

import { describe, test, expect } from 'vitest';
import {
  handleLivenessCheck,
  handleReadinessCheck,
  handleDeepCheck,
  handleHealthRequest,
  type HealthCheckResult,
} from '../../src/api/health';

// Stub appState — Phase 0 health checks do not query the DB.
// When Phase 1 wires real DB checks, replace this with a real ephemeral pool.
const stubAppState = {} as import('../../src/index').AppState;

describe('handleLivenessCheck', () => {
  test('returns 200 with status ok', async () => {
    const res = handleLivenessCheck();
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthCheckResult;
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
  });

  test('version falls back to dev when RELEASE_TAG is unset', async () => {
    delete process.env.RELEASE_TAG;
    const res = handleLivenessCheck();
    const body = (await res.json()) as HealthCheckResult;
    expect(body.version).toBe('dev');
  });

  test('version reflects RELEASE_TAG env var when set', async () => {
    process.env.RELEASE_TAG = 'v1.2.3';
    const res = handleLivenessCheck();
    const body = (await res.json()) as HealthCheckResult;
    expect(body.version).toBe('v1.2.3');
    delete process.env.RELEASE_TAG;
  });
});

describe('handleReadinessCheck (Phase 0 stub)', () => {
  test('returns 200 with status ok and db check stub', async () => {
    const res = await handleReadinessCheck(stubAppState);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthCheckResult;
    expect(body.status).toBe('ok');
    expect(body.checks?.db).toBe('ok');
  });
});

describe('handleDeepCheck (Phase 0 stub)', () => {
  test('returns 200 with status ok and all subsystem check stubs', async () => {
    const res = await handleDeepCheck(stubAppState);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthCheckResult;
    expect(body.status).toBe('ok');
    expect(body.checks?.db_app).toBe('ok');
    expect(body.checks?.db_audit).toBe('ok');
    expect(body.checks?.db_analytics).toBe('ok');
    expect(body.checks?.task_queue).toBe('ok');
  });
});

describe('handleHealthRequest — route dispatch', () => {
  test('/health/live routes to liveness', async () => {
    const res = await handleHealthRequest('/health/live', stubAppState);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });

  test('/health routes to liveness (backward compat)', async () => {
    const res = await handleHealthRequest('/health', stubAppState);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });

  test('/healthz routes to liveness (k8s convention)', async () => {
    const res = await handleHealthRequest('/healthz', stubAppState);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });

  test('/health/ready routes to readiness', async () => {
    const res = await handleHealthRequest('/health/ready', stubAppState);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as HealthCheckResult;
    expect(body.checks?.db).toBe('ok');
  });

  test('/health/deep routes to deep check', async () => {
    const res = await handleHealthRequest('/health/deep', stubAppState);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as HealthCheckResult;
    expect(body.checks?.db_app).toBe('ok');
  });

  test('unknown path returns null', async () => {
    const res = await handleHealthRequest('/healthiest', stubAppState);
    expect(res).toBeNull();
  });

  test('/api/foo does not match health routes', async () => {
    const res = await handleHealthRequest('/api/foo', stubAppState);
    expect(res).toBeNull();
  });
});
