/**
 * SOC compliance review cron job.
 *
 * Registers a cron-scheduled job that enqueues a SOC 2 compliance review
 * task every 24 hours. The task is claimed by a soc_compliance worker which
 * invokes the Claude CLI to review the codebase for SOC 2 Trust Service
 * Criteria violations.
 *
 * Findings are stored as structured JSON with SOC 2 category, severity,
 * file path, description, and remediation guidance.
 *
 * Blueprint reference: WORKER domain — cron-scheduled compliance agent
 */

import type { CronScheduler } from '../scheduler';

/**
 * Default cron expression: run daily at midnight UTC.
 * Adjust via the expression parameter for testing or different cadences.
 */
export const SOC_COMPLIANCE_CRON_EXPRESSION = '0 0 * * *';

/**
 * The agent_type used when enqueueing SOC compliance review tasks.
 * Must match the AGENT_TYPE env var set on the soc_compliance worker pod.
 */
export const SOC_COMPLIANCE_CRON_AGENT_TYPE = 'soc_compliance';

/**
 * The job_type identifying SOC compliance review tasks in the queue.
 */
export const SOC_COMPLIANCE_CRON_JOB_TYPE = 'soc_compliance_review';

/**
 * Registers the SOC compliance review job on the given scheduler.
 *
 * Each tick enqueues a single `soc_compliance_review` task into task_queue
 * with agent_type=`soc_compliance`. The task is processed by the SOC
 * compliance worker which runs a read-only codebase review via the Claude CLI.
 *
 * The idempotency key is derived from the tick timestamp (minute-granular)
 * so that exactly one review task is created per scheduled interval even
 * under retry conditions.
 *
 * @param scheduler  - The cron scheduler instance.
 * @param expression - Cron expression. Defaults to daily at midnight UTC.
 */
export function registerSocComplianceReviewJob(
  scheduler: CronScheduler,
  expression = SOC_COMPLIANCE_CRON_EXPRESSION,
): void {
  scheduler.register('soc-compliance-review', expression, async (ctx) => {
    const tickTs = new Date();
    // Idempotency key scoped to the minute so retries within the same
    // scheduled window converge to the same task row (TQ-P-003).
    const minuteKey = tickTs.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"

    await ctx.enqueueCronTask({
      job_type: SOC_COMPLIANCE_CRON_JOB_TYPE,
      payload: {
        scheduled_at: tickTs.toISOString(),
        review_scope: 'full',
      },
      idempotency_key_suffix: `soc-review-${minuteKey}`,
      priority: 3, // Lower priority than interactive tasks; runs in background.
      max_attempts: 2, // One retry on transient failure.
    });

    console.log(`[cron] soc-compliance-review: enqueued review task for ${minuteKey}`);
  });
}
