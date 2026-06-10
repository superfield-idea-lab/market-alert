/**
 * @file signal-store.ts
 *
 * DB access layer for the event-evaluation pipeline — Phase 6 dev-scout (issue #82).
 *
 * ## Status: dev-scout stub
 *
 * Defines the `signals` and `signal_cites` table row types, and the function
 * signatures for:
 *   - `insertSignal`               — idempotent creation of one signal from an EVENT_EVALUATE task
 *   - `getSignalByIdempotencyKey`  — look up a signal by idempotency key
 *   - `getSignalById`              — fetch a signal by primary key
 *   - `insertSignalCite`           — attach a cites edge (signal → wiki_page_version or standing_prompt_version)
 *   - `getSignalCites`             — fetch all cites edges for a signal
 *   - `transitionSignalStatus`     — advance a signal through its state machine
 *
 * No real business logic is implemented here — this file exists to:
 *   1. Confirm the schema and types compile without error.
 *   2. Give the POST /internal/event-evaluation handler a typed seam.
 *   3. Document integration points for follow-on Phase 6 issues.
 *
 * ## Schema design
 *
 * `signals` — one row per evaluated market_event × standing_prompt_version pair.
 * Idempotency key format: `event_eval:<market_event_id>:<standing_prompt_version_id>`
 * ON CONFLICT (idempotency_key) DO NOTHING enforces idempotency so that re-evaluating
 * the same event against the same prompt version is always a no-op.
 *
 * `signal_cites` — typed directed edges from a signal to:
 *   - `wiki_page_version`         — the wiki snapshot the signal was reasoned against
 *   - `standing_prompt_version`   — the standing prompt revision used for evaluation
 *
 * Both cites targets are immutable snapshots captured at evaluation time. They remain
 * stable even if the wiki or standing prompt is subsequently updated, enabling the
 * auditability and replay constraint (PRD §9, architecture §"Citations: first-class
 * relation edges").
 *
 * ## Signal status state machine
 *
 * Generated → Delivered (direct delivery, confidence ≥ threshold)
 * Generated → Queued    (routed to Reviewer queue, confidence < threshold)
 * Queued    → Delivered (Reviewer approves)
 * Queued    → Suppressed (Reviewer suppresses)
 *
 * Confidence decomposition (confidence decomposition is a follow-on Phase 6 issue):
 *   - source_trust: tier of the supporting wiki claims per Research Methodology
 *   - extraction_certainty: how unambiguously the event maps to the standing prompt
 * Both factors will be stored on the signal row. For this scout they default to 1.0.
 *
 * ## Idempotency
 *
 * `insertSignal` uses ON CONFLICT (idempotency_key) DO NOTHING so that re-evaluating
 * the same event is always idempotent (acceptance criterion AC-3).
 * The idempotency key encodes both the market_event_id and the standing_prompt_version_id
 * so a later prompt revision produces a new signal row rather than a conflict.
 *
 * ## Zero PII constraint (TQ-P-002, TQ-C-004)
 *
 * No trader-visible PII may appear in task payloads or signal rows. Signal rationale
 * is stored as structured markdown, not free-form text with PII.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5, §9 — event evaluation, confidence, auditability
 * - docs/architecture.md §"Signal routing"
 * - docs/architecture.md §"Citations: first-class relation edges"
 * - packages/db/mkt-schema.sql — DDL for signals and signal_cites (this scout)
 * - packages/db/task-queue.ts — EVENT_EVALUATE task type
 * - packages/db/mkt-market-event-store.ts — market_events store
 * - packages/db/standing-prompt-store.ts — standing_prompt_versions store
 * - apps/worker/src/event-eval-job.ts — worker handler (this scout)
 * - apps/server/src/api/event-eval-api.ts — internal API endpoints (this scout)
 * - tests/integration/event-evaluation.spec.ts — integration tests (this scout)
 *
 * ## Integration points discovered during scout (issue #82)
 *
 * 1. `packages/db/mkt-schema.sql` — `signals` and `signal_cites` DDL added in
 *    this scout. The follow-on implementation issue must verify `migrateMkt()`
 *    applies these tables before the event-evaluation handler runs.
 *
 * 2. `packages/db/standing-prompt-store.ts` — `getActiveStandingPromptVersion`
 *    is the read path for the evaluator: given (tenant_id, researcher_id,
 *    subject_type, subject_id), returns the currently active version body.
 *    The evaluator falls back through the prompt family hierarchy
 *    (entity → thesis → portfolio) if no entity-level prompt exists.
 *    Family-fallback logic is OUT OF SCOPE for this scout.
 *
 * 3. `packages/db/mkt-market-event-store.ts` — `getMarketEventById` fetches
 *    the market_event for the task payload's `market_event_id`. The evaluator
 *    reads the event description and subject_entity_id to resolve which
 *    standing prompt to apply.
 *
 * 4. `packages/db/wiki-rebuild-store.ts` — the evaluator may need the
 *    currently published wiki_page_version_id for the subject to attach a
 *    `wiki_page_version` cites edge. This requires a new
 *    GET /internal/wiki-rebuild/published-version endpoint (follow-on issue).
 *
 * 5. Confidence decomposition (follow-on Phase 6 issue) — `source_trust` and
 *    `extraction_certainty` are both stored on the signal row. For this scout
 *    they are fixed at 1.0. The confidence threshold routing (direct delivery
 *    vs Reviewer queue) is also deferred to a follow-on issue.
 *
 * 6. SIGNAL_NOTIFY task (follow-on Phase 6 issue) — after creating a signal,
 *    the event-evaluator must enqueue a SIGNAL_NOTIFY task so the researcher
 *    dashboard receives a WebSocket push. Task key:
 *    `notify:<signal_id>:<channel>`. This is OUT OF SCOPE for this scout.
 *
 * 7. `market_events.status` must be transitioned from `Detected`/`Enriched` to
 *    `Evaluated` after the signal is created (architecture §"Catalyst event
 *    state machine"). The `transitionMarketEventStatus` function in
 *    `mkt-market-event-store.ts` owns this transition.
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/82
 */

import type postgres from 'postgres';

export type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// Signal status state machine
// ---------------------------------------------------------------------------

/**
 * Status values for the `signals` state machine.
 *
 * State machine (PRD §5, §9):
 *   Generated → Delivered  (direct delivery, confidence ≥ threshold)
 *   Generated → Queued     (routed to Reviewer queue, confidence < threshold)
 *   Queued    → Delivered  (Reviewer approves)
 *   Queued    → Suppressed (Reviewer suppresses)
 *   Delivered → Suppressed (researcher dismisses — PRD §5: "Delivered → Dismissed")
 *
 * Terminal state: Suppressed.
 *
 * Architecture ref: docs/architecture.md §"Signal routing"
 */
export type SignalStatus = 'Generated' | 'Queued' | 'Delivered' | 'Suppressed';

// ---------------------------------------------------------------------------
// Cites edge target types
// ---------------------------------------------------------------------------

/**
 * The two citation target types for signal_cites edges.
 *
 * - `wiki_page_version`       — the wiki snapshot the signal was reasoned against
 * - `standing_prompt_version` — the standing prompt revision used for evaluation
 *
 * Architecture ref: docs/architecture.md §"Citations: first-class relation edges"
 *
 * From the architecture table:
 *   | `signal` | `wiki_page_version`       | This signal was reasoned against … |
 *   | `signal` | `standing_prompt_version` | This signal was evaluated by …     |
 */
export type SignalCiteTargetType = 'wiki_page_version' | 'standing_prompt_version';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/**
 * TypeScript representation of a `signals` row.
 *
 * One row per evaluated market_event × standing_prompt_version pair.
 * The idempotency key format: `event_eval:<market_event_id>:<standing_prompt_version_id>`.
 *
 * Confidence decomposition (follow-on Phase 6 issue):
 *   - `source_trust`           — tier of the supporting wiki claims per Research Methodology
 *   - `extraction_certainty`   — how unambiguously the event maps to the standing prompt
 * Both are stored as floats in [0.0, 1.0]. For this scout they default to 1.0.
 *
 * Architecture ref: docs/architecture.md §"Signal routing"
 * PRD ref: §9 — auditability, confidence decomposition
 */
export interface SignalRow {
  id: string;
  tenant_id: string;
  researcher_id: string;
  market_event_id: string;
  standing_prompt_version_id: string;
  /** Idempotency key: event_eval:<market_event_id>:<standing_prompt_version_id> */
  idempotency_key: string;
  /**
   * Structured markdown rationale produced by the evaluation model call.
   * Null in the stub (set by the real implementation on the follow-on feature issue).
   */
  rationale: string | null;
  /**
   * Source trust component of the confidence decomposition (PRD §9).
   * Float in [0.0, 1.0]. Defaults to 1.0 in this scout.
   */
  source_trust: number;
  /**
   * Extraction certainty component of the confidence decomposition (PRD §9).
   * Float in [0.0, 1.0]. Defaults to 1.0 in this scout.
   */
  extraction_certainty: number;
  status: SignalStatus;
  created_at: Date;
  updated_at: Date;
}

/**
 * TypeScript representation of a `signal_cites` row.
 *
 * Typed directed edge from a signal to an immutable snapshot target.
 * Both cites targets are captured at evaluation time and remain stable
 * even if the wiki or standing prompt is subsequently updated.
 *
 * Architecture ref: docs/architecture.md §"Citations: first-class relation edges"
 */
export interface SignalCiteRow {
  id: string;
  signal_id: string;
  target_type: SignalCiteTargetType;
  target_id: string;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Insert / query option types
// ---------------------------------------------------------------------------

/**
 * Options for creating one signal row in `signals`.
 *
 * The idempotency key is derived from market_event_id + standing_prompt_version_id
 * and enforced at the DB layer via ON CONFLICT (idempotency_key) DO NOTHING.
 */
export interface InsertSignalOptions {
  tenant_id: string;
  researcher_id: string;
  market_event_id: string;
  standing_prompt_version_id: string;
  rationale?: string | null;
  /** Defaults to 1.0. Confidence decomposition is a follow-on Phase 6 issue. */
  source_trust?: number;
  /** Defaults to 1.0. Confidence decomposition is a follow-on Phase 6 issue. */
  extraction_certainty?: number;
  status?: SignalStatus;
  sql: SqlClient;
}

/**
 * Options for inserting one cites edge from a signal to an immutable snapshot.
 */
export interface InsertSignalCiteOptions {
  signal_id: string;
  target_type: SignalCiteTargetType;
  target_id: string;
  sql: SqlClient;
}

// ---------------------------------------------------------------------------
// Valid state machine transitions
// ---------------------------------------------------------------------------

/**
 * Valid state machine transitions for signals.
 *
 * State machine (PRD §5, §9):
 *   Generated → Delivered   (direct delivery, confidence ≥ threshold)
 *   Generated → Queued      (routed to Reviewer queue, confidence < threshold)
 *   Queued    → Delivered   (Reviewer approves)
 *   Queued    → Suppressed  (Reviewer suppresses)
 *   Delivered → Suppressed  (researcher dismisses — PRD §5: "Delivered → Dismissed")
 *
 * Terminal states: Suppressed.
 *
 * Architecture ref: docs/architecture.md §"Signal routing"
 */
export const VALID_SIGNAL_TRANSITIONS: ReadonlyMap<
  SignalStatus,
  ReadonlySet<SignalStatus>
> = new Map([
  ['Generated', new Set<SignalStatus>(['Delivered', 'Queued'])],
  ['Queued', new Set<SignalStatus>(['Delivered', 'Suppressed'])],
  ['Delivered', new Set<SignalStatus>(['Suppressed'])],
  ['Suppressed', new Set<SignalStatus>()],
]);

/**
 * Returns true if the transition from `from` to `to` is permitted by the
 * signal state machine (PRD §5, §9).
 */
export function isValidSignalTransition(from: SignalStatus, to: SignalStatus): boolean {
  return VALID_SIGNAL_TRANSITIONS.get(from)?.has(to) ?? false;
}

// ---------------------------------------------------------------------------
// Data access stubs
// ---------------------------------------------------------------------------

/**
 * Inserts one signal row into `signals`.
 *
 * The idempotency key is: `event_eval:<market_event_id>:<standing_prompt_version_id>`.
 * Uses ON CONFLICT (idempotency_key) DO NOTHING so that re-evaluating the same
 * event against the same prompt version is always a no-op (acceptance criterion AC-3).
 *
 * Returns the inserted row, or null if the row already existed (conflict case).
 *
 * DEV-SCOUT STUB: function signature and ON CONFLICT contract are correct. The
 * follow-on implementation issue owns the call-site wiring in the event-evaluation
 * API handler and the LLM evaluation call. No implementation body needed for the
 * scout to compile and test.
 *
 * @throws Error if the database write fails for any reason other than a duplicate
 *   idempotency key.
 */
export async function insertSignal(options: InsertSignalOptions): Promise<SignalRow | null> {
  const {
    tenant_id,
    researcher_id,
    market_event_id,
    standing_prompt_version_id,
    rationale = null,
    source_trust = 1.0,
    extraction_certainty = 1.0,
    status = 'Generated',
    sql,
  } = options;

  const idempotency_key = `event_eval:${market_event_id}:${standing_prompt_version_id}`;

  const rows = await sql<SignalRow[]>`
    INSERT INTO signals
      (tenant_id, researcher_id, market_event_id, standing_prompt_version_id,
       idempotency_key, rationale, source_trust, extraction_certainty, status)
    VALUES
      (${tenant_id}, ${researcher_id}, ${market_event_id}, ${standing_prompt_version_id},
       ${idempotency_key}, ${rationale}, ${source_trust}, ${extraction_certainty}, ${status})
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING
      id, tenant_id, researcher_id, market_event_id, standing_prompt_version_id,
      idempotency_key, rationale, source_trust, extraction_certainty, status,
      created_at, updated_at
  `;
  return rows[0] ?? null;
}

/**
 * Retrieves a signal row by its idempotency key.
 *
 * Returns null when no row exists.
 *
 * DEV-SCOUT STUB: function signature is correct. Follow-on implementation owns
 * the call site.
 */
export async function getSignalByIdempotencyKey(
  idempotency_key: string,
  sqlClient: SqlClient,
): Promise<SignalRow | null> {
  const rows = await sqlClient<SignalRow[]>`
    SELECT id, tenant_id, researcher_id, market_event_id, standing_prompt_version_id,
           idempotency_key, rationale, source_trust, extraction_certainty, status,
           created_at, updated_at
    FROM signals
    WHERE idempotency_key = ${idempotency_key}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Retrieves a signal row by its primary key.
 *
 * Returns null if no row exists.
 */
export async function getSignalById(
  signalId: string,
  sqlClient: SqlClient,
): Promise<SignalRow | null> {
  const rows = await sqlClient<SignalRow[]>`
    SELECT id, tenant_id, researcher_id, market_event_id, standing_prompt_version_id,
           idempotency_key, rationale, source_trust, extraction_certainty, status,
           created_at, updated_at
    FROM signals
    WHERE id = ${signalId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Inserts one cites edge from a signal to an immutable snapshot target.
 *
 * Uses ON CONFLICT (signal_id, target_type, target_id) DO NOTHING so that
 * attaching the same cites edge twice is idempotent (safe on worker retry).
 *
 * Returns the inserted row, or null if the edge already existed.
 *
 * DEV-SCOUT STUB: function signature and ON CONFLICT contract are correct.
 * Follow-on implementation owns the call site in the event-evaluation handler.
 *
 * Architecture ref: docs/architecture.md §"Citations: first-class relation edges"
 */
export async function insertSignalCite(
  options: InsertSignalCiteOptions,
): Promise<SignalCiteRow | null> {
  const { signal_id, target_type, target_id, sql } = options;

  const rows = await sql<SignalCiteRow[]>`
    INSERT INTO signal_cites (signal_id, target_type, target_id)
    VALUES (${signal_id}, ${target_type}, ${target_id})
    ON CONFLICT (signal_id, target_type, target_id) DO NOTHING
    RETURNING id, signal_id, target_type, target_id, created_at
  `;
  return rows[0] ?? null;
}

/**
 * Fetches all cites edges for a given signal, ordered by creation time.
 *
 * Returns the list of cites edges (may be empty if none have been attached yet).
 */
export async function getSignalCites(
  signalId: string,
  sqlClient: SqlClient,
): Promise<SignalCiteRow[]> {
  return sqlClient<SignalCiteRow[]>`
    SELECT id, signal_id, target_type, target_id, created_at
    FROM signal_cites
    WHERE signal_id = ${signalId}
    ORDER BY created_at ASC
  `;
}

/**
 * Advances a signal from `from` to `to` status, enforcing the state machine guard.
 *
 * Returns the updated row, or null if the row was not found or was already in
 * a different status than `from` (concurrent update — caller should retry).
 *
 * @throws Error if the transition is not permitted by the signal state machine.
 */
export async function transitionSignalStatus(
  signalId: string,
  from: SignalStatus,
  to: SignalStatus,
  sqlClient: SqlClient,
): Promise<SignalRow | null> {
  if (!isValidSignalTransition(from, to)) {
    throw new Error(
      `[signal-store] Invalid state machine transition: ${from} → ${to}. ` +
        'See VALID_SIGNAL_TRANSITIONS for allowed paths.',
    );
  }

  const rows = await sqlClient<SignalRow[]>`
    UPDATE signals
    SET status = ${to}, updated_at = NOW()
    WHERE id = ${signalId}
      AND status = ${from}
    RETURNING
      id, tenant_id, researcher_id, market_event_id, standing_prompt_version_id,
      idempotency_key, rationale, source_trust, extraction_certainty, status,
      created_at, updated_at
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// DDL (exported for use in test setup and migration scripts)
// ---------------------------------------------------------------------------

/**
 * DDL for the event-evaluation tables — issue #82.
 *
 * Applied by the test helper and by the production migration runner (migrateMkt).
 * Mirrors the authoritative DDL in packages/db/mkt-schema.sql.
 *
 * ## Schema
 *
 * ### signals
 *
 * One row per evaluated market_event × standing_prompt_version pair.
 * Idempotency key: `event_eval:<market_event_id>:<standing_prompt_version_id>`.
 * ON CONFLICT (idempotency_key) DO NOTHING prevents duplicate signal rows when
 * the same EVENT_EVALUATE task is retried (at-least-once delivery).
 *
 * Confidence decomposition (follow-on Phase 6 issue):
 *   - source_trust         FLOAT NOT NULL DEFAULT 1.0
 *   - extraction_certainty FLOAT NOT NULL DEFAULT 1.0
 * Both are stored as floats in [0.0, 1.0]. Defaulted to 1.0 in this scout.
 *
 * Status lifecycle: Generated → Delivered | Queued → Delivered | Suppressed.
 *
 * ### signal_cites
 *
 * Typed directed edges from a signal to an immutable snapshot target.
 * Unique per (signal_id, target_type, target_id). ON CONFLICT DO NOTHING
 * makes cite insertion idempotent on retry.
 *
 * target_type values (architecture §"Citations: first-class relation edges"):
 *   - `wiki_page_version`       — the wiki snapshot the signal was reasoned against
 *   - `standing_prompt_version` — the standing prompt revision used for evaluation
 *
 * Both targets are immutable snapshots captured at evaluation time.
 */
export const SIGNAL_STORE_DDL = `
-- signals — one row per evaluated market_event × standing_prompt_version pair.
-- Idempotency key: event_eval:<market_event_id>:<standing_prompt_version_id>.
-- Confidence decomposition columns (source_trust, extraction_certainty) default
-- to 1.0; the follow-on Phase 6 issue adds the LLM decomposition logic.
-- Status state machine: Generated → Delivered (direct) | Generated → Queued (reviewer)
--   Queued → Delivered (Reviewer approves) | Queued → Suppressed (Reviewer suppresses)
-- Architecture ref: docs/architecture.md §"Signal routing"
-- PRD ref: §5, §9 — event evaluation, confidence, auditability
CREATE TABLE IF NOT EXISTS signals (
  id                          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  tenant_id                   TEXT NOT NULL,
  researcher_id               TEXT NOT NULL,
  market_event_id             TEXT NOT NULL,
  standing_prompt_version_id  TEXT NOT NULL,
  -- Idempotency key: event_eval:<market_event_id>:<standing_prompt_version_id>
  idempotency_key             TEXT NOT NULL UNIQUE,
  -- Structured markdown rationale. Null in scout; set by real implementation.
  rationale                   TEXT,
  -- Confidence decomposition (follow-on Phase 6 issue). Default 1.0 for scout.
  source_trust                FLOAT NOT NULL DEFAULT 1.0,
  extraction_certainty        FLOAT NOT NULL DEFAULT 1.0,
  status                      TEXT NOT NULL DEFAULT 'Generated'
                                CHECK (status IN ('Generated', 'Queued', 'Delivered', 'Suppressed')),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_signals_tenant_researcher
  ON signals (tenant_id, researcher_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_signals_market_event
  ON signals (market_event_id);

CREATE INDEX IF NOT EXISTS idx_signals_status
  ON signals (status, created_at DESC);

-- signal_cites — typed directed edges from a signal to an immutable snapshot target.
-- target_type: wiki_page_version | standing_prompt_version
-- ON CONFLICT (signal_id, target_type, target_id) DO NOTHING makes cite insertion
-- idempotent on worker retry.
-- Architecture ref: docs/architecture.md §"Citations: first-class relation edges"
CREATE TABLE IF NOT EXISTS signal_cites (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  signal_id   TEXT NOT NULL,
  target_type TEXT NOT NULL
                CHECK (target_type IN ('wiki_page_version', 'standing_prompt_version')),
  target_id   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (signal_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_signal_cites_signal_id
  ON signal_cites (signal_id);
`;
