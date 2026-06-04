/**
 * @file pipeline-health-api.ts
 *
 * Pipeline-health view: source state and queue depth — Phase (Admin,
 * cost envelope, and replay) scout stub (issue #88).
 *
 * ## What this file does (stub)
 *
 * This is a no-op stub that defines the response types and handler signature
 * for the pipeline-health view endpoint. The full implementation (live DB
 * queries, real queue depth, per-source status aggregation) is a phase feature
 * issue.
 *
 * The stub:
 *   - Defines `PipelineHealthResponse` and `SourceHealthEntry` (the contract
 *     that the admin panel health view depends on).
 *   - Implements `handlePipelineHealthRequest` which validates admin auth and
 *     returns a 501 stub response in non-TEST mode.
 *   - Enforces admin-scoped session gate: non-admin callers receive 403 now,
 *     so the auth seam is tested before the full feature lands.
 *   - Does NOT yet query canonical_sources or task_queue for live data.
 *
 * ## Security model
 *
 * Session cookie authentication is required. The caller must hold a session
 * whose user entity has `properties.role === 'admin'` (or is a superuser).
 * Non-admin sessions receive 403 before any data is returned.
 *
 * ## Route contract
 *
 *   GET /api/admin/pipeline-health
 *     Cookie: <session-cookie>
 *   →  200 PipelineHealthResponse                (full implementation)
 *   →  401 { error: "…" }                        (not authenticated)
 *   →  403 { error: "…" }                        (not admin)
 *   →  501 { error: "…" }                        (stub: awaiting full impl)
 *
 *   GET /api/admin/pipeline-health/sources/:id
 *     Cookie: <session-cookie>
 *   →  200 SourceHealthEntry                     (full implementation)
 *   →  401 { error: "…" }                        (not authenticated)
 *   →  403 { error: "…" }                        (not admin)
 *   →  404 { error: "…" }                        (source not found)
 *   →  501 { error: "…" }                        (stub: awaiting full impl)
 *
 * ## Integration points discovered
 *
 * - Source state reads from `canonical_sources` (status, updated_at, name,
 *   url). The health view aggregates rows across tenants for the admin
 *   perspective — RLS must be bypassed via the app pool (no row-level
 *   tenant filter on the admin read path).
 * - Queue depth reads from `task_queue WHERE status IN ('pending', 'claimed')`
 *   grouped by `agent_type`. The SOURCE_DISCOVER agent_type is the primary
 *   interest for this phase; future phases will surface WIKI_REBUILD and
 *   STANDING_PROMPT_DISTILL depths as well.
 * - The health view must reflect scope adjustments made via
 *   `admin-source-scope-api.ts` without caching lag. A short TTL (e.g. 5 s)
 *   or no caching is appropriate for admin health views.
 * - SSE streaming (like replay.ts GET /api/replay/stream) is a natural
 *   evolution path for live health updates; the stub should not block that
 *   shape by defining a non-streaming response contract.
 * - The admin panel (apps/admin) will poll or subscribe to this endpoint to
 *   render a source-health table. The frontend dependency does not exist yet.
 *
 * ## Risks captured
 *
 * - Queue depth query over `task_queue` may be expensive without an index on
 *   `(agent_type, status)`. The full implementation must verify index coverage
 *   before enabling the endpoint in production (DATA-D-007).
 * - Aggregating across all tenants bypasses RLS; the app pool user must have
 *   explicit SELECT on canonical_sources and task_queue without the tenant_id
 *   filter. This is intentional for admin reads but must be documented in the
 *   RLS policy notes (AUTH-C-002).
 * - The health view shape (per-source vs. aggregate) is not yet validated
 *   against admin panel UX requirements. The phase design should confirm the
 *   granularity before the DB query is written.
 *
 * ## Canonical docs
 *
 * - `docs/prd.md`              — Admin user story, pipeline health display
 * - `docs/architecture.md`     — Admin role, mkt_kb schema, task-queue
 * - `docs/implementation-plan.md` — Phase: Admin, cost envelope, and replay
 * - `packages/db/canonical-source-store.ts` — DB access layer for sources
 * - `packages/db/task-queue.ts` — task_queue schema and TaskType enum
 * - `apps/server/src/api/admin-source-scope-api.ts` — companion scope endpoint
 * - `apps/server/src/api/health.ts` — system-level health check (DEPLOY-C-030/032)
 * - `apps/server/src/api/replay.ts` — isAdminOrSuperuser auth pattern
 * - `tests/integration/admin-source-scope.spec.ts` — integration tests
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/88
 *
 * ## TODO (phase full implementation)
 *
 * - Query canonical_sources: SELECT id, name, url, status, access_mode,
 *   updated_at FROM canonical_sources ORDER BY updated_at DESC.
 * - Query task_queue: SELECT agent_type, COUNT(*) AS depth FROM task_queue
 *   WHERE status IN ('pending', 'claimed') GROUP BY agent_type.
 * - Merge the two result sets into PipelineHealthResponse.
 * - Add a short in-memory TTL cache (5 s) to avoid thundering-herd on
 *   repeated admin panel polls.
 * - Consider SSE streaming for live updates (follow-on issue).
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';

// ---------------------------------------------------------------------------
// Role check helper (identical pattern to replay.ts and admin-source-scope-api.ts)
// ---------------------------------------------------------------------------

/**
 * Returns true when the user is a superuser or has the 'admin' role.
 *
 * ## Integration point
 *
 * Duplicated from admin-source-scope-api.ts intentionally for scout isolation.
 * The phase implementation should extract this into `apps/server/src/lib/access.ts`.
 */
async function isAdminOrSuperuser(sql: AppState['sql'], userId: string): Promise<boolean> {
  if (isSuperuser(userId)) return true;

  const rows = await sql<{ role: string }[]>`
    SELECT (properties->>'role') AS role
    FROM entities
    WHERE id = ${userId} AND type = 'user'
    LIMIT 1
  `;
  const role = rows[0]?.role ?? '';
  return role === 'admin';
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/**
 * Per-source health entry in the pipeline-health view.
 *
 * One entry per canonical_sources row. The `queue_depth` field reflects
 * the number of pending/claimed SOURCE_DISCOVER tasks for this source.
 *
 * ## TODO (phase full implementation)
 *
 * Add `last_scraped_at` (timestamp of most recent successful scrape),
 * `error_count` (consecutive scrape failures), and `next_scheduled_at`
 * (next planned poll) once the scraper-health worker is built.
 */
export interface SourceHealthEntry {
  /** Primary key of the canonical_sources row. */
  id: string;
  /** Human-readable source name (e.g. "SEC EDGAR"). */
  name: string;
  /** Canonical URL for the venue. */
  url: string;
  /**
   * Current lifecycle state of the source.
   * One of: "pending" | "active" | "retired"
   */
  status: 'pending' | 'active' | 'retired';
  /**
   * Current access mode (scope) of the source.
   * null when not yet declared.
   */
  access_mode: 'public' | 'authenticated' | 'api_key' | null;
  /**
   * Number of pending or claimed SOURCE_DISCOVER tasks for this source.
   * 0 when no tasks are queued.
   *
   * ## TODO (phase full implementation)
   *
   * Join task_queue on source_id (requires task payload to carry source_id)
   * or group by agent_type='source_discovery' at the aggregate level.
   */
  queue_depth: number;
  /** ISO-8601 timestamp of the most recent status or scope change. */
  updated_at: string;
}

/**
 * Response body for GET /api/admin/pipeline-health.
 *
 * Provides a summary of source states and task-queue depths.
 *
 * ## TODO (phase full implementation)
 *
 * Add `cost_envelope` (current cost-period spend vs. limit) once the cost
 * enforcement feature lands in this phase.
 */
export interface PipelineHealthResponse {
  /**
   * Ordered list of source health entries (most recently updated first).
   */
  sources: SourceHealthEntry[];
  /**
   * Aggregate queue depths by agent_type.
   *
   * Example:
   *   { source_discovery: 3, wiki_rebuild: 12, sp_distiller: 1 }
   */
  queue_depths: Record<string, number>;
  /** ISO-8601 timestamp when this snapshot was generated. */
  as_of: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle GET /api/admin/pipeline-health and
 *        GET /api/admin/pipeline-health/sources/:id.
 *
 * Returns null when the request path does not match so the caller can fall
 * through to the next handler.
 *
 * ## Stub note (issue #88)
 *
 * This handler enforces admin authentication but does not yet query the DB.
 * It returns 501 in non-TEST mode to make the missing implementation visible
 * rather than silently returning stale or empty data.
 *
 * The admin auth gate (401/403) is fully functional now, so integration tests
 * can verify the access-control seam before the feature is built.
 */
export async function handlePipelineHealthRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/admin/pipeline-health')) return null;
  if (req.method !== 'GET') return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  // ── Session auth ──────────────────────────────────────────────────────────
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return json({ error: 'Unauthorized — session required' }, 401);
  }

  // ── Admin role check ──────────────────────────────────────────────────────
  const isAdmin = await isAdminOrSuperuser(sql, user.id);
  if (!isAdmin) {
    return json({ error: 'Forbidden — admin role required' }, 403);
  }

  // ── Route: GET /api/admin/pipeline-health/sources/:id ────────────────────
  const sourceMatch = url.pathname.match(/^\/api\/admin\/pipeline-health\/sources\/([^/]+)$/);
  if (sourceMatch) {
    const sourceId = sourceMatch[1]!;
    void sourceId; // used in full implementation

    // TODO (phase full implementation): query canonical_sources WHERE id = sourceId
    // and join task_queue queue depth. Return 404 if not found.
    return json(
      {
        error: 'Not implemented — per-source pipeline health is a phase follow-on (issue #88)',
      },
      501,
    );
  }

  // ── Route: GET /api/admin/pipeline-health ─────────────────────────────────
  if (url.pathname === '/api/admin/pipeline-health') {
    // TODO (phase full implementation):
    //   1. SELECT id, name, url, status, access_mode, updated_at
    //      FROM canonical_sources ORDER BY updated_at DESC.
    //   2. SELECT agent_type, COUNT(*) AS depth
    //      FROM task_queue WHERE status IN ('pending', 'claimed')
    //      GROUP BY agent_type.
    //   3. Merge into PipelineHealthResponse and return 200.
    return json(
      {
        error: 'Not implemented — pipeline health view is a phase follow-on (issue #88)',
      },
      501,
    );
  }

  return null;
}
