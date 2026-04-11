/**
 * Dead-letter queue (DLQ) monitor cron job.
 *
 * Runs every 5 minutes, queries the current dead-task depth per agent type,
 * and logs an alert when any type exceeds the configured threshold.
 *
 * Blueprint ref: TQ-C-003 (dead-letter alert threshold).
 * Issue: #95
 */

import { checkDlqAlertThreshold, DLQ_ALERT_THRESHOLD } from 'db/task-queue';
import type { CronScheduler } from '../scheduler';

/**
 * Registers the DLQ monitor job on the given scheduler.
 *
 * @param scheduler  - The cron scheduler instance.
 * @param expression - Cron expression. Defaults to every 5 minutes.
 * @param threshold  - Dead-task count that triggers an alert.
 *                     Defaults to `DLQ_ALERT_THRESHOLD` (10).
 */
export function registerDlqMonitorJob(
  scheduler: CronScheduler,
  expression = '*/5 * * * *',
  threshold = DLQ_ALERT_THRESHOLD,
): void {
  scheduler.register('dlq-monitor', expression, async (ctx) => {
    const { breached, depth } = await checkDlqAlertThreshold(threshold);

    if (breached.length > 0) {
      for (const row of breached) {
        console.error(
          `[dlq-monitor] ALERT: agent_type="${row.agent_type}" dead_count=${row.dead_count} exceeds threshold=${threshold} (TQ-C-003)`,
        );
      }
    } else {
      console.log(
        `[dlq-monitor] DLQ depth within threshold (threshold=${threshold}, types checked=${depth.length})`,
      );
    }

    // Enqueue a cron task so the sweep is visible in the admin task queue.
    await ctx.enqueueCronTask({
      job_type: 'dlq-monitor',
      payload: {
        checked_at: new Date().toISOString(),
        threshold,
        breached_count: breached.length,
        depth: depth.map((r) => ({ agent_type: r.agent_type, dead_count: r.dead_count })),
      },
      idempotency_key_suffix: `dlq-${Date.now()}`,
    });
  });
}
