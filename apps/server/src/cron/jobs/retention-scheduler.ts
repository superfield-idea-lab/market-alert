/**
 * @file cron/jobs/retention-scheduler
 *
 * Nightly retention scheduler cron job.
 *
 * Registers a cron job that runs once per night, scanning all tenant entities
 * for retention-eligible rows. Eligible rows (past their retention window,
 * not under a legal hold) are hard-deleted via the controlled deletion path in
 * `packages/db/retention-scheduler.ts`. Every deletion emits a hash-chained
 * audit event with `actor_id = 'scheduler'`.
 *
 * ## Schedule
 *
 * Default: `0 1 * * *` — daily at 01:00 UTC, after midnight to avoid peak
 * traffic while ensuring nightly execution. Override via the `expression`
 * parameter for testing.
 *
 * ## Audit events
 *
 * Each entity deletion emits:
 *   - `actor_id`: `'scheduler'`
 *   - `action`: `'retention.delete'`
 *   - `before`: `{ retention_class, tenant_id, entity_type }`
 *   - `after`: `null`
 *
 * Blueprint reference: Phase 8 — Records management & compliance (issue #83)
 */

import type { CronScheduler } from '../scheduler';
import { sql } from 'db';
import { emitAuditEvent } from '../../policies/audit-service';
import { runRetentionScheduler } from 'db/retention-scheduler';

/**
 * Default cron expression: run daily at 01:00 UTC.
 */
export const RETENTION_SCHEDULER_CRON_EXPRESSION = '0 1 * * *';

/**
 * Registers the nightly retention scheduler job on the given scheduler.
 *
 * @param scheduler  - The cron scheduler instance.
 * @param expression - Cron expression. Defaults to daily at 01:00 UTC.
 */
export function registerRetentionSchedulerJob(
  scheduler: CronScheduler,
  expression = RETENTION_SCHEDULER_CRON_EXPRESSION,
): void {
  scheduler.register('retention-scheduler', expression, async (ctx) => {
    const runDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    console.log(`[cron] retention-scheduler: starting nightly scan for ${runDate}`);

    const summary = await runRetentionScheduler(sql, async (event) => {
      await emitAuditEvent(event);
    });

    // Enqueue a cron task so the scan is visible in the admin task queue.
    await ctx.enqueueCronTask({
      job_type: 'retention_scheduler_run',
      payload: {
        run_date: runDate,
        deleted_count: summary.deletedCount,
        skipped_count: summary.skippedCount,
        started_at: summary.startedAt,
        completed_at: summary.completedAt,
      },
      idempotency_key_suffix: `retention-scan-${runDate}`,
      priority: 5, // Low priority — background compliance task.
      max_attempts: 1, // Do not retry; next nightly run will pick up any missed rows.
    });

    console.log(
      `[cron] retention-scheduler: done — deleted=${summary.deletedCount} skipped=${summary.skippedCount}`,
    );
  });
}
