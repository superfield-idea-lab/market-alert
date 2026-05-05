/**
 * @file deployment-audit.ts
 *
 * Writes a structured JSONL deployment audit record to `deployments.jsonl`.
 *
 * Each record captures the who, what, where, and outcome of a deployment event.
 * The file is append-only — one JSON line per deployment — and is written by
 * `deploy.sh` (or the CI pipeline) at the end of each phase.
 *
 * Blueprint ref: DEPLOY-D-006 / DEPLOY-D-008 / DEPLOY-C-035.
 */

import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeployOutcome = 'success' | 'failure' | 'rollback';

export interface DeploymentRecord {
  /** ISO 8601 timestamp of the deployment event. */
  ts: string;
  /** Identity of the operator or CI principal triggering the deploy. */
  operator: string;
  /** Release tag or image digest being deployed (e.g. "v1.2.3", "sha-abc1234"). */
  release_tag: string;
  /** Target environment ("production", "staging", etc.). */
  environment: string;
  /** Outcome of the deployment phase. */
  outcome: DeployOutcome;
  /** OCI image digest — ensures the exact binary is recorded. */
  image_digest: string;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Returns the path to the `deployments.jsonl` file.
 *
 * Resolution order:
 *   1. `DEPLOYMENTS_AUDIT_PATH` env variable (absolute or relative to cwd)
 *   2. `<process.cwd()>/deployments.jsonl`
 */
export function resolveDeploymentAuditPath(): string {
  const env = process.env.DEPLOYMENTS_AUDIT_PATH;
  if (env) {
    return env.startsWith('/') ? env : join(process.cwd(), env);
  }
  return join(process.cwd(), 'deployments.jsonl');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Appends a deployment audit record to `deployments.jsonl`.
 *
 * The parent directory is created if it does not already exist.
 *
 * @param record - Deployment event details.
 * @param filePath - Optional override path (default: `resolveDeploymentAuditPath()`).
 * @returns The full path of the file that was written to.
 */
export function writeDeploymentAudit(
  record: DeploymentRecord,
  filePath: string = resolveDeploymentAuditPath(),
): string {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const line = JSON.stringify(record) + '\n';
  appendFileSync(filePath, line, 'utf8');
  return filePath;
}

/**
 * Builds a DeploymentRecord with the current UTC timestamp.
 *
 * Convenience wrapper so callers do not need to format the timestamp
 * themselves.
 */
export function buildDeploymentRecord(
  fields: Omit<DeploymentRecord, 'ts'> & { ts?: string },
): DeploymentRecord {
  return {
    ...fields,
    ts: fields.ts ?? new Date().toISOString(),
  };
}
