/**
 * @file golden-document-store.ts
 *
 * Scout stub — Phase 2 golden-document DB seam (issue #72).
 *
 * ## Purpose
 *
 * This file is a **no-op stub** introduced by the dev-scout issue that proves
 * the golden-document write-path end-to-end. It defines the data types,
 * interfaces, and function signatures for the `golden_documents` table and its
 * author-only enforcement without implementing the real DB layer.
 *
 * The real implementation will land in the Phase 2 follow-on issue
 * ("Golden-document tables and author-only enforcement"). That issue will:
 *   1. Add the `golden_documents` and `golden_document_sections` DDL to
 *      `schema.sql`.
 *   2. Enable RLS on both tables with a `researcher_only` policy that checks
 *      `current_setting('app.current_role', true) = 'researcher'`.
 *   3. Add a trigger backstop (`guard_golden_document_writer`) that re-validates
 *      the current role at the DB layer so even a direct `app_rw` connection
 *      cannot bypass the API check.
 *   4. Replace every `throw new Error('Not implemented...')` below with the
 *      real SQL.
 *
 * ## Canonical docs
 *
 * - `docs/prd.md` §9 — golden documents are author-only forever; agents hold
 *   read-only access enforced at the API, RLS, and trigger layers.
 * - `docs/architecture.md` — data tier, per-pool role isolation.
 * - `docs/implementation-plan.md` Phase 2 — "golden-document write path
 *   end-to-end" scout, "Golden-document tables and author-only enforcement"
 *   follow-on.
 *
 * ## Discovered integration points
 *
 * - `rls-context.ts` — `withRlsContext()` will need a new `role` field (e.g.
 *   `'researcher'`) so the RLS policy can distinguish researcher sessions from
 *   worker sessions using `current_setting('app.current_role', true)`.
 *   Alternatively a dedicated `SET LOCAL app.current_role` can be added inside
 *   the researcher session binding without touching `RlsSessionContext`.
 * - `init-remote.ts` — `CUSTOMER_SCOPED_TABLES` must be extended with
 *   `'golden_documents'` and `'golden_document_sections'` so that
 *   `configureCustomerScopedRls()` enables RLS on both tables at provision time.
 * - `schema.sql` — DDL for `golden_documents` and `golden_document_sections`
 *   plus the `guard_golden_document_writer` trigger function and trigger.
 * - `business-journal.ts` — denied worker writes must be journalled via
 *   `writeJournalEvent` with `event_type = 'golden_document.write_denied'`.
 *   The API layer is responsible for writing the denial event before rejecting
 *   the request; the DB trigger backstop should also raise an error that the
 *   API layer catches and converts into a journal entry.
 *
 * ## Known risks
 *
 * - Worker DB role (`agent_worker`) must never receive INSERT/UPDATE on
 *   `golden_documents`. The `init-remote.ts` provisioning step must
 *   explicitly REVOKE those privileges after the GRANT ALL used during
 *   table creation.
 * - The trigger backstop must be created as SECURITY DEFINER with the owner
 *   set to the admin role so it can read the per-session config variable even
 *   when called through `app_rw`.
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
// Row shape
// ---------------------------------------------------------------------------

/**
 * A row in the `golden_documents` table.
 *
 * Phase 2 follow-on will add `golden_document_sections` with the
 * per-section content and revision lifecycle (Authored → Active → Retired).
 */
export interface GoldenDocumentRow {
  /** Primary key — generated UUID. */
  id: string;
  /** The kind of golden document. */
  kind: GoldenDocumentKind;
  /**
   * The researcher who authored this document.
   *
   * References `entities.id` where the entity type is `user`.  The API layer
   * and RLS policy must agree that only the owner researcher may write.
   */
  author_id: string;
  /**
   * Tenant the document belongs to.  Used by the tenant-scoped RLS policy.
   */
  tenant_id: string;
  /** Free-text title provided by the researcher. */
  title: string;
  /**
   * Lifecycle state.
   *
   * - `authored` — written but not yet active.
   * - `active`   — the current live version used by agents.
   * - `retired`  — superseded by a newer version.
   *
   * Full lifecycle is implemented in the Phase 2 authoring surface follow-on.
   */
  state: 'authored' | 'active' | 'retired';
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Write request
// ---------------------------------------------------------------------------

/**
 * Validated fields accepted by `createGoldenDocument`.
 *
 * The caller is responsible for verifying that the actor is a researcher
 * before calling this function.  The function itself does NOT enforce
 * authorship — enforcement is layered:
 *
 *   1. API layer  — check session role before calling this function.
 *   2. RLS policy — `researcher_only` policy on `golden_documents`.
 *   3. Trigger    — `guard_golden_document_writer` fires on INSERT/UPDATE.
 */
export interface CreateGoldenDocumentInput {
  kind: GoldenDocumentKind;
  author_id: string;
  tenant_id: string;
  title: string;
}

// ---------------------------------------------------------------------------
// Stub implementations
// ---------------------------------------------------------------------------

/**
 * Create a new golden document row.
 *
 * **Scout stub** — throws `Error('Not implemented')`.
 * The real implementation will INSERT into `golden_documents` inside a
 * transaction that also calls `writeJournalEvent` with
 * `event_type = 'golden_document.created'`.
 *
 * Canonical docs: `docs/implementation-plan.md` Phase 2 follow-on.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function createGoldenDocument(
  _sql: SqlClient,
  _input: CreateGoldenDocumentInput,
): Promise<GoldenDocumentRow> {
  throw new Error(
    'Not implemented — golden_documents table DDL and author-only enforcement are ' +
      'the Phase 2 follow-on issue. Scout stub only.',
  );
}

/**
 * Fetch a golden document by primary key.
 *
 * **Scout stub** — throws `Error('Not implemented')`.
 * The real implementation will SELECT from `golden_documents` through
 * `withRlsContext` so the tenant-scoped RLS policy filters results.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function getGoldenDocument(
  _sql: SqlClient,
  _id: string,
): Promise<GoldenDocumentRow | null> {
  throw new Error(
    'Not implemented — golden_documents table DDL and author-only enforcement are ' +
      'the Phase 2 follow-on issue. Scout stub only.',
  );
}

/**
 * List golden documents for a researcher within a tenant.
 *
 * **Scout stub** — throws `Error('Not implemented')`.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function listGoldenDocuments(
  _sql: SqlClient,
  _authorId: string,
  _tenantId: string,
): Promise<GoldenDocumentRow[]> {
  throw new Error(
    'Not implemented — golden_documents table DDL and author-only enforcement are ' +
      'the Phase 2 follow-on issue. Scout stub only.',
  );
}
