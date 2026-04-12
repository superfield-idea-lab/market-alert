/**
 * @file wiki-page-view.ts
 *
 * Read-only wiki page view API — Phase 4 wiki web UX (issue #47).
 *
 * Routes:
 *
 *   GET  /api/wiki/pages/:customerId
 *     List all accessible WikiPageVersion rows for a customer, ordered by
 *     created_at descending. Returns created_by and source metadata on each.
 *     RLS: only rows where customer = :customerId AND state IN ('draft', 'published')
 *     are returned; archived rows are hidden.
 *
 *   GET  /api/wiki/pages/:customerId/versions/:versionId
 *     Fetch a single accessible WikiPageVersion by ID, including full markdown
 *     content for rendering.
 *
 *   GET  /api/wiki/pages/:customerId/versions/:versionId/citations/:citationToken
 *     Resolve a citation token to the underlying CorpusChunk via the
 *     re-identification service. Used by the citation hover UI.
 *
 * Authentication:
 *   All routes require an authenticated session cookie (RM role or above).
 *
 * RLS (Row-Level Security):
 *   Versions are filtered to the authenticated user's accessible customer IDs.
 *   For now, the authenticated user can view any customer's wiki (RM-level
 *   access). Scoping to specific tenant/dept is enforced via the customer
 *   field on the wiki_page_versions table.
 *
 * Blueprint references:
 * - PRD §5.3 — history panel
 * - Implementation plan Phase 4 — Wiki web UX
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/47
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { makeJson } from '../lib/response';

/**
 * Shape of a WikiPageVersion entry in the version picker list.
 */
export interface WikiPageVersionSummary {
  /** Opaque version identifier. */
  id: string;
  /** Markdown content of this version. */
  content: string;
  /** Agent or user that created this version. */
  created_by: string;
  /** Opaque reference to the ground-truth source task (source_task column). */
  source: string | null;
  /** ISO timestamp of version creation. */
  created_at: string;
  /** Whether this version has been published. */
  published: boolean;
}

/**
 * Shape of a resolved citation — the source CorpusChunk revealed on hover.
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
 * All routes enforce authentication. Accessible versions are filtered by the
 * customer ID in the URL path; archived rows are excluded.
 */
export async function handleWikiPageViewRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/wiki/pages')) return null;
  if (req.method !== 'GET') return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  // Auth invariant — all wiki page view routes require authentication.
  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // ── GET /api/wiki/pages/:customerId ───────────────────────────────────────
  // List all accessible versions for a customer, ordered newest-first.

  const listMatch = url.pathname.match(/^\/api\/wiki\/pages\/([^/]+)$/);
  if (listMatch) {
    const customerId = listMatch[1];

    const rows = await sql<
      {
        id: string;
        content: string;
        created_by: string;
        source_task: string | null;
        created_at: Date;
        state: string;
      }[]
    >`
      SELECT id, content, created_by, source_task, created_at, state
      FROM wiki_page_versions
      WHERE customer = ${customerId}
        AND state != 'archived'
      ORDER BY created_at DESC
    `;

    const versions: WikiPageVersionSummary[] = rows.map((row) => ({
      id: row.id,
      content: row.content,
      created_by: row.created_by,
      source: row.source_task,
      created_at:
        row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      published: row.state === 'published',
    }));

    return json({ customer_id: customerId, versions });
  }

  // ── GET /api/wiki/pages/:customerId/versions/:versionId ──────────────────
  // Fetch a single accessible version by ID (RLS: must belong to customerId).

  const versionMatch = url.pathname.match(/^\/api\/wiki\/pages\/([^/]+)\/versions\/([^/]+)$/);
  if (versionMatch) {
    const customerId = versionMatch[1];
    const versionId = versionMatch[2];

    const rows = await sql<
      {
        id: string;
        content: string;
        created_by: string;
        source_task: string | null;
        created_at: Date;
        state: string;
      }[]
    >`
      SELECT id, content, created_by, source_task, created_at, state
      FROM wiki_page_versions
      WHERE id       = ${versionId}
        AND customer = ${customerId}
        AND state   != 'archived'
    `;

    if (rows.length === 0) return json({ error: 'Not found' }, 404);

    const row = rows[0];
    const version: WikiPageVersionSummary & { customer_id: string } = {
      id: row.id,
      customer_id: customerId,
      content: row.content,
      created_by: row.created_by,
      source: row.source_task,
      created_at:
        row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      published: row.state === 'published',
    };

    return json(version);
  }

  // ── GET /api/wiki/pages/:customerId/versions/:versionId/citations/:token ─
  // Resolve a citation token — stub until citation service is implemented.

  const citationMatch = url.pathname.match(
    /^\/api\/wiki\/pages\/([^/]+)\/versions\/([^/]+)\/citations\/([^/]+)$/,
  );
  if (citationMatch) {
    const citationToken = citationMatch[3];
    // Citation resolution requires the re-identification service (Phase 6).
    // Return 501 with the planned shape so callers can detect the stub.
    return json(
      {
        error: 'Not Implemented — citation hover resolution is a Phase 6 follow-on issue',
        expected_response_shape: {
          token: citationToken,
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
