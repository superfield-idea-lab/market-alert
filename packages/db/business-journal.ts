/**
 * Business journal writer and ledger replay utilities.
 *
 * DATA-D-004, DATA-C-026/027: the business journal is distinct from the audit log.
 * The audit log records access events for compliance (written by audit_w to kb_audit).
 * The business journal records consequential business operations with enough
 * information to deterministically reconstruct materialized state.
 *
 * The table is INSERT-only: no UPDATE or DELETE privileges are granted to app_rw
 * (enforced in init-remote.ts).
 *
 * TEST-D-006, TEST-C-014: ledger replay tests can rebuild materialized state from
 * journal facts.
 */

import postgres from 'postgres';

type SqlClient = postgres.Sql;

export interface JournalEvent {
  event_type: string;
  entity_id: string;
  actor_id: string;
  /** Optional opaque reference to a payload stored elsewhere (no PII inline). */
  payload_ref?: string | null;
}

export interface JournalRow extends JournalEvent {
  id: string;
  created_at: Date;
}

/**
 * Write one consequential business operation to the business_journal table.
 *
 * Called before (or as part of) each consequential operation so that if the
 * operation fails the journal row is rolled back with the outer transaction.
 *
 * No PII is stored inline; use payload_ref to reference payloads stored
 * elsewhere if needed.
 */
export async function writeJournalEvent(sql: SqlClient, event: JournalEvent): Promise<JournalRow> {
  const rows = await sql<JournalRow[]>`
    INSERT INTO business_journal (event_type, entity_id, actor_id, payload_ref)
    VALUES (
      ${event.event_type},
      ${event.entity_id},
      ${event.actor_id},
      ${event.payload_ref ?? null}
    )
    RETURNING id, event_type, entity_id, actor_id, payload_ref, created_at
  `;
  return rows[0];
}

/**
 * Replay journal events from the beginning (genesis replay).
 *
 * Fetches all rows in insertion order and applies `reducer` to build up
 * materialized state from first principles.
 *
 * TEST-C-014: genesis replay test.
 */
export async function replayFromGenesis<S>(
  sql: SqlClient,
  initialState: S,
  reducer: (state: S, event: JournalRow) => S,
): Promise<S> {
  const rows = await sql<JournalRow[]>`
    SELECT id, event_type, entity_id, actor_id, payload_ref, created_at
    FROM business_journal
    ORDER BY created_at ASC, id ASC
  `;
  return rows.reduce(reducer, initialState);
}

/**
 * Replay journal events from a checkpoint (a specific row id, inclusive).
 *
 * Useful for incremental rebuilds: fetch only events after a known-good
 * snapshot identified by `fromId`.
 *
 * TEST-C-014: checkpoint replay test.
 */
export async function replayFromCheckpoint<S>(
  sql: SqlClient,
  fromId: string,
  initialState: S,
  reducer: (state: S, event: JournalRow) => S,
): Promise<S> {
  // Resolve the created_at of the checkpoint row so we can use the index.
  const checkpointRows = await sql<{ created_at: Date }[]>`
    SELECT created_at FROM business_journal WHERE id = ${fromId}
  `;
  if (checkpointRows.length === 0) {
    throw new Error(`Checkpoint journal row not found: ${fromId}`);
  }
  const { created_at } = checkpointRows[0];

  const rows = await sql<JournalRow[]>`
    SELECT id, event_type, entity_id, actor_id, payload_ref, created_at
    FROM business_journal
    WHERE (created_at, id) >= (${created_at}, ${fromId})
    ORDER BY created_at ASC, id ASC
  `;
  return rows.reduce(reducer, initialState);
}
