/**
 * Dead-letter queue (DLQ) monitor cron job stub.
 *
 * Phase 0 dev-scout stub. Monitors the task queue for failed tasks that have
 * exhausted all retry attempts and enqueues a DLQ monitoring task.
 *
 * Blueprint refs: TQ-D-006 (DLQ monitoring), issue #5 (Phase 0 follow-on).
 *
 * ## Integration points discovered
 * - Requires task_queue table with status='failed' and attempt >= max_attempts.
 * - Admin dashboard (Phase 4) needs a DLQ view to surface stuck tasks.
 * - alerting hooks (Slack, email) for failed task spikes are Phase 4 follow-on.
 *
 * ## Phase 0 stub behaviour
 * No-op: the job is registered but does not enqueue tasks until Phase 0
 * task-queue follow-on lands (when task_queue table exists in schema).
 */

import type { CronScheduler } from '../scheduler';

/**
 * Registers the DLQ monitor job on the given scheduler.
 *
 * @param scheduler  - The cron scheduler instance.
 * @param expression - Cron expression. Defaults to every 15 minutes.
 */
export function registerDlqMonitorJob(scheduler: CronScheduler, expression = '*/15 * * * *'): void {
  // Phase 0 stub: no-op registration so the scheduler wires up without errors.
  // Real DLQ monitoring lands in the Phase 0 task-queue follow-on issue.
  scheduler.register('dlq-monitor', expression, async () => {
    // stub — Phase 0 task-queue follow-on will implement:
    // 1. SELECT count(*) FROM task_queue WHERE status='failed' AND attempt>=max_attempts
    // 2. If count > threshold, enqueue a dlq_alert task for the admin agent
  });
}
