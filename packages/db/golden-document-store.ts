/**
 * @file golden-document-store.ts
 *
 * DB access layer for the `golden_documents` and `golden_document_sections`
 * tables (issue #73, PRD §6 §9).
 *
 * ## Author-only enforcement (three layers)
 *
 *   1. API layer  — callers must check session role before calling these functions.
 *   2. RLS policy — `golden_documents_researcher_only` (RESTRICTIVE) and
 *                   `golden_documents_tenant_isolation` applied in init-remote.ts.
 *   3. Trigger    — `guard_golden_document_writer` fires on INSERT/UPDATE; requires
 *                   `app.current_role = 'researcher'` in the session config.
 *
 * Callers must wrap write calls in `withRlsContext(sql, { role: 'researcher', … }, …)`
 * so that all three enforcement layers are satisfied.
 *
 * ## Revision lifecycle
 *
 * A document advances through: authored → active → retired.
 * `activateGoldenDocument` retires all previous active documents of the same
 * (kind, author_id, tenant_id) before setting the new one to 'active', so that
 * at most one document per kind is active at any time.
 *
 * ## Canonical docs
 *
 * - `docs/prd.md` §9 — golden documents are author-only forever.
 * - `docs/architecture.md` — data tier, per-pool role isolation.
 * - `docs/implementation-plan.md` Phase 2 — golden-document tables and
 *   author-only enforcement.
 */

import type postgres from 'postgres';

export type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// Document kind
// ---------------------------------------------------------------------------

/**
 * The two golden document kinds defined by PRD §9.
 *
 * - `industry_definition` — Alice's definition of the industry, sectors, and
 *   sub-sectors she covers.
 * - `research_methodology` — Alice's methodology for how she evaluates
 *   companies and catalysts.
 */
export type GoldenDocumentKind = 'industry_definition' | 'research_methodology';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/**
 * A row in the `golden_documents` table.
 */
export interface GoldenDocumentRow {
  /** Primary key — generated UUID. */
  id: string;
  /** The kind of golden document. */
  kind: GoldenDocumentKind;
  /**
   * The researcher who authored this document.
   * References `entities.id` where the entity type is `user`.
   */
  author_id: string;
  /**
   * Tenant the document belongs to. Used by the tenant-scoped RLS policy.
   */
  tenant_id: string;
  /** Free-text title provided by the researcher. */
  title: string;
  /**
   * Lifecycle state.
   * - `authored` — written but not yet active.
   * - `active`   — the current live version used by agents.
   * - `retired`  — superseded by a newer version.
   */
  state: 'authored' | 'active' | 'retired';
  created_at: Date;
  updated_at: Date;
}

/**
 * A row in the `golden_document_sections` table.
 */
export interface GoldenDocumentSectionRow {
  id: string;
  document_id: string;
  section_key: string;
  content: string;
  position: number;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Write request shapes
// ---------------------------------------------------------------------------

/**
 * Validated fields accepted by `createGoldenDocument`.
 *
 * The caller is responsible for verifying that the actor is a researcher
 * before calling this function and for wrapping the call in `withRlsContext`
 * with `{ role: 'researcher' }` so the trigger and RLS policy are satisfied.
 */
export interface CreateGoldenDocumentInput {
  kind: GoldenDocumentKind;
  author_id: string;
  tenant_id: string;
  title: string;
}

/**
 * Upsert a section on an existing golden document.
 */
export interface UpsertGoldenDocumentSectionInput {
  document_id: string;
  section_key: string;
  content: string;
  position?: number;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Create a new golden document row in 'authored' state.
 *
 * Must be called inside `withRlsContext(sql, { role: 'researcher', … }, …)` so
 * that the `guard_golden_document_writer` trigger and
 * `golden_documents_researcher_only` RLS policy are satisfied.
 *
 * A `golden_document.created` journal event is written by the API layer; this
 * function only performs the INSERT.
 */
export async function createGoldenDocument(
  sql: SqlClient,
  input: CreateGoldenDocumentInput,
): Promise<GoldenDocumentRow> {
  const rows = await sql<GoldenDocumentRow[]>`
    INSERT INTO golden_documents (kind, author_id, tenant_id, title, state)
    VALUES (
      ${input.kind},
      ${input.author_id},
      ${input.tenant_id},
      ${input.title},
      'authored'
    )
    RETURNING id, kind, author_id, tenant_id, title, state, created_at, updated_at
  `;
  return rows[0];
}

/**
 * Fetch a golden document by primary key.
 *
 * Reads through RLS — the session must have `app.current_tenant_id` set so the
 * tenant-isolation policy passes. No role restriction on reads.
 *
 * Returns `null` when no matching row is found (either non-existent or outside
 * the current tenant scope).
 */
export async function getGoldenDocument(
  sql: SqlClient,
  id: string,
): Promise<GoldenDocumentRow | null> {
  const rows = await sql<GoldenDocumentRow[]>`
    SELECT id, kind, author_id, tenant_id, title, state, created_at, updated_at
    FROM golden_documents
    WHERE id = ${id}
  `;
  return rows[0] ?? null;
}

/**
 * List all golden documents for a researcher within a tenant.
 *
 * Returns rows ordered by created_at DESC (newest first).
 */
export async function listGoldenDocuments(
  sql: SqlClient,
  authorId: string,
  tenantId: string,
): Promise<GoldenDocumentRow[]> {
  return sql<GoldenDocumentRow[]>`
    SELECT id, kind, author_id, tenant_id, title, state, created_at, updated_at
    FROM golden_documents
    WHERE author_id = ${authorId}
      AND tenant_id = ${tenantId}
    ORDER BY created_at DESC
  `;
}

/**
 * Advance a golden document from 'authored' or 'active' to 'active', retiring
 * any previously active document of the same (kind, author_id, tenant_id).
 *
 * Must be called inside a `withRlsContext` transaction with role: 'researcher'.
 *
 * Returns the updated document row.
 */
export async function activateGoldenDocument(
  sql: SqlClient,
  id: string,
  authorId: string,
  tenantId: string,
): Promise<GoldenDocumentRow | null> {
  // Fetch the target document first to get its kind.
  const targetRows = await sql<Pick<GoldenDocumentRow, 'kind'>[]>`
    SELECT kind FROM golden_documents WHERE id = ${id} AND author_id = ${authorId} AND tenant_id = ${tenantId}
  `;
  if (targetRows.length === 0) return null;
  const { kind } = targetRows[0];

  // Retire any currently active documents of the same kind for this author+tenant.
  await sql`
    UPDATE golden_documents
    SET state = 'retired', updated_at = CURRENT_TIMESTAMP
    WHERE kind = ${kind}
      AND author_id = ${authorId}
      AND tenant_id = ${tenantId}
      AND state = 'active'
      AND id != ${id}
  `;

  // Activate the target document.
  const rows = await sql<GoldenDocumentRow[]>`
    UPDATE golden_documents
    SET state = 'active', updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
      AND author_id = ${authorId}
      AND tenant_id = ${tenantId}
      AND state IN ('authored', 'active')
    RETURNING id, kind, author_id, tenant_id, title, state, created_at, updated_at
  `;
  return rows[0] ?? null;
}

/**
 * Retire a golden document explicitly (set state to 'retired').
 *
 * Must be called inside a `withRlsContext` transaction with role: 'researcher'.
 */
export async function retireGoldenDocument(
  sql: SqlClient,
  id: string,
  authorId: string,
  tenantId: string,
): Promise<GoldenDocumentRow | null> {
  const rows = await sql<GoldenDocumentRow[]>`
    UPDATE golden_documents
    SET state = 'retired', updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
      AND author_id = ${authorId}
      AND tenant_id = ${tenantId}
      AND state != 'retired'
    RETURNING id, kind, author_id, tenant_id, title, state, created_at, updated_at
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Section operations
// ---------------------------------------------------------------------------

/**
 * Upsert a section on a golden document.
 *
 * Uses INSERT … ON CONFLICT (document_id, section_key) DO UPDATE to allow
 * idempotent section writes. Must be called inside a researcher RLS context.
 */
export async function upsertGoldenDocumentSection(
  sql: SqlClient,
  input: UpsertGoldenDocumentSectionInput,
): Promise<GoldenDocumentSectionRow> {
  const rows = await sql<GoldenDocumentSectionRow[]>`
    INSERT INTO golden_document_sections (document_id, section_key, content, position)
    VALUES (
      ${input.document_id},
      ${input.section_key},
      ${input.content},
      ${input.position ?? 0}
    )
    ON CONFLICT (document_id, section_key) DO UPDATE
      SET content = EXCLUDED.content,
          position = EXCLUDED.position,
          updated_at = CURRENT_TIMESTAMP
    RETURNING id, document_id, section_key, content, position, created_at, updated_at
  `;
  return rows[0];
}

/**
 * List sections for a golden document, ordered by position ASC.
 */
export async function listGoldenDocumentSections(
  sql: SqlClient,
  documentId: string,
): Promise<GoldenDocumentSectionRow[]> {
  return sql<GoldenDocumentSectionRow[]>`
    SELECT id, document_id, section_key, content, position, created_at, updated_at
    FROM golden_document_sections
    WHERE document_id = ${documentId}
    ORDER BY position ASC, section_key ASC
  `;
}

// ---------------------------------------------------------------------------
// Unified retrieval
// ---------------------------------------------------------------------------

/**
 * Unified retrieval result: active wiki version, latest non-superseded facts,
 * and top-k embedded chunks for a subject in one call (issue #73 AC-3).
 *
 * `wikiContent` — content of the active golden document matching `kind` for
 *   the given (authorId, tenantId), or null when no active document exists.
 * `sections` — ordered list of sections for the active document.
 * `document` — the active GoldenDocumentRow, or null.
 */
export interface UnifiedRetrievalResult {
  document: GoldenDocumentRow | null;
  sections: GoldenDocumentSectionRow[];
}

/**
 * Retrieve the active golden document and its sections for a given kind,
 * author, and tenant. Returns null document when no active document exists.
 *
 * This is the unified retrieval endpoint used by agents and the researcher UI.
 * Because golden documents are author-only, only one active document per
 * (kind, author_id, tenant_id) should exist — the query takes the most recently
 * activated one if there are multiple (should not happen in steady state).
 */
export async function fetchActiveGoldenDocument(
  sql: SqlClient,
  kind: GoldenDocumentKind,
  authorId: string,
  tenantId: string,
): Promise<UnifiedRetrievalResult> {
  const docs = await sql<GoldenDocumentRow[]>`
    SELECT id, kind, author_id, tenant_id, title, state, created_at, updated_at
    FROM golden_documents
    WHERE kind = ${kind}
      AND author_id = ${authorId}
      AND tenant_id = ${tenantId}
      AND state = 'active'
    ORDER BY updated_at DESC
    LIMIT 1
  `;

  if (docs.length === 0) {
    return { document: null, sections: [] };
  }

  const document = docs[0];
  const sections = await listGoldenDocumentSections(sql, document.id);
  return { document, sections };
}
