/**
 * @file canonical-source-store.ts
 *
 * DB access layer for the `canonical_sources` table (issue #74, PRD §3 §5).
 *
 * ## What this module does
 *
 * Exposes typed read/write helpers for `canonical_sources`. The discovery
 * worker reads the active Research Methodology golden document (read-only)
 * and calls `registerCanonicalSource` via the internal API for each venue
 * the methodology designates as authoritative.
 *
 * Workers never call this module directly — they POST to
 * POST /internal/canonical-sources (WORKER-T-001). Only `apps/server` holds
 * DB credentials and calls into this module.
 *
 * ## Idempotency
 *
 * `registerCanonicalSource` uses `INSERT … ON CONFLICT (methodology_id, url)
 * DO NOTHING`, so re-running discovery never creates duplicate rows.
 *
 * ## Status lifecycle
 *
 *   pending  → active    (scraper confirms venue is reachable)
 *   active   → retired   (venue dropped from methodology)
 *
 * The discovery worker registers sources as `pending`. A future scraper-health
 * job promotes them to `active` once the venue responds successfully.
 *
 * ## Canonical docs
 *
 * - `docs/prd.md` §3      — researcher user story: discover and register venues
 * - `docs/prd.md` §5      — core workflow step 2-3
 * - `docs/architecture.md` — mkt_kb schema, four-pool Postgres, WORKER-T-001
 * - `packages/db/mkt-canonical-sources.sql` — DDL
 * - `apps/server/src/api/canonical-source-registration.ts` — internal API endpoint
 * - `apps/worker/src/source-discover-job.ts` — discovery worker job
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/74
 */

import type postgres from 'postgres';

export type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// Status enum
// ---------------------------------------------------------------------------

/**
 * Lifecycle state for a canonical source.
 *
 * - `pending`  — registered by discovery; not yet confirmed reachable.
 * - `active`   — scraper has confirmed the venue is reachable; polling scheduled.
 * - `retired`  — venue dropped from the methodology; no longer polled.
 *
 * @see mkt-canonical-sources.sql for the CHECK constraint definition.
 */
export type CanonicalSourceStatus = 'pending' | 'active' | 'retired';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/**
 * A row in the `canonical_sources` table.
 */
export interface CanonicalSourceRow {
  /** Primary key — generated UUID. */
  id: string;
  /**
   * The research_methodology golden document whose venue catalog produced
   * this row. Soft FK (no CASCADE) — history is retained even after the
   * methodology document is retired.
   */
  methodology_id: string;
  /**
   * Researcher (author) who owns the methodology.
   * Used to scope reads and writes by RLS.
   */
  author_id: string;
  /**
   * Tenant the source belongs to.
   * Used by the tenant-isolation RLS policy.
   */
  tenant_id: string;
  /** Human-readable name extracted from the methodology (e.g. "SEC EDGAR"). */
  name: string;
  /** Canonical URL for the venue as declared in the methodology. */
  url: string;
  /**
   * Optional short description extracted from the methodology text.
   * null when the methodology did not supply one.
   */
  description: string | null;
  /**
   * Access mode declared in the methodology.
   * `public`          — no authentication required.
   * `authenticated`   — session / cookie-based auth.
   * `api_key`         — machine-readable API key.
   * null              — not declared in the methodology.
   */
  access_mode: 'public' | 'authenticated' | 'api_key' | null;
  /** Current lifecycle state. */
  status: CanonicalSourceStatus;
  created_at: Date;
  updated_at: Date;
  /** Research topic scope (issue #121). Null for legacy rows not yet migrated. */
  topic_id: string | null;
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

/**
 * Input accepted by `registerCanonicalSource`.
 *
 * The discovery worker extracts these fields from the active Research
 * Methodology and POSTs them to the internal registration endpoint.
 */
export interface RegisterCanonicalSourceInput {
  methodology_id: string;
  author_id: string;
  tenant_id: string;
  name: string;
  url: string;
  description?: string | null;
  access_mode?: 'public' | 'authenticated' | 'api_key' | null;
  /** Optional research topic scope (issue #121). When provided, the canonical
   *  source is associated with the given topic. Callers that cannot supply a
   *  topic_id should resolve the tenant's Default topic via
   *  `getDefaultTopicIdForTenant` and pass it here. */
  topic_id?: string | null;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Register a venue as a canonical source.
 *
 * Uses `INSERT … ON CONFLICT (methodology_id, url) DO NOTHING` so that
 * re-running discovery never creates duplicate rows. The new row starts in
 * `pending` status; a future scraper-health pass promotes it to `active`.
 *
 * Returns the existing or newly inserted row.
 *
 * ## Integration point
 *
 * Called by `apps/server/src/api/canonical-source-registration.ts` (the
 * POST /internal/canonical-sources handler). Workers reach this via HTTP,
 * not direct DB access (WORKER-T-001).
 *
 * ## TODO (Phase 3 full implementation)
 *
 * - Add RLS context wrapping once the researcher-scoping policy is applied
 *   to `canonical_sources` (analogous to `golden_documents`).
 * - Validate that `methodology_id` references an active `research_methodology`
 *   golden document before inserting.
 */
export async function registerCanonicalSource(
  sql: SqlClient,
  input: RegisterCanonicalSourceInput,
): Promise<CanonicalSourceRow> {
  // Attempt to insert; silently skip on conflict (idempotency).
  await sql`
    INSERT INTO canonical_sources
      (methodology_id, author_id, tenant_id, name, url, description, access_mode, status, topic_id)
    VALUES (
      ${input.methodology_id},
      ${input.author_id},
      ${input.tenant_id},
      ${input.name},
      ${input.url},
      ${input.description ?? null},
      ${input.access_mode ?? null},
      'pending',
      ${input.topic_id ?? null}
    )
    ON CONFLICT (methodology_id, url) DO NOTHING
  `;

  // Return the row (pre-existing or newly inserted).
  const rows = await sql<CanonicalSourceRow[]>`
    SELECT id, methodology_id, author_id, tenant_id, name, url,
           description, access_mode, status, topic_id, created_at, updated_at
    FROM canonical_sources
    WHERE methodology_id = ${input.methodology_id}
      AND url            = ${input.url}
  `;

  // The row must exist at this point — either we just inserted it or it
  // already existed and the conflict guard returned it.
  if (rows.length === 0) {
    throw new Error(
      `canonical_sources: row not found after insert for methodology_id=${input.methodology_id} url=${input.url}`,
    );
  }
  return rows[0];
}

/**
 * Advance a canonical source from `pending` to `active`.
 *
 * Called by the scraper-health worker (Phase 3 full implementation) once it
 * confirms the venue is reachable. Idempotent: if the source is already
 * `active`, the row is returned unchanged.
 *
 * ## TODO (Phase 3 full implementation)
 *
 * Wire this into the scraper-health worker job once that job is built.
 */
export async function activateCanonicalSource(
  sql: SqlClient,
  id: string,
): Promise<CanonicalSourceRow | null> {
  const rows = await sql<CanonicalSourceRow[]>`
    UPDATE canonical_sources
    SET status = 'active', updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
      AND status IN ('pending', 'active')
    RETURNING id, methodology_id, author_id, tenant_id, name, url,
              description, access_mode, status, topic_id, created_at, updated_at
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Fetch a single canonical source by primary key.
 *
 * Returns `null` when no row matches (non-existent or outside tenant scope).
 */
export async function getCanonicalSource(
  sql: SqlClient,
  id: string,
): Promise<CanonicalSourceRow | null> {
  const rows = await sql<CanonicalSourceRow[]>`
    SELECT id, methodology_id, author_id, tenant_id, name, url,
           description, access_mode, status, topic_id, created_at, updated_at
    FROM canonical_sources
    WHERE id = ${id}
  `;
  return rows[0] ?? null;
}

/**
 * List all canonical sources for a methodology document.
 *
 * Ordered by `created_at ASC` (registration order) so that logs and tests
 * produce deterministic output.
 *
 * @param methodologyId  The golden document ID of the research_methodology.
 * @param status         When supplied, filters to the given status.
 */
export async function listCanonicalSourcesByMethodology(
  sql: SqlClient,
  methodologyId: string,
  status?: CanonicalSourceStatus,
): Promise<CanonicalSourceRow[]> {
  if (status !== undefined) {
    return sql<CanonicalSourceRow[]>`
      SELECT id, methodology_id, author_id, tenant_id, name, url,
             description, access_mode, status, topic_id, created_at, updated_at
      FROM canonical_sources
      WHERE methodology_id = ${methodologyId}
        AND status = ${status}
      ORDER BY created_at ASC
    `;
  }

  return sql<CanonicalSourceRow[]>`
    SELECT id, methodology_id, author_id, tenant_id, name, url,
           description, access_mode, status, topic_id, created_at, updated_at
    FROM canonical_sources
    WHERE methodology_id = ${methodologyId}
    ORDER BY created_at ASC
  `;
}

// ---------------------------------------------------------------------------
// Admin scope adjustment (issue #89)
// ---------------------------------------------------------------------------

/**
 * Input for Admin scope adjustments on a canonical source.
 */
export interface UpdateSourceScopeInput {
  /** New access mode for the source. */
  access_mode?: 'public' | 'authenticated' | 'api_key' | null;
  /** Optional human-readable note stored in audit trail. */
  reason?: string | null;
}

/**
 * Update the access_mode (scope) of a canonical source.
 *
 * Returns the updated row, or null when the source does not exist.
 *
 * ## Integration point
 *
 * Called by `PATCH /api/admin/sources/:id/scope` after the caller emits a
 * `source.scope_adjusted` business_journal event.
 *
 * @see apps/server/src/api/admin-source-scope-api.ts
 */
export async function updateSourceScope(
  sql: SqlClient,
  id: string,
  input: UpdateSourceScopeInput,
): Promise<CanonicalSourceRow | null> {
  const rows = await sql<CanonicalSourceRow[]>`
    UPDATE canonical_sources
    SET
      access_mode = COALESCE(${input.access_mode ?? null}, access_mode),
      updated_at  = CURRENT_TIMESTAMP
    WHERE id = ${id}
    RETURNING id, methodology_id, author_id, tenant_id, name, url,
              description, access_mode, status, topic_id, created_at, updated_at
  `;
  return rows[0] ?? null;
}

/**
 * List all canonical sources across all tenants (admin read path).
 *
 * Ordered by updated_at DESC. The admin view bypasses tenant-scoped RLS
 * because this query is executed by the app pool with the admin session.
 *
 * @param limit   Max rows to return (default 100).
 * @param offset  Pagination offset (default 0).
 */
export async function listAllCanonicalSources(
  sql: SqlClient,
  limit = 100,
  offset = 0,
): Promise<CanonicalSourceRow[]> {
  return sql<CanonicalSourceRow[]>`
    SELECT id, methodology_id, author_id, tenant_id, name, url,
           description, access_mode, status, topic_id, created_at, updated_at
    FROM canonical_sources
    ORDER BY updated_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
}

// ---------------------------------------------------------------------------
// DDL helper (used by migrateMkt in packages/db/index.ts)
// ---------------------------------------------------------------------------

/**
 * Inline DDL string for the `canonical_sources` table.
 *
 * Identical to `mkt-canonical-sources.sql` but available as an importable
 * constant so `migrateMkt` can apply it programmatically (same pattern as
 * `CORPORATE_ACTION_DDL` in `mkt-corporate-action.ts`).
 *
 * ## Canonical docs
 *
 * - `packages/db/mkt-canonical-sources.sql` — the authoritative DDL source
 * - `packages/db/mkt-corporate-action.ts`   — reference pattern
 */
export const CANONICAL_SOURCES_DDL = `
CREATE TABLE IF NOT EXISTS canonical_sources (
  id               TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  methodology_id   TEXT        NOT NULL,
  author_id        TEXT        NOT NULL,
  tenant_id        TEXT        NOT NULL,
  name             TEXT        NOT NULL,
  url              TEXT        NOT NULL,
  description      TEXT,
  access_mode      TEXT        CHECK (access_mode IN ('public', 'authenticated', 'api_key')),
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'active', 'retired')),
  UNIQUE (methodology_id, url),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_canonical_sources_methodology_id
  ON canonical_sources (methodology_id, status);

CREATE INDEX IF NOT EXISTS idx_canonical_sources_author_tenant
  ON canonical_sources (author_id, tenant_id, status);
`;
