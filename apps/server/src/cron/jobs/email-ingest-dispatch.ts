/**
 * @file email-ingest-dispatch.ts
 *
 * Email ingestion cron dispatcher — Phase 2 dev-scout stub.
 *
 * ## Status: dev-scout stub
 *
 * This file is a **no-op stub** created by the Phase 2 dev-scout (issue #25).
 * Registering the job wires a named slot into the cron scheduler so follow-on
 * issues can attach real IMAP dispatch logic without touching the scheduler
 * boot path or the cron registry.
 *
 * No task rows are enqueued; no IMAP connections are made; no side effects
 * occur at runtime.
 *
 * ## Production design
 *
 * The production implementation will:
 *
 *   1. Query the `mailbox_configs` table (to be created in a follow-on issue)
 *      for all active tenant IMAP credential bundles.
 *
 *   2. For each credential bundle, open an IMAP connection via `imapflow` and
 *      call `SEARCH UNSEEN` to obtain UIDs of unread messages.
 *
 *   3. For each UID, insert one `EMAIL_INGEST` task row into `task_queue`
 *      with:
 *        - `agent_type`:      "email_ingest"
 *        - `job_type`:        "email_ingest"
 *        - `payload.mailbox_ref`:  opaque ref to the credential bundle
 *        - `payload.uid`:          IMAP UID (string)
 *        - `payload.tenant_ref`:   opaque tenant identifier
 *        - `payload.ingest_ref`:   `${mailboxRef}-${uid}` (idempotency anchor)
 *        - `idempotency_key`:  `email-ingest-${mailboxRef}-${uid}`
 *
 *   4. The `idempotency_key` prevents re-enqueuing a UID that is already
 *      pending or in-flight (TQ-C-005). UIDs that are already completed can
 *      be re-enqueued if the IMAP flag is reset (e.g. after re-delivery).
 *
 * Reuse `superfield-distribution/apps/server/src/cron/imap-etl-dispatch.ts` as
 * the implementation reference.
 *
 * ## Integration points discovered during scout
 *
 * - `mailbox_configs` table does not yet exist. A follow-on issue must add
 *   it to `packages/db/schema.sql` with at minimum: `id`, `tenant_id`,
 *   `mailbox_ref` (opaque), `imap_host`, `imap_port`, `active` columns.
 *   Raw IMAP passwords must never appear in the app database; they live in
 *   the worker-credentials table (`packages/db/worker-credentials.ts`).
 *
 * - `enqueueCronTask` in the scheduler context (`apps/server/src/cron/
 *   scheduler.ts`) enforces `agent_type` = the scheduler's own agent type by
 *   default. The email-ingest dispatcher targets agent_type="email_ingest";
 *   the scheduler boot path (`apps/server/src/cron/boot.ts`) must be updated
 *   to register this job under a scheduler instance scoped to that agent type.
 *
 * - The `task_queue_view_email_ingest` SQL view is already defined in
 *   `packages/db/schema.sql` (added during Phase 1 scaffolding) but the
 *   corresponding DB role and RLS policies have not yet been applied via
 *   `packages/db/init-remote.ts`. A follow-on issue must add the role
 *   creation, GRANT, and RLS policy calls there.
 *
 * ## Canonical docs
 *
 * - Implementation plan Phase 2: `docs/implementation-plan-v1.md`
 * - PRD §4.1 (ingestion state machine): `docs/PRD.md`
 * - Worker blueprint: `calypso-blueprint/rules/blueprints/worker.yaml`
 * - Task queue design: `packages/db/task-queue.ts`
 */

import type { CronScheduler } from '../scheduler';

/** Default cron expression: every 5 minutes. */
const DEFAULT_EXPRESSION = '*/5 * * * *';

/**
 * Registers the email ingestion dispatch job on the given scheduler.
 *
 * In this scout stub the handler does nothing — it exists only to confirm
 * that the scheduler accepts the registration and that follow-on issues can
 * attach real dispatch logic by replacing the body of the handler below.
 *
 * @param scheduler   - The cron scheduler instance.
 * @param expression  - Cron expression. Defaults to every 5 minutes.
 */
export function registerEmailIngestDispatchJob(
  scheduler: CronScheduler,
  expression = DEFAULT_EXPRESSION,
): void {
  scheduler.register('email-ingest-dispatch', expression, async (_ctx) => {
    // DEV-SCOUT STUB — no real IMAP dispatch yet.
    //
    // Follow-on: replace this comment with the IMAP SEARCH + enqueueCronTask
    // loop described in the file-level doc above.
    //
    // Risks identified during scout:
    //   1. IMAP connection back-pressure: if the mailbox has thousands of
    //      unseen messages the first run will create a large burst of task
    //      rows. The follow-on must cap per-run enqueue count and implement
    //      a watermark cursor.
    //   2. IMAP credential rotation: the credential bundle in worker-credentials
    //      is encrypted at rest; the dispatcher must not cache it in memory
    //      across cron ticks.
    //   3. Greenmail test container startup order: integration tests must
    //      start the Greenmail container before the dispatcher fires. The
    //      imap-container.ts helper from superfield-distribution handles this.
  });
}
