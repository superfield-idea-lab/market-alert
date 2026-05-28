/**
 * @file mkt-corporate-action-lifecycle.ts
 *
 * Corporate Action state machine and lifecycle data access — Phase 2 (issue #16).
 *
 * ## State machine
 *
 *   Announced → Effective   (when effective_date is in the past)
 *   Effective  → Closed     (when settlement_date is in the past)
 *   Any        → Disputed   (admin-forced via POST /internal/corporate-actions/:id/dispute)
 *
 * Illegal transitions return a CorporateActionTransitionError (HTTP 409).
 *
 * ## Journal
 *
 * Every state transition produces exactly one row in mkt_corporate_action_journal
 * with actor, from_state, to_state, reason, and occurred_at.
 *
 * ## Cron query
 *
 * `findCorporateActionsNeedingAdvance` returns rows whose effective_date or
 * settlement_date is in the past and whose state has not yet advanced. Used by
 * the corp-action-advance-dispatch cron job to decide which IDs to enqueue.
 *
 * ## Canonical docs
 *
 * - docs/plan.md — Phase 2 scope
 * - packages/db/mkt-schema.sql — DDL (state, effective_date, settlement_date, journal)
 * - packages/db/task-queue.ts — TaskType.CORP_ACTION_ADVANCE
 * - apps/server/src/api/corporate-action-lifecycle.ts — API handlers
 * - apps/server/src/cron/jobs/corp-action-advance-dispatch.ts — cron job
 */

import postgres from 'postgres';
import { sql as defaultSql } from './index';

// ---------------------------------------------------------------------------
// State constants
// ---------------------------------------------------------------------------

export const CorporateActionState = {
  Announced: 'Announced',
  Effective: 'Effective',
  Closed: 'Closed',
  Disputed: 'Disputed',
} as const;

export type CorporateActionState = (typeof CorporateActionState)[keyof typeof CorporateActionState];

// ---------------------------------------------------------------------------
// Valid automatic advance transitions
// ---------------------------------------------------------------------------

/**
 * Maps from_state → to_state for automatic CORP_ACTION_ADVANCE transitions.
 *
 * Disputed is not reachable via advance (only via dispute endpoint).
 */
const ADVANCE_TRANSITIONS: Partial<Record<CorporateActionState, CorporateActionState>> = {
  [CorporateActionState.Announced]: CorporateActionState.Effective,
  [CorporateActionState.Effective]: CorporateActionState.Closed,
};

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when an advance or dispute transition is not legal for the current
 * state. The API layer converts this to HTTP 409.
 */
export class CorporateActionTransitionError extends Error {
  constructor(
    public readonly corporate_action_id: string,
    public readonly from_state: string,
    public readonly attempted_to_state: string,
  ) {
    super(
      `Illegal state transition for corporate action ${corporate_action_id}: ` +
        `${from_state} → ${attempted_to_state}`,
    );
    this.name = 'CorporateActionTransitionError';
  }
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface CorporateActionStateRow {
  id: string;
  state: CorporateActionState;
  effective_date: Date | null;
  settlement_date: Date | null;
  updated_at: Date;
}

export interface CorporateActionJournalRow {
  id: string;
  corporate_action_id: string;
  actor: string;
  from_state: string;
  to_state: string;
  reason: string | null;
  occurred_at: Date;
}

// ---------------------------------------------------------------------------
// Advance transition
// ---------------------------------------------------------------------------

/**
 * Advances the state of a CorporateAction by one step in the state machine.
 *
 * Transitions:
 *   Announced → Effective
 *   Effective  → Closed
 *
 * Returns the new state after transition.
 *
 * @throws CorporateActionTransitionError when the current state has no legal
 *   advance transition (e.g. Closed, Disputed, or Disputed).
 * @throws Error when the corporate_action_id does not exist.
 */
export async function advanceCorporateAction(
  corporate_action_id: string,
  actor: string,
  db: postgres.Sql = defaultSql,
): Promise<CorporateActionState> {
  // Fetch current state inside a transaction to prevent races.
  const result = await db.begin(async (tx) => {
    const rows = await tx<CorporateActionStateRow[]>`
      SELECT id, state, effective_date, settlement_date, updated_at
      FROM mkt_corporate_actions
      WHERE id = ${corporate_action_id}
      FOR UPDATE
    `;

    if (rows.length === 0) {
      throw new Error(`CorporateAction not found: ${corporate_action_id}`);
    }

    const row = rows[0];
    const from_state = row.state as CorporateActionState;
    const to_state = ADVANCE_TRANSITIONS[from_state];

    if (!to_state) {
      throw new CorporateActionTransitionError(corporate_action_id, from_state, '(advance)');
    }

    await tx`
      UPDATE mkt_corporate_actions
      SET state = ${to_state}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${corporate_action_id}
    `;

    await tx`
      INSERT INTO mkt_corporate_action_journal
        (corporate_action_id, actor, from_state, to_state)
      VALUES
        (${corporate_action_id}, ${actor}, ${from_state}, ${to_state})
    `;

    return to_state;
  });

  return result as CorporateActionState;
}

// ---------------------------------------------------------------------------
// Dispute transition
// ---------------------------------------------------------------------------

/**
 * Forces a CorporateAction into the Disputed state.
 *
 * Any state except Disputed itself may transition to Disputed.
 *
 * @param reason - Non-empty human-readable reason (required).
 * @throws CorporateActionTransitionError when the action is already Disputed.
 * @throws Error when the corporate_action_id does not exist.
 */
export async function disputeCorporateAction(
  corporate_action_id: string,
  reason: string,
  actor: string,
  db: postgres.Sql = defaultSql,
): Promise<void> {
  await db.begin(async (tx) => {
    const rows = await tx<CorporateActionStateRow[]>`
      SELECT id, state, updated_at
      FROM mkt_corporate_actions
      WHERE id = ${corporate_action_id}
      FOR UPDATE
    `;

    if (rows.length === 0) {
      throw new Error(`CorporateAction not found: ${corporate_action_id}`);
    }

    const from_state = rows[0].state as CorporateActionState;

    if (from_state === CorporateActionState.Disputed) {
      throw new CorporateActionTransitionError(
        corporate_action_id,
        from_state,
        CorporateActionState.Disputed,
      );
    }

    await tx`
      UPDATE mkt_corporate_actions
      SET state = ${CorporateActionState.Disputed}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${corporate_action_id}
    `;

    await tx`
      INSERT INTO mkt_corporate_action_journal
        (corporate_action_id, actor, from_state, to_state, reason)
      VALUES
        (${corporate_action_id}, ${actor}, ${from_state},
         ${CorporateActionState.Disputed}, ${reason})
    `;
  });
}

// ---------------------------------------------------------------------------
// Cron query: find rows needing advance
// ---------------------------------------------------------------------------

export interface CorporateActionAdvanceCandidateRow {
  id: string;
  state: CorporateActionState;
  effective_date: Date | null;
  settlement_date: Date | null;
}

/**
 * Returns CorporateAction IDs that are eligible for state advancement:
 *
 *   - Announced with effective_date <= NOW()  → candidate for Effective
 *   - Effective  with settlement_date <= NOW() → candidate for Closed
 *
 * Rows that already have a pending CORP_ACTION_ADVANCE task in task_queue
 * (status IN ('pending', 'claimed')) are excluded to prevent duplicates.
 *
 * Blueprint ref: DATA-D-004 (idempotent enqueue).
 */
export async function findCorporateActionsNeedingAdvance(
  db: postgres.Sql = defaultSql,
): Promise<CorporateActionAdvanceCandidateRow[]> {
  return db<CorporateActionAdvanceCandidateRow[]>`
    SELECT ca.id, ca.state, ca.effective_date, ca.settlement_date
    FROM mkt_corporate_actions ca
    WHERE
      (
        (ca.state = 'Announced' AND ca.effective_date IS NOT NULL AND ca.effective_date <= CURRENT_DATE)
        OR
        (ca.state = 'Effective' AND ca.settlement_date IS NOT NULL AND ca.settlement_date <= CURRENT_DATE)
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_queue tq
        WHERE tq.job_type = 'CORP_ACTION_ADVANCE'
          AND tq.status IN ('pending', 'claimed')
          AND (tq.payload->>'corporate_action_id') = ca.id
      )
  `;
}

// ---------------------------------------------------------------------------
// Journal query
// ---------------------------------------------------------------------------

/**
 * Returns all journal entries for a CorporateAction ordered by occurred_at asc.
 */
export async function getCorporateActionJournal(
  corporate_action_id: string,
  db: postgres.Sql = defaultSql,
): Promise<CorporateActionJournalRow[]> {
  return db<CorporateActionJournalRow[]>`
    SELECT id, corporate_action_id, actor, from_state, to_state, reason, occurred_at
    FROM mkt_corporate_action_journal
    WHERE corporate_action_id = ${corporate_action_id}
    ORDER BY occurred_at ASC
  `;
}

/**
 * Retrieves a CorporateAction state row by id.
 */
export async function getCorporateActionStateById(
  id: string,
  db: postgres.Sql = defaultSql,
): Promise<CorporateActionStateRow | null> {
  const rows = await db<CorporateActionStateRow[]>`
    SELECT id, state, effective_date, settlement_date, updated_at
    FROM mkt_corporate_actions
    WHERE id = ${id}
    LIMIT 1
  `;
  return rows[0] ?? null;
}
