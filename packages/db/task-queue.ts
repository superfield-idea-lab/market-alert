import { sql } from './index';
import type postgres from 'postgres';

/**
 * TaskType enum — canonical job types for the worker pipeline.
 *
 * KB-demo worker phases:
 *   EMAIL_INGEST   — Phase 2: pull emails into the KB (agent_type: email_ingest)
 *   AUTOLEARN      — Phase 3: autolearning from ingested content (agent_type: autolearn)
 *   TRANSCRIPTION  — Phase 5: audio/video transcription (agent_type: transcription)
 *   ANNOTATION     — Phase 6: entity annotation agent (agent_type: annotation)
 *   DEEPCLEAN      — Phase 4: deep PII cleaning pass (agent_type: deepclean)
 *   BDM_SUMMARY    — Phase 7: BDM-ready summary generation (agent_type: bdm_summary)
 *
 * Trading platform task types (issue #5, TQ-D-001):
 *   EDGAR_POLL          — Ingestion: poll EDGAR for new filings (agent_type: edgar_ingest)
 *   ALERT_ENRICH        — Enrichment: enrich alert from filing data (agent_type: enrichment)
 *   ALERT_DEDUP         — Enrichment: deduplicate alert records (agent_type: enrichment)
 *   ALERT_NOTIFY        — Notification: send alert to subscribers (agent_type: notification)
 *   ALERT_SUPPLEMENT    — Enrichment: supplement alert with additional data (agent_type: enrichment)
 *   CORP_ACTION_ADVANCE — Scheduler: advance corporate action state machine (agent_type: scheduler)
 *   TRADE_SETTLE        — Scheduler: advance trade settlement state machine (agent_type: scheduler)
 *
 * Phase 3 — Canonical-source discovery (issue #74, TQ-D-001):
 *   SOURCE_DISCOVER — Read the active Research Methodology, extract venue catalog,
 *                     and register designated venues as Active canonical_sources.
 *                     (agent_type: source_discovery)
 *
 * Phase 3 — Wiki rebuild: facts and chunks to a published wiki page (issue #76, TQ-D-001):
 *   WIKI_REBUILD — For one subject (subject_type + subject_id), read its confirmed_facts
 *                  and corpus_chunks, synthesise a full-snapshot wiki_page_version, advance
 *                  it through the pending → content_written → embedded → indexed pipeline,
 *                  attach cites edges to supporting evidence, and flip
 *                  wiki_page.currently_published only when status reaches indexed.
 *                  Crash-resume: the version row is left at its stalled stage and the next
 *                  re-scheduled worker resumes from that stage rather than restarting.
 *                  (agent_type: wiki_rebuild)
 *
 *                  Task key: wiki_rebuild:<subject_type>:<subject_id>:<trigger>
 *                  Trigger values: scheduled | fact_extract | manual
 *
 *                  Architecture refs:
 *                    - docs/architecture.md §"Wiki pages: full-snapshot versioning"
 *                    - docs/architecture.md §"Citations: first-class relation edges"
 *
 * Phase 3 — Standing-prompt distillation (issue #78, TQ-D-001):
 *   STANDING_PROMPT_DISTILL — For one researcher, read all published wiki_page_versions
 *                             within the researcher's scope, distil a compact bounded
 *                             standing_prompt_version (hard ceiling ~250 words, target
 *                             ~100 words), flip the prior Active prompt to Superseded, and
 *                             mark the new version Active.
 *                             Idempotent: re-running on the same wiki version window
 *                             produces no new standing_prompt_version row.
 *                             A debounce window collapses bursts of wiki publishes.
 *                             (agent_type: sp_distiller)
 *
 *                             Task key: sp_distill:<researcher_id>:<wiki_version_window>
 *                             Triggered by: wiki_page_version publish events
 *
 *                             Architecture refs:
 *                               - docs/architecture.md §"Standing prompt as derived artifact"
 *                               - packages/db/standing-prompt-store.ts — DB store
 *                               - apps/server/src/api/standing-prompt-distill-api.ts — API
 *
 * Phase 6 — Silent-passage detection (issue #81):
 *   SILENT_PASSAGE_CHECK — Detect when an anticipated catalyst window closes with no Detected event.
 *                          Transitions the Expected market_event to PassedSilently.
 *                          Enqueued by the SILENT_PASSAGE_CHECK cron or event-feed poller when
 *                          anticipated_window_close is reached with no disclosure.
 *                          (agent_type: event_evaluator)
 *
 *                          Task key: silent_check:<expected_event_id>:<window_close>
 *
 *                          Architecture refs:
 *                            - docs/architecture.md § task-type table (SILENT_PASSAGE_CHECK row)
 *                            - docs/prd.md §9 — silent-passage latency ≤ 15 min of window close
 *                            - packages/db/mkt-market-event-store.ts — transitionToPassedSilently
 *
 * Blueprint refs: TQ-D-001 (single-table multi-type queue).
 */
export const TaskType = {
  EMAIL_INGEST: 'EMAIL_INGEST',
  AUTOLEARN: 'AUTOLEARN',
  TRANSCRIPTION: 'TRANSCRIPTION',
  ANNOTATION: 'ANNOTATION',
  DEEPCLEAN: 'DEEPCLEAN',
  BDM_SUMMARY: 'BDM_SUMMARY',
  // Trading platform task types (issue #5)
  EDGAR_POLL: 'EDGAR_POLL',
  ALERT_ENRICH: 'ALERT_ENRICH',
  ALERT_DEDUP: 'ALERT_DEDUP',
  ALERT_NOTIFY: 'ALERT_NOTIFY',
  ALERT_SUPPLEMENT: 'ALERT_SUPPLEMENT',
  CORP_ACTION_ADVANCE: 'CORP_ACTION_ADVANCE',
  TRADE_SETTLE: 'TRADE_SETTLE',
  // Phase 3 — Canonical-source discovery (issue #74)
  SOURCE_DISCOVER: 'SOURCE_DISCOVER',
  // Phase 3 — Canonical-source scraping, ingestion, fact extraction (issue #75)
  SOURCE_SCRAPE: 'SOURCE_SCRAPE',
  FINDING_INGEST: 'FINDING_INGEST',
  FACT_EXTRACT: 'FACT_EXTRACT',
  // Phase 3 — Wiki rebuild: facts/chunks → published wiki page (issue #76)
  WIKI_REBUILD: 'WIKI_REBUILD',
  // Phase 3 — Standing-prompt distillation: wiki publish → bounded active standing prompt (issue #78)
  STANDING_PROMPT_DISTILL: 'STANDING_PROMPT_DISTILL',
  // Phase 6 — Event ingestion: EDGAR filing → normalized market event (issue #80)
  EVENT_EVALUATE: 'EVENT_EVALUATE',
  // Phase 6 — Silent-passage detection: Expected event window closes with no Detected event (issue #81)
  SILENT_PASSAGE_CHECK: 'SILENT_PASSAGE_CHECK',
  // Phase 6 — Signal delivery: outbound multi-channel notification per delivered signal (issue #85)
  SIGNAL_NOTIFY: 'SIGNAL_NOTIFY',
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
  // Trading platform task types (issue #5)
  [TaskType.EDGAR_POLL]: 'edgar_ingest',
  [TaskType.ALERT_ENRICH]: 'enrichment',
  [TaskType.ALERT_DEDUP]: 'enrichment',
  [TaskType.ALERT_NOTIFY]: 'notification',
  [TaskType.ALERT_SUPPLEMENT]: 'enrichment',
  [TaskType.CORP_ACTION_ADVANCE]: 'scheduler',
  [TaskType.TRADE_SETTLE]: 'scheduler',
  // Phase 3 (issue #74)
  [TaskType.SOURCE_DISCOVER]: 'source_discovery',
  // Phase 3 (issue #75)
  [TaskType.SOURCE_SCRAPE]: 'source_scraper',
  [TaskType.FINDING_INGEST]: 'ingestion',
  [TaskType.FACT_EXTRACT]: 'fact_extraction',
  // Phase 3 (issue #76)
  [TaskType.WIKI_REBUILD]: 'wiki_rebuild',
  // Phase 3 (issue #78)
  [TaskType.STANDING_PROMPT_DISTILL]: 'sp_distiller',
  // Phase 6 (issue #80)
  [TaskType.EVENT_EVALUATE]: 'event_evaluator',
  // Phase 6 — Silent-passage detection (issue #81)
  [TaskType.SILENT_PASSAGE_CHECK]: 'event_evaluator',
  // Phase 6 — Signal delivery: outbound multi-channel notification (issue #85)
  [TaskType.SIGNAL_NOTIFY]: 'signal_delivery',
};

/**
 * PII field names that must never appear in task payloads (TQ-C-004, TQ-P-002).
 *
 * Payloads carry only UUIDs, routing metadata, and action descriptors —
 * never PII, business content, or credentials. Workers fetch business data
 * through authenticated API reads at execution time.
 */
export const PAYLOAD_PII_FIELDS: readonly string[] = [
  'email',
  'phone',
  'ssn',
  'dob',
  'date_of_birth',
  'full_name',
  'first_name',
  'last_name',
  'address',
  'street',
  'postal_code',
  'zip',
  'national_id',
  'passport',
  'credit_card',
  'bank_account',
  'ip_address',
];

/**
 * Set of trading task types that require the no-PII payload validator (TQ-C-004).
 */
const TRADING_TASK_TYPES: ReadonlySet<TaskType> = new Set<TaskType>([
  TaskType.EDGAR_POLL,
  TaskType.ALERT_ENRICH,
  TaskType.ALERT_DEDUP,
  TaskType.ALERT_NOTIFY,
  TaskType.ALERT_SUPPLEMENT,
  TaskType.CORP_ACTION_ADVANCE,
  TaskType.TRADE_SETTLE,
  // Phase 3 (issue #74): source-discovery payload carries only UUIDs
  TaskType.SOURCE_DISCOVER,
  // Phase 3 (issue #75): scrape/ingest/fact payloads carry only IDs
  TaskType.SOURCE_SCRAPE,
  TaskType.FINDING_INGEST,
  TaskType.FACT_EXTRACT,
  // Phase 3 (issue #78): standing-prompt distill payload carries only researcher_id + window
  TaskType.STANDING_PROMPT_DISTILL,
  // Phase 6 (issue #80): event evaluate payload carries only market_event_id
  TaskType.EVENT_EVALUATE,
  // Phase 6 (issue #81): silent-passage check payload carries only expected_event_id + window_close
  TaskType.SILENT_PASSAGE_CHECK,
  // Phase 6 (issue #85): signal-notify payload carries only signal_id + channel
  TaskType.SIGNAL_NOTIFY,
]);

/**
 * Validates that a task payload contains no PII fields (TQ-C-004, TQ-P-002).
 *
 * Throws a `PayloadPiiError` if any key in the payload (top-level) matches a
 * known PII field name. Workers are responsible for fetching sensitive data
 * through authenticated API reads, not storing it in the task queue.
 *
 * @throws {PayloadPiiError} when a PII field is detected in the payload.
 */
export function assertNoPiiInPayload(payload: Record<string, unknown>): void {
  const keys = Object.keys(payload);
  for (const key of keys) {
    if (PAYLOAD_PII_FIELDS.includes(key.toLowerCase())) {
      throw new PayloadPiiError(key);
    }
  }
}

/**
 * Error thrown when a task payload contains a PII field that is not allowed
 * in the task queue (TQ-C-004).
 */
export class PayloadPiiError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(
      `Task payload must not contain PII field "${field}". ` +
        'Payloads carry only UUIDs, routing metadata, and action descriptors (TQ-P-002, TQ-C-004).',
    );
    this.name = 'PayloadPiiError';
    this.field = field;
  }
}

/**
 * Builds an idempotency key for EDGAR_POLL tasks.
 *
 * Format: edgar_poll:<form_type>:<accession_number>
 * Example: edgar_poll:8-K:0001234567-24-000001
 */
export function buildEdgarPollIdempotencyKey(formType: string, accessionNumber: string): string {
  return `edgar_poll:${formType}:${accessionNumber}`;
}

/**
 * Builds an idempotency key for SIGNAL_NOTIFY tasks.
 *
 * Format: notify:<signal_id>:<channel>
 * Example: notify:abc123:email
 *
 * One task per (signal, channel) pair. Re-enqueueing the same (signal_id, channel)
 * is safe — ON CONFLICT DO NOTHING prevents duplicates.
 *
 * Architecture ref: docs/architecture.md § task-type table (SIGNAL_NOTIFY row)
 * Issue ref: #85
 */
export function buildSignalNotifyIdempotencyKey(signalId: string, channel: string): string {
  return `notify:${signalId}:${channel}`;
}

/**
 * Builds an idempotency key for SILENT_PASSAGE_CHECK tasks.
 *
 * Format: silent_check:<expected_event_id>:<window_close_iso>
 * Example: silent_check:abc123:2026-06-01T00:00:00.000Z
 *
 * The window_close ISO string makes each check for a given event+window unique.
 * Re-scheduling the same check for the same window close produces no duplicate task.
 *
 * Architecture ref: docs/architecture.md § task-type table (SILENT_PASSAGE_CHECK row)
 */
export function buildSilentPassageCheckIdempotencyKey(
  expectedEventId: string,
  windowClose: Date,
): string {
  return `silent_check:${expectedEventId}:${windowClose.toISOString()}`;
}

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
  /**
   * Optional sql pool override. When provided, this pool is used instead of
   * the module-level singleton. Intended for tests that need to direct writes
   * to an ephemeral Postgres container.
   */
  sql?: postgres.Sql;
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
    sql: sqlOverride,
  } = options;

  // Use injected sql pool when provided (e.g. in tests pointing to an
  // ephemeral Postgres container), otherwise fall back to the module-level
  // singleton bound to DATABASE_URL at import time.
  const db = sqlOverride ?? sql;

  // Apply no-PII validator to all trading platform task types (TQ-C-004, TQ-P-002).
  // Payloads for trading tasks must carry only UUIDs and routing metadata —
  // never PII, business content, or credentials.
  if (TRADING_TASK_TYPES.has(job_type as TaskType)) {
    assertNoPiiInPayload(payload);
  }

  const [row] = await db<TaskQueueRow[]>`
    INSERT INTO task_queue
      (idempotency_key, agent_type, job_type, payload, correlation_id,
       created_by, priority, max_attempts)
    VALUES
      (${idempotency_key}, ${agent_type}, ${job_type}, ${db.json(payload as never)},
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
export async function getDlqDepth(options: { sql?: postgres.Sql } = {}): Promise<DlqDepthRow[]> {
  const db = options.sql ?? sql;
  const rows = await db<DlqDepthRow[]>`
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

// ---------------------------------------------------------------------------
// DLQ list and requeue — Admin panel operations (issue #89)
// ---------------------------------------------------------------------------

/**
 * List dead-letter tasks, optionally filtered by agent_type.
 *
 * Returns up to `limit` rows ordered by created_at DESC.
 *
 * ## Integration point
 *
 * Called by GET /api/admin/dlq (admin DLQ view).
 *
 * @param sqlClient  Optional SQL pool override (used in tests).
 */
export interface ListDlqOptions {
  agent_type?: string;
  limit?: number;
  offset?: number;
  /** Optional SQL pool override (for tests). */
  sql?: postgres.Sql;
}

export async function listDlqTasks(options: ListDlqOptions = {}): Promise<TaskQueueAdminRow[]> {
  const { agent_type, limit = 50, offset = 0, sql: sqlOverride } = options;
  const db = sqlOverride ?? sql;

  const rows = await db<TaskQueueAdminRow[]>`
    SELECT
      id, idempotency_key, agent_type, job_type, status,
      correlation_id, created_by, claimed_by, claimed_at,
      claim_expires_at, result, error_message, attempt,
      max_attempts, next_retry_at, priority, created_at, updated_at
    FROM task_queue
    WHERE status = 'dead'
      ${agent_type ? db`AND agent_type = ${agent_type}` : db``}
    ORDER BY created_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return rows;
}

export interface RequeueDlqResult {
  /** ID of the task that was requeued. */
  task_id: string;
  /** The new status after requeue (always 'pending'). */
  new_status: 'pending';
}

/**
 * Requeue a dead-letter task by resetting it to `pending` status.
 *
 * Resets: status → 'pending', attempt → 0, error_message → null,
 * claimed_by → null, claimed_at → null, claim_expires_at → null,
 * next_retry_at → null.
 *
 * Returns null when the task does not exist or is not in 'dead' status
 * (idempotent: calling twice on the same task returns null on the second call).
 *
 * ## Integration point
 *
 * Called by POST /api/admin/dlq/:id/requeue (admin DLQ replay).
 *
 * Architecture ref: docs/architecture.md §"DLQ replay"
 */
export async function requeueDlqTask(
  taskId: string,
  options: { sql?: postgres.Sql } = {},
): Promise<RequeueDlqResult | null> {
  const db = options.sql ?? sql;

  const rows = await db<{ id: string; status: string }[]>`
    UPDATE task_queue
    SET
      status           = 'pending',
      attempt          = 0,
      error_message    = NULL,
      claimed_by       = NULL,
      claimed_at       = NULL,
      claim_expires_at = NULL,
      delegated_token  = NULL,
      next_retry_at    = NULL,
      updated_at       = NOW()
    WHERE id     = ${taskId}
      AND status = 'dead'
    RETURNING id, status
  `;

  const row = rows[0];
  if (!row) return null;
  return { task_id: row.id, new_status: 'pending' };
}
