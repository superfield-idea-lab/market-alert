/**
 * @file autolearn-state-machine.ts
 *
 * Autolearn job state machine — PRD §4.3.
 *
 * Provides typed constants and DB helpers for creating, advancing, and
 * querying autolearn job rows.  The state machine enforces the legal
 * transitions defined in PRD §4.3; illegal transitions are rejected with
 * an `InvalidTransitionError`.
 *
 * ## State machine (PRD §4.3 — Wiki Autolearning)
 *
 * ```
 * WORKER_STARTED
 *   → FETCHING_GROUND_TRUTH
 *   → FETCHING_WIKI
 *   → WRITING_TEMP_FILES
 *   → CLAUDE_CLI_RUNNING
 *   → WRITING_NEW_VERSION
 *   → EMBEDDING
 *   → AWAITING_REVIEW
 *   → PUBLISHED
 *   → COMPLETE
 *
 * AWAITING_REVIEW → REJECTED   (reviewer rejects draft)
 * Any state      → FAILED      (unrecoverable error; previous version retained)
 * ```
 *
 * Blueprint refs: issue #42, PRD §4.3.
 */

import postgres from 'postgres';
import { resolveDatabaseUrls } from './index';

// ---------------------------------------------------------------------------
// Lazy SQL connection
//
// `sql` is resolved lazily on first use so that tests may set DATABASE_URL
// via process.env before any query runs.  The pool is cached after the first
// call; the cache is intentionally keyed to the URL so that a test that
// changes DATABASE_URL (e.g. pointing it at an ephemeral pg-container) does
// not keep the old pool alive.
// ---------------------------------------------------------------------------

let _sqlCache: { url: string; pool: ReturnType<typeof postgres> } | null = null;

function getSql(): ReturnType<typeof postgres> {
  const url = resolveDatabaseUrls().app;
  if (_sqlCache?.url !== url) {
    _sqlCache = {
      url,
      pool: postgres(url, {
        max: 5,
        idle_timeout: 20,
        connect_timeout: 10,
        connection: { client_min_messages: 'warning' },
      }),
    };
  }
  return _sqlCache.pool;
}

// ---------------------------------------------------------------------------
// State type
// ---------------------------------------------------------------------------

/** All legal states in the PRD §4.3 autolearn state machine. */
export const AutolearnState = {
  WORKER_STARTED: 'WORKER_STARTED',
  FETCHING_GROUND_TRUTH: 'FETCHING_GROUND_TRUTH',
  FETCHING_WIKI: 'FETCHING_WIKI',
  WRITING_TEMP_FILES: 'WRITING_TEMP_FILES',
  CLAUDE_CLI_RUNNING: 'CLAUDE_CLI_RUNNING',
  WRITING_NEW_VERSION: 'WRITING_NEW_VERSION',
  EMBEDDING: 'EMBEDDING',
  AWAITING_REVIEW: 'AWAITING_REVIEW',
  PUBLISHED: 'PUBLISHED',
  REJECTED: 'REJECTED',
  COMPLETE: 'COMPLETE',
  FAILED: 'FAILED',
} as const;

export type AutolearnState = (typeof AutolearnState)[keyof typeof AutolearnState];

/** Source type — gardening (cron) or deepclean (on-demand). */
export const AutolearnSourceType = {
  GARDENING: 'gardening',
  DEEPCLEAN: 'deepclean',
} as const;

export type AutolearnSourceType = (typeof AutolearnSourceType)[keyof typeof AutolearnSourceType];

// ---------------------------------------------------------------------------
// Legal transitions
// ---------------------------------------------------------------------------

/**
 * Adjacency map for the PRD §4.3 autolearn state machine.
 *
 * Every state maps to the set of states it may legally transition into.
 * Any state may transition to FAILED (handled separately in `advanceState`).
 */
export const LEGAL_TRANSITIONS: Readonly<Record<AutolearnState, readonly AutolearnState[]>> = {
  [AutolearnState.WORKER_STARTED]: [AutolearnState.FETCHING_GROUND_TRUTH, AutolearnState.FAILED],
  [AutolearnState.FETCHING_GROUND_TRUTH]: [AutolearnState.FETCHING_WIKI, AutolearnState.FAILED],
  [AutolearnState.FETCHING_WIKI]: [AutolearnState.WRITING_TEMP_FILES, AutolearnState.FAILED],
  [AutolearnState.WRITING_TEMP_FILES]: [AutolearnState.CLAUDE_CLI_RUNNING, AutolearnState.FAILED],
  [AutolearnState.CLAUDE_CLI_RUNNING]: [AutolearnState.WRITING_NEW_VERSION, AutolearnState.FAILED],
  [AutolearnState.WRITING_NEW_VERSION]: [AutolearnState.EMBEDDING, AutolearnState.FAILED],
  [AutolearnState.EMBEDDING]: [AutolearnState.AWAITING_REVIEW, AutolearnState.FAILED],
  [AutolearnState.AWAITING_REVIEW]: [
    AutolearnState.PUBLISHED,
    AutolearnState.REJECTED,
    AutolearnState.FAILED,
  ],
  [AutolearnState.PUBLISHED]: [AutolearnState.COMPLETE, AutolearnState.FAILED],
  [AutolearnState.REJECTED]: [],
  [AutolearnState.COMPLETE]: [],
  [AutolearnState.FAILED]: [],
};

/** Terminal states — no further transitions are possible. */
export const TERMINAL_STATES: ReadonlySet<AutolearnState> = new Set([
  AutolearnState.COMPLETE,
  AutolearnState.REJECTED,
  AutolearnState.FAILED,
]);

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when a state transition is not permitted by the state machine. */
export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: AutolearnState,
    public readonly to: AutolearnState,
  ) {
    super(
      `Invalid autolearn transition: ${from} → ${to}. ` +
        `Legal successors: [${LEGAL_TRANSITIONS[from].join(', ')}]`,
    );
    this.name = 'InvalidTransitionError';
  }
}

/** Thrown when an operation targets a job that does not exist. */
export class AutolearnJobNotFoundError extends Error {
  constructor(public readonly jobId: string) {
    super(`Autolearn job not found: ${jobId}`);
    this.name = 'AutolearnJobNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

export interface AutolearnJobRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  dept_id: string;
  source_type: AutolearnSourceType;
  state: AutolearnState;
  task_queue_id: string | null;
  error_message: string | null;
  wiki_version_id: string | null;
  /**
   * When `true` the publication gate must route this draft to explicit human
   * approval regardless of its materiality score.
   *
   * Set at job creation time by checking the hallucination-escalation counter
   * (three DISMISSED annotations in 30 days for this customer, PRD §9 / issue #67).
   */
  requires_explicit_approval: boolean;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateAutolearnJobOptions {
  tenant_id: string;
  customer_id: string;
  dept_id: string;
  source_type?: AutolearnSourceType;
  task_queue_id?: string;
  /**
   * When `true` the publication gate must route this draft to explicit human
   * approval regardless of its materiality score.
   *
   * Callers should consult `customerRequiresEscalation()` from
   * `hallucination-escalation.ts` before creating the job and pass the result
   * here (PRD §9 / issue #67).
   */
  requires_explicit_approval?: boolean;
}

/**
 * Creates a new autolearn job row in the WORKER_STARTED state.
 */
export async function createAutolearnJob(
  options: CreateAutolearnJobOptions,
): Promise<AutolearnJobRow> {
  const {
    tenant_id,
    customer_id,
    dept_id,
    source_type = AutolearnSourceType.GARDENING,
    task_queue_id = null,
    requires_explicit_approval = false,
  } = options;

  const sql = getSql();
  const [row] = await sql<AutolearnJobRow[]>`
    INSERT INTO autolearn_jobs
      (tenant_id, customer_id, dept_id, source_type, state, task_queue_id,
       requires_explicit_approval)
    VALUES
      (${tenant_id}, ${customer_id}, ${dept_id}, ${source_type},
       'WORKER_STARTED', ${task_queue_id}, ${requires_explicit_approval})
    RETURNING *
  `;
  return row;
}

// ---------------------------------------------------------------------------
// Advance
// ---------------------------------------------------------------------------

export interface AdvanceStateOptions {
  job_id: string;
  to: AutolearnState;
  error_message?: string;
  wiki_version_id?: string;
}

/**
 * Advances the autolearn job to a new state.
 *
 * Validates the transition against `LEGAL_TRANSITIONS` before writing.
 * Throws `InvalidTransitionError` if the transition is illegal.
 * Throws `AutolearnJobNotFoundError` if the job does not exist.
 *
 * The `error_message` field is only written when `to` is `FAILED`.
 * The `wiki_version_id` field is only written when provided and non-null.
 */
export async function advanceAutolearnState(
  options: AdvanceStateOptions,
): Promise<AutolearnJobRow> {
  const { job_id, to, error_message, wiki_version_id } = options;
  const sql = getSql();

  // Fetch current state.
  const [current] = await sql<Pick<AutolearnJobRow, 'id' | 'state'>[]>`
    SELECT id, state FROM autolearn_jobs WHERE id = ${job_id}
  `;

  if (!current) {
    throw new AutolearnJobNotFoundError(job_id);
  }

  const from = current.state;
  const legal = LEGAL_TRANSITIONS[from];
  if (!legal.includes(to)) {
    throw new InvalidTransitionError(from, to);
  }

  const errMsg = to === AutolearnState.FAILED ? (error_message ?? null) : null;
  const wikiVerId = wiki_version_id ?? null;

  const [updated] = await sql<AutolearnJobRow[]>`
    UPDATE autolearn_jobs
    SET
      state           = ${to},
      error_message   = ${errMsg},
      wiki_version_id = COALESCE(${wikiVerId}, wiki_version_id),
      updated_at      = NOW()
    WHERE id = ${job_id}
    RETURNING *
  `;

  return updated;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Fetches a single autolearn job by ID.
 * Returns null if not found.
 */
export async function getAutolearnJob(job_id: string): Promise<AutolearnJobRow | null> {
  const sql = getSql();
  const [row] = await sql<AutolearnJobRow[]>`
    SELECT * FROM autolearn_jobs WHERE id = ${job_id}
  `;
  return row ?? null;
}

/**
 * Returns all autolearn jobs for a given customer, ordered by creation time
 * descending.
 */
export async function listAutolearnJobs(options: {
  tenant_id: string;
  customer_id: string;
  limit?: number;
}): Promise<AutolearnJobRow[]> {
  const { tenant_id, customer_id, limit = 50 } = options;
  const sql = getSql();

  return sql<AutolearnJobRow[]>`
    SELECT * FROM autolearn_jobs
    WHERE tenant_id = ${tenant_id}
      AND customer_id = ${customer_id}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}
