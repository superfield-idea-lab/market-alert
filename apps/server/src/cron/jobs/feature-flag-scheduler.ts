/**
 * Feature-flag scheduled-disable cron job.
 *
 * Every minute, queries feature_flags for rows where:
 *   state = 'enabled' AND scheduled_disable_at <= NOW()
 *
 * Any matching rows are flipped to state = 'disabled' with disabled_at = NOW().
 * A cron task is enqueued for admin-monitor visibility.
 *
 * PRUNE-D-003, PRUNE-C-002.
 */

import { getFlagsDueForDisable, disableFlag } from 'db/feature-flags';
import type { CronScheduler } from '../scheduler';

/**
 * Registers the feature-flag scheduler job.
 *
 * @param scheduler  - The cron scheduler instance.
 * @param expression - Cron expression. Defaults to every minute.
 */
export function registerFeatureFlagSchedulerJob(
  scheduler: CronScheduler,
  expression = '* * * * *',
): void {
  scheduler.register('feature-flag-scheduler', expression, async (ctx) => {
    const due = await getFlagsDueForDisable();

    for (const flag of due) {
      await disableFlag(flag.name);
      console.log(
        `[feature-flag-scheduler] Disabled flag "${flag.name}" (scheduled_disable_at: ${flag.scheduled_disable_at?.toISOString()})`,
      );
    }

    await ctx.enqueueCronTask({
      job_type: 'feature-flag-scheduler',
      payload: {
        disabled_count: due.length,
        disabled_flags: due.map((f) => f.name),
        swept_at: new Date().toISOString(),
      },
      idempotency_key_suffix: `sweep-${Date.now()}`,
    });
  });
}
