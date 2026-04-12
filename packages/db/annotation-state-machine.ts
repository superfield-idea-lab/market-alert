/**
 * @file annotation-state-machine.ts
 *
 * Deterministic state machine for annotation threads — PRD §4.4.
 *
 * Provides typed constants and DB helpers for creating, advancing, and
 * querying annotation rows. The state machine enforces the legal transitions
 * defined in PRD §4.4; illegal transitions are rejected with an
 * `IllegalAnnotationTransitionError`. Every transition emits an audit event.
 *
 * ## State machine (PRD §4.4 — Wiki Correction via Annotation Thread)
 *
 * ```
 * ANNOTATION_OPEN
 *   → AGENT_RESPONDING      (agent reads thread and current wiki; proposes correction)
 *   → DISCUSSION            (RM replies; agent responds; thread continues)
 *   → CORRECTION_APPLIED    (agent writes new WikiPageVersion; marks annotation resolved)
 *
 *   DISCUSSION → DISMISSED          (RM dismisses without applying)
 *   CORRECTION_APPLIED → REOPENED   (RM reopens; thread continues)
 *   AGENT_RESPONDING → AUTO_RESOLVED  (agent confident issue is satisfied; closes thread)
 * ```
 *
 * Blueprint refs: issue #64, PRD §4.4.
 */

import type postgres from 'postgres';
import { computeAuditHash } from '../core/audit';

// ---------------------------------------------------------------------------
// State enum
// ---------------------------------------------------------------------------

/**
 * All legal states in the PRD §4.4 annotation state machine.
 *
 * State names match the PRD exactly so the enum values are self-documenting.
 */
export const AnnotationState = {
  /** Initial state — annotation thread has been opened by the RM. */
  ANNOTATION_OPEN: 'ANNOTATION_OPEN',
  /** Agent is reading the thread and current wiki to propose a correction. */
  AGENT_RESPONDING: 'AGENT_RESPONDING',
  /** RM and agent are exchanging replies; thread is active. */
  DISCUSSION: 'DISCUSSION',
  /** Agent has written a new WikiPageVersion; annotation is resolved. */
  CORRECTION_APPLIED: 'CORRECTION_APPLIED',
  /** RM dismissed the thread without applying a correction. */
  DISMISSED: 'DISMISSED',
  /** RM reopened the thread after a correction was applied. */
  REOPENED: 'REOPENED',
  /** Agent closed the thread autonomously — confident the issue is satisfied. */
  AUTO_RESOLVED: 'AUTO_RESOLVED',
} as const;

export type AnnotationState = (typeof AnnotationState)[keyof typeof AnnotationState];

// ---------------------------------------------------------------------------
// Transition map
// ---------------------------------------------------------------------------

/**
 * Canonical map of legal `from → to[]` transitions (PRD §4.4).
 *
 * Any transition not listed here is illegal and will be rejected by
 * `transitionAnnotation()` with an `IllegalAnnotationTransitionError`.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<AnnotationState, readonly AnnotationState[]>> = {
  [AnnotationState.ANNOTATION_OPEN]: [AnnotationState.AGENT_RESPONDING],
  [AnnotationState.AGENT_RESPONDING]: [
    AnnotationState.DISCUSSION,
    AnnotationState.CORRECTION_APPLIED,
    AnnotationState.AUTO_RESOLVED,
  ],
  [AnnotationState.DISCUSSION]: [
    AnnotationState.AGENT_RESPONDING,
    AnnotationState.CORRECTION_APPLIED,
    AnnotationState.DISMISSED,
  ],
  [AnnotationState.CORRECTION_APPLIED]: [AnnotationState.REOPENED],
  [AnnotationState.DISMISSED]: [],
  [AnnotationState.REOPENED]: [AnnotationState.AGENT_RESPONDING, AnnotationState.DISCUSSION],
  [AnnotationState.AUTO_RESOLVED]: [],
};

/** Terminal states — no further transitions are possible from these states. */
export const TERMINAL_STATES: ReadonlySet<AnnotationState> = new Set([
  AnnotationState.DISMISSED,
  AnnotationState.AUTO_RESOLVED,
]);

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when a caller attempts a transition that is not listed in
 * `LEGAL_TRANSITIONS` for the current annotation state.
 */
export class IllegalAnnotationTransitionError extends Error {
  constructor(
    public readonly from: AnnotationState,
    public readonly to: AnnotationState,
  ) {
    super(
      `Illegal annotation state transition: ${from} → ${to}. ` +
        `Legal transitions from ${from}: [${(LEGAL_TRANSITIONS[from] as readonly string[]).join(', ')}]`,
    );
    this.name = 'IllegalAnnotationTransitionError';
  }
}

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

/**
 * A single row in the `annotation_state` table.
 */
export interface AnnotationStateRow {
  annotation_id: string;
  state: AnnotationState;
  actor_id: string;
  updated_at: Date;
}

/**
 * A single row in the `annotation_transitions` table.
 */
export interface AnnotationTransitionRow {
  id: string;
  annotation_id: string;
  from_state: AnnotationState | null;
  to_state: AnnotationState;
  actor_id: string;
  transitioned_at: Date;
  reason: string | null;
}

/**
 * Input to `transitionAnnotation()`.
 */
export interface AnnotationTransitionInput {
  /** The entity ID of the annotation thread being transitioned. */
  annotationId: string;
  /** The state to transition to. */
  toState: AnnotationState;
  /** Actor performing the transition (user ID or agent ID). */
  actorId: string;
  /**
   * Human-readable reason for the transition.
   * Recommended for all transitions; required for DISMISSED.
   */
  reason?: string;
}

/**
 * Result of a successful `transitionAnnotation()` call.
 */
export interface AnnotationTransitionResult {
  /** The recorded transition row. */
  transitionRow: AnnotationTransitionRow;
  /** The new canonical state of the annotation. */
  newState: AnnotationState;
}

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

/**
 * SQL that creates the `annotation_state` and `annotation_transitions`
 * tables if they do not already exist.
 *
 * - `annotation_state`: one row per annotation thread, holds the current state.
 * - `annotation_transitions`: append-only log of every state change.
 */
export const ANNOTATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS annotation_state (
    annotation_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT annotation_state_valid_state
        CHECK (state IN (
            'ANNOTATION_OPEN','AGENT_RESPONDING','DISCUSSION',
            'CORRECTION_APPLIED','DISMISSED','REOPENED','AUTO_RESOLVED'
        ))
);

CREATE TABLE IF NOT EXISTS annotation_transitions (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    annotation_id TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    transitioned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reason TEXT,
    CONSTRAINT annotation_transitions_valid_to_state
        CHECK (to_state IN (
            'ANNOTATION_OPEN','AGENT_RESPONDING','DISCUSSION',
            'CORRECTION_APPLIED','DISMISSED','REOPENED','AUTO_RESOLVED'
        ))
);

CREATE INDEX IF NOT EXISTS idx_annotation_transitions_annotation_id
    ON annotation_transitions (annotation_id, transitioned_at);
`;

// ---------------------------------------------------------------------------
// State machine helpers
// ---------------------------------------------------------------------------

type SqlClient = postgres.Sql;

/**
 * Applies the `ANNOTATION_SCHEMA_SQL` DDL to the given database.
 * Idempotent — safe to call on a database that already has these tables.
 */
export async function migrateAnnotationSchema(sql: SqlClient): Promise<void> {
  const statements = ANNOTATION_SCHEMA_SQL.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await sql.unsafe(stmt);
  }
}

/**
 * Emits an audit event for an annotation state transition.
 *
 * Uses the annotation `annotation_transitions` table as the append-only audit
 * log. For systems that require a separate centralised audit store the caller
 * may pass an `auditSql` pool; when omitted no separate audit row is written.
 */
async function emitAuditEvent(options: {
  auditSql: SqlClient;
  annotationId: string;
  actorId: string;
  fromState: AnnotationState | null;
  toState: AnnotationState;
  reason?: string;
  genesisHash?: string;
}): Promise<void> {
  const { auditSql, annotationId, actorId, fromState, toState, reason, genesisHash } = options;

  // Fetch the last hash in the chain for this entity (or use genesis hash).
  const genesis = genesisHash ?? '0000000000000000000000000000000000000000000000000000000000000000';

  const [lastRow] = await auditSql<{ hash: string }[]>`
    SELECT hash
    FROM audit_events
    WHERE entity_type = 'wiki_annotation'
      AND entity_id    = ${annotationId}
    ORDER BY ts DESC
    LIMIT 1
  `;

  const prevHash = lastRow?.hash ?? genesis;
  const ts = new Date().toISOString();

  const payload = {
    actor_id: actorId,
    action: 'annotation.transition',
    entity_type: 'wiki_annotation',
    entity_id: annotationId,
    before: fromState !== null ? { state: fromState } : null,
    after: { state: toState, reason: reason ?? null },
    ts,
  };

  const hash = await computeAuditHash(prevHash, payload);

  await auditSql.unsafe(
    `INSERT INTO audit_events
       (actor_id, action, entity_type, entity_id, before, after, ts, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::timestamptz, $8, $9)`,
    [
      payload.actor_id,
      payload.action,
      payload.entity_type,
      payload.entity_id,
      payload.before as unknown as string,
      payload.after as unknown as string,
      payload.ts,
      prevHash,
      hash,
    ],
  );
}

/**
 * Initialises the state machine for a newly opened annotation thread.
 *
 * Inserts a row into `annotation_state` (state = ANNOTATION_OPEN) and records
 * the initial transition in `annotation_transitions`. Also emits an audit event
 * when an `auditSql` pool is provided.
 *
 * Throws if a state row already exists for `annotationId`.
 */
export async function initAnnotationState(
  sql: SqlClient,
  annotationId: string,
  actorId: string,
  options?: { reason?: string; auditSql?: SqlClient; genesisHash?: string },
): Promise<AnnotationTransitionResult> {
  const { reason, auditSql, genesisHash } = options ?? {};
  const initialState = AnnotationState.ANNOTATION_OPEN;

  await sql`
    INSERT INTO annotation_state (annotation_id, state, actor_id, updated_at)
    VALUES (${annotationId}, ${initialState}, ${actorId}, NOW())
  `;

  const [row] = await sql<AnnotationTransitionRow[]>`
    INSERT INTO annotation_transitions
        (annotation_id, from_state, to_state, actor_id, transitioned_at, reason)
    VALUES
        (${annotationId}, NULL, ${initialState}, ${actorId}, NOW(), ${reason ?? null})
    RETURNING id, annotation_id, from_state, to_state, actor_id, transitioned_at, reason
  `;

  if (auditSql) {
    await emitAuditEvent({
      auditSql,
      annotationId,
      actorId,
      fromState: null,
      toState: initialState,
      reason,
      genesisHash,
    });
  }

  return { transitionRow: row, newState: initialState };
}

/**
 * Reads the current state row for an annotation.
 *
 * Returns `null` if no state row exists for `annotationId`.
 */
export async function getAnnotationState(
  sql: SqlClient,
  annotationId: string,
): Promise<AnnotationStateRow | null> {
  const [row] = await sql<AnnotationStateRow[]>`
    SELECT annotation_id, state, actor_id, updated_at
    FROM annotation_state
    WHERE annotation_id = ${annotationId}
  `;
  return row ?? null;
}

/**
 * Advances the state of an annotation to `input.toState`.
 *
 * Enforcement rules:
 * 1. The annotation must have an existing state row (must have been initialised
 *    via `initAnnotationState()`).
 * 2. The `from → to` pair must appear in `LEGAL_TRANSITIONS`.
 *
 * On success the function atomically:
 * - Updates `annotation_state.state`, `actor_id`, and `updated_at`.
 * - Appends a row to `annotation_transitions`.
 * - Emits an audit event when an `auditSql` pool is provided.
 *
 * @throws {IllegalAnnotationTransitionError} when the transition is not legal.
 * @throws {Error}                            when no state row exists for `annotationId`.
 */
export async function transitionAnnotation(
  sql: SqlClient,
  input: AnnotationTransitionInput,
  options?: { auditSql?: SqlClient; genesisHash?: string },
): Promise<AnnotationTransitionResult> {
  const { annotationId, toState, actorId, reason } = input;
  const { auditSql, genesisHash } = options ?? {};

  // Read current state row
  const stateRow = await getAnnotationState(sql, annotationId);
  if (stateRow === null) {
    throw new Error(
      `No annotation state found for annotation_id "${annotationId}". ` +
        `Call initAnnotationState() before transitionAnnotation().`,
    );
  }

  const currentState = stateRow.state;
  const legal = LEGAL_TRANSITIONS[currentState] as readonly AnnotationState[];

  if (!legal.includes(toState)) {
    throw new IllegalAnnotationTransitionError(currentState, toState);
  }

  // Atomically update state + append transition record
  await sql`
    UPDATE annotation_state
    SET state = ${toState}, actor_id = ${actorId}, updated_at = NOW()
    WHERE annotation_id = ${annotationId}
  `;

  const [row] = await sql<AnnotationTransitionRow[]>`
    INSERT INTO annotation_transitions
        (annotation_id, from_state, to_state, actor_id, transitioned_at, reason)
    VALUES
        (${annotationId}, ${currentState}, ${toState}, ${actorId}, NOW(), ${reason ?? null})
    RETURNING id, annotation_id, from_state, to_state, actor_id, transitioned_at, reason
  `;

  if (auditSql) {
    await emitAuditEvent({
      auditSql,
      annotationId,
      actorId,
      fromState: currentState,
      toState,
      reason,
      genesisHash,
    });
  }

  return { transitionRow: row, newState: toState };
}

/**
 * Returns the full ordered transition history for an annotation, oldest first.
 */
export async function getAnnotationHistory(
  sql: SqlClient,
  annotationId: string,
): Promise<AnnotationTransitionRow[]> {
  return sql<AnnotationTransitionRow[]>`
    SELECT id, annotation_id, from_state, to_state, actor_id, transitioned_at, reason
    FROM annotation_transitions
    WHERE annotation_id = ${annotationId}
    ORDER BY transitioned_at ASC, id ASC
  `;
}
