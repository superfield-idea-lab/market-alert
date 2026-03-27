/**
 * Security vulnerability scanner cron job.
 *
 * Enqueues a `security_scan` task into the task queue on a configurable
 * schedule (default: daily at 03:00 UTC). The task is picked up by a worker
 * running with agent_type="security" and executed via Claude CLI with a
 * security-focused prompt.
 *
 * The cron job enqueues once per run. The worker performs read-only code
 * analysis and stores structured JSON findings in the task queue result.
 */

import type { CronScheduler } from '../scheduler';

/** Default cron expression: daily at 03:00 UTC. */
const DEFAULT_EXPRESSION = '0 3 * * *';

/**
 * Registers the security vulnerability scanner job on the given scheduler.
 *
 * @param scheduler   - The cron scheduler instance.
 * @param expression  - Cron expression. Defaults to daily at 03:00 UTC.
 */
export function registerSecurityScannerJob(
  scheduler: CronScheduler,
  expression = DEFAULT_EXPRESSION,
): void {
  scheduler.register('security-scanner', expression, async (ctx) => {
    const scanRef = `scan-${Date.now()}`;

    await ctx.enqueueCronTask({
      job_type: 'security_scan',
      payload: { scan_ref: scanRef },
      idempotency_key_suffix: scanRef,
      // Security scans are lower priority than interactive tasks.
      priority: 3,
      // A single attempt per scheduled run; failures appear in task queue.
      max_attempts: 1,
    });

    console.log(`[cron] security-scanner enqueued scan task with scan_ref=${scanRef}`);
  });
}
