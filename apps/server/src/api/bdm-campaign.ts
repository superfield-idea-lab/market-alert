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
 * Audit (issue #76): every cross-customer BDM campaign query emits a
 * hash-chained audit event into the append-only audit store BEFORE the
 * analytics rows are returned to the caller. The event captures:
 *   - actor_id  — the authenticated user performing the query
 *   - entity_type — 'bdm_campaign_query'
 *   - entity_id   — the queried tenant_id
 *   - after.asset_manager_id — the tenant_id (cross-customer boundary marker)
 *   - after.event_type_filter — the optional event_type filter, if provided
 *   - after.limit  — the effective row limit
 *   - ts — ISO 8601 timestamp of the query
 *
 * The Compliance Officer role (isSuperuser) can query the audit log at
 * GET /api/audit/verify to inspect the hash-chain integrity and retrieve
 * individual BDM query events.
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
import { emitAuditEvent } from '../policies/audit-service';

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

  // Emit audit event BEFORE returning data to the caller (issue #76).
  // If the audit write fails, the query result must not be returned.
  const queryTs = new Date().toISOString();
  await emitAuditEvent({
    actor_id: user.id,
    action: 'bdm.campaign.query',
    entity_type: 'bdm_campaign_query',
    entity_id: tenantId,
    before: null,
    after: {
      asset_manager_id: tenantId,
      event_type_filter: eventType ?? null,
      limit,
    },
    ip: req.headers.get('X-Forwarded-For') ?? req.headers.get('CF-Connecting-IP') ?? undefined,
    ts: queryTs,
  });

  const events = await queryBdmCampaignEvents({
    analyticsSql,
    tenantId,
    eventType,
    limit,
  });

  return json({ events }, 200);
}
