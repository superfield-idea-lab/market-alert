/**
 * @file corp-action-advance-dispatch.ts
 *
 * Corporate Action advance dispatch cron job — Phase 2 (issue #16).
 *
 * ## What this does
 *
 * On each tick the job:
 *   1. Queries `findCorporateActionsNeedingAdvance()` for rows whose
 *      effective_date or settlement_date has passed and whose state has not
 *      yet advanced.
 *   2. For each qualifying row, enqueues one CORP_ACTION_ADVANCE task with
 *      idempotency key `corp-action-advance:<id>` so that a second cron tick
 *      does not produce a duplicate pending task.
 *   3. Logs the count of tasks enqueued.
 *
 * Duplicate prevention relies on two layers:
 *   a. `findCorporateActionsNeedingAdvance` excludes rows that already have a
 *      pending or claimed CORP_ACTION_ADVANCE task.
 *   b. `enqueueTask` uses ON CONFLICT (idempotency_key) DO NOTHING as a
 *      final guard.
 *
 * ## Cron expression
 *
 * Default: every minute (`* * * * *`). Configurable via the expression param.
 *
 * ## Canonical docs
 *
 * - docs/plan.md — Phase 2 scope
 * - packages/db/mkt-corporate-action-lifecycle.ts — findCorporateActionsNeedingAdvance
 * - packages/db/task-queue.ts — enqueueTask, TaskType.CORP_ACTION_ADVANCE
 * - apps/server/src/cron/boot.ts — registration wiring
 */

import type { CronScheduler } from '../scheduler';
import { findCorporateActionsNeedingAdvance } from 'db/mkt-corporate-action-lifecycle';
import { enqueueTask, TaskType, TASK_TYPE_AGENT_MAP } from 'db/task-queue';

const DEFAULT_EXPRESSION = '* * * * *';

/**
 * Registers the CORP_ACTION_ADVANCE dispatch cron job on the given scheduler.
 *
 * @param scheduler   - The cron scheduler instance.
 * @param expression  - Cron expression. Defaults to every minute.
 */
export function registerCorpActionAdvanceDispatchJob(
  scheduler: CronScheduler,
  expression = DEFAULT_EXPRESSION,
): void {
  scheduler.register('corp-action-advance-dispatch', expression, async (_ctx) => {
    const candidates = await findCorporateActionsNeedingAdvance();

    if (candidates.length === 0) {
      return;
    }

    let enqueued = 0;
    for (const candidate of candidates) {
      const idempotencyKey = `corp-action-advance:${candidate.id}`;
      await enqueueTask({
        idempotency_key: idempotencyKey,
        agent_type: TASK_TYPE_AGENT_MAP[TaskType.CORP_ACTION_ADVANCE],
        job_type: TaskType.CORP_ACTION_ADVANCE,
        payload: { corporate_action_id: candidate.id },
        created_by: 'cron:corp-action-advance-dispatch',
      });
      enqueued += 1;
    }

    console.log(`[corp-action-advance-dispatch] Enqueued ${enqueued} CORP_ACTION_ADVANCE task(s)`);
  });
}
