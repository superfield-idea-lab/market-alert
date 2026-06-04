/**
 * @file signal-routing-api.ts
 *
 * Internal API for prompt routing and confidence-based signal routing — issue #83.
 *
 * ## Routes
 *
 *   GET  /internal/signal-routing/resolve-prompt
 *     Query: tenant_id, researcher_id, subject_entity_id, thesis_ids? (CSV)
 *     Returns: { prompt_version: StandingPromptVersionRow | null,
 *                subject_type: string | null, subject_id: string | null }
 *     Resolves the most specific Active standing prompt for the given subject
 *     using the entity → thesis → portfolio fallback chain (PRD §5, §9).
 *
 *   POST /internal/signal-routing/route
 *     Body: { source_trust: number, extraction_certainty: number, threshold?: number }
 *     Returns: { confidence: number, source_trust: number, extraction_certainty: number,
 *                route: 'direct' | 'reviewer' }
 *     Computes the confidence decomposition and determines the routing decision
 *     (direct delivery vs Reviewer queue).
 *
 * ## Security
 *
 * Bearer token validated against SIGNAL_ROUTING_TEST_TOKEN in TEST_MODE.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5, §9 — event evaluation, confidence, auditability
 * - docs/architecture.md §"Signal routing"
 * - packages/db/signal-routing.ts — routing logic
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/83
 */

import type { AppState } from '../index';
import { makeJson } from '../lib/response';
import {
  resolveStandingPromptForEvent,
  computeConfidence,
  routeByConfidence,
  DEFAULT_CONFIDENCE_THRESHOLD,
} from '../../../../packages/db/signal-routing';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Test-mode bearer token for the signal-routing API (issue #83). */
export const SIGNAL_ROUTING_TEST_TOKEN = 'signal-routing-test-secret-83';

function checkBearer(req: Request): string | null {
  const auth = req.headers.get('authorization') ?? '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function isAuthorized(token: string | null): boolean {
  if (process.env.TEST_MODE === 'true' && token === SIGNAL_ROUTING_TEST_TOKEN) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Handle all requests under /internal/signal-routing.
 *
 * Returns a Response on match, or null if the path does not match.
 */
export async function handleSignalRoutingApiRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/internal/signal-routing')) return null;

  const json = makeJson({});
  const token = checkBearer(req);
  if (!isAuthorized(token)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const path = url.pathname;
  const method = req.method.toUpperCase();
  const { sql } = appState;

  // GET /internal/signal-routing/resolve-prompt
  // Resolves the most specific Active standing prompt for the given subject.
  if (method === 'GET' && path === '/internal/signal-routing/resolve-prompt') {
    const tenant_id = url.searchParams.get('tenant_id');
    const researcher_id = url.searchParams.get('researcher_id');
    const subject_entity_id = url.searchParams.get('subject_entity_id');
    const thesis_ids_raw = url.searchParams.get('thesis_ids');

    if (!tenant_id || !researcher_id || !subject_entity_id) {
      return json({ error: 'tenant_id, researcher_id, and subject_entity_id are required' }, 400);
    }

    const thesis_ids = thesis_ids_raw
      ? thesis_ids_raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    const resolved = await resolveStandingPromptForEvent({
      sql,
      tenant_id,
      researcher_id,
      subject_entity_id,
      thesis_ids,
    });

    if (!resolved) {
      return json({ prompt_version: null, subject_type: null, subject_id: null });
    }

    return json({
      prompt_version: resolved.promptVersion,
      subject_type: resolved.subjectType,
      subject_id: resolved.subjectId,
    });
  }

  // POST /internal/signal-routing/route
  // Computes confidence and determines the routing decision.
  if (method === 'POST' && path === '/internal/signal-routing/route') {
    const body = (await req.json()) as {
      source_trust?: unknown;
      extraction_certainty?: unknown;
      threshold?: unknown;
    };

    if (typeof body.source_trust !== 'number' || typeof body.extraction_certainty !== 'number') {
      return json({ error: 'source_trust and extraction_certainty must be numbers' }, 400);
    }

    const threshold =
      typeof body.threshold === 'number' ? body.threshold : DEFAULT_CONFIDENCE_THRESHOLD;

    const decomposition = computeConfidence(body.source_trust, body.extraction_certainty);
    const route = routeByConfidence(decomposition.confidence, threshold);

    return json({
      source_trust: decomposition.source_trust,
      extraction_certainty: decomposition.extraction_certainty,
      confidence: decomposition.confidence,
      route,
    });
  }

  return null;
}
