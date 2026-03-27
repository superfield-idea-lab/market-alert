/**
 * Code cleanup and dependency optimization cron job.
 *
 * Enqueues a `code_cleanup` task for the code_cleanup agent on a scheduled
 * basis.  The worker claims the task and invokes the Claude CLI to perform
 * read-only code quality and dependency analysis.
 *
 * Findings are stored as structured JSON and surfaced through the admin task
 * queue view.
 */

import type { CronScheduler } from '../scheduler';

/**
 * Registers the code cleanup analysis job on the given scheduler.
 *
 * @param scheduler  - The cron scheduler instance.
 * @param expression - Cron expression. Defaults to once daily at 02:00 UTC.
 */
export function registerCodeCleanupJob(scheduler: CronScheduler, expression = '0 2 * * *'): void {
  scheduler.register('code-cleanup', expression, async (ctx) => {
    await ctx.enqueueCronTask({
      job_type: 'code_cleanup',
      payload: {
        prompt_ref: 'builtin:code-cleanup-v1',
        triggered_at: new Date().toISOString(),
      },
      idempotency_key_suffix: `daily-${new Date().toISOString().slice(0, 10)}`,
      // Low priority — analysis should not compete with user-initiated tasks.
      priority: 3,
      max_attempts: 1,
    });
  });
}
