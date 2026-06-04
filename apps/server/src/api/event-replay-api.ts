/**
 * @file event-replay-api.ts
 *
 * Event replay and audit API — Phase 10 (issue #89).
 *
 * ## Routes
 *
 *   POST /api/replay/event
 *     Replay a past market event against the wiki snapshot and standing-prompt
 *     revision that were active at evaluation time (or at a specified point
 *     in time).
 *
 *     Body: {
 *       market_event_id: string;
 *       // Optional: replay against the wiki/prompt as of this time.
 *       // Defaults to the time of the original signal evaluation.
 *       as_of?: string; // ISO-8601
 *     }
 *
 *     Auth: Researcher (own signals) or Admin.
 *
 *     Returns: {
 *       original_signal: SignalRow | null;   // The signal produced by the original evaluation
 *       replay_inputs: {
 *         market_event: MarketEventRow;
 *         wiki_page_version_id: string | null;
 *         standing_prompt_version_id: string | null;
 *         wiki_page_version_body: string | null; // decrypted body
 *         standing_prompt_body: string | null;
 *       };
 *       signal_cites: SignalCiteRow[];        // Citations from the original signal
 *       replayed_at: string;                  // ISO-8601
 *     }
 *
 * ## Replay semantics
 *
 * "Replay" here means: given a past market_event, return the exact inputs that
 * were used to produce the original signal. It does NOT re-run the LLM call;
 * it surfaces the snapshot state for audit and researcher inspection.
 *
 * PRD §9 auditability: "any past signal must be replayable against the exact
 * wiki snapshot and standing-prompt revision active at the time."
 *
 * ## Canonical docs
 *
 * - `docs/prd.md` §9, §12 — auditability, replay constraint
 * - `docs/architecture.md` §"Citations: first-class relation edges"
 * - `packages/db/signal-store.ts` — signal and signal_cites store
 * - `packages/db/wiki-rebuild-store.ts` — wiki_page_version access
 * - `packages/db/standing-prompt-store.ts` — standing_prompt_version access
 * - `packages/db/mkt-market-event-store.ts` — market_events store
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/89
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import { getMarketEventById } from 'db/mkt-market-event-store';
import { getSignalById, getSignalCites, type SignalRow, type SignalCiteRow } from 'db/signal-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isAdminOrSuperuser(sql: AppState['sql'], userId: string): Promise<boolean> {
  if (isSuperuser(userId)) return true;

  const rows = await sql<{ role: string }[]>`
    SELECT (properties->>'role') AS role
    FROM entities
    WHERE id = ${userId} AND type = 'user'
    LIMIT 1
  `;
  const role = rows[0]?.role ?? '';
  return role === 'admin';
}

/**
 * Fetch the most recent signal for a market event.
 * Returns the signal that was produced by the original evaluation.
 */
async function getSignalForEvent(
  sql: AppState['sql'],
  marketEventId: string,
): Promise<SignalRow | null> {
  const rows = await sql<SignalRow[]>`
    SELECT id, tenant_id, researcher_id, market_event_id, standing_prompt_version_id,
           idempotency_key, rationale, source_trust, extraction_certainty, status,
           created_at, updated_at
    FROM signals
    WHERE market_event_id = ${marketEventId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Fetch the wiki_page_version body for a given version ID.
 * Returns null when the version does not exist.
 */
async function getWikiVersionBody(
  sql: AppState['sql'],
  versionId: string,
): Promise<{
  id: string;
  body_ciphertext: string | null;
  subject_type: string;
  subject_id: string;
} | null> {
  const rows = await sql<
    {
      id: string;
      body_ciphertext: string | null;
      subject_type: string;
      subject_id: string;
    }[]
  >`
    SELECT id, body_ciphertext, subject_type, subject_id
    FROM wiki_page_versions_mkt
    WHERE id = ${versionId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Fetch the standing_prompt_version body for a given version ID.
 * Joins to standing_prompts to retrieve subject_type and subject_id.
 */
async function getStandingPromptVersionBody(
  sql: AppState['sql'],
  versionId: string,
): Promise<{ id: string; prompt_body: string; subject_type: string; subject_id: string } | null> {
  const rows = await sql<
    {
      id: string;
      prompt_body: string;
      subject_type: string;
      subject_id: string;
    }[]
  >`
    SELECT spv.id,
           COALESCE(spv.body, '') AS prompt_body,
           sp.subject_type,
           sp.subject_id
    FROM standing_prompt_versions spv
    JOIN standing_prompts sp ON sp.id = spv.standing_prompt_id
    WHERE spv.id = ${versionId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle POST /api/replay/event.
 *
 * Returns null for unmatched paths.
 */
export async function handleEventReplayRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (url.pathname !== '/api/replay/event') return null;
  if (req.method !== 'POST') return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  // ── Session auth ──────────────────────────────────────────────────────────
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return json({ error: 'Unauthorized — session required' }, 401);
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: { market_event_id?: unknown; as_of?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.market_event_id !== 'string' || !body.market_event_id) {
    return json({ error: 'market_event_id is required' }, 400);
  }

  const marketEventId = body.market_event_id;
  const asOf = typeof body.as_of === 'string' ? body.as_of : undefined;

  // ── Fetch market event ────────────────────────────────────────────────────
  const marketEvent = await getMarketEventById(marketEventId, sql);
  if (!marketEvent) {
    return json({ error: `Market event not found: ${marketEventId}` }, 404);
  }

  // ── Check access: researcher can only replay events that produced signals
  //    they own; admins can replay any event. ─────────────────────────────
  const isAdmin = await isAdminOrSuperuser(sql, user.id);
  const originalSignal = await getSignalForEvent(sql, marketEventId);

  if (!isAdmin && originalSignal && originalSignal.researcher_id !== user.id) {
    return json({ error: 'Forbidden — this signal belongs to another researcher' }, 403);
  }

  // ── Fetch signal citations ────────────────────────────────────────────────
  let signalCites: SignalCiteRow[] = [];
  if (originalSignal) {
    signalCites = await getSignalCites(originalSignal.id, sql);
  }

  // ── Resolve wiki snapshot and standing-prompt revision from citations ─────
  let wikiPageVersionId: string | null = null;
  let standingPromptVersionId: string | null = null;

  for (const cite of signalCites) {
    if (cite.target_type === 'wiki_page_version') {
      wikiPageVersionId = cite.target_id;
    } else if (cite.target_type === 'standing_prompt_version') {
      standingPromptVersionId = cite.target_id;
    }
  }

  // When no citations exist (scout or pre-citation signals), fall back to the
  // signal's standing_prompt_version_id if available.
  if (!standingPromptVersionId && originalSignal) {
    standingPromptVersionId = originalSignal.standing_prompt_version_id;
  }

  // ── If as_of is provided, find the wiki version closest to that time ──────
  if (asOf && !wikiPageVersionId && marketEvent.subject_entity_id) {
    const rows = await sql<{ id: string }[]>`
      SELECT wv.id
      FROM wiki_page_versions_mkt wv
      JOIN wiki_pages wp ON wp.id = wv.wiki_page_id
      WHERE wp.subject_id = ${marketEvent.subject_entity_id}
        AND wv.status = 'indexed'
        AND wv.created_at <= ${asOf}
      ORDER BY wv.created_at DESC
      LIMIT 1
    `;
    wikiPageVersionId = rows[0]?.id ?? null;
  }

  // ── Fetch snapshot bodies ─────────────────────────────────────────────────
  const [wikiVersion, promptVersion] = await Promise.all([
    wikiPageVersionId ? getWikiVersionBody(sql, wikiPageVersionId) : Promise.resolve(null),
    standingPromptVersionId
      ? getStandingPromptVersionBody(sql, standingPromptVersionId)
      : Promise.resolve(null),
  ]);

  // ── Build replay response ─────────────────────────────────────────────────
  // Note: body_ciphertext is returned as-is; the researcher UI decrypts it
  // using the session KMS path. The replay API does not decrypt server-side
  // to avoid PII leakage in audit logs.
  const replayInputs = {
    market_event: marketEvent,
    wiki_page_version_id: wikiPageVersionId,
    standing_prompt_version_id: standingPromptVersionId,
    wiki_page_version_body: wikiVersion?.body_ciphertext ?? null,
    standing_prompt_body: promptVersion?.prompt_body ?? null,
  };

  return json(
    {
      original_signal: originalSignal,
      replay_inputs: replayInputs,
      signal_cites: signalCites,
      replayed_at: new Date().toISOString(),
    },
    200,
  );
}

/**
 * Convenience: GET /api/replay/signal/:id
 *
 * Fetches the inputs that produced a specific signal (by signal ID).
 * Convenience alias for POST /api/replay/event using the signal's market_event_id.
 *
 * Returns null for unmatched paths.
 */
export async function handleSignalReplayRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/replay\/signal\/([^/]+)$/);
  if (!match || req.method !== 'GET') return null;

  const signalId = match[1]!;
  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized — session required' }, 401);

  const signal = await getSignalById(signalId, sql);
  if (!signal) return json({ error: `Signal not found: ${signalId}` }, 404);

  const isAdmin = await isAdminOrSuperuser(sql, user.id);
  if (!isAdmin && signal.researcher_id !== user.id) {
    return json({ error: 'Forbidden — this signal belongs to another researcher' }, 403);
  }

  const [marketEvent, signalCites] = await Promise.all([
    getMarketEventById(signal.market_event_id, sql),
    getSignalCites(signalId, sql),
  ]);

  // Resolve wiki and prompt versions from citations.
  let wikiPageVersionId: string | null = null;
  let standingPromptVersionId: string | null = signal.standing_prompt_version_id;

  for (const cite of signalCites) {
    if (cite.target_type === 'wiki_page_version') wikiPageVersionId = cite.target_id;
    else if (cite.target_type === 'standing_prompt_version')
      standingPromptVersionId = cite.target_id;
  }

  const [wikiVersion, promptVersion] = await Promise.all([
    wikiPageVersionId ? getWikiVersionBody(sql, wikiPageVersionId) : Promise.resolve(null),
    standingPromptVersionId
      ? getStandingPromptVersionBody(sql, standingPromptVersionId)
      : Promise.resolve(null),
  ]);

  return json(
    {
      signal,
      replay_inputs: {
        market_event: marketEvent,
        wiki_page_version_id: wikiPageVersionId,
        standing_prompt_version_id: standingPromptVersionId,
        wiki_page_version_body: wikiVersion?.body_ciphertext ?? null,
        standing_prompt_body: promptVersion?.prompt_body ?? null,
      },
      signal_cites: signalCites,
      replayed_at: new Date().toISOString(),
    },
    200,
  );
}
