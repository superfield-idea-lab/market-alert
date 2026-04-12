/**
 * @file transcription-state-machine.ts
 *
 * Deterministic state machine for the meeting transcription pipeline.
 *
 * Implements the state model defined in PRD §4.2 for both the edge path
 * (short recordings, on-device transcription) and the worker path (longer
 * recordings, cluster-internal transcription worker).
 *
 * ## Edge path (PRD §4.2)
 *
 * ```
 * IDLE
 *   → RECORDING           (RM taps record in PWA)
 *   → TRANSCRIBING        (PWA transcribes locally on-device)
 *   → UPLOADING           (RM stops; only transcript is uploaded)
 *   → TRANSCRIBED         (transcript stored in Postgres)
 *   → QUEUED              (autolearn worker triggered)
 *   → INDEXED             (wiki updated)
 *
 *   TRANSCRIBING → TRANSCRIPTION_FAILED  (on-device model error)
 *   UPLOADING    → UPLOAD_FAILED         (network error)
 * ```
 *
 * ## Worker path (PRD §4.2)
 *
 * ```
 * IDLE
 *   → RECORDING           (RM taps record in PWA)
 *   → UPLOADING           (RM stops; audio uploaded to backend)
 *   → TRANSCRIBING        (cluster-internal worker processes audio)
 *   → TRANSCRIBED         (transcript stored in Postgres)
 *   → QUEUED              (autolearn worker triggered)
 *   → INDEXED             (wiki updated)
 *
 *   UPLOADING    → UPLOAD_FAILED         (network error)
 *   TRANSCRIBING → TRANSCRIPTION_FAILED  (worker error)
 * ```
 *
 * ## Design decisions
 *
 * - All legal transitions are encoded in LEGAL_TRANSITIONS — anything not in
 *   this map is rejected by `transitionRecording()` with an
 *   `IllegalTranscriptionTransitionError`.
 * - Each transition is recorded to the `transcription_transitions` table with a
 *   timestamp so the full history of a recording's processing lifecycle is
 *   queryable.
 * - The path (edge or worker) is stored on the state row and on transition
 *   records so per-path assertions are possible in tests.
 *
 * Blueprint refs: PRD §4.2, issue #61.
 */

import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// State enum
// ---------------------------------------------------------------------------

/**
 * All states in the transcription lifecycle (PRD §4.2).
 *
 * States are shared between the edge path and the worker path; the path
 * determines which transitions are legal from each state (see LEGAL_TRANSITIONS).
 */
export const TranscriptionState = {
  /** No recording in progress. */
  IDLE: 'IDLE',
  /** The RM is actively recording audio in the PWA. */
  RECORDING: 'RECORDING',
  /** On-device (edge path) or cluster-internal (worker path) transcription is running. */
  TRANSCRIBING: 'TRANSCRIBING',
  /** The transcript or audio is being uploaded to the backend. */
  UPLOADING: 'UPLOADING',
  /** The transcript has been stored in Postgres with speaker labels. */
  TRANSCRIBED: 'TRANSCRIBED',
  /** The autolearn worker has been triggered. */
  QUEUED: 'QUEUED',
  /** The wiki has been updated by the autolearn worker. */
  INDEXED: 'INDEXED',
  /** On-device model error (edge path) or worker error (worker path). */
  TRANSCRIPTION_FAILED: 'TRANSCRIPTION_FAILED',
  /** Network error while uploading (both paths). */
  UPLOAD_FAILED: 'UPLOAD_FAILED',
} as const;

export type TranscriptionState = (typeof TranscriptionState)[keyof typeof TranscriptionState];

// ---------------------------------------------------------------------------
// Path type
// ---------------------------------------------------------------------------

/**
 * Which execution path is being used for this recording.
 *
 * - `edge`   — short recording; PWA transcribes on-device; only transcript text uploaded.
 * - `worker` — longer recording; raw audio uploaded to backend; cluster-internal worker transcribes.
 */
export const TranscriptionPath = {
  EDGE: 'edge',
  WORKER: 'worker',
} as const;

export type TranscriptionPath = (typeof TranscriptionPath)[keyof typeof TranscriptionPath];

// ---------------------------------------------------------------------------
// Transition maps — one per path
// ---------------------------------------------------------------------------

/**
 * Legal transitions for the **edge path** (PRD §4.2).
 *
 * Edge path order: IDLE → RECORDING → TRANSCRIBING → UPLOADING → TRANSCRIBED → QUEUED → INDEXED
 * Failure transitions from TRANSCRIBING → TRANSCRIPTION_FAILED
 *                     from UPLOADING    → UPLOAD_FAILED
 */
export const EDGE_PATH_TRANSITIONS: Readonly<
  Record<TranscriptionState, readonly TranscriptionState[]>
> = {
  [TranscriptionState.IDLE]: [TranscriptionState.RECORDING],
  [TranscriptionState.RECORDING]: [TranscriptionState.TRANSCRIBING],
  [TranscriptionState.TRANSCRIBING]: [
    TranscriptionState.UPLOADING,
    TranscriptionState.TRANSCRIPTION_FAILED,
  ],
  [TranscriptionState.UPLOADING]: [
    TranscriptionState.TRANSCRIBED,
    TranscriptionState.UPLOAD_FAILED,
  ],
  [TranscriptionState.TRANSCRIBED]: [TranscriptionState.QUEUED],
  [TranscriptionState.QUEUED]: [TranscriptionState.INDEXED],
  [TranscriptionState.INDEXED]: [],
  [TranscriptionState.TRANSCRIPTION_FAILED]: [],
  [TranscriptionState.UPLOAD_FAILED]: [TranscriptionState.UPLOADING],
};

/**
 * Legal transitions for the **worker path** (PRD §4.2).
 *
 * Worker path order: IDLE → RECORDING → UPLOADING → TRANSCRIBING → TRANSCRIBED → QUEUED → INDEXED
 * Failure transitions from UPLOADING    → UPLOAD_FAILED
 *                     from TRANSCRIBING → TRANSCRIPTION_FAILED
 */
export const WORKER_PATH_TRANSITIONS: Readonly<
  Record<TranscriptionState, readonly TranscriptionState[]>
> = {
  [TranscriptionState.IDLE]: [TranscriptionState.RECORDING],
  [TranscriptionState.RECORDING]: [TranscriptionState.UPLOADING],
  [TranscriptionState.UPLOADING]: [
    TranscriptionState.TRANSCRIBING,
    TranscriptionState.UPLOAD_FAILED,
  ],
  [TranscriptionState.TRANSCRIBING]: [
    TranscriptionState.TRANSCRIBED,
    TranscriptionState.TRANSCRIPTION_FAILED,
  ],
  [TranscriptionState.TRANSCRIBED]: [TranscriptionState.QUEUED],
  [TranscriptionState.QUEUED]: [TranscriptionState.INDEXED],
  [TranscriptionState.INDEXED]: [],
  [TranscriptionState.TRANSCRIPTION_FAILED]: [],
  [TranscriptionState.UPLOAD_FAILED]: [TranscriptionState.UPLOADING],
};

/**
 * Combined legal-transition map used for coverage-probe assertions.
 *
 * A transition is considered legal if it is legal on *either* path, so the
 * probe can verify that every `TranscriptionState` value appears in the map.
 */
export const LEGAL_TRANSITIONS: Readonly<
  Record<TranscriptionState, readonly TranscriptionState[]>
> = Object.fromEntries(
  Object.values(TranscriptionState).map((state) => {
    const edgeTargets = EDGE_PATH_TRANSITIONS[state] ?? [];
    const workerTargets = WORKER_PATH_TRANSITIONS[state] ?? [];
    const merged = Array.from(new Set([...edgeTargets, ...workerTargets]));
    return [state, merged];
  }),
) as unknown as Readonly<Record<TranscriptionState, readonly TranscriptionState[]>>;

/** Terminal states — no further transitions are possible from these states. */
export const TERMINAL_STATES: ReadonlySet<TranscriptionState> = new Set([
  TranscriptionState.INDEXED,
  TranscriptionState.TRANSCRIPTION_FAILED,
]);

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when a caller attempts a transition that is not listed in the
 * path-specific transition map for the current state.
 */
export class IllegalTranscriptionTransitionError extends Error {
  constructor(
    public readonly from: TranscriptionState,
    public readonly to: TranscriptionState,
    public readonly path: TranscriptionPath,
  ) {
    const map = path === TranscriptionPath.EDGE ? EDGE_PATH_TRANSITIONS : WORKER_PATH_TRANSITIONS;
    super(
      `Illegal transcription state transition on ${path} path: ${from} → ${to}. ` +
        `Legal transitions from ${from}: [${(map[from] as readonly string[]).join(', ')}]`,
    );
    this.name = 'IllegalTranscriptionTransitionError';
  }
}

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

/**
 * A single row in the `transcription_state` table.
 */
export interface TranscriptionStateRow {
  recording_id: string;
  state: TranscriptionState;
  path: TranscriptionPath;
  updated_at: Date;
}

/**
 * A single row in the `transcription_transitions` table.
 */
export interface TranscriptionTransitionRow {
  id: string;
  recording_id: string;
  path: TranscriptionPath;
  from_state: TranscriptionState | null;
  to_state: TranscriptionState;
  transitioned_at: Date;
  reason: string | null;
}

/**
 * Input to `transitionRecording()`.
 */
export interface TranscriptionTransitionInput {
  /** The entity ID of the recording being transitioned. */
  recordingId: string;
  /** The state to transition to. */
  toState: TranscriptionState;
  /**
   * Human-readable reason for the transition.
   * Required when transitioning to a failure state; recommended otherwise.
   */
  reason?: string;
}

/**
 * Result of a successful `transitionRecording()` call.
 */
export interface TranscriptionTransitionResult {
  /** The recorded transition row. */
  transitionRow: TranscriptionTransitionRow;
  /** The new canonical state of the recording. */
  newState: TranscriptionState;
}

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

/**
 * SQL that creates the `transcription_state` and `transcription_transitions`
 * tables if they do not already exist.
 *
 * - `transcription_state`: one row per recording, holds the current state and path.
 * - `transcription_transitions`: append-only log of every state change.
 */
export const TRANSCRIPTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS transcription_state (
    recording_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    path TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT transcription_state_valid_state
        CHECK (state IN ('IDLE','RECORDING','TRANSCRIBING','UPLOADING','TRANSCRIBED',
                         'QUEUED','INDEXED','TRANSCRIPTION_FAILED','UPLOAD_FAILED')),
    CONSTRAINT transcription_state_valid_path
        CHECK (path IN ('edge','worker'))
);

CREATE TABLE IF NOT EXISTS transcription_transitions (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    recording_id TEXT NOT NULL,
    path TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    transitioned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reason TEXT,
    CONSTRAINT transcription_transitions_valid_to_state
        CHECK (to_state IN ('IDLE','RECORDING','TRANSCRIBING','UPLOADING','TRANSCRIBED',
                            'QUEUED','INDEXED','TRANSCRIPTION_FAILED','UPLOAD_FAILED')),
    CONSTRAINT transcription_transitions_valid_path
        CHECK (path IN ('edge','worker'))
);

CREATE INDEX IF NOT EXISTS idx_transcription_transitions_recording_id
    ON transcription_transitions (recording_id, transitioned_at);
`;

// ---------------------------------------------------------------------------
// State machine helpers
// ---------------------------------------------------------------------------

type SqlClient = postgres.Sql;

/**
 * Applies the `TRANSCRIPTION_SCHEMA_SQL` DDL to the given database.
 * Idempotent — safe to call on a database that already has these tables.
 */
export async function migrateTranscriptionSchema(sql: SqlClient): Promise<void> {
  const statements = TRANSCRIPTION_SCHEMA_SQL.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await sql.unsafe(stmt);
  }
}

/**
 * Initialises the state machine for a newly started recording.
 *
 * Inserts a row into `transcription_state` (state = IDLE) and records the
 * initial transition in `transcription_transitions`.
 *
 * Throws if a state row already exists for `recordingId`.
 */
export async function initRecordingState(
  sql: SqlClient,
  recordingId: string,
  path: TranscriptionPath,
  reason?: string,
): Promise<TranscriptionTransitionResult> {
  const initialState = TranscriptionState.IDLE;

  await sql`
    INSERT INTO transcription_state (recording_id, state, path, updated_at)
    VALUES (${recordingId}, ${initialState}, ${path}, NOW())
  `;

  const [row] = await sql<TranscriptionTransitionRow[]>`
    INSERT INTO transcription_transitions
        (recording_id, path, from_state, to_state, transitioned_at, reason)
    VALUES
        (${recordingId}, ${path}, NULL, ${initialState}, NOW(), ${reason ?? null})
    RETURNING id, recording_id, path, from_state, to_state, transitioned_at, reason
  `;

  return { transitionRow: row, newState: initialState };
}

/**
 * Reads the current state row for a recording.
 *
 * Returns `null` if no state row exists for `recordingId`.
 */
export async function getRecordingState(
  sql: SqlClient,
  recordingId: string,
): Promise<TranscriptionStateRow | null> {
  const [row] = await sql<TranscriptionStateRow[]>`
    SELECT recording_id, state, path, updated_at
    FROM transcription_state
    WHERE recording_id = ${recordingId}
  `;
  return row ?? null;
}

/**
 * Advances the state of a recording to `input.toState`.
 *
 * Enforcement rules:
 * 1. The recording must have an existing state row (must have been initialised
 *    via `initRecordingState()`).
 * 2. The `from → to` pair must appear in the path-specific transition map.
 *
 * On success the function atomically:
 * - Updates `transcription_state.state` and `updated_at`.
 * - Appends a row to `transcription_transitions`.
 *
 * @throws {IllegalTranscriptionTransitionError} when the transition is not legal.
 * @throws {Error}                               when no state row exists for `recordingId`.
 */
export async function transitionRecording(
  sql: SqlClient,
  input: TranscriptionTransitionInput,
): Promise<TranscriptionTransitionResult> {
  const { recordingId, toState, reason } = input;

  // Read current state row
  const stateRow = await getRecordingState(sql, recordingId);
  if (stateRow === null) {
    throw new Error(
      `No transcription state found for recording_id "${recordingId}". ` +
        `Call initRecordingState() before transitionRecording().`,
    );
  }

  const { state: currentState, path } = stateRow;

  // Enforce legal transitions for this path
  const transitionMap =
    path === TranscriptionPath.EDGE ? EDGE_PATH_TRANSITIONS : WORKER_PATH_TRANSITIONS;
  const legal = transitionMap[currentState] as readonly TranscriptionState[];

  if (!legal.includes(toState)) {
    throw new IllegalTranscriptionTransitionError(currentState, toState, path);
  }

  // Atomically update state + append transition record
  await sql`
    UPDATE transcription_state
    SET state = ${toState}, updated_at = NOW()
    WHERE recording_id = ${recordingId}
  `;

  const [row] = await sql<TranscriptionTransitionRow[]>`
    INSERT INTO transcription_transitions
        (recording_id, path, from_state, to_state, transitioned_at, reason)
    VALUES
        (${recordingId}, ${path}, ${currentState}, ${toState}, NOW(), ${reason ?? null})
    RETURNING id, recording_id, path, from_state, to_state, transitioned_at, reason
  `;

  return { transitionRow: row, newState: toState };
}

/**
 * Returns the full ordered transition history for a recording, oldest first.
 */
export async function getTranscriptionHistory(
  sql: SqlClient,
  recordingId: string,
): Promise<TranscriptionTransitionRow[]> {
  return sql<TranscriptionTransitionRow[]>`
    SELECT id, recording_id, path, from_state, to_state, transitioned_at, reason
    FROM transcription_transitions
    WHERE recording_id = ${recordingId}
    ORDER BY transitioned_at ASC, id ASC
  `;
}
