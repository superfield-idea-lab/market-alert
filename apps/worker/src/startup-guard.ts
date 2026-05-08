/**
 * Worker startup credential guard.
 *
 * Blueprint reference: Phase 1 — Linkerd mTLS and machine tokens for workers.
 *
 * Workers must carry NO database credentials. They authenticate to the API
 * server exclusively via WORKER_TOKEN (a scoped machine API token from AWS
 * Secrets Manager, rotated weekly). Direct database access from workers is
 * structurally blocked at the network layer by a Kubernetes NetworkPolicy.
 *
 * This guard is a belt-and-suspenders check at the application layer:
 * if ANY of the following env vars are present at startup, the process
 * aborts immediately with exit code 1.
 *
 *   DATABASE_URL   PGPASSWORD   PGHOST   PGUSER   PGDATABASE
 *
 * This makes misconfigured deployments fail loudly rather than silently
 * allowing a worker to bypass the mTLS/token model by talking to postgres
 * directly.
 *
 * Canonical docs:
 *   - docs/plan.md (Phase 1: Linkerd mTLS service mesh and machine tokens)
 *   - k8s/linkerd/namespaces.yaml (Linkerd sidecar injection)
 *   - k8s/linkerd/authorization-policies.yaml (default-deny mTLS policies)
 *   - k8s/worker-network-policy.yaml (egress block on port 5432)
 *
 * @see https://linkerd.io/2.14/features/automatic-mtls/
 */

/**
 * The set of environment variable names that must never be present in a
 * worker pod. Presence of any of these indicates a misconfigured deployment
 * that attempts to give the worker direct database access.
 */
export const FORBIDDEN_DB_ENV_VARS = [
  'DATABASE_URL',
  'PGPASSWORD',
  'PGHOST',
  'PGUSER',
  'PGDATABASE',
] as const;

export type ForbiddenDbEnvVar = (typeof FORBIDDEN_DB_ENV_VARS)[number];

export interface StartupGuardResult {
  /** Whether the guard passed (no forbidden vars found). */
  ok: boolean;
  /** The forbidden env var names that were detected. Empty when ok === true. */
  detected: ForbiddenDbEnvVar[];
}

/**
 * Inspect the given env object for forbidden database credential variables.
 *
 * Returns a result object rather than throwing so that callers can decide
 * how to handle the failure (log, exit, etc.).
 *
 * @param env - The environment to inspect. Defaults to `process.env`.
 */
export function checkStartupGuard(env: NodeJS.ProcessEnv = process.env): StartupGuardResult {
  const detected = FORBIDDEN_DB_ENV_VARS.filter(
    (key) => key in env && env[key] !== undefined && env[key] !== '',
  );
  return { ok: detected.length === 0, detected };
}

/**
 * Assert that no forbidden database credential variables are present.
 *
 * If any are found, logs a descriptive error and calls `process.exit(1)`.
 * Call this once at the very start of the worker process, before any other
 * initialization.
 *
 * @param env    - The environment to inspect. Defaults to `process.env`.
 * @param logger - Logger for the error message. Defaults to `console`.
 */
export function assertNoDatabaseCredentials(
  env: NodeJS.ProcessEnv = process.env,
  logger: { error: (msg: string) => void } = console,
): void {
  const { ok, detected } = checkStartupGuard(env);
  if (!ok) {
    logger.error(
      `[startup-guard] FATAL: worker process detected forbidden database credential env vars: ` +
        `${detected.join(', ')}. ` +
        `Workers must use WORKER_TOKEN for authentication — no direct DB access is permitted. ` +
        `Remove these env vars from the deployment and use the API gateway instead. ` +
        `Aborting with exit code 1.`,
    );
    process.exit(1);
  }
}
