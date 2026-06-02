/**
 * @file golden-documents.ts
 *
 * Scout stub — Phase 2 golden-document API seam (issue #72).
 *
 * ## Routes
 *
 *   POST /api/golden-documents       — researcher creates a golden document
 *   GET  /api/golden-documents/:id   — researcher reads a golden document back
 *
 * ## Scout stub behaviour
 *
 * All routes return **501 Not Implemented** with the expected request/response
 * contract documented inline. The stub enforces the presence of an
 * Authorization or session-cookie header and returns 401 when the caller is
 * unauthenticated. A worker Bearer token is detected and rejected with 403 so
 * that integration tests can assert the auth invariant before the real
 * implementation lands.
 *
 * ## Real implementation (Phase 2 follow-on)
 *
 * The follow-on issue ("Golden-document tables and author-only enforcement")
 * will replace the 501 stubs with:
 *
 *   POST /api/golden-documents
 *     1. Validate the session is a researcher (`role === 'researcher'`).
 *     2. Parse and validate the request body.
 *     3. Call `createGoldenDocument(sql, input)` inside a `withRlsContext`
 *        transaction that sets `app.current_role = 'researcher'`.
 *     4. Emit a `golden_document.created` journal event.
 *     5. Return the new row as JSON with status 201.
 *
 *   GET /api/golden-documents/:id
 *     1. Validate the session is authenticated.
 *     2. Call `getGoldenDocument(sql, id)` inside `withRlsContext`.
 *     3. Return the row as JSON or 404.
 *
 * A worker token (JWT `role` claim = `'worker'`) attempting POST must be:
 *   - Rejected by the API layer with 403.
 *   - Blocked by the `researcher_only` RLS policy if it somehow reaches the DB.
 *   - Blocked by the `guard_golden_document_writer` trigger backstop.
 *   - Journalled via `writeJournalEvent` with
 *     `event_type = 'golden_document.write_denied'`.
 *
 * ## Canonical docs
 *
 * - `docs/prd.md` §9 — golden documents are author-only forever.
 * - `docs/architecture.md` — data tier, per-pool role isolation.
 * - `docs/implementation-plan.md` Phase 2.
 *
 * ## Discovered integration points
 *
 * - `packages/db/golden-document-store.ts` — type signatures and stub DB
 *   functions that the real implementation will fill in.
 * - `packages/db/rls-context.ts` — `withRlsContext` needs a `role` field
 *   (or a dedicated `SET LOCAL app.current_role`) so the RLS policy can
 *   distinguish researcher from worker sessions.
 * - `packages/db/business-journal.ts` — `writeJournalEvent` for
 *   `golden_document.created` and `golden_document.write_denied` events.
 * - `packages/db/init-remote.ts` — `CUSTOMER_SCOPED_TABLES` must include
 *   `'golden_documents'` so RLS is provisioned at deploy time.
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { makeJson } from '../lib/response';

// ---------------------------------------------------------------------------
// Type contracts (documented for follow-on implementors)
// ---------------------------------------------------------------------------

/**
 * Request body for POST /api/golden-documents.
 *
 * Inline PII is not stored in the body; title is researcher-supplied metadata.
 */
export interface CreateGoldenDocumentRequest {
  /** 'industry_definition' | 'research_methodology' */
  kind: string;
  /** Researcher-supplied title for the document. */
  title: string;
}

/**
 * Response body for POST /api/golden-documents (201) and
 * GET /api/golden-documents/:id (200).
 */
export interface GoldenDocumentResponse {
  id: string;
  kind: string;
  title: string;
  author_id: string;
  tenant_id: string;
  state: 'authored' | 'active' | 'retired';
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle all /api/golden-documents requests.
 *
 * Returns null when the route does not match so the caller can fall through
 * to the next handler.
 *
 * Scout stub: enforces auth invariants and returns 501 for all matched routes.
 */
export async function handleGoldenDocumentsRequest(
  req: Request,
  url: URL,
  _appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/golden-documents')) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);

  // ── Authentication check ──────────────────────────────────────────────────
  //
  // A researcher session must be authenticated via session cookie.
  // A worker token (Authorization: Bearer <jwt>) must be rejected with 403
  // because golden documents are author-only — workers never write them.
  //
  // Detect worker Bearer tokens so integration tests can assert the 403 path
  // even before the real implementation lands.

  const authHeader = req.headers.get('Authorization') ?? '';
  if (authHeader.startsWith('Bearer ')) {
    // Any Bearer token on this route is a worker token — deny immediately.
    // The real implementation will call writeJournalEvent here with
    // event_type = 'golden_document.write_denied'.
    return json(
      {
        error: 'Forbidden — worker tokens may not write golden documents (PRD §9)',
        journal_note:
          'A golden_document.write_denied journal entry will be written by the real implementation.',
      },
      403,
    );
  }

  // Require an authenticated researcher session cookie.
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return json({ error: 'Unauthorized — researcher session required' }, 401);
  }

  // ── POST /api/golden-documents ───────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/golden-documents') {
    // Scout stub: document the expected 201 response shape without executing.
    return json(
      {
        error:
          'Not Implemented — golden_documents DDL and author-only enforcement ' +
          'are the Phase 2 follow-on issue (scout stub only)',
        expected_request_shape: {
          kind: 'industry_definition | research_methodology',
          title: '<researcher-supplied title>',
        } satisfies Record<string, unknown>,
        expected_response_shape: {
          id: '<uuid>',
          kind: 'industry_definition',
          title: '<researcher-supplied title>',
          author_id: '<researcher entity id>',
          tenant_id: '<tenant id>',
          state: 'authored',
          created_at: '<ISO 8601>',
          updated_at: '<ISO 8601>',
        } satisfies Record<string, unknown>,
      },
      501,
    );
  }

  // ── GET /api/golden-documents/:id ────────────────────────────────────────
  const getMatch = url.pathname.match(/^\/api\/golden-documents\/([^/]+)$/);
  if (req.method === 'GET' && getMatch) {
    const _id = getMatch[1];
    // Scout stub: document the expected 200 response shape.
    return json(
      {
        error:
          'Not Implemented — golden_documents DDL and author-only enforcement ' +
          'are the Phase 2 follow-on issue (scout stub only)',
        expected_response_shape: {
          id: '<uuid>',
          kind: 'industry_definition | research_methodology',
          title: '<researcher-supplied title>',
          author_id: '<researcher entity id>',
          tenant_id: '<tenant id>',
          state: 'authored | active | retired',
          created_at: '<ISO 8601>',
          updated_at: '<ISO 8601>',
        } satisfies Record<string, unknown>,
      },
      501,
    );
  }

  return null;
}
