/**
 * @file wiki-debate-store.ts
 *
 * DB access layer for the wiki debate lifecycle — issue #77.
 *
 * ## Design
 *
 * A `wiki_debate` row is opened when fact-checking produces a non-converging
 * result for a claim on a wiki page. The claim is flagged and the researcher
 * can inspect, resolve, or archive the debate.
 *
 * ## Lifecycle
 *
 *   open → resolved | archived
 *
 * - `open`     — the debate is active; the contested claim is flagged on the wiki page.
 * - `resolved` — the debate was settled (e.g. one source was deemed more authoritative);
 *                a WIKI_REBUILD is typically enqueued to refresh the page.
 * - `archived` — the debate was closed without resolution (e.g. both claims are
 *                retained as contested, or the subject is no longer tracked).
 *
 * ## Tables managed here
 *
 * ### wiki_debates
 *
 * One row per contested claim. Linked to the wiki_page_versions_mkt version
 * that first surfaced the contest. Stores the claim text and the conflicting
 * evidence IDs so the researcher can see both sides.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5 — debates surfaced as wiki annotations.
 * - docs/architecture.md §"Knowledge subsystem" — wiki_debates entity type.
 * - packages/db/mkt-schema.sql — DDL (wiki_debates).
 * - apps/server/src/api/wiki-debate-api.ts — API endpoints.
 * - tests/integration/wiki-debate.spec.ts — integration tests.
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/77
 */

import type postgres from 'postgres';

export type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WikiDebateStatus = 'open' | 'resolved' | 'archived';

export type WikiDebateRow = {
  id: string;
  tenant_id: string;
  wiki_page_id: string;
  wiki_page_version_id: string;
  /** Short description of the contested claim. */
  claim: string;
  /**
   * JSON array of confirmed_fact IDs or corpus_chunk IDs supporting side A.
   * Stored as a TEXT column containing a JSON array for portability.
   */
  evidence_a: string;
  /**
   * JSON array of confirmed_fact IDs or corpus_chunk IDs supporting side B.
   * Stored as a TEXT column containing a JSON array for portability.
   */
  evidence_b: string;
  status: WikiDebateStatus;
  /** Optional free-text note recorded when the debate is resolved or archived. */
  resolution_note: string | null;
  created_at: Date;
  updated_at: Date;
};

export interface OpenDebateInput {
  tenant_id: string;
  wiki_page_id: string;
  wiki_page_version_id: string;
  claim: string;
  /** Array of confirmed_fact/corpus_chunk IDs supporting side A. */
  evidence_a: string[];
  /** Array of confirmed_fact/corpus_chunk IDs supporting side B. */
  evidence_b: string[];
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

/**
 * DDL for the wiki_debates table.
 *
 * Applied by the test helper and by the production migration runner.
 * Mirrors the authoritative DDL in packages/db/mkt-schema.sql.
 */
export const WIKI_DEBATE_DDL = `
-- wiki_debates — contested claims on wiki pages that have not yet converged.
-- Lifecycle: open → resolved | archived
-- Architecture ref: docs/architecture.md §"Knowledge subsystem"
CREATE TABLE IF NOT EXISTS wiki_debates (
  id                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  tenant_id               TEXT NOT NULL,
  wiki_page_id            TEXT NOT NULL,
  wiki_page_version_id    TEXT NOT NULL,
  -- Short human-readable description of the contested claim.
  claim                   TEXT NOT NULL,
  -- JSON arrays of evidence IDs supporting each side of the debate.
  evidence_a              TEXT NOT NULL DEFAULT '[]',
  evidence_b              TEXT NOT NULL DEFAULT '[]',
  status                  TEXT NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'resolved', 'archived')),
  resolution_note         TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wiki_debates_page
  ON wiki_debates (wiki_page_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wiki_debates_tenant_status
  ON wiki_debates (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wiki_debates_version
  ON wiki_debates (wiki_page_version_id);
`;

// ---------------------------------------------------------------------------
// openDebate
// ---------------------------------------------------------------------------

/**
 * Open a new wiki_debate for a contested claim.
 *
 * Returns the new debate row at status `open`.
 */
export async function openDebate(sql: SqlClient, input: OpenDebateInput): Promise<WikiDebateRow> {
  const rows = await sql<WikiDebateRow[]>`
    INSERT INTO wiki_debates
      (tenant_id, wiki_page_id, wiki_page_version_id, claim, evidence_a, evidence_b, status)
    VALUES (
      ${input.tenant_id},
      ${input.wiki_page_id},
      ${input.wiki_page_version_id},
      ${input.claim},
      ${JSON.stringify(input.evidence_a)},
      ${JSON.stringify(input.evidence_b)},
      'open'
    )
    RETURNING
      id, tenant_id, wiki_page_id, wiki_page_version_id, claim,
      evidence_a, evidence_b, status, resolution_note, created_at, updated_at
  `;
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// resolveDebate
// ---------------------------------------------------------------------------

/**
 * Resolve an open wiki_debate.
 *
 * Transitions `open → resolved`. No-op if the debate is already resolved or archived.
 *
 * @param debate_id      The debate to resolve.
 * @param resolution_note Free-text explanation of how the debate was settled.
 */
export async function resolveDebate(
  sql: SqlClient,
  debate_id: string,
  resolution_note: string,
): Promise<WikiDebateRow | null> {
  const rows = await sql<WikiDebateRow[]>`
    UPDATE wiki_debates
    SET status          = 'resolved',
        resolution_note = ${resolution_note},
        updated_at      = CURRENT_TIMESTAMP
    WHERE id     = ${debate_id}
      AND status = 'open'
    RETURNING
      id, tenant_id, wiki_page_id, wiki_page_version_id, claim,
      evidence_a, evidence_b, status, resolution_note, created_at, updated_at
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// archiveDebate
// ---------------------------------------------------------------------------

/**
 * Archive an open wiki_debate without resolving it.
 *
 * Transitions `open → archived`. No-op if the debate is already resolved or archived.
 *
 * @param debate_id      The debate to archive.
 * @param resolution_note Optional note explaining why the debate is being closed.
 */
export async function archiveDebate(
  sql: SqlClient,
  debate_id: string,
  resolution_note: string | null,
): Promise<WikiDebateRow | null> {
  const rows = await sql<WikiDebateRow[]>`
    UPDATE wiki_debates
    SET status          = 'archived',
        resolution_note = ${resolution_note},
        updated_at      = CURRENT_TIMESTAMP
    WHERE id     = ${debate_id}
      AND status = 'open'
    RETURNING
      id, tenant_id, wiki_page_id, wiki_page_version_id, claim,
      evidence_a, evidence_b, status, resolution_note, created_at, updated_at
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// getDebate
// ---------------------------------------------------------------------------

/**
 * Fetch a single wiki_debate by ID.
 */
export async function getDebate(sql: SqlClient, debate_id: string): Promise<WikiDebateRow | null> {
  const rows = await sql<WikiDebateRow[]>`
    SELECT id, tenant_id, wiki_page_id, wiki_page_version_id, claim,
           evidence_a, evidence_b, status, resolution_note, created_at, updated_at
    FROM wiki_debates
    WHERE id = ${debate_id}
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// listOpenDebatesForPage
// ---------------------------------------------------------------------------

/**
 * List all open debates for a wiki page.
 *
 * Used by the wiki navigation UI to surface the debate badge count.
 */
export async function listOpenDebatesForPage(
  sql: SqlClient,
  wiki_page_id: string,
): Promise<WikiDebateRow[]> {
  return sql<WikiDebateRow[]>`
    SELECT id, tenant_id, wiki_page_id, wiki_page_version_id, claim,
           evidence_a, evidence_b, status, resolution_note, created_at, updated_at
    FROM wiki_debates
    WHERE wiki_page_id = ${wiki_page_id}
      AND status = 'open'
    ORDER BY created_at DESC
  `;
}

// ---------------------------------------------------------------------------
// listDebatesForTenant
// ---------------------------------------------------------------------------

/**
 * List all debates (optionally filtered by status) for a tenant.
 *
 * Used by the researcher dashboard debate inbox.
 */
export async function listDebatesForTenant(
  sql: SqlClient,
  tenant_id: string,
  status?: WikiDebateStatus,
): Promise<WikiDebateRow[]> {
  if (status) {
    return sql<WikiDebateRow[]>`
      SELECT id, tenant_id, wiki_page_id, wiki_page_version_id, claim,
             evidence_a, evidence_b, status, resolution_note, created_at, updated_at
      FROM wiki_debates
      WHERE tenant_id = ${tenant_id}
        AND status    = ${status}
      ORDER BY created_at DESC
    `;
  }
  return sql<WikiDebateRow[]>`
    SELECT id, tenant_id, wiki_page_id, wiki_page_version_id, claim,
           evidence_a, evidence_b, status, resolution_note, created_at, updated_at
    FROM wiki_debates
    WHERE tenant_id = ${tenant_id}
    ORDER BY created_at DESC
  `;
}
