/**
 * @file signal-reviewer-store.ts
 *
 * Reviewer queue data-access layer — issue #83.
 *
 * ## Reviewer queue (PRD §5, §9; architecture §"Signal routing")
 *
 * Below-threshold signals are routed to the Reviewer queue (status `Queued`).
 * The Reviewer role (`signals:review`, `signals:suppress`) may:
 *   - **Approve** — advance the signal from Queued → Delivered as-is.
 *   - **Edit and approve** — patch the rationale on the signal, then advance
 *     Queued → Delivered.
 *   - **Suppress** — advance the signal from Queued → Suppressed.
 *
 * Every triage action writes a journal entry to `business_journal` inside the
 * same transaction as the status transition, so the transition and its audit
 * record are always durable together.
 *
 * ## Journal event types
 *
 *   - `signal.reviewer.approved`  — Reviewer approved; signal → Delivered.
 *   - `signal.reviewer.edited`    — Reviewer edited rationale; signal → Delivered.
 *   - `signal.reviewer.suppressed`— Reviewer suppressed; signal → Suppressed.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5, §9 — signal routing, confidence, reviewer queue
 * - docs/architecture.md §"Signal routing" — Reviewer role and journal entries
 * - packages/db/signal-store.ts — signal row types and state machine
 * - packages/db/business-journal.ts — journal writer
 * - apps/server/src/api/reviewer-api.ts — HTTP surface
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/83
 */

import type postgres from 'postgres';
import { transitionSignalStatus, getSignalById, type SignalRow } from './signal-store';

export type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// Reviewer queue query
// ---------------------------------------------------------------------------

/**
 * Options for listing queued signals.
 */
export interface ListQueuedSignalsOptions {
  sql: SqlClient;
  tenant_id: string;
  researcher_id: string;
  /** Maximum number of rows to return. Defaults to 50. */
  limit?: number;
}

/**
 * Returns all signals in `Queued` status for the given researcher, ordered
 * by creation time (oldest first — FIFO review order).
 *
 * Architecture ref: docs/architecture.md §"Signal routing"
 */
export async function listQueuedSignals(options: ListQueuedSignalsOptions): Promise<SignalRow[]> {
  const { sql, tenant_id, researcher_id, limit = 50 } = options;

  return sql<SignalRow[]>`
    SELECT id, tenant_id, researcher_id, market_event_id, standing_prompt_version_id,
           idempotency_key, rationale, source_trust, extraction_certainty, status,
           created_at, updated_at
    FROM signals
    WHERE tenant_id     = ${tenant_id}
      AND researcher_id = ${researcher_id}
      AND status        = 'Queued'
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;
}

// ---------------------------------------------------------------------------
// Journal helpers (private)
// ---------------------------------------------------------------------------

/**
 * Journal event types for reviewer triage actions.
 * Architecture ref: docs/architecture.md §"Signal routing"
 */
const JOURNAL_EVENT_TYPES = {
  approved: 'signal.reviewer.approved',
  edited: 'signal.reviewer.edited',
  suppressed: 'signal.reviewer.suppressed',
} as const;

type JournalEventType = (typeof JOURNAL_EVENT_TYPES)[keyof typeof JOURNAL_EVENT_TYPES];

interface WriteJournalArgs {
  tx: SqlClient;
  event_type: JournalEventType;
  signal_id: string;
  reviewer_id: string;
}

async function writeSignalJournalEntry(args: WriteJournalArgs): Promise<void> {
  const { tx, event_type, signal_id, reviewer_id } = args;
  await tx`
    INSERT INTO business_journal (event_type, entity_id, actor_id, payload_ref)
    VALUES (${event_type}, ${signal_id}, ${reviewer_id}, ${null})
  `;
}

// ---------------------------------------------------------------------------
// Triage actions
// ---------------------------------------------------------------------------

/**
 * Approve a queued signal: Queued → Delivered.
 *
 * Writes a `signal.reviewer.approved` journal entry inside the same
 * transaction as the status transition.
 *
 * Returns the updated signal row, or null if the signal was not found or
 * was not in `Queued` status (concurrent triage).
 *
 * Architecture ref: docs/architecture.md §"Signal routing"
 * PRD ref: §5 — "Reviewer queue; advances to Delivered only on Reviewer approval"
 */
export async function approveQueuedSignal(
  signal_id: string,
  reviewer_id: string,
  sqlClient: SqlClient,
): Promise<SignalRow | null> {
  return sqlClient.begin(async (txRaw) => {
    const tx = txRaw as unknown as SqlClient;

    const updated = await transitionSignalStatus(signal_id, 'Queued', 'Delivered', tx);
    if (!updated) return null;

    await writeSignalJournalEntry({
      tx,
      event_type: JOURNAL_EVENT_TYPES.approved,
      signal_id,
      reviewer_id,
    });

    return updated;
  }) as Promise<SignalRow | null>;
}

/**
 * Edit the rationale of a queued signal and approve it: Queued → Delivered.
 *
 * Patches the `rationale` field on the signal row, then transitions its status.
 * Writes a `signal.reviewer.edited` journal entry inside the same transaction.
 *
 * Returns the updated signal row, or null if the signal was not found or
 * was not in `Queued` status (concurrent triage).
 *
 * Architecture ref: docs/architecture.md §"Signal routing"
 * PRD ref: §5 — "Reviewer approves, edits, or suppresses"
 */
export async function editAndApproveQueuedSignal(
  signal_id: string,
  new_rationale: string,
  reviewer_id: string,
  sqlClient: SqlClient,
): Promise<SignalRow | null> {
  return sqlClient.begin(async (txRaw) => {
    const tx = txRaw as unknown as SqlClient;

    // Patch the rationale first (only if signal is still Queued).
    const patched = await tx<SignalRow[]>`
      UPDATE signals
      SET rationale  = ${new_rationale},
          updated_at = NOW()
      WHERE id     = ${signal_id}
        AND status = 'Queued'
      RETURNING id, tenant_id, researcher_id, market_event_id, standing_prompt_version_id,
                idempotency_key, rationale, source_trust, extraction_certainty, status,
                created_at, updated_at
    `;
    if (patched.length === 0) return null;

    // Transition Queued → Delivered.
    const updated = await transitionSignalStatus(signal_id, 'Queued', 'Delivered', tx);
    if (!updated) return null;

    await writeSignalJournalEntry({
      tx,
      event_type: JOURNAL_EVENT_TYPES.edited,
      signal_id,
      reviewer_id,
    });

    // Re-fetch to get the final state with the patched rationale.
    return getSignalById(signal_id, tx);
  }) as Promise<SignalRow | null>;
}

/**
 * Suppress a queued signal: Queued → Suppressed.
 *
 * Writes a `signal.reviewer.suppressed` journal entry inside the same
 * transaction as the status transition.
 *
 * Returns the updated signal row, or null if the signal was not found or
 * was not in `Queued` status (concurrent triage).
 *
 * Architecture ref: docs/architecture.md §"Signal routing"
 * PRD ref: §5 — "Reviewer suppresses"
 */
export async function suppressQueuedSignal(
  signal_id: string,
  reviewer_id: string,
  sqlClient: SqlClient,
): Promise<SignalRow | null> {
  return sqlClient.begin(async (txRaw) => {
    const tx = txRaw as unknown as SqlClient;

    const updated = await transitionSignalStatus(signal_id, 'Queued', 'Suppressed', tx);
    if (!updated) return null;

    await writeSignalJournalEntry({
      tx,
      event_type: JOURNAL_EVENT_TYPES.suppressed,
      signal_id,
      reviewer_id,
    });

    return updated;
  }) as Promise<SignalRow | null>;
}
