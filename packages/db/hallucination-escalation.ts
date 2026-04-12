/**
 * @file hallucination-escalation.ts
 *
 * Hallucination escalation counter for the autolearn publication gate.
 *
 * When an annotation is dismissed (DISMISSED state) the caller records the
 * dismissal via `recordDismissal()`.  A rolling 30-day window query then
 * determines whether the next autolearn draft for that customer must be forced
 * into explicit-approval mode.
 *
 * ## Escalation rule (PRD §9 / issue #67)
 *
 * - Three or more dismissals within the last 30 days → `requiresEscalation = true`.
 * - Dismissals outside the 30-day window do not count.
 * - The flag clears automatically as soon as the oldest qualifying dismissal
 *   rolls out of the window — no explicit reset is needed.
 *
 * ## Schema
 *
 * `annotation_dismissal_log` — one row per DISMISSED annotation.
 *
 * ```
 * CREATE TABLE annotation_dismissal_log (
 *   id            TEXT PRIMARY KEY,
 *   customer_id   TEXT NOT NULL,
 *   annotation_id TEXT NOT NULL,
 *   dismissed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
 * );
 * ```
 *
 * Blueprint refs: issue #67, PRD §9.
 */

import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

/**
 * DDL that creates the `annotation_dismissal_log` table if it does not exist.
 *
 * Safe to call on a database that already has this table (idempotent).
 */
export const ESCALATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS annotation_dismissal_log (
    id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    customer_id   TEXT NOT NULL,
    annotation_id TEXT NOT NULL,
    dismissed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_annotation_dismissal_log_customer_dismissed
    ON annotation_dismissal_log (customer_id, dismissed_at DESC);
`;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default rolling window length in days (PRD §9). */
export const DEFAULT_WINDOW_DAYS = 30;

/** Default dismissal threshold that triggers escalation (PRD §9). */
export const DEFAULT_ESCALATION_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SqlClient = postgres.Sql;

/** A single row in `annotation_dismissal_log`. */
export interface DismissalLogRow {
  id: string;
  customer_id: string;
  annotation_id: string;
  dismissed_at: Date;
}

/** Input to `recordDismissal()`. */
export interface RecordDismissalInput {
  /** The customer whose annotation was dismissed. */
  customerId: string;
  /** The annotation thread that was dismissed. */
  annotationId: string;
  /**
   * Timestamp of the dismissal.  Defaults to `NOW()` when omitted.
   * Explicitly provide this when backfilling or in tests where you need
   * deterministic timestamps.
   */
  dismissedAt?: Date;
}

// ---------------------------------------------------------------------------
// Schema migration helper
// ---------------------------------------------------------------------------

/**
 * Applies `ESCALATION_SCHEMA_SQL` to the given database.
 * Idempotent — safe to call on a database that already has the table.
 */
export async function migrateEscalationSchema(sql: SqlClient): Promise<void> {
  const statements = ESCALATION_SCHEMA_SQL.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await sql.unsafe(stmt);
  }
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/**
 * Records a dismissal event for the given customer and annotation.
 *
 * Called whenever an annotation transitions to `DISMISSED` so that the
 * rolling 30-day window can be queried without joining through annotation
 * threads or wiki page versions.
 *
 * @returns The newly inserted log row.
 */
export async function recordDismissal(
  sql: SqlClient,
  input: RecordDismissalInput,
): Promise<DismissalLogRow> {
  const { customerId, annotationId, dismissedAt } = input;

  if (dismissedAt !== undefined) {
    const [row] = await sql<DismissalLogRow[]>`
      INSERT INTO annotation_dismissal_log (customer_id, annotation_id, dismissed_at)
      VALUES (${customerId}, ${annotationId}, ${dismissedAt})
      RETURNING id, customer_id, annotation_id, dismissed_at
    `;
    return row;
  }

  const [row] = await sql<DismissalLogRow[]>`
    INSERT INTO annotation_dismissal_log (customer_id, annotation_id, dismissed_at)
    VALUES (${customerId}, ${annotationId}, NOW())
    RETURNING id, customer_id, annotation_id, dismissed_at
  `;
  return row;
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

/**
 * Counts the number of dismissals for a customer within the rolling window.
 *
 * @param sql        Postgres client.
 * @param customerId Customer to query.
 * @param windowDays Rolling window length in days.  Defaults to 30.
 * @returns          Number of dismissals within the window.
 */
export async function countDismissalsInWindow(
  sql: SqlClient,
  customerId: string,
  windowDays: number = DEFAULT_WINDOW_DAYS,
): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::TEXT AS count
    FROM annotation_dismissal_log
    WHERE customer_id  = ${customerId}
      AND dismissed_at >= NOW() - (${windowDays} || ' days')::INTERVAL
  `;
  return parseInt(row.count, 10);
}

/**
 * Returns `true` when the customer has reached the escalation threshold within
 * the rolling window — meaning the next autolearn draft must be placed in
 * explicit-approval mode regardless of its materiality score.
 *
 * @param sql       Postgres client.
 * @param customerId Customer to check.
 * @param windowDays Rolling window in days.  Defaults to `DEFAULT_WINDOW_DAYS` (30).
 * @param threshold  Dismissal count that triggers escalation.  Defaults to
 *                   `DEFAULT_ESCALATION_THRESHOLD` (3).
 */
export async function customerRequiresEscalation(
  sql: SqlClient,
  customerId: string,
  windowDays: number = DEFAULT_WINDOW_DAYS,
  threshold: number = DEFAULT_ESCALATION_THRESHOLD,
): Promise<boolean> {
  const count = await countDismissalsInWindow(sql, customerId, windowDays);
  return count >= threshold;
}
