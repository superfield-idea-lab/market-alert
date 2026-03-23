/**
 * Stale-claim recovery service (TQ-D-003).
 *
 * Wraps the db-layer recoverStaleClaims() call and emits an audit log entry
 * for each recovered row:
 *   - action: 'task.stale_recovery'  when the task is reset to 'pending'
 *   - action: 'task.dead'            when the task is promoted to 'dead'
 */

import { startStaleClaimRecovery as dbStartStaleClaimRecovery } from 'db/task-queue';
import type { RecoveredTaskRow } from 'db/task-queue';
import { emitAuditEvent } from './audit-service';

/**
 * Emits one audit event per recovered row, absorbing individual failures so a
 * single bad audit write does not block the rest of the batch.
 */
export async function auditRecoveredRows(rows: RecoveredTaskRow[]): Promise<void> {
  const ts = new Date().toISOString();
  await Promise.all(
    rows.map((row) =>
      emitAuditEvent({
        actor_id: 'system:stale-claim-recovery',
        action: row.status === 'dead' ? 'task.dead' : 'task.stale_recovery',
        entity_type: 'task_queue',
        entity_id: row.id,
        before: null,
        after: {
          id: row.id,
          status: row.status,
          attempt: row.attempt,
          agent_type: row.agent_type,
          job_type: row.job_type,
        },
        ts,
      }).catch((err) => console.error(`[task-queue] audit emit failed for task ${row.id}:`, err)),
    ),
  );
}

/**
 * Starts the stale-claim recovery scheduler with audit event emission.
 *
 * Wraps the db-layer startStaleClaimRecovery with an audit callback that
 * writes one audit event per recovered row.
 *
 * @param intervalMs - Polling interval in milliseconds. Defaults to 60 000.
 */
export function startStaleClaimRecovery(intervalMs = 60_000): ReturnType<typeof setInterval> {
  return dbStartStaleClaimRecovery(intervalMs, auditRecoveredRows);
}
