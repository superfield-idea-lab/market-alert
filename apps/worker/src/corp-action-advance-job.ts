/**
 * @file corp-action-advance-job.ts
 *
 * CORP_ACTION_ADVANCE worker job handler — Phase 2 (issue #16).
 *
 * ## What this file does
 *
 * Implements `executeCorpActionAdvanceTask`, which:
 *
 *   1. Parses `task.payload` as `{ corporate_action_id: string }`.
 *   2. Calls PATCH `${apiBaseUrl}/internal/corporate-actions/:id/advance` with
 *      the delegated task token.
 *   3. Returns a `CorpActionAdvanceResult` indicating the new state or the
 *      error status.
 *
 * ## Integration points
 *
 * `runner.ts` must import `CORP_ACTION_ADVANCE_JOB_TYPE` and route tasks with
 * `job_type === 'CORP_ACTION_ADVANCE'` to `executeCorpActionAdvanceTask`.
 *
 * ## Auth
 *
 * Uses the delegated_token from the task row (passed as workerToken). In
 * TEST_MODE=true the INTERNAL_TEST_TOKEN env var is used instead (consistent
 * with the server's isAuthorized check).
 *
 * ## Canonical docs
 *
 * - docs/plan.md — Phase 2 scope
 * - apps/server/src/api/corporate-action-lifecycle.ts — PATCH advance handler
 * - packages/db/task-queue.ts — TaskType.CORP_ACTION_ADVANCE
 */

export const CORP_ACTION_ADVANCE_JOB_TYPE = 'CORP_ACTION_ADVANCE';

export interface CorpActionAdvancePayload {
  corporate_action_id: string;
}

export interface CorpActionAdvanceResult {
  corporate_action_id: string;
  /** The new state returned by the advance endpoint, or null on error. */
  new_state: string | null;
  /** HTTP status from the advance endpoint. */
  http_status: number;
  /** Error message, if any. */
  error?: string;
}

/**
 * Validates the task payload for CORP_ACTION_ADVANCE tasks.
 *
 * @throws Error when `corporate_action_id` is missing or not a non-empty string.
 */
export function parseCorpActionAdvancePayload(payload: unknown): CorpActionAdvancePayload {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as Record<string, unknown>).corporate_action_id !== 'string' ||
    ((payload as Record<string, unknown>).corporate_action_id as string).trim() === ''
  ) {
    throw new Error(
      `[corp-action-advance] Invalid payload: expected { corporate_action_id: string }, got: ${JSON.stringify(payload)}`,
    );
  }
  return {
    corporate_action_id: (payload as Record<string, unknown>).corporate_action_id as string,
  };
}

/**
 * Executes one CORP_ACTION_ADVANCE task.
 *
 * @param payload    - The task payload (validated by parseCorpActionAdvancePayload).
 * @param apiBaseUrl - Base URL of the API server.
 * @param workerToken - Bearer token for the PATCH request (delegated task token).
 */
export async function executeCorpActionAdvanceTask(
  payload: unknown,
  apiBaseUrl: string,
  workerToken: string,
): Promise<CorpActionAdvanceResult> {
  const { corporate_action_id } = parseCorpActionAdvancePayload(payload);

  const url = `${apiBaseUrl}/internal/corporate-actions/${corporate_action_id}/advance`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${workerToken}`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[corp-action-advance] Network error calling ${url}:`, message);
    return {
      corporate_action_id,
      new_state: null,
      http_status: 0,
      error: message,
    };
  }

  if (resp.ok) {
    const body = (await resp.json()) as { id: string; state: string };
    console.log(
      `[corp-action-advance] Advanced ${corporate_action_id} → ${body.state} (HTTP ${resp.status})`,
    );
    return {
      corporate_action_id,
      new_state: body.state,
      http_status: resp.status,
    };
  }

  const errorBody = await resp.text();
  console.error(
    `[corp-action-advance] PATCH returned ${resp.status} for ${corporate_action_id}: ${errorBody}`,
  );
  return {
    corporate_action_id,
    new_state: null,
    http_status: resp.status,
    error: errorBody,
  };
}
