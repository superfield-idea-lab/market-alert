/**
 * @file code-cleanup-job.ts
 *
 * Code cleanup and dependency optimization agent job type — "code_cleanup".
 *
 * ## Job type: code_cleanup
 *
 * A cron-scheduled agent that reviews the codebase via Claude CLI for cleanup
 * opportunities and dependency optimizations.  Identifies:
 *
 *   - Dead code and unused exports
 *   - Unused imports
 *   - Redundant abstractions
 *   - Outdated or duplicate dependencies
 *   - General simplification opportunities
 *
 * The agent runs with read-only code access and a hard timeout to prevent
 * runaway analysis.
 *
 * ### Payload shape
 *
 * ```json
 * {
 *   "prompt_ref": "<opaque reference to the code-cleanup analysis prompt>",
 *   "scope_ref": "<optional opaque reference to a scope filter (e.g. path glob)>"
 * }
 * ```
 *
 * Payloads must contain only opaque identifiers (TQ-P-002). The Claude CLI
 * fetches prompt content at execution time via the authenticated API.
 *
 * ### Result shape
 *
 * ```json
 * {
 *   "findings": [
 *     {
 *       "category": "cleanup" | "dependency",
 *       "impact": "high" | "medium" | "low",
 *       "path": "<file path relative to repo root>",
 *       "description": "<human-readable description of the finding>",
 *       "action": "<suggested remediation action>"
 *     }
 *   ],
 *   "summary": "<overall analysis summary>",
 *   "status": "completed"
 * }
 * ```
 *
 * Blueprint reference: WORKER domain — code cleanup cron agent
 */

/** The job_type string identifying a code cleanup analysis task. */
export const CODE_CLEANUP_JOB_TYPE = 'code_cleanup' as const;

/** The agent_type for the code cleanup worker. */
export const CODE_CLEANUP_AGENT_TYPE = 'code_cleanup' as const;

/**
 * Hard timeout for code cleanup analysis tasks.
 * Code analysis can take longer than the default timeout; cap at 5 minutes.
 */
export const CODE_CLEANUP_TIMEOUT_MS = 5 * 60 * 1_000;

/**
 * Payload shape for the `code_cleanup` job type.
 *
 * Only opaque identifiers are permitted (TQ-P-002). Workers fetch data
 * through the API at execution time; the queue row must never carry raw content.
 */
export interface CodeCleanupPayload {
  /** Opaque reference to the stored code-cleanup analysis prompt. Required. */
  prompt_ref: string;
  /** Opaque reference to an optional scope filter (e.g. a path glob pattern). */
  scope_ref?: string;
  /** Opaque correlation tag for tracing. */
  correlation_ref?: string;
}

/**
 * A single code cleanup or dependency finding returned by the agent.
 */
export interface CodeCleanupFinding {
  /** Category of the finding. */
  category: 'cleanup' | 'dependency';
  /** Impact level of the finding. */
  impact: 'high' | 'medium' | 'low';
  /** File path relative to the repository root. */
  path: string;
  /** Human-readable description of the finding. */
  description: string;
  /** Suggested remediation action. */
  action: string;
}

/**
 * Expected result shape returned by the Claude CLI for `code_cleanup` tasks.
 */
export interface CodeCleanupResult {
  /** Structured findings from the code analysis. */
  findings: CodeCleanupFinding[];
  /** Overall analysis summary. */
  summary: string;
  /** Execution status. */
  status?: 'completed' | 'failed';
  /** Whether the result was produced by the dev stub (local dev only). */
  stub?: boolean;
  /** Additional vendor-specific fields forwarded as-is. */
  [key: string]: unknown;
}

/**
 * Build the stdin payload sent to the Claude CLI for a `code_cleanup` task.
 *
 * The task's `id`, `job_type`, `agent_type`, and `payload` fields are merged
 * into a single object so the CLI binary has all context it needs.
 */
export function buildCodeCleanupCliPayload(
  taskId: string,
  agentType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: taskId,
    job_type: CODE_CLEANUP_JOB_TYPE,
    agent_type: agentType,
    ...payload,
  };
}

/**
 * Validate that a raw CLI result object conforms to the expected shape.
 *
 * Throws if the result is missing the required `findings` array or `summary`
 * string fields.
 */
export function validateCodeCleanupResult(raw: Record<string, unknown>): CodeCleanupResult {
  if (!Array.isArray(raw['findings'])) {
    throw new Error(
      `Code cleanup CLI result is missing required "findings" array field. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  if (typeof raw['summary'] !== 'string') {
    throw new Error(
      `Code cleanup CLI result is missing required "summary" string field. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }

  // Validate individual findings structure.
  const findings = raw['findings'] as unknown[];
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i] as Record<string, unknown>;
    if (
      (f['category'] !== 'cleanup' && f['category'] !== 'dependency') ||
      (f['impact'] !== 'high' && f['impact'] !== 'medium' && f['impact'] !== 'low') ||
      typeof f['path'] !== 'string' ||
      typeof f['description'] !== 'string' ||
      typeof f['action'] !== 'string'
    ) {
      throw new Error(
        `Code cleanup finding[${i}] has invalid shape. Got: ${JSON.stringify(f).slice(0, 200)}`,
      );
    }
  }

  return raw as CodeCleanupResult;
}
