/**
 * @file etl-cursors.ts
 *
 * etl_cursors data-access — per-source watermarks for incremental EDGAR ingestion.
 *
 * ## Purpose
 *
 * The EDGAR ingestion worker polls multiple form types per tick (8-K, 8-K/A,
 * SC 13D, SC 13G, S-4, 425, DEF 14A). Each form type maintains an independent
 * watermark in the etl_cursors table so the worker can fetch only new filings
 * on each poll cycle and resume safely after a restart.
 *
 * ## Schema
 *
 * See packages/db/mkt-schema.sql — the etl_cursors DDL lives there and is
 * applied by migrateMkt() on server startup.
 *
 * ## Watermark semantics
 *
 * - `watermark_value` is an ISO-8601 UTC timestamp string (may be empty string
 *   on first run, indicating no prior poll).
 * - `overlap_seconds` defines how far behind the watermark to re-check, used
 *   for amended filings (e.g. 8-K/A) so late amendments are never missed.
 * - The watermark is advanced only after the full batch for that form type is
 *   successfully POSTed to the ingestion API.
 *
 * ## Canonical docs
 *
 * - packages/db/mkt-schema.sql — etl_cursors DDL
 * - apps/server/src/api/etl-cursor.ts — GET/PUT internal API endpoints
 * - apps/worker/src/edgar-ingest-job.ts — consumer
 * - docs/architecture.md — ingestion pipeline
 */

import postgres from 'postgres';
import { sql as defaultSql } from './index';

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

/**
 * One row from etl_cursors.
 */
export interface EtlCursorRow {
  id: string;
  /** Source identifier, e.g. 'edgar'. */
  source: string;
  /** Form-type key, e.g. '8-K', '8-K/A', 'SC 13D'. */
  cursor_key: string;
  /**
   * ISO-8601 UTC string of the latest filing date seen.
   * Empty string on first run (no prior poll).
   */
  watermark_value: string;
  /**
   * Overlap window in seconds. The worker re-checks filings this far behind
   * the watermark to catch late-filed amendments. 0 = no overlap.
   */
  overlap_seconds: number;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Upsert options
// ---------------------------------------------------------------------------

export interface UpsertEtlCursorOptions {
  source: string;
  cursor_key: string;
  watermark_value: string;
  overlap_seconds?: number;
  sql?: postgres.Sql;
}

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

/**
 * Returns the current watermark for a (source, cursor_key) pair.
 * Returns null when no row exists (first run for this form type).
 */
export async function getEtlCursor(
  source: string,
  cursor_key: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<EtlCursorRow | null> {
  const rows = await sqlClient<EtlCursorRow[]>`
    SELECT * FROM etl_cursors
    WHERE source = ${source} AND cursor_key = ${cursor_key}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Upsert (advance watermark)
// ---------------------------------------------------------------------------

/**
 * Inserts or updates the watermark for a (source, cursor_key) pair.
 *
 * On conflict (source, cursor_key), updates watermark_value and updated_at.
 * The overlap_seconds column is only set on INSERT and left unchanged on UPDATE
 * — to change overlap_seconds, delete and re-insert the row.
 *
 * Returns the resulting row.
 */
export async function upsertEtlCursor(options: UpsertEtlCursorOptions): Promise<EtlCursorRow> {
  const {
    source,
    cursor_key,
    watermark_value,
    overlap_seconds = 0,
    sql: sqlClient = defaultSql,
  } = options;

  const rows = await sqlClient<EtlCursorRow[]>`
    INSERT INTO etl_cursors (source, cursor_key, watermark_value, overlap_seconds)
    VALUES (${source}, ${cursor_key}, ${watermark_value}, ${overlap_seconds})
    ON CONFLICT (source, cursor_key)
    DO UPDATE SET
      watermark_value = EXCLUDED.watermark_value,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *
  `;
  return rows[0];
}
