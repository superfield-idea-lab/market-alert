/**
 * @file chat-feedback-api.ts
 *
 * ## Phase scout — Chat feedback API (issue #86)
 *
 * Stub-only integration pass. Defines the HTTP API seam for the researcher
 * chat-feedback correction flow described in PRD §5.
 *
 * ## Routes (stub)
 *
 *   POST   /api/wiki/feedback
 *     Submit a researcher chat correction targeting a wiki page.
 *     Body: { researcher_id, tenant_id, message, wiki_page_id,
 *             superseded_fact_id, new_fact_value,
 *             methodology_shift?, drift_observation? }
 *     Response: { feedback_id, meta_commentary_id? }
 *
 *   GET    /api/wiki/feedback/meta-commentary?researcher_id=...
 *     List open methodology meta-commentary entries for a researcher.
 *     Response: { entries: MetaCommentaryRow[] }
 *
 *   GET    /api/wiki/feedback/golden-doc-check
 *     Dev/test guard — confirms golden_documents was not mutated.
 *     Response: { golden_doc_unmutated: true }
 *
 * ## Auth
 *
 * Bearer token validated against CHAT_FEEDBACK_TEST_TOKEN in TEST_MODE.
 * Production will require a signed researcher JWT with `wiki:feedback` scope
 * (architecture §"Row-level security").
 *
 * ## Full implementation notes
 *
 * POST /api/wiki/feedback will:
 *   1. Parse and validate the request body.
 *   2. Call an LLM `classify_feedback` function to confirm wiki_page_id and
 *      target_fact_id, and detect methodology_shift (the caller may pre-classify,
 *      but the server re-validates to prevent SSRF-style fact injection).
 *   3. Validate that superseded_fact_id belongs to the authenticated researcher's
 *      tenant before inserting the superseding confirmed_fact row.
 *   4. Call `applyFeedback` from packages/db/chat-feedback-store.ts.
 *   5. Return 201 with the feedback_id and, when applicable, meta_commentary_id.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5 — researcher feedback surface.
 * - docs/prd.md §9 — golden-document invariant.
 * - docs/architecture.md §"Knowledge subsystem" — methodology_meta_commentary entity type.
 * - docs/implementation-plan.md § Phase 9.
 * - packages/db/chat-feedback-store.ts — DB store stub.
 * - tests/integration/chat-feedback.spec.ts — integration tests.
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/86
 */

import type { AppState } from '../index';
import { getCorsHeaders } from './auth';
import { makeJson } from '../lib/response';
import {
  applyFeedback,
  listOpenMetaCommentaryForResearcher,
  goldenDocIsUnmutated,
} from 'db/chat-feedback-store';

// ---------------------------------------------------------------------------
// Test token env var name (mirrors pattern in wiki-rebuild-api.ts)
// ---------------------------------------------------------------------------

const CHAT_FEEDBACK_TEST_TOKEN_KEY = 'CHAT_FEEDBACK_TEST_TOKEN';

// ---------------------------------------------------------------------------
// Auth helper (Bearer token — mirrors wiki-debate-api.ts pattern)
// ---------------------------------------------------------------------------

function checkBearer(req: Request): string | null {
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice('Bearer '.length).trim();
}

function isAuthorized(token: string | null): boolean {
  if (!token) return false;
  const testMode = process.env.TEST_MODE === 'true';
  const expectedToken = process.env[CHAT_FEEDBACK_TEST_TOKEN_KEY] ?? '';
  if (testMode) return token === expectedToken && expectedToken.length > 0;
  // Production: replace with signed researcher JWT verification (Phase 9 full impl).
  return false;
}

// ---------------------------------------------------------------------------
// Route handler (stub)
// ---------------------------------------------------------------------------

/**
 * Handle chat-feedback API requests.
 *
 * Returns `null` for non-matching paths so the caller can continue to the next handler.
 *
 * STUB: The POST handler inserts via `applyFeedback` (which itself is a stub).
 * The LLM classify_feedback step is omitted — the caller supplies wiki_page_id
 * and superseded_fact_id directly. The full implementation must validate these
 * against the DB before inserting.
 */
export async function handleChatFeedbackRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/wiki/feedback')) return null;

  const corsHeaders = getCorsHeaders(req);
  const { sql } = appState;
  const json = makeJson(corsHeaders);

  const token = checkBearer(req);
  if (!isAuthorized(token)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // ---------------------------------------------------------------------------
  // POST /api/wiki/feedback — apply a chat correction
  // ---------------------------------------------------------------------------

  if (req.method === 'POST' && url.pathname === '/api/wiki/feedback') {
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
      message,
      wiki_page_id,
      superseded_fact_id,
      new_fact_value,
      methodology_shift = false,
      drift_observation = null,
    } = body as Record<string, unknown>;

    if (typeof researcher_id !== 'string' || researcher_id.trim() === '') {
      return json({ error: 'researcher_id is required' }, 422);
    }
    if (typeof tenant_id !== 'string' || tenant_id.trim() === '') {
      return json({ error: 'tenant_id is required' }, 422);
    }
    if (typeof message !== 'string' || message.trim() === '') {
      return json({ error: 'message is required' }, 422);
    }
    if (typeof wiki_page_id !== 'string' || wiki_page_id.trim() === '') {
      return json({ error: 'wiki_page_id is required' }, 422);
    }
    if (typeof superseded_fact_id !== 'string' || superseded_fact_id.trim() === '') {
      return json({ error: 'superseded_fact_id is required' }, 422);
    }
    if (typeof new_fact_value !== 'string' || new_fact_value.trim() === '') {
      return json({ error: 'new_fact_value is required' }, 422);
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

    // STUB: `applyFeedback` inserts the feedback row and the meta-commentary
    // entry (when methodology_shift is true) but does NOT yet insert the
    // superseding confirmed_fact or enqueue WIKI_REBUILD. Those steps are
    // documented in packages/db/chat-feedback-store.ts and will land in the
    // Phase 9 full implementation.
    const feedback = await applyFeedback(sql, {
      tenant_id,
      researcher_id,
      message,
      wiki_page_id,
      superseded_fact_id,
      new_fact_value,
      methodology_shift: methodology_shift as boolean,
      drift_observation: (drift_observation as string | null) ?? null,
    });

    return json(
      {
        feedback_id: feedback.id,
        meta_commentary_id: feedback.meta_commentary_id ?? null,
      },
      201,
    );
  }

  // ---------------------------------------------------------------------------
  // GET /api/wiki/feedback/meta-commentary — list open meta-commentary entries
  // ---------------------------------------------------------------------------

  if (req.method === 'GET' && url.pathname === '/api/wiki/feedback/meta-commentary') {
    const researcher_id = url.searchParams.get('researcher_id');
    if (!researcher_id) {
      return json({ error: 'researcher_id query parameter is required' }, 422);
    }
    const entries = await listOpenMetaCommentaryForResearcher(sql, researcher_id);
    return json({ entries }, 200);
  }

  // ---------------------------------------------------------------------------
  // GET /api/wiki/feedback/golden-doc-check
  // Development / integration test guard — confirms the golden_documents table
  // was not mutated by the feedback handler (PRD §9 golden-document invariant).
  // This route must NOT be registered in production route tables.
  // ---------------------------------------------------------------------------

  if (req.method === 'GET' && url.pathname === '/api/wiki/feedback/golden-doc-check') {
    const unmutated = goldenDocIsUnmutated(new Date(0));
    return json({ golden_doc_unmutated: unmutated }, 200);
  }

  return null;
}
