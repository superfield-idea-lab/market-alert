/**
 * @file wiki-rebuild-api.ts
 *
 * Internal API handlers for the wiki rebuild pipeline — Phase 3 scout (issue #76).
 *
 * ## Routes
 *
 *   GET  /internal/wiki-rebuild/facts
 *     Query: tenant_id, subject_type, subject_id
 *     Returns: { facts: Array<{ id, attribute, value, confidence }> }
 *     Lists all non-superseded confirmed_facts for a subject.
 *
 *   GET  /internal/wiki-rebuild/chunks
 *     Query: tenant_id, subject_type, subject_id
 *     Returns: { chunks: Array<{ id, content }> }
 *     Lists corpus_chunks whose source entity matches the subject.
 *
 *   POST /internal/wiki-rebuild/page-version
 *     Body: { tenant_id, subject_type, subject_id }
 *     Returns: { wiki_page_id, wiki_page_version_id, current_status, resumed_from_stall }
 *     Upserts a wiki_pages row and either returns a stalled version (crash-resume)
 *     or creates a fresh `pending` version.
 *
 *   PATCH /internal/wiki-rebuild/page-version/:id/status
 *     Body: { status: 'content_written' | 'embedded' | 'indexed', body?: string, wiki_page_id?: string }
 *     Advances the version status by one stage. The `indexed` transition also
 *     flips wiki_pages.currently_published_version_id atomically.
 *
 *   POST /internal/wiki-rebuild/cites
 *     Body: { wiki_page_version_id, target_id, target_type: 'corpus_chunk' | 'confirmed_fact' }
 *     Returns: { id, wiki_page_version_id, target_id, target_type, created_at }
 *     Inserts a cites edge (idempotent: ON CONFLICT DO NOTHING).
 *
 * ## Security
 *
 * Bearer token is validated against WIKI_REBUILD_TEST_TOKEN in TEST_MODE.
 * Production will require a signed worker JWT scoped to wiki_rebuild operations.
 *
 * ## Crash-resume
 *
 * POST /internal/wiki-rebuild/page-version checks for a stalled version row
 * (status != indexed) before creating a new one. If found, it returns the stalled
 * version so the worker can resume from the next stage. This implements AC-2:
 * "A crashed rebuild resumes from the stalled stage, not from scratch."
 *
 * ## Canonical docs
 *
 * - docs/architecture.md §"Wiki pages: full-snapshot versioning"
 * - docs/architecture.md §"Citations: first-class relation edges"
 * - packages/db/wiki-rebuild-store.ts — DB store
 * - apps/worker/src/wiki-rebuild-job.ts — worker handler
 * - tests/integration/wiki-rebuild.spec.ts — integration tests
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/76
 */

import type { AppState } from '../index';
import { makeJson } from '../lib/response';
import {
  upsertWikiPage,
  insertWikiPageVersion,
  getStalledWikiPageVersion,
  setWikiPageVersionBody,
  setWikiPageVersionEmbedded,
  publishWikiPageVersion,
  insertCitesEdge,
  type CitesTargetType,
} from 'db/wiki-rebuild-store';
import type { ConfirmedFactRow } from 'db/mkt-knowledge-store';

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

function checkBearer(req: Request): string | null {
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice('Bearer '.length).trim();
}

function isAuthorized(token: string | null): boolean {
  if (!token) return false;
  const testMode = process.env.TEST_MODE === 'true';
  const expectedToken = process.env.WIKI_REBUILD_TEST_TOKEN ?? '';
  if (testMode) return token === expectedToken && expectedToken.length > 0;
  // Production: TODO replace with signed JWT verification (follow-on).
  return false;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Handle all /internal/wiki-rebuild/* routes.
 *
 * Returns null when the pathname does not match so the caller can fall through.
 */
export async function handleWikiRebuildApiRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/internal/wiki-rebuild')) return null;

  const json = makeJson({});
  const token = checkBearer(req);

  if (!isAuthorized(token)) return json({ error: 'Unauthorized' }, 401);

  const { sql } = appState;

  // ── GET /internal/wiki-rebuild/facts ───────────────────────────────────────
  if (url.pathname === '/internal/wiki-rebuild/facts' && req.method === 'GET') {
    const tenant_id = url.searchParams.get('tenant_id') ?? '';
    const subject_type = url.searchParams.get('subject_type') ?? '';
    const subject_id = url.searchParams.get('subject_id') ?? '';

    if (!tenant_id || !subject_type || !subject_id) {
      return json({ error: 'tenant_id, subject_type, and subject_id are required' }, 400);
    }

    // List all non-superseded confirmed_facts for the subject.
    // mkt-knowledge-store.listCurrentFacts requires an attribute parameter, so
    // here we query the confirmed_facts table directly to list all attributes
    // for the subject. A follow-on issue should extend listCurrentFacts with an
    // optional attribute filter.
    const facts = await sql<ConfirmedFactRow[]>`
      SELECT id, tenant_id, corpus_chunk_id, subject_entity_id, subject_entity_type,
             attribute, value, confidence, supersedes_fact_id, superseded_by_id, created_at
      FROM confirmed_facts
      WHERE tenant_id         = ${tenant_id}
        AND subject_entity_id = ${subject_id}
        AND superseded_by_id  IS NULL
      ORDER BY attribute ASC, created_at DESC
    `;

    return json({
      facts: facts.map((f) => ({
        id: f.id,
        attribute: f.attribute,
        value: f.value,
        confidence: f.confidence,
      })),
    });
  }

  // ── GET /internal/wiki-rebuild/chunks ──────────────────────────────────────
  if (url.pathname === '/internal/wiki-rebuild/chunks' && req.method === 'GET') {
    const tenant_id = url.searchParams.get('tenant_id') ?? '';
    const subject_type = url.searchParams.get('subject_type') ?? '';
    const subject_id = url.searchParams.get('subject_id') ?? '';

    if (!tenant_id || !subject_type || !subject_id) {
      return json({ error: 'tenant_id, subject_type, and subject_id are required' }, 400);
    }

    // Fetch corpus_chunks for the subject.
    // In Phase 3 the subject_entity_id on confirmed_facts equals the
    // canonical_source_id (see fact-extract-job.ts comment). For the wiki
    // rebuild scout we fetch all chunks whose source_id matches subject_id.
    // A follow-on entity-resolution issue will generalise this mapping.
    const chunkRows = await sql<Array<{ id: string; content: string }>>`
      SELECT id, content
      FROM corpus_chunks
      WHERE tenant_id = ${tenant_id}
        AND source_id = ${subject_id}
      ORDER BY chunk_index ASC
    `;

    return json({ chunks: chunkRows });
  }

  // ── POST /internal/wiki-rebuild/page-version ───────────────────────────────
  if (url.pathname === '/internal/wiki-rebuild/page-version' && req.method === 'POST') {
    let body: { tenant_id?: string; subject_type?: string; subject_id?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { tenant_id, subject_type, subject_id } = body;
    if (!tenant_id || !subject_type || !subject_id) {
      return json({ error: 'tenant_id, subject_type, and subject_id are required' }, 400);
    }

    // Upsert the wiki_pages row (idempotent).
    const page = await upsertWikiPage(sql, { tenant_id, subject_type, subject_id });

    // Crash-resume: look for a stalled in-progress version.
    const stalled = await getStalledWikiPageVersion(sql, page.id, tenant_id);
    if (stalled) {
      return json({
        wiki_page_id: page.id,
        wiki_page_version_id: stalled.id,
        current_status: stalled.status,
        resumed_from_stall: true,
      });
    }

    // No stalled version: create a fresh `pending` version.
    const version = await insertWikiPageVersion(sql, {
      wiki_page_id: page.id,
      tenant_id,
      subject_type,
      subject_id,
    });

    return json(
      {
        wiki_page_id: page.id,
        wiki_page_version_id: version.id,
        current_status: version.status,
        resumed_from_stall: false,
      },
      201,
    );
  }

  // ── PATCH /internal/wiki-rebuild/page-version/:id/status ──────────────────
  const statusMatch = url.pathname.match(
    /^\/internal\/wiki-rebuild\/page-version\/([^/]+)\/status$/,
  );
  if (statusMatch && req.method === 'PATCH') {
    const version_id = statusMatch[1]!;

    let body: {
      status?: string;
      body?: string;
      wiki_page_id?: string;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { status, body: markdownBody, wiki_page_id } = body;

    if (status === 'content_written') {
      if (!markdownBody) {
        return json({ error: 'body is required for content_written transition' }, 400);
      }
      await setWikiPageVersionBody(sql, version_id, markdownBody);
      return json({ id: version_id, status: 'content_written' });
    }

    if (status === 'embedded') {
      await setWikiPageVersionEmbedded(sql, version_id);
      return json({ id: version_id, status: 'embedded' });
    }

    if (status === 'indexed') {
      if (!wiki_page_id) {
        return json({ error: 'wiki_page_id is required for indexed transition' }, 400);
      }
      await publishWikiPageVersion(sql, version_id, wiki_page_id);
      return json({ id: version_id, status: 'indexed' });
    }

    return json({ error: `Unknown target status: ${status ?? '(none)'}` }, 400);
  }

  // ── POST /internal/wiki-rebuild/cites ──────────────────────────────────────
  if (url.pathname === '/internal/wiki-rebuild/cites' && req.method === 'POST') {
    let body: {
      wiki_page_version_id?: string;
      target_id?: string;
      target_type?: string;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { wiki_page_version_id, target_id, target_type } = body;

    if (!wiki_page_version_id || !target_id || !target_type) {
      return json({ error: 'wiki_page_version_id, target_id, and target_type are required' }, 400);
    }

    if (target_type !== 'corpus_chunk' && target_type !== 'confirmed_fact') {
      return json({ error: 'target_type must be corpus_chunk or confirmed_fact' }, 400);
    }

    const edge = await insertCitesEdge(sql, {
      wiki_page_version_id,
      target_id,
      target_type: target_type as CitesTargetType,
    });

    return json(
      {
        id: edge.id,
        wiki_page_version_id: edge.wiki_page_version_id,
        target_id: edge.target_id,
        target_type: edge.target_type,
        created_at: edge.created_at,
      },
      201,
    );
  }

  return null;
}
