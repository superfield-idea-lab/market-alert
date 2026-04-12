/**
 * Wiki API — draft `wiki_page_version` management (issue #43).
 *
 * Routes:
 *
 *   POST   /api/wiki/versions
 *     Create a new `wiki_page_version` entity (draft).  Immediately runs the
 *     claim-citation coverage check; drafts below the SLA threshold are marked
 *     P1 and get `publication_blocked = true`.
 *
 *   GET    /api/wiki/versions/:id
 *     Fetch a single `wiki_page_version` entity by ID.
 *
 *   POST   /api/wiki/versions/:id/publish
 *     Attempt to publish a draft.  Rejected with 422 when
 *     `publication_blocked = true` (P1 drafts).
 *
 * Auth: all routes require an authenticated session cookie.
 *
 * Citation coverage threshold is read from the
 * `CITATION_COVERAGE_THRESHOLD` environment variable (float 0–1).
 * Defaults to 0.99 when not set.
 *
 * Canonical docs: docs/implementation-plan-v1.md §Phase 3
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/43
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { makeJson } from '../lib/response';
import { checkAndMarkDraft } from 'db/claim-citation-coverage';

// ---------------------------------------------------------------------------
// Configuration helper
// ---------------------------------------------------------------------------

function getCoverageThreshold(): number {
  const raw = process.env.CITATION_COVERAGE_THRESHOLD;
  if (raw !== undefined) {
    const parsed = parseFloat(raw);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  }
  return 0.99;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleWikiRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/wiki')) return null;

  const corsHeaders = getCorsHeaders(req);
  const { sql } = appState;
  const json = makeJson(corsHeaders);

  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // -------------------------------------------------------------------------
  // POST /api/wiki/versions — create a draft wiki_page_version
  // -------------------------------------------------------------------------

  if (req.method === 'POST' && url.pathname === '/api/wiki/versions') {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as Record<string, unknown>).content !== 'string'
    ) {
      return json({ error: 'content (string) is required' }, 400);
    }

    const { content, wiki_page_id, tenant_id } = body as {
      content: string;
      wiki_page_id?: string;
      tenant_id?: string;
    };

    // Insert the new wiki_page_version entity.
    const versionId = crypto.randomUUID();

    await sql`
      INSERT INTO entities (id, type, properties, tenant_id)
      VALUES (
        ${versionId},
        'wiki_page_version',
        ${sql.json({ content, created_by: user.id, wiki_page_id: wiki_page_id ?? null })},
        ${tenant_id ?? null}
      )
    `;

    // Run citation coverage check immediately.
    const slaThreshold = getCoverageThreshold();
    const markResult = await checkAndMarkDraft(sql, versionId, { slaThreshold });

    // Re-fetch the updated entity to include patched properties.
    const rows = await sql<
      { id: string; properties: Record<string, unknown>; created_at: string; updated_at: string }[]
    >`
      SELECT id, properties, created_at, updated_at
      FROM entities
      WHERE id = ${versionId}
    `;
    const entity = rows[0];

    return json(
      {
        id: entity.id,
        properties: entity.properties,
        created_at: entity.created_at,
        updated_at: entity.updated_at,
        coverage_check: {
          passes: markResult.coverage.passes,
          coverage: markResult.coverage.coverage,
          total_claims: markResult.coverage.totalClaims,
          uncited_claims: markResult.coverage.uncitedClaims,
          sla_threshold: markResult.coverage.slaThreshold,
          marked_p1: markResult.markedP1,
        },
      },
      201,
    );
  }

  // -------------------------------------------------------------------------
  // GET /api/wiki/versions/:id — fetch a draft by ID
  // -------------------------------------------------------------------------

  const getMatch = url.pathname.match(/^\/api\/wiki\/versions\/([^/]+)$/);
  if (req.method === 'GET' && getMatch) {
    const versionId = getMatch[1];
    const rows = await sql<
      {
        id: string;
        properties: Record<string, unknown>;
        tenant_id: string | null;
        created_at: string;
        updated_at: string;
      }[]
    >`
      SELECT id, properties, tenant_id, created_at, updated_at
      FROM entities
      WHERE id   = ${versionId}
        AND type = 'wiki_page_version'
    `;
    if (rows.length === 0) return json({ error: 'Not found' }, 404);
    const entity = rows[0];
    return json({
      id: entity.id,
      properties: entity.properties,
      tenant_id: entity.tenant_id,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    });
  }

  // -------------------------------------------------------------------------
  // POST /api/wiki/versions/:id/publish — publish a draft
  // -------------------------------------------------------------------------

  const publishMatch = url.pathname.match(/^\/api\/wiki\/versions\/([^/]+)\/publish$/);
  if (req.method === 'POST' && publishMatch) {
    const versionId = publishMatch[1];

    const rows = await sql<{ id: string; properties: Record<string, unknown> }[]>`
      SELECT id, properties
      FROM entities
      WHERE id   = ${versionId}
        AND type = 'wiki_page_version'
    `;

    if (rows.length === 0) return json({ error: 'Not found' }, 404);

    const entity = rows[0];

    // Block publication for P1 drafts.
    if (entity.properties.publication_blocked === true) {
      return json(
        {
          error: 'Publication blocked: draft is marked P1 due to insufficient citation coverage',
          priority: entity.properties.priority,
          citation_coverage: entity.properties.citation_coverage,
          uncited_claims: entity.properties.uncited_claims,
        },
        422,
      );
    }

    // Mark as published.
    await sql`
      UPDATE entities
      SET
        properties = properties || ${sql.json({ published: true, published_by: user.id, published_at: new Date().toISOString() })},
        updated_at = NOW()
      WHERE id = ${versionId}
    `;

    return json({ id: versionId, published: true });
  }

  return null;
}
