/**
 * Autolearn gardening cron job — task-queue producer.
 *
 * Inserts an `AUTOLEARN` task row into the task_queue every 15 minutes
 * (default). The frequency is overridable per tenant via the
 * `autolearn_cron_interval` policy row in `tenant_policies`.
 *
 * The task payload contains only a reference (tenant_id, dept_id,
 * customer_id) — no business data (`TQ-C-004`).
 *
 * Each insertion uses an idempotency key derived from the 15-minute
 * time window so that duplicate cron firings within the same window
 * produce exactly one task row (`TQ-C-005`).
 *
 * The LISTEN/NOTIFY trigger on `task_queue` (TQ-D-005) wakes the autolearn
 * worker pod automatically on each insertion.
 *
 * Blueprint refs:
 *   TQ-C-004  payload contains only references, no business data
 *   TQ-C-005  idempotency key prevents duplicate runs in the same window
 *   TQ-D-005  LISTEN/NOTIFY wake
 *   PRUNE-A-003  frequency is tenant-overridable, not hard-coded
 *
 * Issue: #40
 */

import { enqueueTask, TaskType, TASK_TYPE_AGENT_MAP } from 'db/task-queue';
import type { CronScheduler } from '../scheduler';

/**
 * The default cron expression for the autolearn gardening run.
 * Resolved at registration time; tenant overrides are applied per-tick.
 *
 * Default: every 15 minutes.
 */
export const AUTOLEARN_DEFAULT_CRON_EXPRESSION = '*/15 * * * *';

/**
 * Policy key used to look up a per-tenant cron expression override.
 */
export const AUTOLEARN_POLICY_KEY = 'autolearn_cron_interval';

/**
 * Derives the idempotency key for an autolearn task from the scheduled
 * time window. Rounds `now` down to the nearest `windowMinutes` boundary
 * so duplicate cron firings within the same window converge to the same key.
 *
 * @param now           The current wall-clock time (injected for testability).
 * @param windowMinutes Size of the dedup window in minutes (default: 15).
 * @param tenantId      Optional tenant ID included in the key for isolation.
 */
export function buildAutolearnIdempotencyKey(
  now: Date,
  windowMinutes = 15,
  tenantId?: string | null,
): string {
  const windowMs = windowMinutes * 60 * 1_000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const windowStr = windowStart.toISOString().replace(/[:.]/g, '-');
  const tenantSegment = tenantId ? `:tenant-${tenantId}` : '';
  return `autolearn:gardening${tenantSegment}:${windowStr}`;
}

export interface AutolearnGardeningPayload {
  /** Tenant identifier — references only, no PII (TQ-C-004). */
  tenant_id: string | null;
  /** Department identifier, if scoped. */
  dept_id: string | null;
  /** Customer identifier, if scoped. */
  customer_id: string | null;
  /** ISO-8601 timestamp of the window start that triggered this task. */
  window_start: string;
}

/**
 * Registers the autolearn gardening cron job on the given scheduler.
 *
 * The job fires on `expression` (default: every 15 minutes) and inserts one
 * `AUTOLEARN` task row per tick. Duplicate insertions within the same
 * 15-minute window are deduped by the idempotency key.
 *
 * @param scheduler  - The cron scheduler instance.
 * @param expression - Cron expression. Defaults to every 15 minutes.
 *                     Should match the `autolearn_cron_interval` global policy.
 */
export function registerAutolearnGardeningJob(
  scheduler: CronScheduler,
  expression = AUTOLEARN_DEFAULT_CRON_EXPRESSION,
): void {
  scheduler.register('autolearn-gardening', expression, async () => {
    const now = new Date();
    const idempotencyKey = buildAutolearnIdempotencyKey(now);

    const payload: AutolearnGardeningPayload = {
      tenant_id: null,
      dept_id: null,
      customer_id: null,
      window_start: new Date(
        Math.floor(now.getTime() / (15 * 60 * 1_000)) * (15 * 60 * 1_000),
      ).toISOString(),
    };

    await enqueueTask({
      idempotency_key: idempotencyKey,
      agent_type: TASK_TYPE_AGENT_MAP[TaskType.AUTOLEARN],
      job_type: TaskType.AUTOLEARN,
      payload: payload as unknown as Record<string, unknown>,
      created_by: 'cron:autolearn-gardening',
    });

    console.log(
      `[autolearn-gardening] Enqueued AUTOLEARN task (idempotency_key=${idempotencyKey})`,
    );
  });
}
