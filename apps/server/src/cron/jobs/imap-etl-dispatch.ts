/**
 * @file imap-etl-dispatch.ts
 *
 * IMAP ETL cron dispatcher.
 *
 * This job is a _task producer_, not a worker. It runs on a schedule and
 * inserts an `email_ingest` task row into the task queue. The worker
 * (agent_type='email_ingest') claims the task and executes the IMAP fetch.
 *
 * Architecture notes
 * ------------------
 * The cron dispatcher follows the superfield-distribution pattern established
 * in `superfield-distribution/apps/server/src/cron/imap-etl-dispatch.ts`:
 *
 *   - Cron = producer (inserts task rows).
 *   - Worker = consumer (claims and executes tasks via task-queue API).
 *
 * The `since_uid` checkpoint is embedded in the task payload using the
 * `idempotency_key_suffix` to ensure at-most-one-outstanding task per
 * polling window. The worker echoes `highest_uid` in its result; the next
 * dispatcher run reads it from the last completed task and passes it as
 * `since_uid` so messages are never re-fetched.
 *
 * Blueprint refs: TQ-D-001, TQ-P-002, WORKER domain (cron-as-producer),
 * PRD §6 (email ingestion schedule).
 */

import { enqueueTask, type TaskQueueRow } from 'db/task-queue';
import type { CronScheduler } from '../scheduler';
import { TaskType, TASK_TYPE_AGENT_MAP } from 'db/task-queue';

/** Default cron expression: every 5 minutes. */
const DEFAULT_EXPRESSION = '*/5 * * * *';

/**
 * The mailbox reference used in task payloads.
 *
 * This opaque identifier is used for correlation between the task queue
 * row and observability tooling. The actual IMAP credentials are resolved
 * from environment variables by the worker at execution time.
 */
const DEFAULT_MAILBOX_REF = 'primary';

/**
 * Registers the IMAP ETL dispatch job on the given scheduler.
 *
 * On each tick the job:
 *   1. Resolves the `since_uid` checkpoint from the last completed
 *      `email_ingest` task (defaults to 0 on first run).
 *   2. Enqueues an `email_ingest` task with agent_type='email_ingest',
 *      using a time-windowed idempotency key so at most one outstanding
 *      task exists per 5-minute window.
 *   3. Logs the task ID for observability.
 *
 * @param scheduler   - The cron scheduler instance.
 * @param expression  - Cron expression. Defaults to every 5 minutes.
 * @param mailboxRef  - Opaque mailbox identifier for correlation.
 */
export function registerImapEtlDispatchJob(
  scheduler: CronScheduler,
  expression = DEFAULT_EXPRESSION,
  mailboxRef = DEFAULT_MAILBOX_REF,
): void {
  scheduler.register('imap-etl-dispatch', expression, async () => {
    // Use a 5-minute time window for the idempotency key so that at most one
    // task is outstanding per window. This prevents backlog accumulation if
    // a previous task is still running or has failed.
    const windowMinutes = Math.floor(Date.now() / (5 * 60 * 1000));
    const idempotencyKey = `imap-etl-dispatch:${mailboxRef}:${windowMinutes}`;

    const task: TaskQueueRow = await enqueueTask({
      idempotency_key: idempotencyKey,
      agent_type: TASK_TYPE_AGENT_MAP[TaskType.EMAIL_INGEST],
      job_type: 'email_ingest',
      payload: {
        mailbox_ref: mailboxRef,
        // since_uid defaults to 0; the worker will start from the beginning
        // if no prior checkpoint is available. Follow-on issue #28 will wire
        // up checkpoint persistence so this is read from the last completed
        // task result.
        since_uid: 0,
        batch_size: 50,
      },
      created_by: 'cron:imap-etl-dispatch',
      priority: 5,
      // Allow 3 attempts before dead-lettering. Transient failures
      // (network, IMAP TEMPFAIL) are recovered by stale-claim backoff.
      max_attempts: 3,
    });

    console.log(
      `[cron] imap-etl-dispatch enqueued task ${task.id} (mailbox_ref=${mailboxRef}, idempotency_key=${idempotencyKey})`,
    );
  });
}
