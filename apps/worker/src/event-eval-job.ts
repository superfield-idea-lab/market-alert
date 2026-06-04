/**
 * @file event-eval-job.ts
 *
 * EVENT_EVALUATE worker job handler — Phase 6 dev-scout (issue #82).
 *
 * ## What this file does
 *
 * Implements `executeEventEvalTask`, which for one market event:
 *
 *   1. Fetches the market_event from the API via
 *      GET /internal/event-evaluation/market-event?market_event_id=<id>
 *   2. Resolves the researcher's active standing prompt for the event's subject
 *      entity via GET /internal/event-evaluation/active-prompt?...
 *   3. Checks idempotency: a signal row for this
 *      (market_event_id, standing_prompt_version_id) pair may already exist if
 *      the task was retried. If so, exits with `already_evaluated: true`.
 *   4. Creates a draft signal row via POST /internal/event-evaluation/signal.
 *      The scout implementation uses a no-op rationale stub; the follow-on
 *      implementation issue replaces this with a single LLM model call.
 *   5. Attaches two cites edges via POST /internal/event-evaluation/signal/:id/cite:
 *        a. `standing_prompt_version` → the version used for evaluation
 *        b. `wiki_page_version`       → the currently published wiki snapshot
 *           for the subject (requires the GET /internal/wiki-rebuild/published-version
 *           endpoint, which is a follow-on issue; skipped in this scout).
 *   6. Returns a result summary.
 *
 * ## Scout scope
 *
 * This is a dev-scout — no LLM call is made. The rationale field is left null.
 * The goal is to validate the full pipeline seam:
 *   market_event → signal (cited) with correct idempotency semantics.
 *
 * LLM-backed evaluation (single model call against the compact standing prompt,
 * confidence decomposition, reviewer-queue routing) is deferred to the follow-on
 * Phase 6 feature issue.
 *
 * ## Idempotency
 *
 * Re-running EVENT_EVALUATE for the same (market_event_id, standing_prompt_version_id)
 * pair is safe: the signal creation at the API layer uses ON CONFLICT (idempotency_key)
 * DO NOTHING and returns `created: false` when the row already exists. The task exits
 * early with `already_evaluated: true` without creating duplicate rows or edges.
 * This implements acceptance criterion AC-3.
 *
 * ## Security
 *
 * Workers hold no database credentials (WORKER-T-001, WORKER-T-002). All reads
 * and writes are made through authenticated internal API calls. The delegated
 * token from the task row scopes access to the assigned market_event only.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5, §9 — event evaluation, confidence, auditability
 * - docs/architecture.md §"Signal routing"
 * - docs/architecture.md §"Citations: first-class relation edges"
 * - packages/db/task-queue.ts — TaskType.EVENT_EVALUATE
 * - packages/db/signal-store.ts — DB store (signals, signal_cites)
 * - packages/db/mkt-market-event-store.ts — market_events store
 * - packages/db/standing-prompt-store.ts — standing_prompt_versions store
 * - apps/server/src/api/event-eval-api.ts — internal API endpoints
 * - tests/integration/event-evaluation.spec.ts — integration tests (this scout)
 *
 * ## Integration points discovered during scout (issue #82)
 *
 * 1. `packages/db/signal-store.ts` — `insertSignal` and `insertSignalCite` are
 *    the write path. The follow-on implementation issue adds the LLM rationale.
 *
 * 2. `packages/db/standing-prompt-store.ts` — `getActiveStandingPromptVersion`
 *    (entity-level, then thesis-level, then portfolio-level fallback) is the
 *    read path for resolving the active prompt. The family-fallback logic belongs
 *    in a helper in standing-prompt-store.ts (follow-on issue).
 *
 * 3. `packages/db/mkt-market-event-store.ts` — `getMarketEventById` and
 *    `transitionMarketEventStatus` (Detected/Enriched → Evaluated) are called
 *    after the signal is created. The status transition is not wired in this scout.
 *
 * 4. `packages/db/wiki-rebuild-store.ts` — the evaluator needs the currently
 *    published wiki_page_version_id for the subject to attach the wiki cites edge.
 *    A new GET /internal/wiki-rebuild/published-version endpoint is needed
 *    (follow-on issue). The wiki cite is SKIPPED in this scout.
 *
 * 5. SIGNAL_NOTIFY task (follow-on Phase 6 issue) — after creating a signal,
 *    the task handler must enqueue a SIGNAL_NOTIFY task so the researcher
 *    dashboard receives a WebSocket push. Task key:
 *    `notify:<signal_id>:<channel>`. OUT OF SCOPE for this scout.
 *
 * 6. The confidence threshold routing (Generated → Delivered vs Generated →
 *    Queued) belongs in the follow-on Phase 6 feature issue. In this scout,
 *    all signals are created at status 'Generated'.
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/82
 */

import type { TaskQueueRow } from 'db/task-queue';
import { assertNoDatabaseUrl } from './startup';

/** The job_type constant for EVENT_EVALUATE tasks. */
export const EVENT_EVAL_JOB_TYPE = 'EVENT_EVALUATE' as const;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/**
 * Payload for an EVENT_EVALUATE task.
 *
 * Task key format: `event_eval:<market_event_id>`
 * Triggered by: EDGAR_POLL worker after normalising a filing into a market_event.
 *
 * PRD §9 (zero PII in task payloads, TQ-P-002, TQ-C-004): the payload carries
 * only `market_event_id` (UUID). Worker fetches all business data at execution
 * time through authenticated API reads.
 *
 * Architecture ref: docs/architecture.md § task-type table (EVENT_EVALUATE row)
 */
export interface EventEvalPayload {
  /** UUID of the market_event to evaluate. */
  market_event_id: string;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Result returned by `executeEventEvalTask`.
 */
export interface EventEvalResult {
  /** True when the signal row was created in this run. */
  signal_created: boolean;
  /**
   * True when a signal row already existed for this
   * (market_event_id, standing_prompt_version_id) pair (idempotent retry).
   */
  already_evaluated: boolean;
  /** The signal_id of the created or existing signal row, or null if no active prompt exists. */
  signal_id: string | null;
  /** The standing_prompt_version_id used, or null if no active prompt exists. */
  standing_prompt_version_id: string | null;
  /** Number of cites edges attached (0 in this scout; follow-on issue adds wiki cite). */
  cites_attached: number;
}

// ---------------------------------------------------------------------------
// Payload validator
// ---------------------------------------------------------------------------

/**
 * Validates and narrows the raw task payload to `EventEvalPayload`.
 *
 * Throws if the payload is missing the required `market_event_id` field.
 * No PII validation is needed for this payload (carries only a UUID).
 */
export function parseEventEvalPayload(raw: unknown): EventEvalPayload {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('[event-eval-job] Payload must be a JSON object');
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.market_event_id !== 'string' || !p.market_event_id) {
    throw new Error('[event-eval-job] Payload missing required field: market_event_id');
  }
  return { market_event_id: p.market_event_id };
}

// ---------------------------------------------------------------------------
// Task executor
// ---------------------------------------------------------------------------

/**
 * Execute one EVENT_EVALUATE task.
 *
 * DEV-SCOUT STUB: implements the full pipeline seam (market_event → signal with
 * cites) without an LLM call. The rationale is null; confidence defaults to 1.0.
 * The follow-on Phase 6 feature issue replaces the stub evaluation with a real
 * model call.
 *
 * Steps:
 *   1. Assert no direct database URL is present in the environment (WORKER-T-001).
 *   2. Parse and validate the task payload.
 *   3. Fetch the market_event from the internal API.
 *   4. Resolve the researcher's active standing prompt version for the subject.
 *   5. If no active prompt exists, return early (no signal can be produced).
 *   6. Check idempotency — exit early if signal already exists.
 *   7. Create the signal row via the internal API.
 *   8. Attach the `standing_prompt_version` cites edge.
 *   9. Return the result summary.
 *
 * @param task - The task queue row. Must have a valid `delegated_token`.
 * @param apiBaseUrl - Base URL of the apps/server HTTP API.
 * @param delegatedToken - Single-use token scoped to this task.
 */
export async function executeEventEvalTask(
  task: TaskQueueRow,
  apiBaseUrl: string,
  delegatedToken: string,
): Promise<EventEvalResult> {
  // Workers must never hold a direct database URL (WORKER-T-001, WORKER-T-002).
  assertNoDatabaseUrl();

  const payload = parseEventEvalPayload(task.payload);
  const { market_event_id } = payload;

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${delegatedToken}`,
  };

  // ------------------------------------------------------------------
  // Step 3: Fetch the market_event.
  // ------------------------------------------------------------------
  const eventUrl = new URL(`/internal/event-evaluation/market-event`, apiBaseUrl);
  eventUrl.searchParams.set('market_event_id', market_event_id);

  const eventResp = await fetch(eventUrl.toString(), { headers });
  if (!eventResp.ok) {
    throw new Error(
      `[event-eval-job] Failed to fetch market_event ${market_event_id}: ` +
        `${eventResp.status} ${await eventResp.text().catch(() => '')}`,
    );
  }

  const eventBody = (await eventResp.json()) as {
    market_event: {
      id: string;
      tenant_id?: string;
      researcher_id?: string;
      subject_entity_id?: string | null;
      subject_entity_type?: string;
      event_type?: string;
    } | null;
  };

  if (!eventBody.market_event) {
    throw new Error(`[event-eval-job] market_event ${market_event_id} not found`);
  }

  const marketEvent = eventBody.market_event;
  const { tenant_id, researcher_id, subject_entity_id } = marketEvent as {
    tenant_id: string;
    researcher_id: string;
    subject_entity_id: string | null;
    subject_entity_type: string;
  };

  // ------------------------------------------------------------------
  // Step 4: Resolve the researcher's active standing prompt version.
  // ------------------------------------------------------------------
  const promptUrl = new URL(`/internal/event-evaluation/active-prompt`, apiBaseUrl);
  promptUrl.searchParams.set('tenant_id', tenant_id);
  promptUrl.searchParams.set('researcher_id', researcher_id);
  promptUrl.searchParams.set('subject_type', 'entity');
  promptUrl.searchParams.set('subject_id', subject_entity_id ?? researcher_id);

  const promptResp = await fetch(promptUrl.toString(), { headers });
  if (!promptResp.ok) {
    throw new Error(
      `[event-eval-job] Failed to fetch active prompt for researcher ${researcher_id}: ` +
        `${promptResp.status} ${await promptResp.text().catch(() => '')}`,
    );
  }

  const promptBody = (await promptResp.json()) as {
    version: { id: string; body: string | null } | null;
  };

  // ------------------------------------------------------------------
  // Step 5: No active prompt — cannot produce a signal.
  // ------------------------------------------------------------------
  if (!promptBody.version) {
    return {
      signal_created: false,
      already_evaluated: false,
      signal_id: null,
      standing_prompt_version_id: null,
      cites_attached: 0,
    };
  }

  const standingPromptVersionId = promptBody.version.id;

  // ------------------------------------------------------------------
  // Step 6: Idempotency check.
  // ------------------------------------------------------------------
  const idempotencyKey = `event_eval:${market_event_id}:${standingPromptVersionId}`;

  const checkUrl = new URL(`/internal/event-evaluation/signal/check`, apiBaseUrl);
  checkUrl.searchParams.set('idempotency_key', idempotencyKey);

  const checkResp = await fetch(checkUrl.toString(), { headers });
  if (checkResp.ok) {
    const checkBody = (await checkResp.json()) as { signal_id: string | null };
    if (checkBody.signal_id) {
      return {
        signal_created: false,
        already_evaluated: true,
        signal_id: checkBody.signal_id,
        standing_prompt_version_id: standingPromptVersionId,
        cites_attached: 0,
      };
    }
  }

  // ------------------------------------------------------------------
  // Step 7: Create the signal row.
  // ------------------------------------------------------------------
  const createResp = await fetch(
    new URL(`/internal/event-evaluation/signal`, apiBaseUrl).toString(),
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tenant_id,
        researcher_id,
        market_event_id,
        standing_prompt_version_id: standingPromptVersionId,
        // DEV-SCOUT STUB: rationale null, confidence defaults 1.0
        rationale: null,
        source_trust: 1.0,
        extraction_certainty: 1.0,
      }),
    },
  );

  if (!createResp.ok) {
    throw new Error(
      `[event-eval-job] Failed to create signal: ` +
        `${createResp.status} ${await createResp.text().catch(() => '')}`,
    );
  }

  const createBody = (await createResp.json()) as {
    signal_id: string;
    created: boolean;
  };

  if (!createBody.created) {
    // Concurrent retry already created the row between the check and create.
    return {
      signal_created: false,
      already_evaluated: true,
      signal_id: createBody.signal_id,
      standing_prompt_version_id: standingPromptVersionId,
      cites_attached: 0,
    };
  }

  const signalId = createBody.signal_id;

  // ------------------------------------------------------------------
  // Step 8: Attach standing_prompt_version cites edge.
  // ------------------------------------------------------------------
  const citeResp = await fetch(
    new URL(`/internal/event-evaluation/signal/${signalId}/cite`, apiBaseUrl).toString(),
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        target_type: 'standing_prompt_version',
        target_id: standingPromptVersionId,
      }),
    },
  );

  if (!citeResp.ok) {
    // Non-fatal: log the error but do not fail the task. The cites edge is
    // idempotent and can be re-attached on the next retry.
    console.warn(
      `[event-eval-job] Failed to attach standing_prompt_version cite for signal ${signalId}: ` +
        `${citeResp.status}`,
    );
  }

  const citesAttached = citeResp.ok ? 1 : 0;

  // NOTE: wiki_page_version cites edge is deferred to a follow-on issue.
  // It requires a GET /internal/wiki-rebuild/published-version endpoint
  // that returns the currently published wiki_page_version_id for the subject.

  return {
    signal_created: true,
    already_evaluated: false,
    signal_id: signalId,
    standing_prompt_version_id: standingPromptVersionId,
    cites_attached: citesAttached,
  };
}
