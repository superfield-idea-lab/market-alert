/**
 * @file wiki-page-view.ts
 *
 * Read-only wiki page view API — Phase 4 wiki web UX (issues #47 and #49).
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
 *     Resolve a citation token to the underlying CorpusChunk and optionally
 *     the re-identified sender/speaker name via the re-identification service.
 *     Used by the citation hover UI. LIVE implementation — superuser required
 *     for re-id data (issue #49).
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
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/49
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { makeJson, isSuperuser } from '../lib/response';
import { decryptProperties } from 'core';
import { resolveToken } from '../policies/reidentification-service';
import { withRlsContext } from 'db/rls-context';

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
  /**
   * Real sender/speaker name resolved via the re-identification service.
   * Only present when the caller has superuser role; null otherwise.
   */
  resolved_name: string | null;
}

/**
 * Resolve the list of customer IDs accessible to a given RM.
 *
 * Customer access is determined by `manages` relations in the property graph:
 * a user entity with source_id = rmId has type='manages' relations whose
 * target_id values are the customer entity IDs the RM is authorised to see.
 *
 * This query uses the admin pool (appState.sql) without RLS context so it can
 * enumerate the RM's portfolio before the RLS session is opened.  The result
 * is then fed into withRlsContext as rmCustomerIds to enforce the DB-layer block.
 *
 * Issue #50 — my-customers-only wiki visibility.
 */
async function getRmCustomerIds(sql: AppState['sql'], rmId: string): Promise<string[]> {
  const rows = await sql<{ target_id: string }[]>`
    SELECT r.target_id
    FROM relations r
    WHERE r.source_id = ${rmId}
      AND r.type = 'manages'
  `;
  return rows.map((r) => r.target_id);
}

/**
 * Handle GET /api/wiki/pages/* routes.
 *
 * All routes enforce authentication. Accessible versions are filtered by the
 * customer ID in the URL path; archived rows are excluded. The citation
 * resolution route fetches the CorpusChunk entity, decrypts its body, and
 * (for superusers) resolves the sender token via the re-identification service.
 *
 * RLS: wiki_page_versions reads are wrapped in withRlsContext, which sets
 * app.current_rm_customer_ids so the wiki_page_versions_rm_isolation policy
 * enforces my-customers-only visibility at the database layer (issue #50).
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

  // Resolve the authenticated user's accessible customer IDs.
  // These are fed into the RLS session context so the DB-layer policy
  // enforces my-customers-only visibility without any application-layer
  // filtering (PRD §7, issue #50).
  const rmCustomerIds = await getRmCustomerIds(sql, user.id);

  // ── GET /api/wiki/pages/:customerId ───────────────────────────────────────
  // List all accessible versions for a customer, ordered newest-first.

  const listMatch = url.pathname.match(/^\/api\/wiki\/pages\/([^/]+)$/);
  if (listMatch) {
    const customerId = listMatch[1];

    const rows = await withRlsContext(
      sql,
      { userId: user.id, tenantId: null, rmCustomerIds },
      (tx) =>
        tx<
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
        `,
    );

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

    const rows = await withRlsContext(
      sql,
      { userId: user.id, tenantId: null, rmCustomerIds },
      (tx) =>
        tx<
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
        `,
    );

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
  // Resolve a citation token to the linked CorpusChunk + optional re-id.

  const citationMatch = url.pathname.match(
    /^\/api\/wiki\/pages\/([^/]+)\/versions\/([^/]+)\/citations\/([^/]+)$/,
  );
  if (citationMatch) {
    const citationToken = citationMatch[3];
    const correlationId = req.headers.get('X-Trace-Id') ?? undefined;
    const ip =
      req.headers.get('X-Forwarded-For') ?? req.headers.get('CF-Connecting-IP') ?? undefined;

    // Step 1: look up the CorpusChunk entity whose id matches the citation token.
    // The citation token IS the corpus chunk entity id embedded by the autolearn worker.
    type ChunkRow = {
      id: string;
      properties: Record<string, unknown>;
    };
    const chunkRows = await sql<ChunkRow[]>`
      SELECT id, properties
      FROM entities
      WHERE id = ${citationToken}
        AND type = 'corpus_chunk'
      LIMIT 1
    `;

    if (chunkRows.length === 0) {
      return json({ error: 'Citation not found' }, 404);
    }

    const chunkRow = chunkRows[0];

    // Step 2: decrypt sensitive fields (body is encrypted at rest).
    const decrypted = await decryptProperties('corpus_chunk', chunkRow.properties);
    const excerpt = typeof decrypted.body === 'string' ? decrypted.body : null;
    const sourceId = typeof decrypted.source_id === 'string' ? decrypted.source_id : null;

    // Step 3: resolve the sender/speaker token for superusers.
    // Non-superusers see the chunk excerpt but NOT the re-identified name.
    let resolvedName: string | null = null;

    if (isSuperuser(user.id) && sourceId) {
      try {
        const identity = await resolveToken({
          token: sourceId,
          actorId: user.id,
          correlationId,
          ip,
        });
        if (identity) {
          resolvedName = identity.real_name;
        }
      } catch (err) {
        // If re-id fails we still return the excerpt — audit failure propagates
        // as 500 per the reidentification-service contract.
        console.error('[wiki-page-view] Re-identification failed:', err);
        return json({ error: 'Internal Server Error' }, 500);
      }
    }

    const resolution: CitationResolution = {
      token: citationToken,
      entity_id: chunkRow.id,
      excerpt,
      source_id: sourceId,
      resolved_name: resolvedName,
    };

    return json(resolution, 200);
  }

  return null;
}
