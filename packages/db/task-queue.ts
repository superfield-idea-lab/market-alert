import { sql } from './index';

/**
 * TaskType enum — canonical job types for the kb-demo worker pipeline.
 *
 * Each variant corresponds to a distinct worker phase:
 *   EMAIL_INGEST   — Phase 2: pull emails into the KB (agent_type: email_ingest)
 *   AUTOLEARN      — Phase 3: autolearning from ingested content (agent_type: autolearn)
 *   TRANSCRIPTION  — Phase 5: audio/video transcription (agent_type: transcription)
 *   ANNOTATION     — Phase 6: entity annotation agent (agent_type: annotation)
 *   DEEPCLEAN      — Phase 4: deep PII cleaning pass (agent_type: deepclean)
 *   BDM_SUMMARY    — Phase 7: BDM-ready summary generation (agent_type: bdm_summary)
 *
 * Blueprint refs: TQ-D-001 (single-table multi-type queue), issue #95.
 */
export const TaskType = {
  EMAIL_INGEST: 'EMAIL_INGEST',
  AUTOLEARN: 'AUTOLEARN',
  TRANSCRIPTION: 'TRANSCRIPTION',
  ANNOTATION: 'ANNOTATION',
  DEEPCLEAN: 'DEEPCLEAN',
  BDM_SUMMARY: 'BDM_SUMMARY',
} as const;

export type TaskType = (typeof TaskType)[keyof typeof TaskType];

/**
 * Maps each TaskType to its agent_type string used in the task_queue table
 * and in per-type views (task_queue_view_<agent_type>).
 */
export const TASK_TYPE_AGENT_MAP: Record<TaskType, string> = {
  [TaskType.EMAIL_INGEST]: 'email_ingest',
  [TaskType.AUTOLEARN]: 'autolearn',
  [TaskType.TRANSCRIPTION]: 'transcription',
  [TaskType.ANNOTATION]: 'annotation',
  [TaskType.DEEPCLEAN]: 'deepclean',
  [TaskType.BDM_SUMMARY]: 'bdm_summary',
};

/**
 * Task status values matching the CHECK constraint in schema.sql.
 *
 * State machine (TQ-D-002):
 *   pending → claimed → running → submitting → completed | failed | dead
 *   claimed → pending  (stale recovery, attempt < max_attempts)
 *   claimed → dead     (stale recovery, attempt >= max_attempts)
 */
export type TaskQueueStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'submitting'
  | 'completed'
  | 'failed'
  | 'dead';

export interface TaskQueueRow {
  id: string;
  idempotency_key: string;
  agent_type: string;
  job_type: string;
  status: TaskQueueStatus;
  payload: Record<string, unknown>;
  correlation_id: string | null;
  created_by: string;
  claimed_by: string | null;
  claimed_at: Date | null;
  claim_expires_at: Date | null;
  delegated_token: string | null;
  result: Record<string, unknown> | null;
  error_message: string | null;
  attempt: number;
  max_attempts: number;
  next_retry_at: Date | null;
  priority: number;
  created_at: Date;
  updated_at: Date;
}

export interface EnqueueOptions {
  idempotency_key: string;
  agent_type: string;
  job_type: string;
  payload?: Record<string, unknown>;
  correlation_id?: string;
  created_by: string;
  priority?: number;
  max_attempts?: number;
}

/**
 * Idempotently enqueues a task (TQ-P-003 idempotent-task-creation).
 *
 * On conflict the existing row is returned unchanged. The caller receives a
 * 200-equivalent result — not a 409 — so retried API calls converge to the
 * same task without double-queuing.
 */
export async function enqueueTask(options: EnqueueOptions): Promise<TaskQueueRow> {
  const {
    idempotency_key,
    agent_type,
    job_type,
    payload = {},
    correlation_id = null,
    created_by,
    priority = 5,
    max_attempts = 3,
  } = options;

  const [row] = await sql<TaskQueueRow[]>`
    INSERT INTO task_queue
      (idempotency_key, agent_type, job_type, payload, correlation_id,
       created_by, priority, max_attempts)
    VALUES
      (${idempotency_key}, ${agent_type}, ${job_type}, ${sql.json(payload as never)},
       ${correlation_id}, ${created_by}, ${priority}, ${max_attempts})
    ON CONFLICT (idempotency_key) DO UPDATE
      SET updated_at = task_queue.updated_at
    RETURNING *
  `;
  return row;
}

export interface ClaimOptions {
  agent_type: string;
  claimed_by: string;
  delegated_token?: string;
  /** Claim duration in seconds. Defaults to 300 (5 minutes). */
  claim_ttl_seconds?: number;
}

/**
 * Atomically claims the next available task for the given agent type
 * (TQ-P-001 atomic-claim-exactly-one-winner).
 *
 * Uses FOR UPDATE SKIP LOCKED so concurrent workers never double-claim the
 * same row. Returns null when no task is available.
 */
export async function claimNextTask(options: ClaimOptions): Promise<TaskQueueRow | null> {
  const { agent_type, claimed_by, delegated_token = null, claim_ttl_seconds = 300 } = options;

  const rows = await sql<TaskQueueRow[]>`
    UPDATE task_queue
    SET
      status           = 'claimed',
      claimed_by       = ${claimed_by},
      claimed_at       = NOW(),
      claim_expires_at = NOW() + (${claim_ttl_seconds} * INTERVAL '1 second'),
      delegated_token  = ${delegated_token},
      attempt          = attempt + 1,
      updated_at       = NOW()
    WHERE id = (
      SELECT id FROM task_queue
      WHERE agent_type = ${agent_type}
        AND status = 'pending'
        AND (next_retry_at IS NULL OR next_retry_at <= NOW())
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;
  return rows[0] ?? null;
}

export interface UpdateStatusOptions {
  id: string;
  status: TaskQueueStatus;
  error_message?: string;
  next_retry_at?: Date;
}

/**
 * Updates the status of a task, optionally recording an error message and
 * next retry timestamp.
 */
export async function updateTaskStatus(options: UpdateStatusOptions): Promise<TaskQueueRow | null> {
  const { id, status, error_message = null, next_retry_at = null } = options;

  const rows = await sql<TaskQueueRow[]>`
    UPDATE task_queue
    SET
      status        = ${status},
      error_message = ${error_message},
      next_retry_at = ${next_retry_at},
      updated_at    = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ?? null;
}

export interface SubmitResultOptions {
  id: string;
  result: Record<string, unknown>;
}

/**
 * Records the result of a completed task and marks it as completed.
 */
export async function submitTaskResult(options: SubmitResultOptions): Promise<TaskQueueRow | null> {
  const { id, result } = options;

  const rows = await sql<TaskQueueRow[]>`
    UPDATE task_queue
    SET
      status     = 'completed',
      result     = ${sql.json(result as never)},
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ?? null;
}

export interface RecoveredTaskRow {
  id: string;
  status: TaskQueueStatus;
  attempt: number;
  agent_type: string;
  job_type: string;
}

/**
 * Recovers stale claims (TQ-D-003 stale-claim-recovery).
 *
 * Tasks in 'claimed' status whose claim_expires_at has passed are either
 * reset to 'pending' (if attempt < max_attempts) or transitioned to 'dead'.
 *
 * Exponential backoff: next_retry_at = NOW() + 2^attempt seconds.
 *
 * Returns the list of recovered rows with their new status so callers can
 * emit audit events per row.
 */
export async function recoverStaleClaims(): Promise<RecoveredTaskRow[]> {
  const rows = await sql<RecoveredTaskRow[]>`
    UPDATE task_queue
    SET
      status           = CASE
                           WHEN attempt >= max_attempts THEN 'dead'
                           ELSE 'pending'
                         END,
      claimed_by       = NULL,
      claimed_at       = NULL,
      claim_expires_at = NULL,
      delegated_token  = NULL,
      next_retry_at    = CASE
                           WHEN attempt >= max_attempts THEN NULL
                           ELSE NOW() + (POWER(2, attempt) * INTERVAL '1 second')
                         END,
      updated_at       = NOW()
    WHERE status = 'claimed'
      AND claim_expires_at < NOW()
    RETURNING id, status, attempt, agent_type, job_type
  `;
  return rows;
}

/**
 * Callback invoked once per recovered row so callers can emit audit events
 * without coupling the db package to the audit infrastructure.
 */
/**
 * Response shape for the admin task-queue monitoring endpoint.
 * Excludes sensitive fields (payload, delegated_token) from the full
 * TaskQueueRow to prevent leaking secrets or PII through the admin API.
 */
export interface TaskQueueAdminRow {
  id: string;
  idempotency_key: string;
  agent_type: string;
  job_type: string;
  status: TaskQueueStatus;
  correlation_id: string | null;
  created_by: string;
  claimed_by: string | null;
  claimed_at: Date | null;
  claim_expires_at: Date | null;
  result: Record<string, unknown> | null;
  error_message: string | null;
  attempt: number;
  max_attempts: number;
  next_retry_at: Date | null;
  priority: number;
  created_at: Date;
  updated_at: Date;
}

export interface ListTasksAdminOptions {
  status?: TaskQueueStatus;
  agent_type?: string;
  limit?: number;
  offset?: number;
}

/**
 * Lists task queue entries for admin monitoring.
 *
 * Returns rows ordered by created_at descending. Sensitive fields (payload,
 * delegated_token) are excluded from the result set. Supports optional
 * filtering by status and agent_type, and pagination via limit/offset.
 */
export async function listTasksForAdmin(
  options: ListTasksAdminOptions = {},
): Promise<TaskQueueAdminRow[]> {
  const { status, agent_type, limit = 50, offset = 0 } = options;

  const rows = await sql<TaskQueueAdminRow[]>`
    SELECT
      id, idempotency_key, agent_type, job_type, status,
      correlation_id, created_by, claimed_by, claimed_at,
      claim_expires_at, result, error_message, attempt,
      max_attempts, next_retry_at, priority, created_at, updated_at
    FROM task_queue
    WHERE 1=1
      ${status ? sql`AND status = ${status}` : sql``}
      ${agent_type ? sql`AND agent_type = ${agent_type}` : sql``}
    ORDER BY created_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return rows;
}

export type StaleRecoveryAuditCallback = (rows: RecoveredTaskRow[]) => Promise<void>;

/**
 * Starts the stale-claim recovery on a fixed interval.
 * The returned timer has .unref() called so it does not prevent process exit.
 *
 * @param intervalMs - Polling interval in milliseconds. Defaults to 60 000.
 * @param onRecovered - Optional async callback receiving the list of recovered
 *   rows after each sweep. Use this to emit audit events without coupling the
 *   db package to the audit service.
 */
export function startStaleClaimRecovery(
  intervalMs = 60_000,
  onRecovered?: StaleRecoveryAuditCallback,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    recoverStaleClaims()
      .then((rows) => {
        if (rows.length > 0 && onRecovered) {
          return onRecovered(rows).catch((err) =>
            console.error('[task-queue] stale recovery audit callback failed:', err),
          );
        }
      })
      .catch((err) => console.error('[task-queue] stale claim recovery failed:', err));
  }, intervalMs);
  timer.unref();
  return timer;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dead-letter queue (DLQ) monitoring — TQ-C-003
// ─────────────────────────────────────────────────────────────────────────────

/** Default DLQ depth that triggers an alert (TQ-C-003). */
export const DLQ_ALERT_THRESHOLD = 10;

export interface DlqDepthRow {
  agent_type: string;
  dead_count: number;
}

/**
 * Returns the count of tasks in 'dead' status, grouped by agent_type.
 *
 * Callers should compare each row's `dead_count` against `DLQ_ALERT_THRESHOLD`
 * (or a custom threshold) and emit an alert when the value exceeds it.
 *
 * Blueprint ref: TQ-C-003 (dead-letter alert threshold).
 */
export async function getDlqDepth(): Promise<DlqDepthRow[]> {
  const rows = await sql<DlqDepthRow[]>`
    SELECT agent_type, COUNT(*)::INTEGER AS dead_count
    FROM task_queue
    WHERE status = 'dead'
    GROUP BY agent_type
    ORDER BY dead_count DESC, agent_type ASC
  `;
  return rows;
}

export interface DlqAlertResult {
  /** Agent types whose dead-task count exceeds the threshold. */
  breached: DlqDepthRow[];
  /** Full per-type depth rows. */
  depth: DlqDepthRow[];
}

/**
 * Checks the DLQ depth against the given threshold.
 *
 * Returns a `DlqAlertResult` where `breached` contains only the agent types
 * that have exceeded the threshold. The caller is responsible for emitting the
 * actual alert (log, webhook, metric, etc.) so this function remains
 * infrastructure-independent.
 *
 * Blueprint ref: TQ-C-003.
 *
 * @param threshold - Alert threshold. Defaults to `DLQ_ALERT_THRESHOLD` (10).
 */
export async function checkDlqAlertThreshold(
  threshold = DLQ_ALERT_THRESHOLD,
): Promise<DlqAlertResult> {
  const depth = await getDlqDepth();
  const breached = depth.filter((row) => row.dead_count > threshold);
  return { breached, depth };
}
