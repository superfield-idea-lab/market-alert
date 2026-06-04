/**
 * @file wiki-inline-edit-api.ts
 *
 * ## Phase 9 — Inline wiki edit, methodology meta-commentary entity, and surfacing (issue #87)
 *
 * API routes for:
 *   1. Capturing researcher inline wiki edits as correction prompts.
 *   2. Transitioning methodology meta-commentary entries through their lifecycle.
 *   3. Surfacing meta-commentary via a badge count, weekly digest, and high-urgency escalation.
 *
 * ## Routes
 *
 *   POST   /api/wiki/inline-edit
 *     Capture an inline wiki page edit as a one-off correction prompt.
 *     Body: { researcher_id, tenant_id, wiki_page_id, base_version_id?,
 *             diff_text, methodology_shift?, drift_observation?, urgency_tier? }
 *     Response: { edit_id, meta_commentary_id? }
 *
 *   PATCH  /api/wiki/meta-commentary/:id/acknowledge
 *     Transition an entry from 'open' → 'acknowledged'.
 *     Body: { researcher_id }
 *     Response: { entry }
 *
 *   PATCH  /api/wiki/meta-commentary/:id/fold-in
 *     Explicit researcher fold-in: 'acknowledged' → 'folded_in'.
 *     The golden Research Methodology document is NEVER written by this action.
 *     Body: { researcher_id }
 *     Response: { entry }
 *
 *   PATCH  /api/wiki/meta-commentary/:id/archive
 *     Archive without fold-in: 'open'|'acknowledged' → 'archived'.
 *     Body: { researcher_id }
 *     Response: { entry }
 *
 *   GET    /api/wiki/meta-commentary/badge?researcher_id=...
 *     Badge count of open meta-commentary entries for a researcher.
 *     Response: { open_count: number }
 *
 *   GET    /api/wiki/meta-commentary/digest?researcher_id=...
 *     Weekly digest grouped by class.
 *     Response: { digest: WeeklyDigestEntry[] }
 *
 *   GET    /api/wiki/meta-commentary/urgent?researcher_id=...
 *     High-urgency open entries (escalation surface).
 *     Response: { entries: MetaCommentaryRow[] }
 *
 * ## Auth
 *
 * Bearer token validated against WIKI_INLINE_EDIT_TEST_TOKEN in TEST_MODE.
 * Production will require a signed researcher JWT (architecture §"Row-level security").
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5 — researcher feedback surface (inline edit, meta-commentary surfacing).
 * - docs/prd.md §9 — golden-document invariant.
 * - docs/architecture.md §"Knowledge subsystem" — methodology_meta_commentary entity.
 * - packages/db/wiki-inline-edit-store.ts — DB store.
 * - tests/integration/wiki-inline-edit.spec.ts — integration tests.
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/87
 */

import type { AppState } from '../index';
import { getCorsHeaders } from './auth';
import { makeJson } from '../lib/response';
import {
  applyInlineEdit,
  acknowledgeMetaCommentaryEntry,
  foldInMetaCommentaryEntry,
  archiveMetaCommentaryEntry,
  countOpenMetaCommentary,
  weeklyDigestByClass,
  listHighUrgencyEntries,
  getMetaCommentaryEntry,
} from 'db/wiki-inline-edit-store';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const WIKI_INLINE_EDIT_TEST_TOKEN_KEY = 'WIKI_INLINE_EDIT_TEST_TOKEN';

function checkBearer(req: Request): string | null {
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice('Bearer '.length).trim();
}

function isAuthorized(token: string | null): boolean {
  if (!token) return false;
  const testMode = process.env.TEST_MODE === 'true';
  const expectedToken = process.env[WIKI_INLINE_EDIT_TEST_TOKEN_KEY] ?? '';
  if (testMode) return token === expectedToken && expectedToken.length > 0;
  // Production: replace with signed researcher JWT verification (Phase 9 full impl).
  return false;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Handle all /api/wiki/inline-edit and /api/wiki/meta-commentary/* routes.
 *
 * Returns null for non-matching paths so the caller can fall through to the next handler.
 */
export async function handleWikiInlineEditRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  const isInlineEdit = url.pathname.startsWith('/api/wiki/inline-edit');
  const isMetaCommentary = url.pathname.startsWith('/api/wiki/meta-commentary');
  if (!isInlineEdit && !isMetaCommentary) return null;

  const corsHeaders = getCorsHeaders(req);
  const { sql } = appState;
  const json = makeJson(corsHeaders);

  const token = checkBearer(req);
  if (!isAuthorized(token)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // -------------------------------------------------------------------------
  // POST /api/wiki/inline-edit — capture inline edit as correction prompt
  // -------------------------------------------------------------------------

  if (req.method === 'POST' && url.pathname === '/api/wiki/inline-edit') {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (typeof body !== 'object' || body === null) {
      return json({ error: 'Body must be a JSON object' }, 400);
    }

    const {
      researcher_id,
      tenant_id,
      wiki_page_id,
      base_version_id = null,
      diff_text,
      methodology_shift = false,
      drift_observation = null,
      urgency_tier = 'normal',
    } = body as Record<string, unknown>;

    if (typeof researcher_id !== 'string' || researcher_id.trim() === '') {
      return json({ error: 'researcher_id is required' }, 422);
    }
    if (typeof tenant_id !== 'string' || tenant_id.trim() === '') {
      return json({ error: 'tenant_id is required' }, 422);
    }
    if (typeof wiki_page_id !== 'string' || wiki_page_id.trim() === '') {
      return json({ error: 'wiki_page_id is required' }, 422);
    }
    if (typeof diff_text !== 'string' || diff_text.trim() === '') {
      return json({ error: 'diff_text is required' }, 422);
    }
    if (typeof methodology_shift !== 'boolean') {
      return json({ error: 'methodology_shift must be a boolean' }, 422);
    }
    if (
      methodology_shift &&
      (typeof drift_observation !== 'string' || drift_observation.trim() === '')
    ) {
      return json({ error: 'drift_observation is required when methodology_shift is true' }, 422);
    }
    if (urgency_tier !== 'normal' && urgency_tier !== 'high') {
      return json({ error: "urgency_tier must be 'normal' or 'high'" }, 422);
    }

    const edit = await applyInlineEdit(sql, {
      tenant_id,
      researcher_id,
      wiki_page_id,
      base_version_id: (base_version_id as string | null) ?? null,
      diff_text,
      methodology_shift: methodology_shift as boolean,
      drift_observation: (drift_observation as string | null) ?? null,
      urgency_tier: (urgency_tier as 'normal' | 'high') ?? 'normal',
    });

    return json(
      {
        edit_id: edit.id,
        meta_commentary_id: edit.meta_commentary_id ?? null,
        correction_status: edit.correction_status,
      },
      201,
    );
  }

  // -------------------------------------------------------------------------
  // GET /api/wiki/meta-commentary/badge?researcher_id=...
  // -------------------------------------------------------------------------

  if (req.method === 'GET' && url.pathname === '/api/wiki/meta-commentary/badge') {
    const researcher_id = url.searchParams.get('researcher_id');
    if (!researcher_id) {
      return json({ error: 'researcher_id query parameter is required' }, 422);
    }
    const open_count = await countOpenMetaCommentary(sql, researcher_id);
    return json({ open_count }, 200);
  }

  // -------------------------------------------------------------------------
  // GET /api/wiki/meta-commentary/digest?researcher_id=...
  // -------------------------------------------------------------------------

  if (req.method === 'GET' && url.pathname === '/api/wiki/meta-commentary/digest') {
    const researcher_id = url.searchParams.get('researcher_id');
    if (!researcher_id) {
      return json({ error: 'researcher_id query parameter is required' }, 422);
    }
    const digest = await weeklyDigestByClass(sql, researcher_id);
    return json({ digest }, 200);
  }

  // -------------------------------------------------------------------------
  // GET /api/wiki/meta-commentary/urgent?researcher_id=...
  // -------------------------------------------------------------------------

  if (req.method === 'GET' && url.pathname === '/api/wiki/meta-commentary/urgent') {
    const researcher_id = url.searchParams.get('researcher_id');
    if (!researcher_id) {
      return json({ error: 'researcher_id query parameter is required' }, 422);
    }
    const entries = await listHighUrgencyEntries(sql, researcher_id);
    return json({ entries }, 200);
  }

  // -------------------------------------------------------------------------
  // PATCH /api/wiki/meta-commentary/:id/acknowledge
  // -------------------------------------------------------------------------

  const acknowledgeMatch = url.pathname.match(
    /^\/api\/wiki\/meta-commentary\/([^/]+)\/acknowledge$/,
  );
  if (req.method === 'PATCH' && acknowledgeMatch) {
    const entry_id = acknowledgeMatch[1]!;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    const { researcher_id } = (body as Record<string, unknown>) ?? {};
    if (typeof researcher_id !== 'string' || researcher_id.trim() === '') {
      return json({ error: 'researcher_id is required' }, 422);
    }
    try {
      const entry = await acknowledgeMetaCommentaryEntry(sql, entry_id, researcher_id);
      return json({ entry }, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: msg }, 409);
    }
  }

  // -------------------------------------------------------------------------
  // PATCH /api/wiki/meta-commentary/:id/fold-in
  // The golden Research Methodology document is NOT written by this action.
  // -------------------------------------------------------------------------

  const foldInMatch = url.pathname.match(/^\/api\/wiki\/meta-commentary\/([^/]+)\/fold-in$/);
  if (req.method === 'PATCH' && foldInMatch) {
    const entry_id = foldInMatch[1]!;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    const { researcher_id } = (body as Record<string, unknown>) ?? {};
    if (typeof researcher_id !== 'string' || researcher_id.trim() === '') {
      return json({ error: 'researcher_id is required' }, 422);
    }

    // Verify the entry exists before attempting fold-in.
    const entry = await getMetaCommentaryEntry(sql, entry_id);
    if (!entry) {
      return json({ error: `Meta-commentary entry ${entry_id} not found` }, 404);
    }

    try {
      const updated = await foldInMetaCommentaryEntry(sql, entry_id, researcher_id);
      return json(
        {
          entry: updated,
          // Explicit reminder: the researcher must manually update the golden doc.
          golden_doc_note:
            'Fold-in recorded. The golden Research Methodology document is NOT automatically updated. Update it manually to reflect this observation.',
        },
        200,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: msg }, 409);
    }
  }

  // -------------------------------------------------------------------------
  // PATCH /api/wiki/meta-commentary/:id/archive
  // -------------------------------------------------------------------------

  const archiveMatch = url.pathname.match(/^\/api\/wiki\/meta-commentary\/([^/]+)\/archive$/);
  if (req.method === 'PATCH' && archiveMatch) {
    const entry_id = archiveMatch[1]!;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    const { researcher_id } = (body as Record<string, unknown>) ?? {};
    if (typeof researcher_id !== 'string' || researcher_id.trim() === '') {
      return json({ error: 'researcher_id is required' }, 422);
    }
    try {
      const updated = await archiveMetaCommentaryEntry(sql, entry_id, researcher_id);
      return json({ entry: updated }, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: msg }, 409);
    }
  }

  return null;
}
