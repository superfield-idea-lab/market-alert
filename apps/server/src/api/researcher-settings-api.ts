/**
 * @file researcher-settings-api.ts
 *
 * Researcher-facing Sources & Triggers settings API — issue #118.
 *
 * ## Routes
 *
 *   GET /api/researcher/sources
 *     Cookie: <session-cookie>
 *     Returns: { sources: ResearcherSourceRow[] }
 *     Lists all canonical_sources for the authenticated researcher's tenant.
 *     Returns name, url, trust_tier (access_mode), and status for each source.
 *
 *   GET /api/researcher/standing-prompts
 *     Cookie: <session-cookie>
 *     Returns: { standing_prompts: ResearcherStandingPromptRow[] }
 *     Lists all standing_prompts for the researcher with currently_active_version
 *     body word count and is_pinned flag.
 *
 * ## Security model
 *
 * Session cookie authentication is required for both endpoints. Worker Bearer
 * tokens are explicitly rejected with 403. Unauthenticated requests receive 401.
 *
 * Pin and unpin operations proxy to the existing internal standing-prompt
 * endpoints (/internal/standing-prompt/prompt/:id/pin and /unpin), which are
 * already implemented in standing-prompt-distill-api.ts. Rather than duplicating
 * that logic, these researcher endpoints call those internal handlers directly.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §3, §5, §7 — researcher sources, standing-prompt routing, pin/override
 * - packages/db/canonical-source-store.ts — DB store for canonical_sources
 * - packages/db/standing-prompt-store.ts  — DB store for standing_prompts
 * - apps/server/src/api/standing-prompt-distill-api.ts — pin/unpin internal API
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/118
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { makeJson } from '../lib/response';
import type { SqlClient } from 'db/canonical-source-store';
import {
  pinActiveStandingPromptVersion,
  unpinActiveStandingPromptVersion,
} from 'db/standing-prompt-store';

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/**
 * A canonical source row as returned to the researcher UI.
 *
 * trust_tier maps to canonical_sources.access_mode (the trust tier of the
 * venue as declared in the Research Methodology).
 */
export interface ResearcherSourceRow {
  id: string;
  name: string;
  url: string;
  /** access_mode from canonical_sources — used as the "trust tier" for researchers. */
  trust_tier: 'public' | 'authenticated' | 'api_key' | null;
  status: 'pending' | 'active' | 'retired';
}

/**
 * A standing prompt row as returned to the researcher triggers UI.
 */
export interface ResearcherStandingPromptRow {
  id: string;
  subject_type: 'entity' | 'thesis' | 'portfolio';
  subject_id: string;
  /** Word count of the currently active version body, or null if no active version. */
  active_version_word_count: number | null;
  /** Whether the currently active version is pinned, or null if no active version. */
  is_pinned: boolean | null;
  /** The currently active version ID, or null if no active version. */
  active_version_id: string | null;
}

// ---------------------------------------------------------------------------
// DB queries
// ---------------------------------------------------------------------------

/**
 * List all canonical sources for a researcher's tenant.
 *
 * Scoped by tenant_id — all sources for the tenant are visible to any
 * researcher in that tenant (read-only surface).
 */
async function listSourcesForTenant(
  sql: SqlClient,
  tenant_id: string,
): Promise<ResearcherSourceRow[]> {
  const rows = await sql<ResearcherSourceRow[]>`
    SELECT
      id,
      name,
      url,
      access_mode AS trust_tier,
      status
    FROM canonical_sources
    WHERE tenant_id = ${tenant_id}
    ORDER BY created_at ASC
  `;
  return rows;
}

/**
 * List all standing prompts for a researcher with their active version metadata.
 *
 * Joins standing_prompts with standing_prompt_versions to return the active
 * version's word count and is_pinned flag.
 */
async function listStandingPromptsForResearcher(
  sql: SqlClient,
  tenant_id: string,
  researcher_id: string,
): Promise<ResearcherStandingPromptRow[]> {
  const rows = await sql<ResearcherStandingPromptRow[]>`
    SELECT
      sp.id,
      sp.subject_type,
      sp.subject_id,
      spv.word_count   AS active_version_word_count,
      spv.is_pinned    AS is_pinned,
      spv.id           AS active_version_id
    FROM standing_prompts sp
    LEFT JOIN standing_prompt_versions spv
      ON spv.id = sp.currently_active_version_id
    WHERE sp.tenant_id     = ${tenant_id}
      AND sp.researcher_id = ${researcher_id}
    ORDER BY sp.subject_type ASC, sp.subject_id ASC
  `;
  return rows;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle GET /api/researcher/sources and GET /api/researcher/standing-prompts.
 *
 * Returns null when the path does not match, allowing the caller to fall
 * through to the next handler.
 */
export async function handleResearcherSettingsRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  // Only handle /api/researcher/* routes
  if (!url.pathname.startsWith('/api/researcher/')) return null;

  const { sql } = appState;
  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      },
    });
  }

  // Worker Bearer tokens are rejected with 403 on all researcher routes.
  const authHeader = req.headers.get('Authorization') ?? '';
  if (authHeader.startsWith('Bearer ')) {
    return json(
      { error: 'Forbidden — worker Bearer tokens may not access researcher settings' },
      403,
    );
  }

  // Require an authenticated session cookie.
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return json({ error: 'Unauthorized — session required' }, 401);
  }

  // ── GET /api/researcher/sources ───────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/researcher/sources') {
    const sources = await listSourcesForTenant(sql, user.id);
    return json({ sources }, 200);
  }

  // ── GET /api/researcher/standing-prompts ──────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/researcher/standing-prompts') {
    const standing_prompts = await listStandingPromptsForResearcher(sql, user.id, user.id);
    return json({ standing_prompts }, 200);
  }

  // ── POST /api/researcher/standing-prompts/:id/pin ─────────────────────────
  const pinMatch = url.pathname.match(
    /^\/api\/researcher\/standing-prompts\/([^/]+)\/(pin|unpin)$/,
  );
  if (req.method === 'POST' && pinMatch) {
    const standingPromptId = pinMatch[1]!;
    const action = pinMatch[2] as 'pin' | 'unpin';

    let updated;
    if (action === 'pin') {
      updated = await pinActiveStandingPromptVersion(sql, standingPromptId);
    } else {
      updated = await unpinActiveStandingPromptVersion(sql, standingPromptId);
    }

    if (!updated) {
      return json({ error: 'No active version found for this standing prompt' }, 404);
    }

    return json(
      {
        standing_prompt_version_id: updated.id,
        is_pinned: updated.is_pinned,
      },
      200,
    );
  }

  // No matching route under /api/researcher/
  return null;
}
