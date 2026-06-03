/**
 * @file standing-prompt-distill-api.ts
 *
 * Internal API handlers for the standing-prompt distillation pipeline — Phase 3 scout (issue #78).
 *
 * ## Routes
 *
 *   POST /internal/standing-prompt/prompt
 *     Body: { tenant_id, researcher_id }
 *     Returns: { standing_prompt_id, researcher_id }
 *     Upserts a standing_prompts row for a researcher.
 *
 *   POST /internal/standing-prompt/version
 *     Body: { standing_prompt_id, tenant_id, researcher_id, wiki_version_window }
 *     Returns: { standing_prompt_version_id, status: 'draft' | 'exists', wiki_version_window }
 *     Creates a new draft standing_prompt_version row, or returns `status: 'exists'`
 *     if the window has already been distilled (idempotency).
 *
 *   POST /internal/standing-prompt/version/:id/activate
 *     Body: { standing_prompt_id, body }
 *     Returns: { standing_prompt_version_id, status: 'active', word_count }
 *     Activates the draft version: validates the word count against the hard
 *     ceiling (~250 words, PRD §9), supersedes the prior active version, and
 *     advances the standing_prompts pointer — all in a single transaction.
 *
 *   GET  /internal/standing-prompt/active
 *     Query: tenant_id, researcher_id
 *     Returns: { version | null }
 *     Returns the currently active standing_prompt_version for the researcher,
 *     or null if none exists.
 *
 * ## Security
 *
 * Bearer token is validated against STANDING_PROMPT_TEST_TOKEN in TEST_MODE.
 * Production will require a signed worker JWT scoped to sp_distiller operations.
 *
 * ## Idempotency
 *
 * POST /internal/standing-prompt/version uses the (researcher_id, wiki_version_window)
 * unique index to collapse duplicate distillation requests for the same publish window.
 * The response `status: 'exists'` signals to the worker that no further action is
 * needed for this window.
 *
 * ## Canonical docs
 *
 * - docs/architecture.md §"Standing prompt as derived artifact"
 * - docs/prd.md §9 — hard ceiling ~250 words
 * - packages/db/standing-prompt-store.ts — DB store
 * - apps/worker/src/standing-prompt-distill-job.ts — worker handler
 * - tests/integration/standing-prompt-distill.spec.ts — integration tests
 *
 * ## Integration points discovered during scout (issue #78)
 *
 * - The `activate` endpoint is responsible for the three-step atomic transaction:
 *     1. Supersede prior `active` version
 *     2. Activate the new version (body + word_count)
 *     3. Advance `standing_prompts.currently_active_version_id`
 *   All three steps must be inside a single DB transaction to prevent a race
 *   where two concurrent STANDING_PROMPT_DISTILL tasks for the same researcher
 *   both try to activate simultaneously, leaving two rows in `active` status.
 * - The word count limit is enforced in `activateStandingPromptVersion` in the
 *   DB store. The API surfaces this as HTTP 422 with a structured error body.
 * - WIKI_REBUILD workers (issue #76) should enqueue STANDING_PROMPT_DISTILL
 *   tasks when a wiki_page_version reaches `indexed`. Enqueue logic lives in
 *   apps/worker/src/wiki-rebuild-job.ts (to be wired in a follow-on issue).
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/78
 */

import type { AppState } from '../index';
import { makeJson } from '../lib/response';
import {
  upsertStandingPrompt,
  insertStandingPromptVersion,
  activateStandingPromptVersion,
  getActiveStandingPromptVersion,
  StandingPromptLengthError,
} from '../../../../packages/db/standing-prompt-store';

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * Test-mode token. Production workers will use signed JWTs scoped to
 * sp_distiller operations.
 */
export const STANDING_PROMPT_TEST_TOKEN = 'standing-prompt-distill-test-secret-78';

function checkBearer(req: Request): string | null {
  const auth = req.headers.get('authorization') ?? '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function isAuthorized(token: string | null): boolean {
  // TEST_MODE: accept the hard-coded test token.
  if (process.env.TEST_MODE === 'true' && token === STANDING_PROMPT_TEST_TOKEN) {
    return true;
  }
  // Production: validate signed JWT (not yet implemented; wired in follow-on issue).
  return false;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Handle all /internal/standing-prompt/* routes.
 *
 * Dispatches to the correct sub-handler based on method + pathname.
 * Returns a JSON Response, or null when the path is not under
 * /internal/standing-prompt (for use in a composite request router).
 */
export async function handleStandingPromptDistillApiRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/internal/standing-prompt')) return null;

  const json = makeJson({});
  const token = checkBearer(req);
  if (!isAuthorized(token)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const path = url.pathname;
  const method = req.method.toUpperCase();

  const { sql } = appState;

  // POST /internal/standing-prompt/prompt — upsert a standing_prompts row
  if (method === 'POST' && path === '/internal/standing-prompt/prompt') {
    const body = (await req.json()) as { tenant_id?: string; researcher_id?: string };
    if (!body.tenant_id || !body.researcher_id) {
      return json({ error: 'tenant_id and researcher_id are required' }, 400);
    }
    const row = await upsertStandingPrompt(sql, {
      tenant_id: body.tenant_id,
      researcher_id: body.researcher_id,
    });
    return json({
      standing_prompt_id: row.id,
      researcher_id: row.researcher_id,
    });
  }

  // POST /internal/standing-prompt/version — create a draft version (idempotent)
  if (method === 'POST' && path === '/internal/standing-prompt/version') {
    const body = (await req.json()) as {
      standing_prompt_id?: string;
      tenant_id?: string;
      researcher_id?: string;
      wiki_version_window?: string;
    };
    if (
      !body.standing_prompt_id ||
      !body.tenant_id ||
      !body.researcher_id ||
      !body.wiki_version_window
    ) {
      return json(
        {
          error:
            'standing_prompt_id, tenant_id, researcher_id, and wiki_version_window are required',
        },
        400,
      );
    }
    const { row, created } = await insertStandingPromptVersion(sql, {
      standing_prompt_id: body.standing_prompt_id,
      tenant_id: body.tenant_id,
      researcher_id: body.researcher_id,
      wiki_version_window: body.wiki_version_window,
    });
    return json({
      standing_prompt_version_id: row.id,
      status: created ? 'draft' : 'exists',
      wiki_version_window: row.wiki_version_window,
    });
  }

  // POST /internal/standing-prompt/version/:id/activate — activate a draft version
  const activateMatch = path.match(/^\/internal\/standing-prompt\/version\/([^/]+)\/activate$/);
  if (method === 'POST' && activateMatch) {
    const standing_prompt_version_id = activateMatch[1];
    const body = (await req.json()) as { standing_prompt_id?: string; body?: string };
    if (!body.standing_prompt_id || body.body === undefined) {
      return json({ error: 'standing_prompt_id and body are required' }, 400);
    }
    try {
      const row = await activateStandingPromptVersion(sql, {
        standing_prompt_id: body.standing_prompt_id,
        standing_prompt_version_id,
        body: body.body,
      });
      return json({
        standing_prompt_version_id: row.id,
        status: row.status,
        word_count: row.word_count,
      });
    } catch (err) {
      if (err instanceof StandingPromptLengthError) {
        return json(
          {
            error: 'length_exceeded',
            message: err.message,
            word_count: err.wordCount,
            hard_ceiling: err.hardCeiling,
          },
          422,
        );
      }
      throw err;
    }
  }

  // GET /internal/standing-prompt/active — fetch the currently active version
  if (method === 'GET' && path === '/internal/standing-prompt/active') {
    const tenant_id = url.searchParams.get('tenant_id');
    const researcher_id = url.searchParams.get('researcher_id');
    if (!tenant_id || !researcher_id) {
      return json({ error: 'tenant_id and researcher_id query params are required' }, 400);
    }
    const row = await getActiveStandingPromptVersion(sql, tenant_id, researcher_id);
    return json({ version: row ?? null });
  }

  // GET /internal/standing-prompt/wiki-pages — list currently published wiki pages for a researcher
  //
  // In this Phase 3 scout stub, "a researcher's wiki pages" means all wiki_pages
  // rows for the tenant. Researcher-to-subject scoping (thesis, portfolio) is a
  // Phase 4 feature. The response body field `body` is returned as plain text
  // (no encryption unwrap) because this is a test-environment stub — the
  // production implementation must decrypt body_ciphertext before returning.
  if (method === 'GET' && path === '/internal/standing-prompt/wiki-pages') {
    const tenant_id = url.searchParams.get('tenant_id');
    const researcher_id = url.searchParams.get('researcher_id');
    if (!tenant_id || !researcher_id) {
      return json({ error: 'tenant_id and researcher_id query params are required' }, 400);
    }

    // Fetch all indexed wiki_page_versions for the tenant via currently_published pointer.
    // This is a naive all-subjects query; researcher-scoped filtering is deferred.
    type WikiPageRow = {
      subject_type: string;
      subject_id: string;
      body_ciphertext: string | null;
    };

    const rows = await sql<WikiPageRow[]>`
      SELECT wpv.subject_type, wpv.subject_id, wpv.body_ciphertext
      FROM wiki_pages wp
      JOIN wiki_page_versions_mkt wpv
        ON wpv.id = wp.currently_published_version_id
      WHERE wp.tenant_id = ${tenant_id}
        AND wpv.status   = 'indexed'
      ORDER BY wpv.subject_type ASC, wpv.subject_id ASC
    `;

    return json({
      wiki_pages: rows.map((r: WikiPageRow) => ({
        subject_type: r.subject_type,
        subject_id: r.subject_id,
        // Phase 3 stub: body_ciphertext is stored as plain text in test environments.
        // Production must decrypt before returning.
        body: r.body_ciphertext ?? '',
      })),
    });
  }

  return json({ error: 'Not found' }, 404);
}
