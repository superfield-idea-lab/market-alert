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
 * Cross-venue dedup (issue #81) collapses duplicate events from different
 * venues into a single row via the composite identity key
 * (subject_entity_id, event_type, event_date window).
 *
 * `anticipated_window_close` is set for Expected events with a known
 * anticipated catalyst window. The SILENT_PASSAGE_CHECK worker transitions
 * Expected events to PassedSilently when the window closes with no Detected
 * event (PRD §9 latency target: ≤ 15 min of window close).
 */
export interface MarketEventRow {
  id: string;
  raw_filing_id: string | null;
  source: string;
  event_type: string;
  subject_entity_id: string | null;
  subject_entity_type: string;
  event_date: Date;
  /** ISO-8601 UTC close of the anticipated catalyst window. Null for non-Expected events. */
  anticipated_window_close: Date | null;
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
  /**
   * Close of the anticipated catalyst window. Set only for Expected events.
   * The SILENT_PASSAGE_CHECK worker uses this to detect silent passage.
   * PRD §9 latency target: ≤ 15 min after anticipated_window_close.
   */
  anticipated_window_close?: Date | null;
  description?: string | null;
  status?: MarketEventStatus;
  sql?: SqlClient;
}

// ---------------------------------------------------------------------------
// Composite identity query types (cross-venue dedup — issue #81)
// ---------------------------------------------------------------------------

/**
 * Options for finding an existing market_event by composite identity.
 *
 * The composite identity (subject_entity_id, event_type, event_date window)
 * is used to collapse the same real-world event arriving via different venues
 * (e.g. wire lead + later filing) into a single market_event row.
 *
 * The event_date window is defined by the dedup window in seconds. The query
 * returns the best-matching existing event within ±window_seconds of event_date.
 *
 * PRD §9: "A single real-world event arriving via different venues must collapse
 * to one event. Deduplication uses a composite identity (subject entity, event
 * type, anticipated date window) and tolerates lag between venues."
 */
export interface FindByCompositeIdentityOptions {
  subject_entity_id: string;
  event_type: string;
  event_date: Date;
  /**
   * Window in seconds around event_date to search for matching events.
   * Default: 86400 (24 hours). Handles filings lagging the wire lead by up to 24h.
   */
  dedup_window_seconds?: number;
  sql: SqlClient;
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
    anticipated_window_close = null,
    description = null,
    status = 'Detected',
    sql,
  } = options;

  if (!sql) {
    throw new Error('[mkt-market-event-store] sql client is required for insertMarketEvent');
  }

  const anticipatedWindowCloseIso = anticipated_window_close
    ? anticipated_window_close.toISOString()
    : null;

  const rows = await sql<MarketEventRow[]>`
    INSERT INTO market_events
      (raw_filing_id, source, event_type, subject_entity_id,
       subject_entity_type, event_date, anticipated_window_close, description, status)
    VALUES
      (${raw_filing_id}, ${source}, ${event_type}, ${subject_entity_id},
       ${subject_entity_type}, ${event_date.toISOString()}, ${anticipatedWindowCloseIso},
       ${description}, ${status})
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

// ---------------------------------------------------------------------------
// Cross-venue deduplication (issue #81)
// ---------------------------------------------------------------------------

/** Default dedup window in seconds: 24 hours. */
export const DEFAULT_DEDUP_WINDOW_SECONDS = 86_400;

/**
 * Finds an existing market_event by composite identity.
 *
 * The composite identity (subject_entity_id, event_type) with an event_date
 * within ±dedup_window_seconds matches the same real-world event arriving via
 * different venues. Returns the best-match row (closest event_date), or null
 * if no match exists.
 *
 * This is the dedup gate in the event-ingestion handler:
 *   1. EDGAR filing arrives for (subject, event_type, event_date).
 *   2. Call dedupMarketEventByCompositeIdentity — if a match is found, it is
 *      the canonical event row; mark the new raw_filing as 'normalized' and
 *      skip creating a duplicate market_event.
 *   3. If no match, call insertMarketEvent as normal.
 *
 * PRD §9: "A single real-world event arriving via different venues must
 * collapse to one event. Deduplication uses a composite identity (subject
 * entity, event type, anticipated date window) and tolerates lag between
 * venues."
 *
 * Architecture ref: docs/architecture.md § "Market-event feed" (cross-venue dedup)
 */
export async function dedupMarketEventByCompositeIdentity(
  options: FindByCompositeIdentityOptions,
): Promise<MarketEventRow | null> {
  const {
    subject_entity_id,
    event_type,
    event_date,
    dedup_window_seconds = DEFAULT_DEDUP_WINDOW_SECONDS,
    sql,
  } = options;

  // Query for existing events matching the composite identity within the dedup window.
  // Only match active (non-terminal) statuses: Expected, Detected, Enriched.
  // Closed / Disputed / PassedSilently events are terminal and should not absorb new filings.
  const rows = await sql<MarketEventRow[]>`
    SELECT * FROM market_events
    WHERE subject_entity_id = ${subject_entity_id}
      AND event_type = ${event_type}
      AND ABS(EXTRACT(EPOCH FROM (event_date - ${event_date.toISOString()}::TIMESTAMPTZ))) <= ${dedup_window_seconds}
      AND status IN ('Expected', 'Detected', 'Enriched')
    ORDER BY ABS(EXTRACT(EPOCH FROM (event_date - ${event_date.toISOString()}::TIMESTAMPTZ))) ASC,
             created_at ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// State machine transition guards (issue #81)
// ---------------------------------------------------------------------------

/**
 * Valid state machine transitions for market_events.
 *
 * State machine (PRD §6):
 *   Expected → Detected → Enriched → Evaluated → Closed
 *   Expected → PassedSilently  (silent passage — no Detected event before window close)
 *   Detected → Disputed        (conflict with a later authoritative filing)
 *   Enriched → Disputed        (conflict discovered during enrichment)
 *
 * Terminal states: Closed, Disputed, PassedSilently.
 *
 * Architecture ref: docs/architecture.md § "Catalyst event state machine"
 */
export const VALID_MARKET_EVENT_TRANSITIONS: ReadonlyMap<
  MarketEventStatus,
  ReadonlySet<MarketEventStatus>
> = new Map([
  ['Expected', new Set<MarketEventStatus>(['Detected', 'PassedSilently'])],
  ['Detected', new Set<MarketEventStatus>(['Enriched', 'Disputed'])],
  ['Enriched', new Set<MarketEventStatus>(['Evaluated', 'Disputed'])],
  ['Evaluated', new Set<MarketEventStatus>(['Closed'])],
  ['Closed', new Set<MarketEventStatus>()],
  ['Disputed', new Set<MarketEventStatus>()],
  ['PassedSilently', new Set<MarketEventStatus>()],
]);

/**
 * Returns true if the transition from `from` to `to` is permitted by the
 * catalyst state machine (PRD §6).
 *
 * Use this guard before any UPDATE that changes market_events.status to ensure
 * illegal transitions are rejected at the application layer before they reach
 * the DB.
 */
export function isValidMarketEventTransition(
  from: MarketEventStatus,
  to: MarketEventStatus,
): boolean {
  return VALID_MARKET_EVENT_TRANSITIONS.get(from)?.has(to) ?? false;
}

/**
 * Advances a market_event from `from` to `to` status, enforcing the state
 * machine guard.
 *
 * Returns the updated row, or null if the row was not found or was already in
 * a different status than `from` (concurrent update — caller should retry).
 *
 * @throws Error if the transition is not permitted by the state machine.
 */
export async function transitionMarketEventStatus(
  marketEventId: string,
  from: MarketEventStatus,
  to: MarketEventStatus,
  sqlClient: SqlClient,
): Promise<MarketEventRow | null> {
  if (!isValidMarketEventTransition(from, to)) {
    throw new Error(
      `[mkt-market-event-store] Invalid state machine transition: ${from} → ${to}. ` +
        'See VALID_MARKET_EVENT_TRANSITIONS for allowed paths.',
    );
  }

  const rows = await sqlClient<MarketEventRow[]>`
    UPDATE market_events
    SET status = ${to}, updated_at = NOW()
    WHERE id = ${marketEventId}
      AND status = ${from}
    RETURNING *
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Silent-passage detection (issue #81)
// ---------------------------------------------------------------------------

/**
 * Lists all market_events in 'Expected' status whose anticipated_window_close
 * has passed (i.e. the anticipated catalyst window is now closed).
 *
 * These are candidates for SILENT_PASSAGE_CHECK: the worker verifies that no
 * Detected event exists for the same composite identity, then calls
 * `transitionToPassedSilently` for each one.
 *
 * The `as_of` date defaults to NOW(). Pass an explicit date for testing.
 *
 * Architecture ref: docs/architecture.md § task-type table (SILENT_PASSAGE_CHECK row)
 * PRD §9: silent-passage events evaluated within 15 min of anticipated window closing.
 */
export async function listExpectedEventsWithExpiredWindows(
  sqlClient: SqlClient,
  asOf: Date = new Date(),
): Promise<MarketEventRow[]> {
  return sqlClient<MarketEventRow[]>`
    SELECT * FROM market_events
    WHERE status = 'Expected'
      AND anticipated_window_close IS NOT NULL
      AND anticipated_window_close <= ${asOf.toISOString()}::TIMESTAMPTZ
    ORDER BY anticipated_window_close ASC
  `;
}

/**
 * Transitions one Expected market_event to PassedSilently.
 *
 * Called by the SILENT_PASSAGE_CHECK worker after confirming that:
 *   1. The anticipated_window_close has passed.
 *   2. No Detected event exists for the same composite identity.
 *
 * Uses `transitionMarketEventStatus` to enforce the state machine guard
 * (Expected → PassedSilently is a permitted transition).
 *
 * Returns the updated row, or null if the row was not found or had already
 * transitioned out of 'Expected' (concurrent update).
 *
 * PRD §9: "An anticipated catalyst window closing with no disclosure is itself
 * a Passed Silently event."
 */
export async function transitionToPassedSilently(
  marketEventId: string,
  sqlClient: SqlClient,
): Promise<MarketEventRow | null> {
  return transitionMarketEventStatus(marketEventId, 'Expected', 'PassedSilently', sqlClient);
}

/**
 * Returns a market_event row by its primary key.
 *
 * Returns null if no row exists.
 */
export async function getMarketEventById(
  marketEventId: string,
  sqlClient: SqlClient,
): Promise<MarketEventRow | null> {
  const rows = await sqlClient<MarketEventRow[]>`
    SELECT * FROM market_events
    WHERE id = ${marketEventId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}
