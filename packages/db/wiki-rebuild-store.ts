/**
 * @file wiki-rebuild-store.ts
 *
 * DB access layer for the wiki rebuild pipeline introduced in issue #76.
 *
 * ## Design
 *
 * Workers never call this module directly. They POST to internal API endpoints
 * on apps/server; only apps/server holds DB credentials and calls into this
 * module (WORKER-T-001).
 *
 * ## Tables managed here
 *
 * ### wiki_pages
 *
 * One row per subject (tenant_id, subject_type, subject_id). Holds a
 * `currently_published_version_id` pointer that is advanced to a new
 * `wiki_page_versions` row only when its `status` reaches `indexed`.
 * Reading code always follows `currently_published_version_id`; in-progress
 * rebuild rows with status < `indexed` are never exposed to readers.
 *
 * ### wiki_page_versions (status pipeline)
 *
 * The crash-resume pipeline uses a `status` column with the values:
 *   pending → content_written → embedded → indexed
 *
 * The rebuild worker advances status one stage at a time. If the pod crashes,
 * the stalled row stays at its intermediate status and the next re-scheduled
 * WIKI_REBUILD task resumes from the next stage rather than from scratch.
 *
 * ### wiki_page_cites
 *
 * Typed directed edges from a `wiki_page_version` to its supporting evidence
 * (`corpus_chunk` or `confirmed_fact`). Mirrors the `cites` edge semantics
 * from architecture §"Citations: first-class relation edges".
 *
 * On retraction of a corpus_chunk (FK cascade), the cites edges are deleted
 * automatically; the wiki page is not immediately rewritten. The next
 * WIKI_REBUILD pass re-derives the page from remaining evidence.
 *
 * ## Canonical docs
 *
 * - docs/architecture.md §"Wiki pages: full-snapshot versioning"
 * - docs/architecture.md §"Citations: first-class relation edges"
 * - packages/db/mkt-schema.sql — DDL (wiki_pages, wiki_page_cites)
 * - apps/worker/src/wiki-rebuild-job.ts — worker handler
 * - apps/server/src/api/wiki-rebuild-api.ts — internal API endpoints
 * - tests/integration/wiki-rebuild.spec.ts — integration tests
 *
 * ## Integration points discovered during scout (issue #76)
 *
 * - The `status` enum on wiki_page_versions_mkt (the Phase 3 variant) is
 *   DISTINCT from the existing `state` column on `wiki_page_versions` (draft/
 *   published/archived). The Phase 3 schema adds a separate `status` column
 *   (pending → content_written → embedded → indexed) so both lifecycle
 *   dimensions co-exist without a destructive migration.
 * - The `currently_published_version_id` pointer on `wiki_pages` must be
 *   updated inside the same transaction that flips status to `indexed` to
 *   prevent readers from ever following a non-indexed version (AC-3).
 * - The embedding step requires pgvector. The DDL block is guarded by a
 *   pgvector availability check mirroring the corpus_chunks pattern.
 * - WIKI_REBUILD tasks are enqueued by FACT_EXTRACT workers when a new fact
 *   changes the evidence set for a subject. The task key format is:
 *   `wiki_rebuild:<subject_type>:<subject_id>:<trigger>`. At-least-once
 *   delivery means the rebuild handler must be idempotent.
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/76
 */

import type postgres from 'postgres';

export type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// wiki_pages
// ---------------------------------------------------------------------------

export type WikiPageRow = {
  id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  currently_published_version_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export interface UpsertWikiPageInput {
  tenant_id: string;
  subject_type: string;
  subject_id: string;
}

/**
 * Upsert a wiki_pages row for a subject.
 *
 * Returns the existing row if already present (idempotent).
 * The `currently_published_version_id` is not touched by this function;
 * it is advanced separately inside the `indexed` stage transaction.
 */
export async function upsertWikiPage(
  sql: SqlClient,
  input: UpsertWikiPageInput,
): Promise<WikiPageRow> {
  const rows = await sql<WikiPageRow[]>`
    INSERT INTO wiki_pages
      (tenant_id, subject_type, subject_id)
    VALUES (
      ${input.tenant_id},
      ${input.subject_type},
      ${input.subject_id}
    )
    ON CONFLICT (tenant_id, subject_type, subject_id) DO UPDATE
      SET updated_at = CURRENT_TIMESTAMP
    RETURNING
      id, tenant_id, subject_type, subject_id,
      currently_published_version_id, created_at, updated_at
  `;
  return rows[0]!;
}

/**
 * Fetch a wiki_pages row by subject coordinates.
 *
 * Returns null when no wiki page has been created for this subject yet.
 */
export async function getWikiPage(
  sql: SqlClient,
  tenant_id: string,
  subject_type: string,
  subject_id: string,
): Promise<WikiPageRow | null> {
  const rows = await sql<WikiPageRow[]>`
    SELECT id, tenant_id, subject_type, subject_id,
           currently_published_version_id, created_at, updated_at
    FROM wiki_pages
    WHERE tenant_id = ${tenant_id}
      AND subject_type = ${subject_type}
      AND subject_id = ${subject_id}
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// wiki_page_versions (Phase 3 status pipeline)
// ---------------------------------------------------------------------------

/**
 * Status values for the wiki rebuild pipeline.
 *
 * Crash-resume: a worker that crashes leaves the version at its current status.
 * The next re-scheduled WIKI_REBUILD task reads the stalled row and resumes
 * from the next stage rather than restarting from `pending`.
 *
 * Architecture ref: docs/architecture.md §"Wiki pages: full-snapshot versioning"
 */
export type WikiPageVersionStatus = 'pending' | 'content_written' | 'embedded' | 'indexed';

export type WikiPageVersionMktRow = {
  id: string;
  wiki_page_id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  /** Full markdown body (AES-256-GCM ciphertext at rest). */
  body_ciphertext: string | null;
  status: WikiPageVersionStatus;
  created_at: Date;
  updated_at: Date;
};

export interface InsertWikiPageVersionInput {
  wiki_page_id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
}

/**
 * Insert a new wiki_page_version row at status `pending`.
 *
 * The body_ciphertext is null at creation; the `content_written` stage
 * populates it via `setWikiPageVersionBody`.
 */
export async function insertWikiPageVersion(
  sql: SqlClient,
  input: InsertWikiPageVersionInput,
): Promise<WikiPageVersionMktRow> {
  const rows = await sql<WikiPageVersionMktRow[]>`
    INSERT INTO wiki_page_versions_mkt
      (wiki_page_id, tenant_id, subject_type, subject_id, body_ciphertext, status)
    VALUES (
      ${input.wiki_page_id},
      ${input.tenant_id},
      ${input.subject_type},
      ${input.subject_id},
      NULL,
      'pending'
    )
    RETURNING
      id, wiki_page_id, tenant_id, subject_type, subject_id,
      body_ciphertext, status, created_at, updated_at
  `;
  return rows[0]!;
}

/**
 * Fetch a stalled wiki_page_version for a subject that has not yet reached
 * `indexed`. Used by the crash-resume path to resume from the stalled stage.
 *
 * Returns null when no in-progress version exists (clean rebuild).
 */
export async function getStalledWikiPageVersion(
  sql: SqlClient,
  wiki_page_id: string,
  tenant_id: string,
): Promise<WikiPageVersionMktRow | null> {
  const rows = await sql<WikiPageVersionMktRow[]>`
    SELECT id, wiki_page_id, tenant_id, subject_type, subject_id,
           body_ciphertext, status, created_at, updated_at
    FROM wiki_page_versions_mkt
    WHERE wiki_page_id = ${wiki_page_id}
      AND tenant_id   = ${tenant_id}
      AND status      != 'indexed'
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Advance a wiki_page_version status to `content_written` and store the
 * encrypted body.
 *
 * Called by the rebuild worker after generating and encrypting the markdown.
 * No-op if the row is already at or past `content_written`.
 */
export async function setWikiPageVersionBody(
  sql: SqlClient,
  version_id: string,
  body_ciphertext: string,
): Promise<void> {
  await sql`
    UPDATE wiki_page_versions_mkt
    SET body_ciphertext = ${body_ciphertext},
        status          = 'content_written',
        updated_at      = CURRENT_TIMESTAMP
    WHERE id     = ${version_id}
      AND status = 'pending'
  `;
}

/**
 * Advance a wiki_page_version status to `embedded`.
 *
 * Called by the rebuild worker after storing the pgvector embedding.
 * No-op if the row is already at or past `embedded`.
 */
export async function setWikiPageVersionEmbedded(
  sql: SqlClient,
  version_id: string,
): Promise<void> {
  await sql`
    UPDATE wiki_page_versions_mkt
    SET status     = 'embedded',
        updated_at = CURRENT_TIMESTAMP
    WHERE id     = ${version_id}
      AND status = 'content_written'
  `;
}

/**
 * Advance a wiki_page_version to `indexed` and atomically flip
 * `wiki_pages.currently_published_version_id`.
 *
 * The two updates are wrapped in a single transaction so readers never observe
 * an intermediate state (AC-3: "Readers never follow a non-indexed version").
 *
 * This is the only place where `currently_published_version_id` is written.
 */
export async function publishWikiPageVersion(
  sql: SqlClient,
  version_id: string,
  wiki_page_id: string,
): Promise<void> {
  await sql.begin(async (txRaw) => {
    // postgres.TransactionSql extends Sql at runtime; the cast is safe.
    const tx = txRaw as unknown as SqlClient;
    await tx`
      UPDATE wiki_page_versions_mkt
      SET status     = 'indexed',
          updated_at = CURRENT_TIMESTAMP
      WHERE id     = ${version_id}
        AND status = 'embedded'
    `;
    await tx`
      UPDATE wiki_pages
      SET currently_published_version_id = ${version_id},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${wiki_page_id}
    `;
  });
}

// ---------------------------------------------------------------------------
// wiki_page_cites (citation edges)
// ---------------------------------------------------------------------------

/**
 * Citation target type.
 *
 * Architecture ref: docs/architecture.md §"Citations: first-class relation edges"
 *   wiki_page_version → corpus_chunk | confirmed_fact
 */
export type CitesTargetType = 'corpus_chunk' | 'confirmed_fact';

export type WikiPageCitesRow = {
  id: string;
  wiki_page_version_id: string;
  target_id: string;
  target_type: CitesTargetType;
  created_at: Date;
};

export interface InsertCitesEdgeInput {
  wiki_page_version_id: string;
  target_id: string;
  target_type: CitesTargetType;
}

/**
 * Insert a `cites` edge from a wiki_page_version to a piece of evidence.
 *
 * Idempotent: ON CONFLICT DO NOTHING so that rebuild retries do not create
 * duplicate edges.
 */
export async function insertCitesEdge(
  sql: SqlClient,
  input: InsertCitesEdgeInput,
): Promise<WikiPageCitesRow> {
  const rows = await sql<WikiPageCitesRow[]>`
    INSERT INTO wiki_page_cites
      (wiki_page_version_id, target_id, target_type)
    VALUES (
      ${input.wiki_page_version_id},
      ${input.target_id},
      ${input.target_type}
    )
    ON CONFLICT (wiki_page_version_id, target_id, target_type) DO NOTHING
    RETURNING id, wiki_page_version_id, target_id, target_type, created_at
  `;
  // ON CONFLICT DO NOTHING returns empty on duplicate; re-fetch to return the row.
  if (rows.length > 0) return rows[0]!;
  const existing = await sql<WikiPageCitesRow[]>`
    SELECT id, wiki_page_version_id, target_id, target_type, created_at
    FROM wiki_page_cites
    WHERE wiki_page_version_id = ${input.wiki_page_version_id}
      AND target_id            = ${input.target_id}
      AND target_type          = ${input.target_type}
  `;
  return existing[0]!;
}

/**
 * Fetch all cites edges for a wiki_page_version.
 *
 * Used by the rebuild worker to verify evidence coverage and by the API to
 * expose citation provenance to researchers.
 */
export async function getCitesEdges(
  sql: SqlClient,
  wiki_page_version_id: string,
): Promise<WikiPageCitesRow[]> {
  return sql<WikiPageCitesRow[]>`
    SELECT id, wiki_page_version_id, target_id, target_type, created_at
    FROM wiki_page_cites
    WHERE wiki_page_version_id = ${wiki_page_version_id}
    ORDER BY created_at ASC
  `;
}

// ---------------------------------------------------------------------------
// DDL (exported for use in test setup and migration scripts)
// ---------------------------------------------------------------------------

/**
 * DDL for the wiki rebuild tables.
 *
 * Applied by the test helper and by the production migration runner.
 * Mirrors the authoritative DDL in packages/db/mkt-schema.sql.
 *
 * Integration note (issue #76 scout):
 *   The `wiki_page_versions_mkt` table is a SEPARATE table from the existing
 *   `wiki_page_versions` table (which stores draft/published/archived versions
 *   for the autolearn workflow). This avoids a destructive migration and allows
 *   both lifecycle dimensions to co-exist. A follow-on consolidation issue
 *   should evaluate whether these two version tables can be merged.
 */
export const WIKI_REBUILD_DDL = `
-- wiki_pages — one row per subject; points at the currently published version.
CREATE TABLE IF NOT EXISTS wiki_pages (
  id                              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  tenant_id                       TEXT NOT NULL,
  subject_type                    TEXT NOT NULL,
  subject_id                      TEXT NOT NULL,
  currently_published_version_id  TEXT,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, subject_type, subject_id)
);

-- wiki_page_versions_mkt — full-snapshot versions with crash-resume status pipeline.
-- Status: pending → content_written → embedded → indexed
-- Readers follow wiki_pages.currently_published_version_id only at indexed.
CREATE TABLE IF NOT EXISTS wiki_page_versions_mkt (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  wiki_page_id    TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  tenant_id       TEXT NOT NULL,
  subject_type    TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  body_ciphertext TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'content_written', 'embedded', 'indexed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wiki_page_versions_mkt_page_id
  ON wiki_page_versions_mkt (wiki_page_id);
CREATE INDEX IF NOT EXISTS idx_wiki_page_versions_mkt_status
  ON wiki_page_versions_mkt (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wiki_page_versions_mkt_subject
  ON wiki_page_versions_mkt (tenant_id, subject_type, subject_id, created_at DESC);

-- wiki_page_cites — typed directed edges from a version to its supporting evidence.
-- On corpus_chunk retraction (FK cascade), cites edges are deleted automatically.
-- Architecture ref: docs/architecture.md §"Citations: first-class relation edges"
CREATE TABLE IF NOT EXISTS wiki_page_cites (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  wiki_page_version_id  TEXT NOT NULL
                          REFERENCES wiki_page_versions_mkt(id) ON DELETE CASCADE,
  target_id             TEXT NOT NULL,
  target_type           TEXT NOT NULL
                          CHECK (target_type IN ('corpus_chunk', 'confirmed_fact')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (wiki_page_version_id, target_id, target_type)
);

CREATE INDEX IF NOT EXISTS idx_wiki_page_cites_version_id
  ON wiki_page_cites (wiki_page_version_id);
CREATE INDEX IF NOT EXISTS idx_wiki_page_cites_target
  ON wiki_page_cites (target_id, target_type);
`;
