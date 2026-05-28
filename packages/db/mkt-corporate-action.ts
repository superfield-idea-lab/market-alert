/**
 * @file mkt-corporate-action.ts
 *
 * CorporateAction entity DDL and data-access stubs — Phase 2 dev-scout (issue #14).
 *
 * ## Status: dev-scout stub
 *
 * Defines the `mkt_corporate_actions` table schema (idempotent DDL), the
 * TypeScript row type, and the `insertCorporateAction` / `getCorporateAction`
 * function signatures. No real business logic is implemented here — this file
 * exists to:
 *
 *   1. Confirm the schema compiles and migrates without error.
 *   2. Give the POST /internal/ingestion/corporate-action handler a typed seam.
 *   3. Document integration points for follow-on Phase 2 issues.
 *
 * ## Schema design
 *
 * `mkt_corporate_actions` lives in the `mkt_app` schema alongside
 * `mkt_feature_flags`. It stores one row per unique EDGAR filing
 * (idempotency key: `edgar:<accession_number>`).
 *
 * Columns:
 *   id                  — UUID primary key (gen_random_uuid())
 *   idempotency_key     — stable de-dup key; UNIQUE; edgar:<accession_number>
 *   form_type           — EDGAR form type, e.g. '8-K'
 *   accession_number    — normalised EDGAR accession number (with dashes)
 *   cik                 — CIK of the reporting entity (string, no leading zeros)
 *   issuer_name         — display name of the issuer (may be null before enrichment)
 *   filing_date         — UTC timestamp of the EDGAR filing
 *   filing_text         — AES-256-GCM encrypted raw filing entry text (ciphertext)
 *   status              — corporate action state machine status (initial: 'raw')
 *   created_at          — row insert timestamp
 *   updated_at          — last-modified timestamp (set by trigger or application)
 *
 * ## Encryption
 *
 * `filing_text` must never store plaintext (acceptance criterion: "CorporateAction
 * .filing_text column contains ciphertext, not plaintext"). The ingestion handler
 * uses `encryptField` from `packages/core/encryption.ts` with sensitivity class
 * 'HIGH' and entity type 'corporate_action' before inserting.
 *
 * `encryptField` is already available in `packages/core/encryption.ts`. The
 * follow-on implementation issue must add 'corporate_action' to the
 * `ENTITY_SENSITIVITY_CLASS` map in that file.
 *
 * ## Zero PII constraint
 *
 * No trader-visible PII may appear in any column. Specifically:
 *   - `issuer_name` is the legal company name (public EDGAR data), not a person name.
 *   - `payload` columns in task_queue rows referencing this entity must contain
 *     only the corporate_action UUID, not any email/phone/name fields.
 *
 * ## Integration points discovered during scout
 *
 * 1. `mkt-schema.sql` — the DDL for `mkt_corporate_actions` must be added to
 *    `packages/db/mkt-schema.sql` (executed by `migrate()` in packages/db/index.ts).
 *    The DDL is defined below in the `CORPORATE_ACTION_DDL` constant and is
 *    executed by `migrateCorporateActions()`.
 *
 * 2. `packages/core/encryption.ts` — 'corporate_action' entity type must be
 *    added to ENTITY_SENSITIVITY_CLASS with class 'HIGH'. The follow-on issue
 *    must also add 'corporate_action' to the EntityType union in
 *    `packages/core/types.ts`.
 *
 * 3. `packages/db/index.ts` (migrate function) — must call
 *    `migrateCorporateActions()` so the table exists before the ingestion
 *    handler runs. The follow-on implementation issue owns this wiring.
 *
 * 4. `POST /internal/ingestion/corporate-action` — the API handler
 *    (apps/server/src/api/corporate-action-ingestion.ts) calls
 *    `insertCorporateAction()` from this file. The seam is defined but the
 *    implementation is a stub throw.
 *
 * 5. ALERT_ENRICH enqueue — after inserting the CorporateAction row the API
 *    handler must call `enqueueTask` with `TaskType.ALERT_ENRICH`. The
 *    payload must contain only `corporate_action_id` (UUID). The follow-on
 *    implementation issue owns this call.
 *
 * ## Canonical docs
 *
 * - docs/architecture.md — ingestion pipeline
 * - docs/plan.md — Phase 2 scope
 * - blueprint: data.yaml § DATA-D-004 (append-only audit)
 * - blueprint: worker.yaml § WORKER-P-001 (API-gateway sole writer)
 * - packages/db/mkt-schema.sql — existing mkt_app DDL
 * - packages/db/task-queue.ts — TaskType.ALERT_ENRICH, enqueueTask
 * - packages/core/encryption.ts — encryptField, SensitivityClass
 */

import postgres from 'postgres';
import { sql as defaultSql } from './index';

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

/**
 * Idempotent DDL for the `mkt_corporate_actions` table.
 *
 * DEV-SCOUT NOTE: This DDL is executed by `migrateCorporateActions()` below.
 * The follow-on implementation issue must wire that call into the `migrate()`
 * function in `packages/db/index.ts` so it runs on server startup.
 */
export const CORPORATE_ACTION_DDL = `
-- ---------------------------------------------------------------------------
-- mkt_corporate_actions — one row per unique EDGAR filing
-- ---------------------------------------------------------------------------
--
-- Blueprint refs:
--   DATA-D-006 (four-pool Postgres)
--   DATA-D-004 (append-only audit store — CorporateAction rows are immutable
--               after insert; state transitions happen via the state machine
--               in CORP_ACTION_ADVANCE tasks, not direct UPDATE)
--
-- Encryption: filing_text stores AES-256-GCM ciphertext produced by
--   packages/core/encryption.ts encryptField('corporate_action', 'HIGH', ...).
--
CREATE TABLE IF NOT EXISTS mkt_corporate_actions (
  id                TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  idempotency_key   TEXT        NOT NULL UNIQUE,
  form_type         TEXT        NOT NULL,
  accession_number  TEXT        NOT NULL,
  cik               TEXT        NOT NULL,
  issuer_name       TEXT,
  filing_date       TIMESTAMPTZ NOT NULL,
  filing_text       TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'raw',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mkt_ca_idempotency
  ON mkt_corporate_actions (idempotency_key);

CREATE INDEX IF NOT EXISTS idx_mkt_ca_status
  ON mkt_corporate_actions (status, created_at);
` as const;

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

/**
 * TypeScript representation of a `mkt_corporate_actions` row.
 *
 * DEV-SCOUT NOTE: The `filing_text` field stores ciphertext, not plaintext
 * XML. Callers must never assume it is human-readable.
 */
export interface CorporateActionRow {
  id: string;
  idempotency_key: string;
  form_type: string;
  accession_number: string;
  cik: string;
  issuer_name: string | null;
  filing_date: Date;
  /** AES-256-GCM ciphertext. Never plaintext. */
  filing_text: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Insert options
// ---------------------------------------------------------------------------

export interface InsertCorporateActionOptions {
  idempotency_key: string;
  form_type: string;
  accession_number: string;
  cik: string;
  issuer_name?: string | null;
  filing_date: Date;
  /** Must be AES-256-GCM ciphertext from packages/core/encryption.ts. */
  filing_text_encrypted: string;
  sql?: postgres.Sql;
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Runs the `mkt_corporate_actions` DDL migration idempotently.
 *
 * DEV-SCOUT STUB: The DDL is correct and this function compiles, but the call
 * site in `packages/db/index.ts` does not yet exist. The follow-on
 * implementation issue must add:
 *
 *   import { migrateCorporateActions } from 'db/mkt-corporate-action';
 *   // ... inside migrate():
 *   await migrateCorporateActions();
 */
export async function migrateCorporateActions(db: postgres.Sql = defaultSql): Promise<void> {
  await db.unsafe(CORPORATE_ACTION_DDL);
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

/**
 * Inserts one CorporateAction row.
 *
 * Uses ON CONFLICT (idempotency_key) DO NOTHING for idempotency so that
 * replaying the same EDGAR filing twice never creates a duplicate row.
 *
 * DEV-SCOUT STUB: This function signature and the ON CONFLICT contract are
 * correct. The follow-on implementation issue must wire this into the
 * POST /internal/ingestion/corporate-action handler.
 *
 * @throws Error — if the database write fails for a reason other than a
 *   duplicate idempotency key.
 */
export async function insertCorporateAction(
  options: InsertCorporateActionOptions,
): Promise<CorporateActionRow | null> {
  const {
    idempotency_key,
    form_type,
    accession_number,
    cik,
    issuer_name = null,
    filing_date,
    filing_text_encrypted,
    sql: sqlClient = defaultSql,
  } = options;

  // ON CONFLICT (idempotency_key) DO NOTHING ensures idempotency — replaying
  // the same EDGAR filing twice never creates a duplicate row. Returns null
  // when the row already exists (conflict case).
  const rows = await sqlClient<CorporateActionRow[]>`
    INSERT INTO mkt_corporate_actions
      (idempotency_key, form_type, accession_number, cik, issuer_name,
       filing_date, filing_text)
    VALUES
      (${idempotency_key}, ${form_type}, ${accession_number}, ${cik},
       ${issuer_name}, ${filing_date.toISOString()}, ${filing_text_encrypted})
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING *
  `;
  return rows[0] ?? null;
}

/**
 * Retrieves a CorporateAction row by its idempotency key.
 *
 * DEV-SCOUT STUB: returns null always; the follow-on implementation must
 * replace this with a real SELECT.
 */
export async function getCorporateActionByIdempotencyKey(
  idempotency_key: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<CorporateActionRow | null> {
  const rows = await sqlClient<CorporateActionRow[]>`
    SELECT * FROM mkt_corporate_actions
    WHERE idempotency_key = ${idempotency_key}
    LIMIT 1
  `;
  return rows[0] ?? null;
}
