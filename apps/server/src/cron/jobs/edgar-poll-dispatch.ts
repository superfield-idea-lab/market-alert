/**
 * @file edgar-poll-dispatch.ts
 *
 * EDGAR poll dispatch cron job — Phase 2 dev-scout stub (issue #14).
 *
 * ## Status: dev-scout stub
 *
 * Registers a named slot in the cron scheduler. The handler does nothing
 * (no tasks enqueued, no network calls). Follow-on Phase 2 issues replace
 * the handler body with the real EDGAR_POLL enqueue logic.
 *
 * ## Production design (follow-on implementation)
 *
 * The production handler must:
 *
 *   1. Call `evaluateFlag('edgar_ingest', sql)` from packages/db/mkt-feature-flags.ts.
 *      If the flag is disabled, log and return early — do not enqueue.
 *
 *   2. Compute the poll window:
 *        - startdt = last successful poll timestamp (stored in a checkpoint table
 *          or derived from the most recent EDGAR_POLL task row — to be designed)
 *        - enddt   = now()
 *
 *   3. For each EDGAR form type in scope (initially just '8-K'), enqueue one
 *      EDGAR_POLL task via `enqueueTask`:
 *        - idempotency_key: `buildEdgarPollIdempotencyKey(formType, windowKey)`
 *          where windowKey encodes the poll window to prevent re-enqueuing
 *          the same window (TQ-P-003).
 *        - agent_type: TASK_TYPE_AGENT_MAP[TaskType.EDGAR_POLL] = 'edgar_ingest'
 *        - job_type:   TaskType.EDGAR_POLL
 *        - payload:    { form_type, poll_window_start, poll_window_end }
 *        - created_by: 'cron:edgar-poll-dispatch'
 *
 *   4. Log the enqueue result (task id or idempotency skip).
 *
 * ## Integration points discovered during scout
 *
 * 1. `evaluateFlag` is already implemented in packages/db/mkt-feature-flags.ts
 *    and the 'edgar_ingest' flag row is seeded in mkt-schema.sql (enabled=false
 *    by default). The cron job must check this flag before enqueueing.
 *
 * 2. `buildEdgarPollIdempotencyKey` in packages/db/task-queue.ts currently
 *    takes (formType, accessionNumber). For the cron-level poll task the
 *    second parameter should encode the poll window, not an accession number.
 *    The follow-on issue must decide whether to reuse this key builder or
 *    introduce a separate `buildEdgarPollWindowKey` helper.
 *
 * 3. The cron scheduler (`apps/server/src/cron/scheduler.ts`) uses
 *    `enqueueTask` internally via `enqueueCronTask`. That helper hardcodes
 *    `agent_type` to the scheduler's own type. The EDGAR_POLL task targets
 *    agent_type='edgar_ingest', which is a different agent. The cron job
 *    must call `enqueueTask` directly (bypassing `enqueueCronTask`) or the
 *    scheduler must be extended to allow cross-agent enqueue.
 *
 * 4. The boot module (apps/server/src/cron/boot.ts) must import and call
 *    `registerEdgarPollDispatchJob(scheduler)` after this stub lands. The
 *    follow-on implementation issue owns that wiring.
 *
 * ## Risks identified during scout
 *
 * 1. Poll window overlap: if the cron fires while a previous EDGAR_POLL task
 *    is still claimed, the idempotency key for that window will prevent
 *    double-enqueue — but if the window advances, the new key will create a
 *    second in-flight task for a different window. The follow-on must define
 *    a maximum in-flight EDGAR_POLL task count (likely 1 per form type).
 *
 * 2. Clock drift: `NOW()` in Postgres and the cron job's JS `Date.now()` may
 *    differ by a few milliseconds. The poll window boundary should use the
 *    Postgres clock for all window calculations to ensure consistency.
 *
 * 3. Feature flag check latency: `evaluateFlag` hits the app database. If the
 *    database is unavailable the cron tick will throw. The scheduler currently
 *    logs errors per-tick without stopping the scheduler loop — this is
 *    acceptable behaviour.
 *
 * ## Canonical docs
 *
 * - docs/architecture.md — ingestion pipeline overview
 * - docs/plan.md — Phase 2 scope
 * - apps/server/src/cron/jobs/email-ingest-dispatch.ts — pattern reference
 * - packages/db/mkt-feature-flags.ts — evaluateFlag
 * - packages/db/task-queue.ts — buildEdgarPollIdempotencyKey, TaskType.EDGAR_POLL
 * - apps/server/src/cron/scheduler.ts — CronScheduler
 * - apps/server/src/cron/boot.ts — job registration wiring
 */

import type { CronScheduler } from '../scheduler';

/** Default cron expression: every 5 minutes. */
const DEFAULT_EXPRESSION = '*/5 * * * *';

/**
 * Registers the EDGAR poll dispatch cron job on the given scheduler.
 *
 * In this scout stub the handler does nothing — it exists only to confirm
 * that the scheduler accepts the registration and that follow-on issues can
 * attach real EDGAR_POLL enqueue logic by replacing the handler body below.
 *
 * @param scheduler   - The cron scheduler instance.
 * @param expression  - Cron expression. Defaults to every 5 minutes.
 */
export function registerEdgarPollDispatchJob(
  scheduler: CronScheduler,
  expression = DEFAULT_EXPRESSION,
): void {
  scheduler.register('edgar-poll-dispatch', expression, async (_ctx) => {
    // DEV-SCOUT STUB — no real EDGAR poll dispatch yet.
    //
    // Follow-on: replace this comment with the feature-flag check +
    // EDGAR_POLL enqueue logic described in the file-level doc above.
    //
    // Step outline:
    //   const enabled = await evaluateFlag('edgar_ingest');
    //   if (!enabled) { console.log('[edgar-poll-dispatch] flag disabled'); return; }
    //   const ikey = buildEdgarPollIdempotencyKey('8-K', pollWindowKey);
    //   await enqueueTask({ idempotency_key: ikey, agent_type: 'edgar_ingest',
    //     job_type: TaskType.EDGAR_POLL, payload: { form_type: '8-K', ... },
    //     created_by: 'cron:edgar-poll-dispatch' });
  });
}
