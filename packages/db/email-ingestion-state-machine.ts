/**
 * @file email-ingestion-state-machine
 *
 * Deterministic state machine for the email ingestion pipeline.
 *
 * Implements the state model defined in PRD §4.1:
 *
 * ```
 * IMAP_RECEIVED
 *     → ANONYMISING       (worker strips and tokenises PII)
 *     → STORING           (anonymised email written to Postgres)
 *     → QUEUED            (ingestion event emitted; autolearn worker triggered)
 *     → INDEXED           (autolearn worker has processed and updated wiki)
 *
 *     ANONYMISING → FAILED        (on error; alert raised; raw email discarded)
 *     STORING     → FAILED        (on DB error; retry up to 3x)
 * ```
 *
 * Recovery transitions (from FAILED state):
 *     FAILED → ANONYMISING        (retry from anonymisation step)
 *     FAILED → STORING            (retry from storing step when anonymisation succeeded)
 *
 * Design decisions:
 * - All legal transitions are encoded in LEGAL_TRANSITIONS — anything not in
 *   this map is rejected by `transition()` with an `IllegalTransitionError`.
 * - Each transition is recorded to the `email_ingestion_transitions` table with
 *   a timestamp so the full history of an email's processing lifecycle is
 *   queryable.
 * - The FAILED state carries an optional `reason` and `failedFrom` field so
 *   the recovery handler can determine which retry entry point to use.
 *
 * Blueprint refs: PRD §4.1, issue #32.
 */

import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// State enum
// ---------------------------------------------------------------------------

/**
 * All states in the email ingestion lifecycle (PRD §4.1).
 */
export const EmailIngestionState = {
  /** Email has arrived at the IMAP endpoint but processing has not started. */
  IMAP_RECEIVED: 'IMAP_RECEIVED',
  /** PII stripping and tokenisation is in progress. */
  ANONYMISING: 'ANONYMISING',
  /** Anonymised email is being written to Postgres. */
  STORING: 'STORING',
  /** Email is stored; ingestion event emitted; autolearn worker triggered. */
  QUEUED: 'QUEUED',
  /** Autolearn worker has processed the email and updated the wiki. */
  INDEXED: 'INDEXED',
  /** A non-recoverable or retriable error has occurred. */
  FAILED: 'FAILED',
} as const;

export type EmailIngestionState = (typeof EmailIngestionState)[keyof typeof EmailIngestionState];

// ---------------------------------------------------------------------------
// Transition map
// ---------------------------------------------------------------------------

/**
 * Canonical map of legal `from → to[]` transitions.
 *
 * Any transition not listed here is illegal and will be rejected by
 * `transition()` with an `IllegalTransitionError`.
 *
 * Recovery entries (FAILED → …) are listed here so the same enforcement path
 * covers both forward and retry transitions.
 */
export const LEGAL_TRANSITIONS: Readonly<
  Record<EmailIngestionState, readonly EmailIngestionState[]>
> = {
  [EmailIngestionState.IMAP_RECEIVED]: [EmailIngestionState.ANONYMISING],
  [EmailIngestionState.ANONYMISING]: [EmailIngestionState.STORING, EmailIngestionState.FAILED],
  [EmailIngestionState.STORING]: [EmailIngestionState.QUEUED, EmailIngestionState.FAILED],
  [EmailIngestionState.QUEUED]: [EmailIngestionState.INDEXED],
  [EmailIngestionState.INDEXED]: [],
  // Recovery from FAILED: caller supplies the correct retry entry point.
  [EmailIngestionState.FAILED]: [EmailIngestionState.ANONYMISING, EmailIngestionState.STORING],
};

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when a caller attempts a transition that is not listed in
 * `LEGAL_TRANSITIONS` for the current state.
 */
export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: EmailIngestionState,
    public readonly to: EmailIngestionState,
  ) {
    super(
      `Illegal email ingestion state transition: ${from} → ${to}. ` +
        `Legal transitions from ${from}: [${(LEGAL_TRANSITIONS[from] as readonly string[]).join(', ')}]`,
    );
    this.name = 'IllegalTransitionError';
  }
}

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

/**
 * A single row in the `email_ingestion_transitions` table.
 */
export interface EmailIngestionTransitionRow {
  id: string;
  email_id: string;
  from_state: EmailIngestionState | null;
  to_state: EmailIngestionState;
  transitioned_at: Date;
  reason: string | null;
}

/**
 * Input to `transition()`.
 */
export interface TransitionInput {
  /** The entity ID of the email being transitioned. */
  emailId: string;
  /** The state to transition to. */
  toState: EmailIngestionState;
  /**
   * Human-readable reason for the transition.
   * Required when transitioning to FAILED; recommended for other transitions.
   */
  reason?: string;
}

/**
 * Result of a successful `transition()` call.
 */
export interface TransitionResult {
  /** The recorded transition row. */
  transitionRow: EmailIngestionTransitionRow;
  /** The new canonical state of the email. */
  newState: EmailIngestionState;
}

// ---------------------------------------------------------------------------
// Schema DDL (applied by migrate())
// ---------------------------------------------------------------------------

/**
 * SQL that creates the `email_ingestion_state` and
 * `email_ingestion_transitions` tables if they do not already exist.
 *
 * - `email_ingestion_state`: one row per email, holds the current state.
 * - `email_ingestion_transitions`: append-only log of every state change.
 *
 * These tables are intentionally separate from the main `entities` table so
 * the state machine is self-contained and queryable without a full graph scan.
 */
export const EMAIL_INGESTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS email_ingestion_state (
    email_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT email_ingestion_state_valid_state
        CHECK (state IN ('IMAP_RECEIVED','ANONYMISING','STORING','QUEUED','INDEXED','FAILED'))
);

CREATE TABLE IF NOT EXISTS email_ingestion_transitions (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    email_id TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    transitioned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reason TEXT,
    CONSTRAINT email_ingestion_transitions_valid_to_state
        CHECK (to_state IN ('IMAP_RECEIVED','ANONYMISING','STORING','QUEUED','INDEXED','FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_email_ingestion_transitions_email_id
    ON email_ingestion_transitions (email_id, transitioned_at);
`;

// ---------------------------------------------------------------------------
// State machine helpers
// ---------------------------------------------------------------------------

type SqlClient = postgres.Sql;

/**
 * Applies the `EMAIL_INGESTION_SCHEMA_SQL` DDL to the given database.
 * Idempotent — safe to call on a database that already has these tables.
 */
export async function migrateEmailIngestionSchema(sql: SqlClient): Promise<void> {
  const statements = EMAIL_INGESTION_SCHEMA_SQL.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await sql.unsafe(stmt);
  }
}

/**
 * Initialises the state machine for a newly received email.
 *
 * Inserts a row into `email_ingestion_state` (state = IMAP_RECEIVED) and
 * records the initial transition in `email_ingestion_transitions`.
 *
 * Throws if a state row already exists for `emailId` (use `transition()` to
 * advance an existing email).
 */
export async function initEmailState(
  sql: SqlClient,
  emailId: string,
  reason?: string,
): Promise<TransitionResult> {
  const initialState = EmailIngestionState.IMAP_RECEIVED;

  await sql`
    INSERT INTO email_ingestion_state (email_id, state, updated_at)
    VALUES (${emailId}, ${initialState}, NOW())
  `;

  const [row] = await sql<EmailIngestionTransitionRow[]>`
    INSERT INTO email_ingestion_transitions
        (email_id, from_state, to_state, transitioned_at, reason)
    VALUES
        (${emailId}, NULL, ${initialState}, NOW(), ${reason ?? null})
    RETURNING id, email_id, from_state, to_state, transitioned_at, reason
  `;

  return { transitionRow: row, newState: initialState };
}

/**
 * Reads the current state of an email from `email_ingestion_state`.
 *
 * Returns `null` if no state row exists for `emailId`.
 */
export async function getEmailState(
  sql: SqlClient,
  emailId: string,
): Promise<EmailIngestionState | null> {
  const [row] = await sql<{ state: EmailIngestionState }[]>`
    SELECT state FROM email_ingestion_state WHERE email_id = ${emailId}
  `;
  return row?.state ?? null;
}

/**
 * Advances the state of an email to `input.toState`.
 *
 * Enforcement rules:
 * 1. The email must have an existing state row (must have been initialised via
 *    `initEmailState()`).
 * 2. The `from → to` pair must appear in `LEGAL_TRANSITIONS`.
 *
 * On success the function atomically:
 * - Updates `email_ingestion_state.state` and `updated_at`.
 * - Appends a row to `email_ingestion_transitions`.
 *
 * @throws {IllegalTransitionError} when the requested transition is not legal.
 * @throws {Error}                  when no state row exists for `emailId`.
 */
export async function transition(
  sql: SqlClient,
  input: TransitionInput,
): Promise<TransitionResult> {
  const { emailId, toState, reason } = input;

  // Read current state
  const currentState = await getEmailState(sql, emailId);
  if (currentState === null) {
    throw new Error(
      `No ingestion state found for email_id "${emailId}". ` +
        `Call initEmailState() before transition().`,
    );
  }

  // Enforce legal transitions
  const legal = LEGAL_TRANSITIONS[currentState] as readonly EmailIngestionState[];
  if (!legal.includes(toState)) {
    throw new IllegalTransitionError(currentState, toState);
  }

  // Atomically update state + append transition record
  await sql`
    UPDATE email_ingestion_state
    SET state = ${toState}, updated_at = NOW()
    WHERE email_id = ${emailId}
  `;

  const [row] = await sql<EmailIngestionTransitionRow[]>`
    INSERT INTO email_ingestion_transitions
        (email_id, from_state, to_state, transitioned_at, reason)
    VALUES
        (${emailId}, ${currentState}, ${toState}, NOW(), ${reason ?? null})
    RETURNING id, email_id, from_state, to_state, transitioned_at, reason
  `;

  return { transitionRow: row, newState: toState };
}

/**
 * Returns the full ordered transition history for an email, oldest first.
 */
export async function getTransitionHistory(
  sql: SqlClient,
  emailId: string,
): Promise<EmailIngestionTransitionRow[]> {
  return sql<EmailIngestionTransitionRow[]>`
    SELECT id, email_id, from_state, to_state, transitioned_at, reason
    FROM email_ingestion_transitions
    WHERE email_id = ${emailId}
    ORDER BY transitioned_at ASC, id ASC
  `;
}
