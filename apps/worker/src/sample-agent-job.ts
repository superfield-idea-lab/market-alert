/**
 * @file sample-agent-job.ts
 *
 * Sample agent job type — "claude_sample" — demonstrating the full
 * enqueue → claim → execute → submit lifecycle via the Claude CLI.
 *
 * ## Job type: claude_sample
 *
 * This job type exists to prove that the complete pipeline works end-to-end:
 *
 *   1. A caller enqueues a `claude_sample` task via `POST /api/tasks-queue`.
 *   2. The worker claims the task from the queue.
 *   3. The worker invokes the Claude CLI (or dev stub) with the task payload.
 *   4. The worker submits the structured result back to the API.
 *
 * ### Payload shape
 *
 * ```json
 * {
 *   "prompt_ref": "<opaque reference to a stored prompt>",
 *   "context_ref": "<optional opaque reference to context data>"
 * }
 * ```
 *
 * Payloads must contain only opaque identifiers — no raw text, PII, or
 * secrets (TQ-P-002).  The Claude CLI binary fetches the prompt content at
 * execution time via the authenticated API using the delegated token.
 *
 * ### Result shape
 *
 * ```json
 * {
 *   "result": "<human-readable summary of what was done>",
 *   "status": "completed"
 * }
 * ```
 *
 * ### Enqueue example
 *
 * ```http
 * POST /api/tasks-queue
 * Content-Type: application/json
 *
 * {
 *   "idempotency_key": "sample-001",
 *   "agent_type": "coding",
 *   "job_type": "claude_sample",
 *   "payload": {
 *     "prompt_ref": "pref_abc123"
 *   }
 * }
 * ```
 *
 * Blueprint reference: WORKER domain — end-to-end integration sample
 */

/** The job_type string identifying a sample Claude agent task. */
export const SAMPLE_JOB_TYPE = 'claude_sample' as const;

/**
 * Payload shape for the `claude_sample` job type.
 *
 * Only opaque identifiers are permitted (TQ-P-002). Workers fetch data
 * through the API at execution time; the queue row must never carry raw content.
 */
export interface SampleAgentPayload {
  /** Opaque reference to a stored prompt. Required. */
  prompt_ref: string;
  /** Opaque reference to optional context data. */
  context_ref?: string;
  /** Opaque correlation tag for tracing. */
  correlation_ref?: string;
}

/**
 * Expected result shape returned by the Claude CLI for `claude_sample` tasks.
 */
export interface SampleAgentResult {
  /** Human-readable summary of the operation. */
  result: string;
  /** Execution status. */
  status?: 'completed' | 'failed';
  /** Whether the result was produced by the dev stub (local dev only). */
  stub?: boolean;
  /** Additional vendor-specific fields forwarded as-is. */
  [key: string]: unknown;
}

/**
 * Build the stdin payload sent to the Claude CLI for a `claude_sample` task.
 *
 * The task's `id`, `job_type`, `agent_type`, and `payload` fields are merged
 * into a single object so the CLI binary has all context it needs.
 */
export function buildCliPayload(
  taskId: string,
  agentType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: taskId,
    job_type: SAMPLE_JOB_TYPE,
    agent_type: agentType,
    ...payload,
  };
}

/**
 * Validate that a raw CLI result object conforms to the expected shape.
 *
 * Throws if the result is missing the required `result` string field.
 */
export function validateCliResult(raw: Record<string, unknown>): SampleAgentResult {
  if (typeof raw['result'] !== 'string') {
    throw new Error(
      `Claude CLI result is missing required "result" string field. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  return raw as SampleAgentResult;
}
