/**
 * @file mkt-market-event-store.ts
 *
 * DB access layer for the event-ingestion pipeline — Phase 6 dev-scout (issue #80).
 *
 * ## Status: dev-scout stub
 *
 * Defines the `raw_filings` and `market_events` table row types, and the
 * function signatures for:
 *   - `insertRawFiling`        — idempotent landing of one EDGAR filing
 *   - `markFilingNormalized`   — transition raw_filing status to 'normalized'
 *   - `insertMarketEvent`      — create one normalized market_event from a filing
 *   - `getRawFilingByIdempotencyKey` — look up a raw_filing by key
 *   - `getMarketEventByRawFilingId` — look up the market_event for a raw filing
 *
 * No real business logic is implemented here — this file exists to:
 *   1. Confirm the schema and types compile without error.
 *   2. Give the POST /internal/event-ingestion handler a typed seam.
 *   3. Document integration points for follow-on Phase 6 issues.
 *
 * ## Schema design
 *
 * `raw_filings` — one row per unique EDGAR filing payload. Idempotency key:
 *   `edgar_poll:<form_type>:<accession_number>`.
 *   ON CONFLICT (idempotency_key) DO NOTHING enforces idempotency.
 *   raw_payload stores AES-256-GCM ciphertext (never plaintext XML).
 *
 * `market_events` — one normalized catalyst event per real-world event.
 *   Created from a raw_filing row after the payload is parsed.
 *   Linked to raw_filings via raw_filing_id.
 *   State machine: Expected → Detected → Enriched → Evaluated → Closed.
 *   Disputed and PassedSilently are terminal branches for follow-on issues.
 *
 * ## Watermark semantics (land-before-advance)
 *
 * The etl_cursors watermark for a given EDGAR form type is advanced only
 * AFTER a durable INSERT into raw_filings. The sequence is:
 *   1. INSERT into raw_filings (durable write).
 *   2. INSERT into market_events (or enqueue EVENT_EVALUATE task).
 *   3. PUT /internal/etl/cursor/edgar/:formType (watermark advance).
 *
 * If the process crashes after step 1 but before step 3, the same filing is
 * re-fetched on the next poll and hits ON CONFLICT DO NOTHING (idempotent).
 * The market_event creation in step 2 also uses ON CONFLICT DO NOTHING on
 * (raw_filing_id) to prevent duplicates.
 *
 * ## Integration points discovered during scout
 *
 * 1. `packages/db/mkt-schema.sql` — DDL for `raw_filings` and `market_events`
 *    added in this scout. The follow-on implementation issue must verify
 *    `migrateMkt()` applies these tables before the ingestion handler runs.
 *
 * 2. `packages/db/task-queue.ts` — `EVENT_EVALUATE` task type added in this
 *    scout. Payload shape: `{ market_event_id: string }`.
 *
 * 3. `apps/server/src/api/event-ingestion.ts` (stub; follow-on) — internal
 *    API endpoint called by the EDGAR_POLL worker. Receives the raw filing XML,
 *    encrypts it, calls `insertRawFiling`, creates a `market_event`, and enqueues
 *    an `EVENT_EVALUATE` task. The watermark PUT is the final step (land-before-advance).
 *
 * 4. `apps/worker/src/edgar-ingest-job.ts` — existing EDGAR_POLL job. The
 *    follow-on implementation will route through the new
 *    POST /internal/event-ingestion endpoint instead of the legacy
 *    POST /internal/ingestion/corporate-action endpoint. Both endpoints
 *    must remain live during the migration window.
 *
 * 5. Cross-venue dedup (follow-on Phase 6 issue) — the composite identity key
 *    (subject_entity_id, event_type, event_date) on market_events supports
 *    collapsing wire-leading + filing-trailing events to one market_event row.
 *    The dedup logic belongs in the follow-on CROSS_VENUE_DEDUP task handler.
 *
 * 6. Silent-passage detection (follow-on Phase 6 issue) — anticipated catalysts
 *    are registered as market_events with status 'Expected'. The detection
 *    worker transitions them to 'PassedSilently' when the anticipated window
 *    closes with no 'Detected' event.
 *
 * ## Encryption
 *
 * `raw_payload` must never store plaintext. The API handler encrypts the filing
 * XML using `encryptField` from `packages/core/encryption.ts` with sensitivity
 * class 'HIGH' and entity type 'raw_filing'. The follow-on implementation issue
 * must add 'raw_filing' to `ENTITY_SENSITIVITY_CLASS` in that file.
 *
 * ## Zero PII constraint (TQ-P-002, TQ-C-004)
 *
 * No trader-visible PII may appear in task payloads referencing market_events.
 * The EVENT_EVALUATE payload carries only `market_event_id` (UUID).
 *
 * ## Canonical docs
 *
 * - docs/architecture.md § "Market-event feed"
 * - docs/architecture.md § "Catalyst event state machine"
 * - docs/prd.md §9 — event evaluation latency constraint
 * - packages/db/mkt-schema.sql — DDL for raw_filings and market_events
 * - packages/db/task-queue.ts — EVENT_EVALUATE task type
 * - packages/db/etl-cursors.ts — watermark read/write primitives
 * - apps/worker/src/edgar-ingest-job.ts — EDGAR_POLL job (existing)
 * - tests/integration/event-ingestion.spec.ts — integration test (this scout)
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/80
 */

import type postgres from 'postgres';

export type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// State machine types
// ---------------------------------------------------------------------------

/**
 * Status values for the `raw_filings` table.
 *
 * - `raw`         — landed but not yet turned into a market_event
 * - `normalized`  — a market_event row has been created from this filing
 * - `quarantined` — malformed payload; moved to etl_quarantine
 */
export type RawFilingStatus = 'raw' | 'normalized' | 'quarantined';

/**
 * Status values for the `market_events` state machine.
 *
 * State machine: Expected → Detected → Enriched → Evaluated → Closed
 * Terminal branches: Disputed, PassedSilently (Phase 6 follow-on issues)
 */
export type MarketEventStatus =
  | 'Expected'
  | 'Detected'
  | 'Enriched'
  | 'Evaluated'
  | 'Closed'
  | 'Disputed'
  | 'PassedSilently';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/**
 * TypeScript representation of a `raw_filings` row.
 *
 * `raw_payload` stores AES-256-GCM ciphertext — never plaintext XML.
 */
export interface RawFilingRow {
  id: string;
  idempotency_key: string;
  source: string;
  form_type: string;
  accession_number: string;
  cik: string;
  issuer_name: string | null;
  filing_date: Date;
  /** AES-256-GCM ciphertext. Never plaintext. */
  raw_payload: string;
  status: RawFilingStatus;
  created_at: Date;
  updated_at: Date;
}

/**
 * TypeScript representation of a `market_events` row.
 *
 * Normalized catalyst event. One row per real-world event.
 * Cross-venue dedup (follow-on) collapses duplicate events from different
 * venues into a single row via the composite identity key
 * (subject_entity_id, event_type, event_date).
 */
export interface MarketEventRow {
  id: string;
  raw_filing_id: string | null;
  source: string;
  event_type: string;
  subject_entity_id: string | null;
  subject_entity_type: string;
  event_date: Date;
  description: string | null;
  status: MarketEventStatus;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Insert option types
// ---------------------------------------------------------------------------

/**
 * Options for inserting one raw filing into `raw_filings`.
 *
 * Idempotency key format: `edgar_poll:<form_type>:<accession_number>`
 */
export interface InsertRawFilingOptions {
  idempotency_key: string;
  source?: string;
  form_type: string;
  accession_number: string;
  cik: string;
  issuer_name?: string | null;
  filing_date: Date;
  /** Must be AES-256-GCM ciphertext from packages/core/encryption.ts. */
  raw_payload_encrypted: string;
  sql?: SqlClient;
}

/**
 * Options for inserting one normalized market event into `market_events`.
 */
export interface InsertMarketEventOptions {
  raw_filing_id: string;
  source?: string;
  event_type: string;
  subject_entity_id?: string | null;
  subject_entity_type?: string;
  event_date: Date;
  description?: string | null;
  status?: MarketEventStatus;
  sql?: SqlClient;
}

// ---------------------------------------------------------------------------
// Data access stubs
// ---------------------------------------------------------------------------

/**
 * Inserts one raw filing into `raw_filings`.
 *
 * Uses ON CONFLICT (idempotency_key) DO NOTHING so that replaying the same
 * EDGAR filing on a worker retry never creates a duplicate row.
 *
 * Returns the inserted row, or null if the row already existed (conflict case).
 *
 * DEV-SCOUT STUB: function signature and contract are correct. The follow-on
 * implementation issue owns the call-site wiring in the event-ingestion API
 * handler. No implementation body needed for the scout to compile and test.
 *
 * @throws Error if the database write fails for any reason other than a
 *   duplicate idempotency key.
 */
export async function insertRawFiling(
  options: InsertRawFilingOptions,
): Promise<RawFilingRow | null> {
  const {
    idempotency_key,
    source = 'edgar',
    form_type,
    accession_number,
    cik,
    issuer_name = null,
    filing_date,
    raw_payload_encrypted,
    sql,
  } = options;

  if (!sql) {
    throw new Error('[mkt-market-event-store] sql client is required for insertRawFiling');
  }

  const rows = await sql<RawFilingRow[]>`
    INSERT INTO raw_filings
      (idempotency_key, source, form_type, accession_number, cik,
       issuer_name, filing_date, raw_payload)
    VALUES
      (${idempotency_key}, ${source}, ${form_type}, ${accession_number},
       ${cik}, ${issuer_name}, ${filing_date.toISOString()}, ${raw_payload_encrypted})
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING *
  `;
  return rows[0] ?? null;
}

/**
 * Transitions a raw filing from `raw` to `normalized` status.
 *
 * Called after a market_event has been successfully created from the filing.
 * This is the second step in the land-before-advance watermark sequence.
 *
 * DEV-SCOUT STUB: function signature is correct. Follow-on implementation owns
 * the call site.
 */
export async function markFilingNormalized(
  rawFilingId: string,
  sqlClient: SqlClient,
): Promise<void> {
  await sqlClient`
    UPDATE raw_filings
    SET status = 'normalized', updated_at = NOW()
    WHERE id = ${rawFilingId}
      AND status = 'raw'
  `;
}

/**
 * Inserts one normalized market event into `market_events`.
 *
 * Uses ON CONFLICT (raw_filing_id) DO NOTHING to prevent creating a second
 * market_event if the same raw filing is processed twice (idempotent).
 *
 * Returns the inserted row, or null if the row already existed.
 *
 * DEV-SCOUT STUB: function signature and ON CONFLICT contract are correct.
 * Follow-on implementation owns the call site.
 *
 * @throws Error if the database write fails.
 */
export async function insertMarketEvent(
  options: InsertMarketEventOptions,
): Promise<MarketEventRow | null> {
  const {
    raw_filing_id,
    source = 'edgar',
    event_type,
    subject_entity_id = null,
    subject_entity_type = 'company',
    event_date,
    description = null,
    status = 'Detected',
    sql,
  } = options;

  if (!sql) {
    throw new Error('[mkt-market-event-store] sql client is required for insertMarketEvent');
  }

  const rows = await sql<MarketEventRow[]>`
    INSERT INTO market_events
      (raw_filing_id, source, event_type, subject_entity_id,
       subject_entity_type, event_date, description, status)
    VALUES
      (${raw_filing_id}, ${source}, ${event_type}, ${subject_entity_id},
       ${subject_entity_type}, ${event_date.toISOString()}, ${description}, ${status})
    ON CONFLICT (raw_filing_id) DO NOTHING
    RETURNING *
  `;
  return rows[0] ?? null;
}

/**
 * Retrieves a raw_filing row by its idempotency key.
 *
 * Returns null when no row exists (first-time filing).
 *
 * DEV-SCOUT STUB: function signature is correct. Follow-on implementation owns
 * the call site.
 */
export async function getRawFilingByIdempotencyKey(
  idempotency_key: string,
  sqlClient: SqlClient,
): Promise<RawFilingRow | null> {
  const rows = await sqlClient<RawFilingRow[]>`
    SELECT * FROM raw_filings
    WHERE idempotency_key = ${idempotency_key}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Retrieves the market_event created from a given raw filing.
 *
 * Returns null when no market_event row exists yet.
 *
 * DEV-SCOUT STUB: function signature is correct. Follow-on implementation owns
 * the call site.
 */
export async function getMarketEventByRawFilingId(
  raw_filing_id: string,
  sqlClient: SqlClient,
): Promise<MarketEventRow | null> {
  const rows = await sqlClient<MarketEventRow[]>`
    SELECT * FROM market_events
    WHERE raw_filing_id = ${raw_filing_id}
    LIMIT 1
  `;
  return rows[0] ?? null;
}
