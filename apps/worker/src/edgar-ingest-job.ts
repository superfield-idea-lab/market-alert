/**
 * @file edgar-ingest-job.ts
 *
 * EDGAR_POLL worker job handler — Phase 2 dev-scout stub (issue #14).
 *
 * ## Status: dev-scout stub
 *
 * Defines the edgar_ingest job type constant, the payload/result TypeScript
 * interfaces, and a no-op `executeEdgarIngestTask` stub. No network calls,
 * no database writes, no side effects at runtime.
 *
 * The stub exists so that:
 *   1. The job type constant is available for wiring into runner.ts.
 *   2. The payload/result interfaces are typed and checkable.
 *   3. Follow-on implementation has a clear seam to fill in.
 *
 * ## Production design (follow-on implementation)
 *
 * The production `executeEdgarIngestTask` must:
 *
 *   1. Startup guard (already enforced by runner.ts / startup.ts):
 *      - Assert DATABASE_URL is NOT set (WORKER-T-002). Workers hold no DB URL.
 *      - Assert AGENT_DATABASE_URL IS set (read-only agent role).
 *
 *   2. Parse `task.payload` as `EdgarPollPayload`.
 *
 *   3. Construct the EDGAR ATOM feed URL from EDGAR_FEED_URL env var
 *      (defaulting to https://efts.sec.gov/LATEST/search-index) and the
 *      poll window from the payload.
 *
 *   4. Fetch the ATOM feed via `fetch(url)`. In CI this call is intercepted
 *      by MSW v2 (see tests/fixtures/edgar/msw-handler.ts). In production
 *      the live sec.gov endpoint is called.
 *
 *   5. Parse the ATOM XML response. The built-in DOMParser is available in
 *      Bun; alternatively, a fast XML parser from the approved dependency
 *      list can be used (a Buy/DIY decision is required — see
 *      docs/dependencies.md Phase 2 entry, to be created).
 *
 *   6. For each <entry> in the feed:
 *        a. Extract accession_number, form_type, CIK, issuer_name,
 *           filing_date, and the raw entry XML string.
 *        b. Build the idempotency key: `edgar:<accession_number>`.
 *        c. POST to `${API_BASE_URL}/internal/ingestion/corporate-action`
 *           with Authorization: Bearer ${WORKER_TOKEN} and the
 *           CorporateActionIngestBody shape.
 *        d. On HTTP 201, increment `stored_count`.
 *        e. On HTTP 409 (idempotent duplicate), increment `skipped_count`.
 *        f. On HTTP 4xx/5xx, log and surface as a permanent/transient error.
 *
 *   7. Return an `EdgarIngestResult` via the task result API
 *      (POST /api/v1/tasks/:id/result with the WORKER_TOKEN).
 *
 * ## Startup guard: DATABASE_URL must not be set
 *
 * Acceptance criterion: "Worker holds no DATABASE_URL: startup-guard passes."
 *
 * The existing startup guard in apps/worker/src/startup.ts checks for
 * INSERT privilege on task_queue via AGENT_DATABASE_URL. A complementary
 * check must ensure DATABASE_URL is absent:
 *
 *   if (process.env.DATABASE_URL) {
 *     console.error('Worker must not have DATABASE_URL set — refusing to start');
 *     process.exit(1);
 *   }
 *
 * This guard belongs in apps/worker/src/startup.ts (follow-on issue). The
 * integration test for this acceptance criterion calls `assertNoDatabaseUrl()`
 * from that module.
 *
 * ## Integration points discovered during scout
 *
 * 1. `runner.ts` must import `EDGAR_INGEST_JOB_TYPE` and route tasks with
 *    `job_type === 'EDGAR_POLL'` to `executeEdgarIngestTask`. The follow-on
 *    implementation issue owns this wiring.
 *
 * 2. The task row's `delegated_token` field carries the WORKER_TOKEN used to
 *    call POST /internal/ingestion/corporate-action. The production handler
 *    passes this token in the Authorization header.
 *
 * 3. The API_BASE_URL env var is already read by runner.ts for the task result
 *    endpoint. The edgar_ingest handler must reuse the same env var.
 *
 * 4. XML parsing: Bun has a native DOMParser but it is not yet validated in
 *    the test environment. A lightweight XML parser (e.g. `fast-xml-parser`)
 *    may be more reliable. This is a Buy/DIY decision for the follow-on issue.
 *
 * 5. The MSW v2 handler (tests/fixtures/edgar/msw-handler.ts) intercepts
 *    `https://efts.sec.gov/*` and replays the fixture. The production code
 *    must use a configurable EDGAR_FEED_URL so that tests can override it
 *    to the MSW intercept URL if needed.
 *
 * ## Risks identified during scout
 *
 * 1. XML parser choice: Bun's native DOMParser may not handle malformed EDGAR
 *    XML gracefully. The follow-on must add error handling for malformed feeds.
 *
 * 2. EDGAR accession number normalisation: the <id> element uses dashes
 *    (0001234567-26-000001); the CIK-based URL uses no dashes. Both forms must
 *    map to the same idempotency key. The normalisation function must strip
 *    all dashes before building the key.
 *
 * 3. Worker token lifecycle: the WORKER_TOKEN from `task.delegated_token`
 *    is single-use. If the POST to /internal/ingestion/corporate-action fails
 *    and the worker retries, the token will already be consumed. The follow-on
 *    must decide whether to mint a fresh token per entry or handle 401 as a
 *    terminal error.
 *
 * ## Canonical docs
 *
 * - docs/architecture.md — ingestion pipeline
 * - apps/worker/src/email-ingest-job.ts — worker job pattern reference
 * - apps/worker/src/startup.ts — startup guard (assertReadOnlyRole)
 * - apps/server/src/api/corporate-action-ingestion.ts — API endpoint stub
 * - tests/fixtures/edgar/msw-handler.ts — MSW intercept
 * - packages/db/task-queue.ts — TaskType.EDGAR_POLL, claimNextTask
 */

import type { TaskQueueRow } from 'db/task-queue';

/** The job_type constant for EDGAR_POLL tasks. */
export const EDGAR_INGEST_JOB_TYPE = 'EDGAR_POLL' as const;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/**
 * Payload shape for EDGAR_POLL tasks.
 *
 * Payload fields must be PII-free (TQ-P-002, TQ-C-004).
 * Only form type and poll window timestamps are included.
 */
export interface EdgarPollPayload {
  /** EDGAR form type to poll, e.g. '8-K'. */
  form_type: string;
  /** ISO-8601 UTC start of the poll window. */
  poll_window_start: string;
  /** ISO-8601 UTC end of the poll window. */
  poll_window_end: string;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Result returned by executeEdgarIngestTask after a successful poll cycle.
 */
export interface EdgarIngestResult {
  /** Number of CorporateAction rows created in this poll cycle. */
  stored_count: number;
  /** Number of entries skipped due to idempotency (already stored). */
  skipped_count: number;
  /** Number of entries that failed to ingest. */
  error_count: number;
  /** ISO-8601 UTC timestamp of the feed's <updated> element. */
  feed_updated_at: string | null;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Executes one EDGAR_POLL task cycle.
 *
 * DEV-SCOUT STUB: immediately returns a zero-count result without performing
 * any network calls or API posts. The real implementation is deferred to the
 * Phase 2 follow-on issue.
 *
 * @param task  The claimed task_queue row (contains payload + delegated_token).
 * @param apiBaseUrl  Base URL of the API server (e.g. 'http://localhost:31415').
 *                    Defaults to the API_BASE_URL env var.
 */
export async function executeEdgarIngestTask(
  task: TaskQueueRow,
  apiBaseUrl: string = process.env.API_BASE_URL ?? '',
): Promise<EdgarIngestResult> {
  // DEV-SCOUT STUB — no real EDGAR fetch or corporate-action POST yet.
  //
  // Follow-on: replace this with the full implementation described in the
  // file-level doc:
  //   1. Parse task.payload as EdgarPollPayload.
  //   2. Build EDGAR feed URL from EDGAR_FEED_URL env + poll window.
  //   3. fetch(url) — intercepted by MSW in CI.
  //   4. Parse ATOM XML entries.
  //   5. For each entry: POST to ${apiBaseUrl}/internal/ingestion/corporate-action.
  //   6. Return EdgarIngestResult.

  void task; // suppress unused-param lint error in stub
  void apiBaseUrl;

  return {
    stored_count: 0,
    skipped_count: 0,
    error_count: 0,
    feed_updated_at: null,
  };
}
