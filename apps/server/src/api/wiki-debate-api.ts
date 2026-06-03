/**
 * @file wiki-debate-api.ts
 *
 * Internal API handlers for the wiki debate lifecycle — issue #77.
 *
 * ## Routes
 *
 *   POST   /internal/wiki-debate
 *     Body: { tenant_id, wiki_page_id, wiki_page_version_id, claim, evidence_a, evidence_b }
 *     Returns: { debate } — opens a new debate at status 'open'.
 *
 *   GET    /internal/wiki-debate/:id
 *     Returns: { debate } — fetch a single debate by ID.
 *
 *   PATCH  /internal/wiki-debate/:id/status
 *     Body: { status: 'resolved' | 'archived', resolution_note?: string }
 *     Returns: { debate } — transitions status from 'open'.
 *
 *   GET    /internal/wiki-debate?wiki_page_id=...&status=...
 *     Returns: { debates } — list debates for a wiki page or tenant.
 *     Query params: wiki_page_id (optional), tenant_id (optional), status (optional).
 *
 * ## Security
 *
 * Bearer token is validated against WIKI_REBUILD_TEST_TOKEN in TEST_MODE.
 * Production will require a signed worker JWT scoped to wiki_rebuild operations.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5 — debates as wiki annotations.
 * - docs/architecture.md §"Knowledge subsystem" — wiki_debates entity type.
 * - packages/db/wiki-debate-store.ts — DB store.
 * - tests/integration/wiki-debate.spec.ts — integration tests.
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/77
 */

import type { AppState } from '../index';
import { makeJson } from '../lib/response';
import {
  openDebate,
  resolveDebate,
  archiveDebate,
  getDebate,
  listOpenDebatesForPage,
  listDebatesForTenant,
  type WikiDebateStatus,
} from 'db/wiki-debate-store';

// ---------------------------------------------------------------------------
// Auth helper (mirrors wiki-rebuild-api.ts pattern)
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
 * Handle all /internal/wiki-debate/* routes.
 *
 * Returns null when the pathname does not match so the caller can fall through.
 */
export async function handleWikiDebateApiRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/internal/wiki-debate')) return null;

  const json = makeJson({});
  const token = checkBearer(req);

  if (!isAuthorized(token)) return json({ error: 'Unauthorized' }, 401);

  const { sql } = appState;

  // ── POST /internal/wiki-debate ─────────────────────────────────────────────
  if (url.pathname === '/internal/wiki-debate' && req.method === 'POST') {
    let body: {
      tenant_id?: string;
      wiki_page_id?: string;
      wiki_page_version_id?: string;
      claim?: string;
      evidence_a?: string[];
      evidence_b?: string[];
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { tenant_id, wiki_page_id, wiki_page_version_id, claim, evidence_a, evidence_b } = body;

    if (!tenant_id || !wiki_page_id || !wiki_page_version_id || !claim) {
      return json(
        { error: 'tenant_id, wiki_page_id, wiki_page_version_id, and claim are required' },
        400,
      );
    }

    if (!Array.isArray(evidence_a) || !Array.isArray(evidence_b)) {
      return json({ error: 'evidence_a and evidence_b must be arrays' }, 400);
    }

    const debate = await openDebate(sql, {
      tenant_id,
      wiki_page_id,
      wiki_page_version_id,
      claim,
      evidence_a,
      evidence_b,
    });

    return json({ debate }, 201);
  }

  // ── GET /internal/wiki-debate (list) ──────────────────────────────────────
  if (url.pathname === '/internal/wiki-debate' && req.method === 'GET') {
    const wiki_page_id = url.searchParams.get('wiki_page_id');
    const tenant_id = url.searchParams.get('tenant_id');
    const statusParam = url.searchParams.get('status') as WikiDebateStatus | null;

    if (wiki_page_id) {
      const debates = await listOpenDebatesForPage(sql, wiki_page_id);
      return json({ debates });
    }

    if (tenant_id) {
      const debates = await listDebatesForTenant(sql, tenant_id, statusParam ?? undefined);
      return json({ debates });
    }

    return json({ error: 'wiki_page_id or tenant_id query param is required' }, 400);
  }

  // ── GET /internal/wiki-debate/:id ─────────────────────────────────────────
  const singleMatch = url.pathname.match(/^\/internal\/wiki-debate\/([^/]+)$/);
  if (singleMatch && req.method === 'GET') {
    const debate_id = singleMatch[1]!;
    const debate = await getDebate(sql, debate_id);
    if (!debate) return json({ error: 'Not found' }, 404);
    return json({ debate });
  }

  // ── PATCH /internal/wiki-debate/:id/status ────────────────────────────────
  const statusMatch = url.pathname.match(/^\/internal\/wiki-debate\/([^/]+)\/status$/);
  if (statusMatch && req.method === 'PATCH') {
    const debate_id = statusMatch[1]!;

    let body: { status?: string; resolution_note?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { status, resolution_note } = body;

    if (status === 'resolved') {
      if (!resolution_note) {
        return json({ error: 'resolution_note is required for resolved transition' }, 400);
      }
      const debate = await resolveDebate(sql, debate_id, resolution_note);
      if (!debate) return json({ error: 'Debate not found or not in open status' }, 404);
      return json({ debate });
    }

    if (status === 'archived') {
      const debate = await archiveDebate(sql, debate_id, resolution_note ?? null);
      if (!debate) return json({ error: 'Debate not found or not in open status' }, 404);
      return json({ debate });
    }

    return json({ error: `Unknown target status: ${status ?? '(none)'}` }, 400);
  }

  return null;
}
