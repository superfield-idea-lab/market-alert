/**
 * @file health
 *
 * ## Phase 0 — Scaffolding & infrastructure (dev-scout)
 *
 * Three-tier health endpoint per DEPLOY-C-030/031/032:
 *   - GET /health/live   — liveness probe: server process is running
 *   - GET /health/ready  — readiness probe: server can serve traffic (DB reachable)
 *   - GET /health/deep   — deep check: all subsystems healthy (DB, queue, version)
 *
 * Also handles the legacy /health and /healthz paths for backward compat.
 *
 * ## Canonical docs
 * - docs/implementation-plan-v1.md § Phase 0 (scout)
 * - calypso-blueprint/rules/blueprints/deploy.yaml (DEPLOY-C-030/031/032)
 *
 * ## Integration points discovered
 * - DB liveness check requires a sql connection to be available at check time.
 *   The readiness probe must not block boot: if DB is not ready, readiness
 *   returns 503 but liveness still returns 200.
 * - k8s manifests must reference /health/live for livenessProbe and
 *   /health/ready for readinessProbe (superfield-distribution/deploy/base/).
 * - Deep check is expensive (queries DB); not suitable for k8s probes, but
 *   used by CI smoke test and the golden-path e2e test.
 *
 * ## Risks captured
 * - If sql is imported at module scope in index.ts and DB is unavailable at
 *   boot, the process will crash before health routes are reachable. Phase 0
 *   follow-on (k3d cluster scaffold) must address ephemeral DB startup order.
 * - Coverage of this file counts toward the 99% threshold. The integration
 *   test in apps/server/tests/integration/health.test.ts must cover all three
 *   routes to prevent coverage-gate failures.
 */

import type { AppState } from '../index';

export interface HealthCheckResult {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  checks?: Record<string, 'ok' | 'error'>;
  message?: string;
}

/**
 * Liveness probe — DEPLOY-C-030.
 *
 * Returns 200 if the server process is alive. Never touches the DB.
 * k8s restarts the pod only when this returns non-200.
 */
export function handleLivenessCheck(): Response {
  const result: HealthCheckResult = {
    status: 'ok',
    version: process.env.RELEASE_TAG ?? 'dev',
  };
  return Response.json(result, { status: 200 });
}

/**
 * Readiness probe — DEPLOY-C-031.
 *
 * Returns 200 when the server is ready to receive traffic (DB reachable).
 * k8s stops routing traffic to the pod when this returns non-200.
 *
 * NOTE (Phase 0 stub): DB check is skipped until the four-pool architecture
 * (Phase 1) lands. Until then, readiness mirrors liveness.
 *
 * @see docs/implementation-plan-v1.md § Phase 1 — four-pool Postgres
 */
export async function handleReadinessCheck(
  // appState: Phase 1 will use this to check DB connectivity (kb_app, kb_audit pools)
  _appState: AppState, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<Response> {
  // Phase 0 stub: DB pool check skipped — wired in Phase 1 (four-pool).
  // When Phase 1 lands, replace the stub body with:
  //   await appState.sql`SELECT 1`
  //   await appState.auditSql`SELECT 1`
  const result: HealthCheckResult = {
    status: 'ok',
    version: process.env.RELEASE_TAG ?? 'dev',
    checks: {
      db: 'ok', // stub — Phase 1 will verify real connectivity
    },
  };
  return Response.json(result, { status: 200 });
}

/**
 * Deep health check — DEPLOY-C-032.
 *
 * Validates all subsystems: DB, task queue reachability, version consistency.
 * Not used by k8s probes (too expensive). Used by:
 *   - CI smoke test
 *   - Golden-path e2e test (Phase 0 follow-on)
 *   - Admin dashboard status panel (Phase 4+)
 *
 * NOTE (Phase 0 stub): All subsystem checks are stubs returning ok.
 * Real checks land with their respective subsystem phases.
 */
export async function handleDeepCheck(
  // appState: Phase 1 will use this for db_app, db_audit, db_analytics checks
  _appState: AppState, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<Response> {
  // Phase 0 stub: real subsystem checks land with their phases.
  // Expected shape when fully implemented:
  //   db_app:       SELECT 1 on kb_app pool
  //   db_audit:     SELECT 1 on kb_audit pool
  //   db_analytics: SELECT 1 on kb_analytics pool
  //   task_queue:   SELECT count(*) FROM task_queue WHERE claimed_at IS NULL
  const result: HealthCheckResult = {
    status: 'ok',
    version: process.env.RELEASE_TAG ?? 'dev',
    checks: {
      db_app: 'ok', // stub — Phase 1
      db_audit: 'ok', // stub — Phase 1
      db_analytics: 'ok', // stub — Phase 1
      task_queue: 'ok', // stub — Phase 0 task-queue follow-on
    },
  };
  return Response.json(result, { status: 200 });
}

/**
 * Route dispatcher for /health/* paths.
 *
 * Handles:
 *   /health/live   → liveness (DEPLOY-C-030)
 *   /health/ready  → readiness (DEPLOY-C-031)
 *   /health/deep   → deep check (DEPLOY-C-032)
 *   /health        → alias for /health/live (backward compat)
 *   /healthz       → alias for /health/live (k8s convention)
 */
export async function handleHealthRequest(
  pathname: string,
  appState: AppState,
): Promise<Response | null> {
  if (pathname === '/health/live' || pathname === '/health' || pathname === '/healthz') {
    return handleLivenessCheck();
  }
  if (pathname === '/health/ready') {
    return handleReadinessCheck(appState);
  }
  if (pathname === '/health/deep') {
    return handleDeepCheck(appState);
  }
  return null; // not a health path
}
