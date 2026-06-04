/**
 * @file admin-source-scope-api.ts
 *
 * Admin API: source-scope adjustment and admin auth enforcement — Phase (Admin,
 * cost envelope, and replay) scout stub (issue #88).
 *
 * ## What this file does (stub)
 *
 * This is a no-op stub that defines the request/response types and the handler
 * signature for the admin source-scope adjustment endpoint. The full
 * implementation (scope mutation, audit trail, pipeline reconciliation) is a
 * phase feature issue.
 *
 * The stub:
 *   - Defines `AdminSourceScopeBody` and `AdminSourceScopeResponse` (the
 *     contract that the admin panel and pipeline depend on).
 *   - Implements `handleAdminSourceScopeRequest` which validates admin auth,
 *     parses the body, and returns a 501 stub response in non-TEST mode.
 *   - Enforces admin-scoped session gate: non-admin callers receive 403 now,
 *     so the auth seam is tested before the full feature lands.
 *   - Does NOT yet apply scope mutation logic (pending phase implementation).
 *
 * ## Security model
 *
 * Session cookie authentication is required. The caller must hold a session
 * whose user entity has `properties.role === 'admin'` (or is a superuser).
 * Non-admin sessions receive 403 before any business logic is reached.
 *
 * ## Route contract
 *
 *   PATCH /api/admin/sources/:id/scope
 *     Cookie: <session-cookie>
 *     Content-Type: application/json
 *     Body: AdminSourceScopeBody
 *   →  200 { source_id, scope, updated_at }     (scope updated — full impl)
 *   →  400 { error: "…" }                        (missing required fields)
 *   →  401 { error: "…" }                        (not authenticated)
 *   →  403 { error: "…" }                        (not admin)
 *   →  404 { error: "…" }                        (source not found)
 *   →  501 { error: "…" }                        (stub: awaiting full impl)
 *
 * ## Integration points discovered
 *
 * - Source scope is stored in `canonical_sources.access_mode` today; a
 *   dedicated `scope` column (or JSONB `scope_config`) may be needed for the
 *   full feature (forward design risk).
 * - Scope change must trigger a `source.scope_adjusted` business_journal event
 *   for the audit trail (AUDIT-C-001). The journal write is a mandatory seam.
 * - Pipeline reconciliation (re-queue stale scrape jobs) must happen as an
 *   async side effect — the HTTP response must not block on worker scheduling.
 * - Auth gate reuses `isAdminOrSuperuser` (same pattern as replay.ts).
 *   The `admin` role value must stay consistent across all admin-gated routes.
 * - CSRF token validation is NOT wired yet; the phase implementation must add
 *   it before mutating state (see `csrf.ts`).
 *
 * ## Risks captured
 *
 * - `canonical_sources` schema has no `scope_config` column today; the full
 *   feature will need a migration. Risk: migration must be additive-only to
 *   avoid downtime (DATA-D-007 additive-migration rule).
 * - The admin panel (apps/admin) will need a dedicated scope-edit form;
 *   that surface does not exist yet (downstream frontend dependency).
 * - Pipeline reconciliation depends on the task-queue schema being stable; if
 *   SOURCE_DISCOVER task semantics change, the reconcile logic will break.
 *
 * ## Canonical docs
 *
 * - `docs/prd.md`              — Admin user story, control surface
 * - `docs/architecture.md`     — Admin role, mkt_kb schema, task-queue
 * - `docs/implementation-plan.md` — Phase: Admin, cost envelope, and replay
 * - `packages/db/canonical-source-store.ts` — DB access layer
 * - `apps/server/src/api/admin.ts` — existing admin endpoints (key/tenant mgmt)
 * - `apps/server/src/api/replay.ts` — isAdminOrSuperuser auth pattern
 * - `apps/server/src/api/pipeline-health-api.ts` — companion health view
 * - `tests/integration/admin-source-scope.spec.ts` — integration tests
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/88
 *
 * ## TODO (phase full implementation)
 *
 * - Add a `scope_config` JSONB column (or extend `access_mode`) to
 *   `canonical_sources` via an additive migration.
 * - Implement scope mutation: UPDATE canonical_sources SET scope_config = …
 * - Emit a `source.scope_adjusted` business_journal event on every change.
 * - Trigger async pipeline reconciliation: re-queue SOURCE_DISCOVER tasks for
 *   the affected source so the pipeline reflects the new scope on next poll.
 * - Add CSRF token validation before the state mutation.
 * - Wire the admin panel UI form in apps/admin to this endpoint.
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import { updateSourceScope, getCanonicalSource } from 'db/canonical-source-store';
import { emitAuditEvent } from '../policies/audit-service';

// ---------------------------------------------------------------------------
// Role check helper (identical pattern to replay.ts)
// ---------------------------------------------------------------------------

/**
 * Returns true when the user is a superuser or has the 'admin' role.
 *
 * ## Integration point
 *
 * The `admin` role string must stay consistent across all admin-gated routes
 * (replay.ts, this file, and any future admin endpoints). If the role value
 * changes, update all call-sites atomically.
 *
 * ## TODO (phase full implementation)
 *
 * Extract this helper into `apps/server/src/lib/access.ts` so that all
 * admin-gated routes share one canonical implementation (DRY).
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
// Request / response types
// ---------------------------------------------------------------------------

/**
 * Body for PATCH /api/admin/sources/:id/scope.
 *
 * Carries the new scope configuration for the canonical source. All fields are
 * optional (partial update semantics) — unset fields are left unchanged.
 *
 * ## TODO (phase full implementation)
 *
 * Replace `access_mode` with a richer `scope_config` JSONB once the schema
 * migration lands. The current shape mirrors `canonical_sources.access_mode`
 * to avoid premature schema coupling.
 */
export interface AdminSourceScopeBody {
  /**
   * New access mode for the source.
   * One of: "public" | "authenticated" | "api_key"
   */
  access_mode?: 'public' | 'authenticated' | 'api_key' | null;

  /**
   * Optional human-readable note explaining the scope adjustment.
   * Stored in the business_journal event payload (full implementation).
   */
  reason?: string | null;
}

/**
 * Response body for PATCH /api/admin/sources/:id/scope.
 */
export interface AdminSourceScopeResponse {
  /** The canonical source ID that was updated. */
  source_id: string;
  /** The new access_mode value (full implementation). */
  access_mode: 'public' | 'authenticated' | 'api_key' | null;
  /** ISO-8601 timestamp of the update (full implementation). */
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle PATCH /api/admin/sources/:id/scope.
 *
 * Returns null when the request path does not match so the caller can fall
 * through to the next handler.
 *
 * ## Stub note (issue #88)
 *
 * This handler enforces admin authentication and validates the request body,
 * but does not yet persist scope changes. It returns 501 in non-TEST mode to
 * make the missing implementation visible rather than silently permissive.
 *
 * The admin auth gate (401/403) is fully functional now, so integration tests
 * can verify the access-control seam before the feature is built.
 */
export async function handleAdminSourceScopeRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  // Only intercept PATCH /api/admin/sources/:id/scope
  const match = url.pathname.match(/^\/api\/admin\/sources\/([^/]+)\/scope$/);
  if (!match || req.method !== 'PATCH') return null;

  const sourceId = match[1]!;
  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  // ── Session auth ──────────────────────────────────────────────────────────
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return json({ error: 'Unauthorized — session required' }, 401);
  }

  // ── Admin role check ──────────────────────────────────────────────────────
  //
  // Only admin-scoped sessions may reach the control surface.
  // This seam is exercised now so the auth path is integration-tested before
  // the full feature lands.
  const isAdmin = await isAdminOrSuperuser(sql, user.id);
  if (!isAdmin) {
    return json({ error: 'Forbidden — admin role required' }, 403);
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: Partial<AdminSourceScopeBody>;
  try {
    body = (await req.json()) as Partial<AdminSourceScopeBody>;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (
    body.access_mode !== undefined &&
    body.access_mode !== null &&
    !['public', 'authenticated', 'api_key'].includes(body.access_mode)
  ) {
    return json({ error: 'access_mode must be one of: public, authenticated, api_key' }, 400);
  }

  // ── Verify source exists ──────────────────────────────────────────────────
  const existing = await getCanonicalSource(sql, sourceId);
  if (!existing) {
    return json({ error: `Source not found: ${sourceId}` }, 404);
  }

  // ── Emit audit event BEFORE mutation (write-before-read invariant) ────────
  await emitAuditEvent({
    actor_id: user.id,
    action: 'source.scope_adjusted',
    entity_type: 'canonical_source',
    entity_id: sourceId,
    before: { access_mode: existing.access_mode },
    after: { access_mode: body.access_mode ?? existing.access_mode, reason: body.reason ?? null },
    ts: new Date().toISOString(),
  });

  // ── Apply scope mutation ──────────────────────────────────────────────────
  const updated = await updateSourceScope(sql, sourceId, {
    access_mode: body.access_mode,
    reason: body.reason,
  });

  if (!updated) {
    // Race: row vanished between the existence check and the update.
    return json({ error: `Source not found: ${sourceId}` }, 404);
  }

  const response: AdminSourceScopeResponse = {
    source_id: updated.id,
    access_mode: updated.access_mode,
    updated_at:
      updated.updated_at instanceof Date
        ? updated.updated_at.toISOString()
        : String(updated.updated_at),
  };

  return json(response, 200);
}
