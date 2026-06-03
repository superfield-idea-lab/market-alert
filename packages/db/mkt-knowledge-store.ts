/**
 * @file mkt-knowledge-store.ts
 *
 * DB access layer for the knowledge-base ingestion tables introduced in issue #75:
 *   - source_findings    — scraped payloads from canonical sources
 *   - confirmed_facts    — append-only extracted facts with supersession chain
 *   - etl_quarantine     — malformed payloads quarantined for operator inspection
 *
 * ## Design
 *
 * Workers never call this module directly. They POST to internal API endpoints
 * on apps/server; only apps/server holds DB credentials and calls into this
 * module (WORKER-T-001).
 *
 * ## Idempotency
 *
 * `insertSourceFinding` uses INSERT … ON CONFLICT (canonical_source_id, content_hash)
 * DO NOTHING so that duplicate scrapes collapse to a single row.
 *
 * ## Append-only facts
 *
 * `confirmed_fact` rows are immutable at the DB layer (a trigger enforces this).
 * `insertConfirmedFact` always inserts a new row. When contradicting a prior fact,
 * pass `supersedes_fact_id`; after insert the prior row's `superseded_by_id` is
 * patched via `markFactSuperseded` (the only permitted UPDATE on the table).
 *
 * ## Canonical docs
 *
 * - docs/prd.md §6
 * - docs/architecture.md §"Confirmed facts: append-only with supersession chain"
 * - packages/db/mkt-schema.sql — DDL
 * - apps/worker/src/source-scrape-job.ts
 * - apps/worker/src/finding-ingest-job.ts
 * - apps/worker/src/fact-extract-job.ts
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/75
 */

import type postgres from 'postgres';

export type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// source_findings
// ---------------------------------------------------------------------------

export type SourceFindingStatus = 'raw' | 'ingested' | 'quarantined';

export interface SourceFindingRow {
  id: string;
  canonical_source_id: string;
  tenant_id: string;
  /** SHA-256 hex digest of the raw scraped payload. */
  content_hash: string;
  raw_content: string;
  source_url: string | null;
  scraped_at: Date;
  status: SourceFindingStatus;
  created_at: Date;
  updated_at: Date;
}

export interface InsertSourceFindingInput {
  canonical_source_id: string;
  tenant_id: string;
  content_hash: string;
  raw_content: string;
  source_url?: string | null;
  scraped_at?: Date | null;
}

/**
 * Insert a scraped finding, collapsing duplicates by content_hash.
 *
 * Returns `{ row, created }`:
 *   - `created = true`  → new row inserted.
 *   - `created = false` → row already existed; returned unchanged.
 */
export async function insertSourceFinding(
  sql: SqlClient,
  input: InsertSourceFindingInput,
): Promise<{ row: SourceFindingRow; created: boolean }> {
  // Use INSERT … ON CONFLICT DO NOTHING RETURNING to detect whether the row was
  // actually inserted (RETURNING returns the new row) or already existed
  // (RETURNING returns nothing). When RETURNING returns nothing (conflict), we
  // fetch the pre-existing row by its unique key.

  const inserted = await sql<SourceFindingRow[]>`
    INSERT INTO source_findings
      (canonical_source_id, tenant_id, content_hash, raw_content, source_url, scraped_at)
    VALUES (
      ${input.canonical_source_id},
      ${input.tenant_id},
      ${input.content_hash},
      ${input.raw_content},
      ${input.source_url ?? null},
      ${input.scraped_at ?? new Date()}
    )
    ON CONFLICT (canonical_source_id, content_hash) DO NOTHING
    RETURNING id, canonical_source_id, tenant_id, content_hash, raw_content,
              source_url, scraped_at, status, created_at, updated_at
  `;

  if (inserted.length > 0) {
    // INSERT succeeded — new row was created.
    return { row: inserted[0]!, created: true };
  }

  // ON CONFLICT fired — fetch the pre-existing row.
  const existing = await sql<SourceFindingRow[]>`
    SELECT id, canonical_source_id, tenant_id, content_hash, raw_content,
           source_url, scraped_at, status, created_at, updated_at
    FROM source_findings
    WHERE canonical_source_id = ${input.canonical_source_id}
      AND content_hash         = ${input.content_hash}
    LIMIT 1
  `;

  const row = existing[0];
  if (!row) {
    throw new Error(
      `source_findings: row not found after conflict for canonical_source_id=${input.canonical_source_id} content_hash=${input.content_hash}`,
    );
  }

  return { row, created: false };
}

/**
 * Advance a source_finding from `raw` to `ingested`.
 * Idempotent: already-ingested rows are returned unchanged.
 */
export async function markFindingIngested(
  sql: SqlClient,
  id: string,
): Promise<SourceFindingRow | null> {
  const rows = await sql<SourceFindingRow[]>`
    UPDATE source_findings
    SET status = 'ingested', updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
      AND status IN ('raw', 'ingested')
    RETURNING id, canonical_source_id, tenant_id, content_hash, raw_content,
              source_url, scraped_at, status, created_at, updated_at
  `;
  return rows[0] ?? null;
}

/**
 * Advance a source_finding from `raw` to `quarantined`.
 */
export async function markFindingQuarantined(
  sql: SqlClient,
  id: string,
): Promise<SourceFindingRow | null> {
  const rows = await sql<SourceFindingRow[]>`
    UPDATE source_findings
    SET status = 'quarantined', updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
      AND status = 'raw'
    RETURNING id, canonical_source_id, tenant_id, content_hash, raw_content,
              source_url, scraped_at, status, created_at, updated_at
  `;
  return rows[0] ?? null;
}

/**
 * Fetch a single source_finding by primary key.
 */
export async function getSourceFinding(
  sql: SqlClient,
  id: string,
): Promise<SourceFindingRow | null> {
  const rows = await sql<SourceFindingRow[]>`
    SELECT id, canonical_source_id, tenant_id, content_hash, raw_content,
           source_url, scraped_at, status, created_at, updated_at
    FROM source_findings
    WHERE id = ${id}
  `;
  return rows[0] ?? null;
}

/**
 * List source_findings for a canonical source, optionally filtered by status.
 * Ordered by created_at ASC for deterministic test output.
 */
export async function listSourceFindingsBySource(
  sql: SqlClient,
  canonicalSourceId: string,
  status?: SourceFindingStatus,
): Promise<SourceFindingRow[]> {
  if (status !== undefined) {
    return sql<SourceFindingRow[]>`
      SELECT id, canonical_source_id, tenant_id, content_hash, raw_content,
             source_url, scraped_at, status, created_at, updated_at
      FROM source_findings
      WHERE canonical_source_id = ${canonicalSourceId}
        AND status = ${status}
      ORDER BY created_at ASC
    `;
  }
  return sql<SourceFindingRow[]>`
    SELECT id, canonical_source_id, tenant_id, content_hash, raw_content,
           source_url, scraped_at, status, created_at, updated_at
    FROM source_findings
    WHERE canonical_source_id = ${canonicalSourceId}
    ORDER BY created_at ASC
  `;
}

// ---------------------------------------------------------------------------
// confirmed_facts
// ---------------------------------------------------------------------------

export interface ConfirmedFactRow {
  id: string;
  tenant_id: string;
  corpus_chunk_id: string;
  subject_entity_id: string;
  subject_entity_type: string;
  attribute: string;
  value: string;
  confidence: string | null;
  supersedes_fact_id: string | null;
  superseded_by_id: string | null;
  created_at: Date;
}

export interface InsertConfirmedFactInput {
  tenant_id: string;
  corpus_chunk_id: string;
  subject_entity_id: string;
  subject_entity_type: string;
  attribute: string;
  value: string;
  confidence?: number | null;
  /** Set when this fact contradicts / updates a prior fact. */
  supersedes_fact_id?: string | null;
}

/**
 * Insert a new confirmed fact.
 *
 * When `supersedes_fact_id` is supplied the prior fact's `superseded_by_id` is
 * patched immediately after insert (the only permitted UPDATE on the table).
 *
 * Returns the newly inserted row.
 */
export async function insertConfirmedFact(
  sql: SqlClient,
  input: InsertConfirmedFactInput,
): Promise<ConfirmedFactRow> {
  return sql.begin(async (txRaw) => {
    // Cast to Sql to access generic typed template literals.
    // postgres.TransactionSql extends Sql at runtime; the cast is safe.
    const tx = txRaw as unknown as SqlClient;

    const rows = await tx<ConfirmedFactRow[]>`
      INSERT INTO confirmed_facts
        (tenant_id, corpus_chunk_id, subject_entity_id, subject_entity_type,
         attribute, value, confidence, supersedes_fact_id)
      VALUES (
        ${input.tenant_id},
        ${input.corpus_chunk_id},
        ${input.subject_entity_id},
        ${input.subject_entity_type},
        ${input.attribute},
        ${input.value},
        ${input.confidence ?? null},
        ${input.supersedes_fact_id ?? null}
      )
      RETURNING id, tenant_id, corpus_chunk_id, subject_entity_id, subject_entity_type,
                attribute, value, confidence, supersedes_fact_id, superseded_by_id, created_at
    `;

    const newFact = rows[0];
    if (!newFact) {
      throw new Error('confirmed_facts: insert returned no row');
    }

    // Patch the prior fact's superseded_by_id (narrow trigger exception).
    if (input.supersedes_fact_id) {
      await tx`
        UPDATE confirmed_facts
        SET superseded_by_id = ${newFact.id}
        WHERE id = ${input.supersedes_fact_id}
          AND superseded_by_id IS NULL
      `;
    }

    return newFact;
  }) as Promise<ConfirmedFactRow>;
}

/**
 * Fetch a single confirmed_fact by primary key.
 */
export async function getConfirmedFact(
  sql: SqlClient,
  id: string,
): Promise<ConfirmedFactRow | null> {
  const rows = await sql<ConfirmedFactRow[]>`
    SELECT id, tenant_id, corpus_chunk_id, subject_entity_id, subject_entity_type,
           attribute, value, confidence, supersedes_fact_id, superseded_by_id, created_at
    FROM confirmed_facts
    WHERE id = ${id}
  `;
  return rows[0] ?? null;
}

/**
 * List the current (non-superseded) facts for a subject entity and attribute.
 * Returns rows whose `superseded_by_id` is NULL, ordered by created_at DESC.
 */
export async function listCurrentFacts(
  sql: SqlClient,
  tenantId: string,
  subjectEntityId: string,
  attribute: string,
): Promise<ConfirmedFactRow[]> {
  return sql<ConfirmedFactRow[]>`
    SELECT id, tenant_id, corpus_chunk_id, subject_entity_id, subject_entity_type,
           attribute, value, confidence, supersedes_fact_id, superseded_by_id, created_at
    FROM confirmed_facts
    WHERE tenant_id          = ${tenantId}
      AND subject_entity_id  = ${subjectEntityId}
      AND attribute          = ${attribute}
      AND superseded_by_id   IS NULL
    ORDER BY created_at DESC
  `;
}

// ---------------------------------------------------------------------------
// etl_quarantine
// ---------------------------------------------------------------------------

export interface EtlQuarantineRow {
  id: string;
  source: string;
  source_finding_id: string | null;
  raw_payload: string;
  error_message: string;
  created_at: Date;
}

export interface InsertEtlQuarantineInput {
  source: string;
  source_finding_id?: string | null;
  raw_payload: string;
  error_message: string;
}

/**
 * Quarantine a malformed payload for operator inspection.
 * Every call inserts a new row — no dedup (operators need the full audit trail).
 */
export async function quarantinePayload(
  sql: SqlClient,
  input: InsertEtlQuarantineInput,
): Promise<EtlQuarantineRow> {
  const rows = await sql<EtlQuarantineRow[]>`
    INSERT INTO etl_quarantine
      (source, source_finding_id, raw_payload, error_message)
    VALUES (
      ${input.source},
      ${input.source_finding_id ?? null},
      ${input.raw_payload},
      ${input.error_message}
    )
    RETURNING id, source, source_finding_id, raw_payload, error_message, created_at
  `;
  const row = rows[0];
  if (!row) {
    throw new Error('etl_quarantine: insert returned no row');
  }
  return row;
}

// ---------------------------------------------------------------------------
// DDL inline strings (for migrateMkt programmatic application)
// ---------------------------------------------------------------------------

/**
 * Inline DDL for source_findings, confirmed_facts, and etl_quarantine.
 *
 * Matches the DDL appended to mkt-schema.sql but available as an importable
 * constant so migrateMkt can apply it programmatically.
 */
export const MKT_KNOWLEDGE_DDL = `
CREATE TABLE IF NOT EXISTS source_findings (
  id                    TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  canonical_source_id   TEXT        NOT NULL,
  tenant_id             TEXT        NOT NULL,
  content_hash          TEXT        NOT NULL,
  raw_content           TEXT        NOT NULL,
  source_url            TEXT,
  scraped_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status                TEXT        NOT NULL DEFAULT 'raw'
                                    CHECK (status IN ('raw', 'ingested', 'quarantined')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (canonical_source_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_source_findings_source_status
  ON source_findings (canonical_source_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_source_findings_tenant_status
  ON source_findings (tenant_id, status, created_at);

CREATE TABLE IF NOT EXISTS confirmed_facts (
  id                    TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  tenant_id             TEXT        NOT NULL,
  corpus_chunk_id       TEXT        NOT NULL,
  subject_entity_id     TEXT        NOT NULL,
  subject_entity_type   TEXT        NOT NULL,
  attribute             TEXT        NOT NULL,
  value                 TEXT        NOT NULL,
  confidence            NUMERIC(5,4) CHECK (confidence >= 0 AND confidence <= 1),
  supersedes_fact_id    TEXT,
  superseded_by_id      TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_confirmed_facts_chunk
  ON confirmed_facts (corpus_chunk_id);

CREATE INDEX IF NOT EXISTS idx_confirmed_facts_subject
  ON confirmed_facts (tenant_id, subject_entity_id, attribute, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_confirmed_facts_supersession
  ON confirmed_facts (supersedes_fact_id)
  WHERE supersedes_fact_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_confirmed_fact_immutable()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'confirmed_facts rows are immutable: DELETE is not permitted (id=%)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
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

CREATE TABLE IF NOT EXISTS etl_quarantine (
  id                  TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  source              TEXT        NOT NULL,
  source_finding_id   TEXT,
  raw_payload         TEXT        NOT NULL,
  error_message       TEXT        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_etl_quarantine_source
  ON etl_quarantine (source, created_at DESC);

-- corpus_chunks without the vector column — used when pgvector is unavailable
-- (e.g. plain postgres:16 containers in integration test environments).
-- When pgvector IS available, schema.sql's guarded block creates the full table
-- with the vector(768) embedding column and HNSW index.  CREATE TABLE IF NOT
-- EXISTS means whichever runs first wins; if the pgvector block ran first, this
-- statement is a no-op.
CREATE TABLE IF NOT EXISTS corpus_chunks (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  tenant_id   TEXT        NOT NULL,
  source_id   TEXT,
  content     TEXT        NOT NULL,
  chunk_index INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_corpus_chunks_tenant_id
  ON corpus_chunks (tenant_id);
`;
