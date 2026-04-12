/**
 * @file wiki-page-view.ts
 *
 * Read-only wiki page view API — Phase 4 wiki web UX.
 *
 * ## Scout stub (Phase 4, issue #45)
 *
 * This file is a **no-op stub** for the dev-scout issue that proves the
 * read-only wiki view API contract. All routes return 501 Not Implemented,
 * encoding the expected request/response shapes so follow-on implementation
 * issues can build against a stable contract.
 *
 * ## Routes (planned)
 *
 *   GET  /api/wiki/pages/:customerId
 *     List all published WikiPageVersion entities for a customer, ordered by
 *     version descending. Returns `created_by` and `source` metadata on each.
 *
 *   GET  /api/wiki/pages/:customerId/versions/:versionId
 *     Fetch a single published WikiPageVersion by ID, including full markdown
 *     content for rendering.
 *
 *   GET  /api/wiki/pages/:customerId/versions/:versionId/citations/:citationToken
 *     Resolve a citation token to the underlying CorpusChunk via the
 *     re-identification service. Used by the citation hover UI.
 *
 * ## Authentication
 *
 * All routes require an authenticated session cookie (RM role or above).
 * Citation resolution additionally requires superuser role via the
 * re-identification service boundary (issue #20).
 *
 * ## Real implementation will
 *   1. Query `entities` filtered by type=wiki_page_version AND published=true
 *      for the given tenant/customer.
 *   2. Return created_by and source fields from entity properties.
 *   3. For citation hover: call resolveToken from the reidentification policy
 *      after checking superuser role.
 *
 * Blueprint references:
 * - PRD §4.3 — read-only wiki rendering
 * - Implementation plan Phase 4 — Wiki web UX
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/45
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { makeJson } from '../lib/response';

/**
 * Shape of a WikiPageVersion entry in the version picker list.
 *
 * The real implementation will populate these fields from the entities table.
 */
export interface WikiPageVersionSummary {
  /** Opaque version identifier. */
  id: string;
  /** Markdown content of this version. */
  content: string;
  /** Agent or user that created this version. */
  created_by: string;
  /** Opaque reference to the ground-truth source entity. */
  source: string | null;
  /** ISO timestamp of version creation. */
  created_at: string;
  /** Whether this version has been published. */
  published: boolean;
}

/**
 * Shape of a resolved citation — the source CorpusChunk revealed on hover.
 *
 * The real implementation will be populated by the re-identification service.
 */
export interface CitationResolution {
  /** The original citation token embedded in the wiki markdown. */
  token: string;
  /** Resolved CorpusChunk entity id. */
  entity_id: string;
  /** Plaintext excerpt from the source chunk. */
  excerpt: string | null;
  /** Opaque source reference (e.g. email entity id). */
  source_id: string | null;
}

/**
 * Handle GET /api/wiki/pages/* routes.
 *
 * Scout stub: returns 501 for all matching routes, encoding the expected
 * response shapes. Auth enforcement (401 for unauthenticated callers) is live
 * even in the stub so integration tests can assert the auth invariant.
 */
export async function handleWikiPageViewRequest(
  req: Request,
  url: URL,
  _appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/wiki/pages')) return null;
  if (req.method !== 'GET') return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);

  // Auth invariant — live in the stub.
  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // ── GET /api/wiki/pages/:customerId ──────────────────────────────────────

  const listMatch = url.pathname.match(/^\/api\/wiki\/pages\/([^/]+)$/);
  if (listMatch) {
    // Scout stub: returns 501 with the expected response shape.
    return json(
      {
        error: 'Not Implemented — wiki page view is a Phase 4 follow-on issue',
        expected_response_shape: {
          customer_id: '<customerId>',
          versions: [
            {
              id: '<uuid>',
              content: '<markdown>',
              created_by: '<user-or-agent-id>',
              source: '<ground-truth-ref-or-null>',
              created_at: '<iso-timestamp>',
              published: true,
            } satisfies WikiPageVersionSummary,
          ],
        },
      },
      501,
    );
  }

  // ── GET /api/wiki/pages/:customerId/versions/:versionId ──────────────────

  const versionMatch = url.pathname.match(/^\/api\/wiki\/pages\/([^/]+)\/versions\/([^/]+)$/);
  if (versionMatch) {
    // Scout stub: returns 501 with the expected response shape.
    return json(
      {
        error: 'Not Implemented — wiki version fetch is a Phase 4 follow-on issue',
        expected_response_shape: {
          id: '<uuid>',
          customer_id: '<customerId>',
          content: '<markdown>',
          created_by: '<user-or-agent-id>',
          source: '<ground-truth-ref-or-null>',
          created_at: '<iso-timestamp>',
          published: true,
        } satisfies Omit<WikiPageVersionSummary, never> & { customer_id: string },
      },
      501,
    );
  }

  // ── GET /api/wiki/pages/:customerId/versions/:versionId/citations/:token ─

  const citationMatch = url.pathname.match(
    /^\/api\/wiki\/pages\/([^/]+)\/versions\/([^/]+)\/citations\/([^/]+)$/,
  );
  if (citationMatch) {
    // Scout stub: returns 501 with the expected response shape.
    // The real implementation requires superuser role — stub enforces 501 only.
    return json(
      {
        error: 'Not Implemented — citation hover resolution is a Phase 4 follow-on issue',
        expected_response_shape: {
          token: '<citation-token>',
          entity_id: '<corpus-chunk-uuid>',
          excerpt: '<plaintext-excerpt-or-null>',
          source_id: '<source-entity-id-or-null>',
        } satisfies CitationResolution,
      },
      501,
    );
  }

  return null;
}
