-- Market-alert schema: mkt_app tables
--
-- Blueprint refs: PRUNE-D-002 (DB-backed feature gates), PRUNE-A-003 (no env-var gates),
--                DATA-D-006 (four-pool Postgres).
--
-- This file defines the market-alert specific DDL that extends the base schema.
-- It is idempotent and safe to run on both fresh and existing databases.

-- ---------------------------------------------------------------------------
-- feature_flags — runtime toggles for vendor sources and outbound channels
-- ---------------------------------------------------------------------------
--
-- Every vendor source and outbound channel is gated by a row in this table.
-- Hard-coded env-var gates are forbidden (PRUNE-D-002, PRUNE-A-003).
--
-- Columns:
--   key                  — stable machine identifier (e.g. 'edgar_ingest')
--   enabled              — current gate value; false = feature is disabled
--   scheduled_disable_at — if non-null and in the past, the flag is treated as
--                          disabled and the scheduler flips enabled to false
--   updated_at           — last write timestamp; set by application on change
CREATE TABLE IF NOT EXISTS mkt_feature_flags (
  key                    TEXT PRIMARY KEY,
  enabled                BOOLEAN NOT NULL DEFAULT false,
  scheduled_disable_at   TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Seed v1 flags.
-- trade_lifecycle is enabled=true as of Phase 6 scout (issue #25): the CTA
-- in apps/web is activated when this flag is true.
-- All other flags remain disabled by default; activated explicitly by an operator.
INSERT INTO mkt_feature_flags (key, enabled) VALUES
  ('edgar_ingest',         false),
  ('alert_notify_email',   false),
  ('alert_notify_sms',     false),
  ('alert_notify_webhook', false),
  ('trade_lifecycle',      true)
ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = CURRENT_TIMESTAMP
  WHERE mkt_feature_flags.key = 'trade_lifecycle';

-- For all other flags, insert without updating if the row already exists.
-- The UPDATE above only applies to trade_lifecycle to ensure the flag is
-- enabled after this scout merges even on existing databases.

-- ---------------------------------------------------------------------------
-- mkt_trades — Phase 6 trade lifecycle entity
-- ---------------------------------------------------------------------------
--
-- Stores one row per trade. Linked to an originating alert via alert_id (plain
-- TEXT until a dedicated mkt_alerts table with a FK constraint lands in a
-- follow-on Phase 4/6 issue).
--
-- Encryption:
--   notional and executed_price store AES-256-GCM ciphertext only.
--   The API handler encrypts these fields before INSERT/UPDATE.
--   Acceptance criterion: "trade.notional column contains ciphertext, not plaintext".
--
-- RLS (to be enforced in follow-on):
--   Only the owning Trader (trader_id = current_setting('app.current_user_id'))
--   may SELECT, UPDATE, or DELETE their own rows. Admin role gets aggregate
--   visibility without per-row content access.
--
-- State machine:
--   Proposed → Executed → Settled → Reconciled
--   Disputed reachable from any post-Executed state via Admin override (follow-on).
--
-- Blueprint refs: DATA-C-023 (field encryption), DATA-D-004 (business journal),
--                AUTH-D-001 (RBAC scopes: trades:propose, trades:execute).
CREATE TABLE IF NOT EXISTS mkt_trades (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id             TEXT,
  trader_id            TEXT        NOT NULL,
  ticker               TEXT        NOT NULL,
  direction            TEXT        NOT NULL CHECK (direction IN ('long', 'short')),
  notional             TEXT        NOT NULL,
  executed_price       TEXT,
  executed_at          TIMESTAMPTZ,
  settlement_date      DATE,
  state                TEXT        NOT NULL DEFAULT 'Proposed'
                                   CHECK (state IN ('Proposed','Executed','Settled','Reconciled','Disputed')),
  reconciliation_notes TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mkt_trades_trader_id
  ON mkt_trades (trader_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mkt_trades_alert_id
  ON mkt_trades (alert_id)
  WHERE alert_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- mkt_corporate_actions — Phase 2 EDGAR filing entity (issue #14)
-- ---------------------------------------------------------------------------
--
-- Stores one row per unique EDGAR filing (idempotency key: edgar:<accession_number>).
--
-- Encryption:
--   filing_text stores AES-256-GCM ciphertext produced by encryptField('corporate_action', ...).
--   The API handler encrypts this field before INSERT.
--   Acceptance criterion: "CorporateAction.filing_text column contains ciphertext, not plaintext".
--   No plaintext EDGAR content is ever persisted in any worker-visible column.
--
-- Idempotency:
--   ON CONFLICT (idempotency_key) DO NOTHING ensures that replaying the same EDGAR
--   filing twice (e.g. after a worker retry) never creates a duplicate row.
--
-- Blueprint refs: DATA-D-004 (append-only audit), DATA-D-006 (four-pool Postgres),
--                WORKER-P-001 (API-gateway sole writer).
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

-- ---------------------------------------------------------------------------
-- etl_cursors — per-source watermarks for incremental EDGAR ingestion (issue #15)
-- ---------------------------------------------------------------------------
--
-- Stores one row per (source, cursor_key) pair. For EDGAR polling, the source
-- is 'edgar' and the cursor_key is the EDGAR form type (e.g. '8-K', '8-K/A').
-- The watermark_value is an ISO-8601 UTC timestamp representing the latest
-- filing date seen in the last successful poll cycle for that form type.
--
-- Design:
--   - On first run for a form type, no row exists — the worker inserts one.
--   - After a successful batch, the worker advances watermark_value to the
--     maximum filing_date seen in that batch.
--   - The watermark is NOT advanced if any POST to the ingestion API fails
--     with a non-2xx response (partial-batch safety).
--   - Amended filings (e.g. 8-K/A) use an overlap_seconds column to enable
--     re-checking a window behind the watermark, preventing missed amendments.
--
-- Blueprint refs: DATA-D-004 (append-only audit), WORKER-P-001 (API sole writer).
CREATE TABLE IF NOT EXISTS etl_cursors (
  id               TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  source           TEXT        NOT NULL,
  cursor_key       TEXT        NOT NULL,
  watermark_value  TEXT        NOT NULL DEFAULT '',
  overlap_seconds  INTEGER     NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source, cursor_key)
);

CREATE INDEX IF NOT EXISTS idx_etl_cursors_source_key
  ON etl_cursors (source, cursor_key);

-- ---------------------------------------------------------------------------
-- source_findings — scraped payloads from canonical sources (issue #75)
-- ---------------------------------------------------------------------------
--
-- One row per unique scraped payload, identified by (canonical_source_id, content_hash).
-- Duplicate scrapes (same content_hash) are collapsed by ON CONFLICT DO NOTHING.
--
-- Status lifecycle:  raw → ingested | quarantined
--   raw         — scraped but not yet chunked
--   ingested    — chunked into corpus_chunk rows
--   quarantined — malformed payload; moved to etl_quarantine for inspection
--
-- Blueprint refs:
--   WORKER-P-001 (API-gateway sole writer)
--   DATA-D-006   (four-pool Postgres)
--   docs/architecture.md — SOURCE_SCRAPE, FINDING_INGEST workers
CREATE TABLE IF NOT EXISTS source_findings (
  id                    TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  canonical_source_id   TEXT        NOT NULL,
  tenant_id             TEXT        NOT NULL,
  -- SHA-256 hex digest of the raw scraped payload for dedup.
  content_hash          TEXT        NOT NULL,
  -- Raw text payload from the scraper.
  raw_content           TEXT        NOT NULL,
  -- Optional URL or identifier within the source for tracing.
  source_url            TEXT,
  -- Optional scrape timestamp (defaults to row creation time if not supplied).
  scraped_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status                TEXT        NOT NULL DEFAULT 'raw'
                                    CHECK (status IN ('raw', 'ingested', 'quarantined')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Dedup: same content from the same source is one row.
  UNIQUE (canonical_source_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_source_findings_source_status
  ON source_findings (canonical_source_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_source_findings_tenant_status
  ON source_findings (tenant_id, status, created_at);

-- ---------------------------------------------------------------------------
-- confirmed_facts — append-only extracted facts with supersession chain (issue #75)
-- ---------------------------------------------------------------------------
--
-- Immutable at the DB layer. No UPDATE or DELETE on data columns is ever permitted.
-- A Postgres trigger enforces this (see guard_confirmed_fact_immutable below).
-- Contradictions produce a NEW row; the old row gains a superseded_by_id pointer
-- (the only allowed patch) and the new row carries a supersedes_fact_id back-link.
--
-- Blueprint refs:
--   docs/architecture.md §"Confirmed facts: append-only with supersession chain"
--   WORKER-P-001 (API-gateway sole writer)
CREATE TABLE IF NOT EXISTS confirmed_facts (
  id                    TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  tenant_id             TEXT        NOT NULL,
  -- The corpus_chunk row from which this fact was extracted.
  corpus_chunk_id       TEXT        NOT NULL,
  -- The entity this fact pertains to (company, thesis, actor, etc.).
  subject_entity_id     TEXT        NOT NULL,
  subject_entity_type   TEXT        NOT NULL,
  -- The attribute / claim name (e.g. "revenue_2024", "ceo_name").
  attribute             TEXT        NOT NULL,
  -- The fact value as a JSON-serialisable string.
  value                 TEXT        NOT NULL,
  -- Confidence score [0, 1] as produced by the extraction model.
  confidence            NUMERIC(5,4) CHECK (confidence >= 0 AND confidence <= 1),
  -- Supersession chain: points to the prior fact this one contradicts/updates.
  supersedes_fact_id    TEXT,
  -- Set by a NARROW trigger exception when this row is superseded.
  -- NULL while the fact is the current head of its chain.
  superseded_by_id      TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  -- No updated_at: immutable rows are never updated.
);

CREATE INDEX IF NOT EXISTS idx_confirmed_facts_chunk
  ON confirmed_facts (corpus_chunk_id);

CREATE INDEX IF NOT EXISTS idx_confirmed_facts_subject
  ON confirmed_facts (tenant_id, subject_entity_id, attribute, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_confirmed_facts_supersession
  ON confirmed_facts (supersedes_fact_id)
  WHERE supersedes_fact_id IS NOT NULL;

-- Trigger: guard confirmed_fact immutability
-- Blocks UPDATE on data columns and all DELETE operations.
-- The only permitted UPDATE is setting superseded_by_id (narrow exception for audit trail).
CREATE OR REPLACE FUNCTION guard_confirmed_fact_immutable()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'confirmed_facts rows are immutable: DELETE is not permitted (id=%)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Allow ONLY the superseded_by_id pointer to change.
  IF OLD.corpus_chunk_id      IS DISTINCT FROM NEW.corpus_chunk_id      OR
     OLD.subject_entity_id    IS DISTINCT FROM NEW.subject_entity_id    OR
     OLD.subject_entity_type  IS DISTINCT FROM NEW.subject_entity_type  OR
     OLD.attribute            IS DISTINCT FROM NEW.attribute            OR
     OLD.value                IS DISTINCT FROM NEW.value                OR
     OLD.confidence           IS DISTINCT FROM NEW.confidence           OR
     OLD.supersedes_fact_id   IS DISTINCT FROM NEW.supersedes_fact_id   OR
     OLD.tenant_id            IS DISTINCT FROM NEW.tenant_id            OR
     OLD.created_at           IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'confirmed_facts rows are immutable: only superseded_by_id may be set (id=%)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_confirmed_facts_immutable ON confirmed_facts;
CREATE TRIGGER trg_confirmed_facts_immutable
  BEFORE UPDATE OR DELETE ON confirmed_facts
  FOR EACH ROW EXECUTE FUNCTION guard_confirmed_fact_immutable();

-- ---------------------------------------------------------------------------
-- etl_quarantine — malformed scrape payloads (issue #75)
-- ---------------------------------------------------------------------------
--
-- Receives payloads that the ingestion worker cannot parse. Neither the queue
-- nor the scraper is blocked by quarantined rows; they are retained for
-- operator inspection.
--
-- Blueprint refs:
--   docs/architecture.md — "Quarantine and DLQ"
CREATE TABLE IF NOT EXISTS etl_quarantine (
  id                  TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  source              TEXT        NOT NULL,
  -- Optional reference to the source_finding row that caused the quarantine.
  source_finding_id   TEXT,
  -- JSON-serialised payload that could not be parsed.
  raw_payload         TEXT        NOT NULL,
  -- Human-readable error message from the parser.
  error_message       TEXT        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_etl_quarantine_source
  ON etl_quarantine (source, created_at DESC);
