/**
 * @file timeout.ts
 *
 * Hard timeout configuration for agent job execution.
 *
 * Each agent job has a program-enforced hard timeout. When the timeout expires
 * the subprocess is sent SIGTERM, and if it does not exit within the grace
 * period it is sent SIGKILL. The task is then marked failed with a timeout
 * reason and the worker returns to the claim loop.
 *
 * ## Configuration
 *
 * Timeouts are configured via environment variables:
 *
 * - `AGENT_TIMEOUT_MS`                   — default timeout for all agent types (ms)
 * - `AGENT_TIMEOUT_MS_<AGENT_TYPE>`      — per-agent-type override (ms)
 *   e.g. `AGENT_TIMEOUT_MS_CODING=600000` for a 10-minute timeout on the
 *   "coding" agent type. The agent type name is uppercased and non-alphanumeric
 *   characters are replaced with underscores.
 * - `AGENT_TIMEOUT_SIGTERM_GRACE_MS`     — how long to wait between SIGTERM and
 *   SIGKILL (default: 5 000 ms)
 *
 * Blueprint reference: WORKER domain — hard timeout enforcement
 */

/** Default hard timeout for agent job execution: 10 minutes. */
export const DEFAULT_AGENT_TIMEOUT_MS = 600_000;

/** Default grace period between SIGTERM and SIGKILL: 5 seconds. */
export const DEFAULT_SIGTERM_GRACE_MS = 5_000;

/**
 * Resolve the hard timeout for a given agent type.
 *
 * Resolution order (first defined wins):
 * 1. `AGENT_TIMEOUT_MS_<AGENT_TYPE_UPPERCASED>` environment variable
 * 2. `AGENT_TIMEOUT_MS` environment variable
 * 3. `DEFAULT_AGENT_TIMEOUT_MS` (10 minutes)
 *
 * @param agentType - The agent type name (e.g. "coding", "analysis").
 * @param env       - Process environment (defaults to `process.env`).
 * @returns Timeout in milliseconds.
 */
export function resolveAgentTimeoutMs(
  agentType: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  // Build per-type env var key: uppercase, replace non-alphanumeric with _.
  const typeKey = `AGENT_TIMEOUT_MS_${agentType.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

  const perType = env[typeKey];
  if (perType !== undefined) {
    const parsed = parseInt(perType, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  const global = env['AGENT_TIMEOUT_MS'];
  if (global !== undefined) {
    const parsed = parseInt(global, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  return DEFAULT_AGENT_TIMEOUT_MS;
}

/**
 * Resolve the SIGTERM grace period.
 *
 * @param env - Process environment (defaults to `process.env`).
 * @returns Grace period in milliseconds.
 */
export function resolveSigtermGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const val = env['AGENT_TIMEOUT_SIGTERM_GRACE_MS'];
  if (val !== undefined) {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_SIGTERM_GRACE_MS;
}
