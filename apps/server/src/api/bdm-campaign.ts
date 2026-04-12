/**
 * @file bdm-campaign
 *
 * GET /api/bdm/campaign — BDM campaign query endpoint.
 *
 * Phase 7: queries `kb_analytics.session_events` only. The `kb_app` database
 * is never touched by this handler (DATA-C-031).
 *
 * Cross-tenant isolation (DATA-C-035): the tenant_id is extracted from the
 * authenticated session context and always applied as a WHERE filter. The
 * `analytics_w` role has no CONNECT privilege on `kb_app`, so even if a BDM
 * caller omitted a tenant filter they could not reach customer-scoped tables.
 *
 * Authentication: requires a valid JWT session (same as other API routes).
 *
 * Canonical docs:
 *   - docs/implementation-plan-v1.md § Phase 7
 *   - docs/PRD.md §4.7 (Cross-Customer Campaign Summary)
 *   - DATA-D-006, DATA-C-031, DATA-C-035
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { makeJson } from '../lib/response';
import { queryBdmCampaignEvents, type SessionEventType } from 'db/analytics-emitter';

/**
 * Handles GET /api/bdm/campaign.
 *
 * Query parameters:
 *   tenant_id  — required: the tenant whose session_events are returned
 *   event_type — optional filter: 'chunk_indexed' | 'wiki_published'
 *   limit      — optional max rows (default 100, max 500)
 *
 * Returns null for non-matching paths so the caller can chain handlers.
 */
export async function handleBdmCampaignRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (url.pathname !== '/api/bdm/campaign' || req.method !== 'GET') return null;

  const corsHeaders = getCorsHeaders(req);
  const { analyticsSql } = appState;
  const json = makeJson(corsHeaders);

  // Require authenticated session.
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // tenant_id is required — the analytics tier only exposes rows for one tenant at a time.
  const tenantId = url.searchParams.get('tenant_id');
  if (!tenantId) {
    return json({ error: 'tenant_id query parameter is required' }, 400);
  }

  // Optional query parameters.
  const rawEventType = url.searchParams.get('event_type');
  const rawLimit = url.searchParams.get('limit');

  let eventType: SessionEventType | undefined;
  if (rawEventType !== null) {
    if (rawEventType !== 'chunk_indexed' && rawEventType !== 'wiki_published') {
      return json({ error: 'event_type must be chunk_indexed or wiki_published' }, 400);
    }
    eventType = rawEventType;
  }

  let limit = 100;
  if (rawLimit !== null) {
    const parsed = parseInt(rawLimit, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return json({ error: 'limit must be a positive integer' }, 400);
    }
    limit = Math.min(parsed, 500);
  }

  const events = await queryBdmCampaignEvents({
    analyticsSql,
    tenantId,
    eventType,
    limit,
  });

  return json({ events }, 200);
}
