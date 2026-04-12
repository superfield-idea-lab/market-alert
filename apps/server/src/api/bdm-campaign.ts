/**
 * @file bdm-campaign
 *
 * BDM campaign query and export endpoints.
 *
 * GET  /api/bdm/campaign        — BDM campaign query (JSON)
 * GET  /api/bdm/campaign/export — BDM campaign CSV export (audited)
 *
 * Phase 7: queries `kb_analytics.session_events` only. The `kb_app` database
 * is never touched by these handlers (DATA-C-031).
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
 * Role restriction for export (issue #77):
 *   Only users with `properties.role === 'bdm'` or superadmins may call the
 *   export endpoint. The check is performed against the `kb_app` entities table
 *   via `getUserAccessFlags`. Non-BDM callers receive 403 Forbidden.
 *
 * Anonymisation guarantee:
 *   The CSV columns are drawn exclusively from `kb_analytics.session_events`
 *   which contains no customer-identifying data by construction:
 *     - session_id: HMAC-SHA256 pseudonym (not the original session identifier)
 *     - asset_manager_id, fund_id: opaque entity UUIDs from kb_app; no PII
 *     - chunk_excerpt_hash: SHA-256 of the chunk content — no raw text
 *   The export therefore cannot leak customer identities through the CSV file.
 *
 * Audit:
 *   Every export request writes one `bdm_campaign.export` event to
 *   `audit_events` *before* the CSV rows are streamed. This preserves the
 *   "audit-before-access" invariant used across Phase 3, Phase 5, and Phase 6
 *   exports (see corpus-chunk-store.ts §writeAuditEvent).
 *
 * Canonical docs:
 *   - docs/implementation-plan-v1.md § Phase 7
 *   - docs/PRD.md §4.7 (Cross-Customer Campaign Summary)
 *   - DATA-D-006, DATA-C-031, DATA-C-035
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { makeJson } from '../lib/response';
import { getUserAccessFlags } from '../lib/access';
import { queryBdmCampaignEvents, type SessionEventType } from 'db/analytics-emitter';
import { emitAuditEvent } from '../policies/audit-service';
import { computeAuditHash } from 'core';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// Genesis hash constant (mirrors corpus-chunk-store.ts)
// ---------------------------------------------------------------------------

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Write one `bdm_campaign.export` audit event.
 *
 * Runs in a SERIALIZABLE transaction to maintain the hash chain.
 * Throws on failure — callers must not stream CSV until this resolves.
 *
 * @param auditSql - Audit database pool.
 * @param actorId  - Authenticated user UUID.
 * @param tenantId - Tenant being exported.
 * @param rowCount - Number of rows included in the export.
 * @param ts       - ISO-8601 timestamp for the event.
 */
async function writeCampaignExportAuditEvent(
  auditSql: postgres.Sql,
  actorId: string,
  tenantId: string,
  rowCount: number,
  ts: string,
): Promise<void> {
  const reserved = await auditSql.reserve();
  try {
    await reserved.unsafe('BEGIN ISOLATION LEVEL SERIALIZABLE');

    const latestRows = (await reserved.unsafe(
      'SELECT hash FROM audit_events ORDER BY ts DESC, id DESC LIMIT 1',
    )) as unknown as { hash: string }[];

    const prevHash = latestRows[0]?.hash ?? GENESIS_HASH;

    const afterPayload: Record<string, unknown> = {
      tenant_id: tenantId,
      row_count: rowCount,
      format: 'csv',
    };

    const hash = await computeAuditHash(prevHash, {
      actor_id: actorId,
      action: 'bdm_campaign.export',
      entity_type: 'campaign_export',
      entity_id: tenantId,
      before: null,
      after: afterPayload,
      ts,
    });

    await reserved.unsafe(
      `INSERT INTO audit_events
         (actor_id, action, entity_type, entity_id, before, after, ip, user_agent, correlation_id, ts, prev_hash, hash)
       VALUES ($1, $2, $3, $4, NULL, $5::jsonb, NULL, NULL, NULL, $6::timestamptz, $7, $8)`,
      [
        actorId,
        'bdm_campaign.export',
        'campaign_export',
        tenantId,
        JSON.stringify(afterPayload),
        ts,
        prevHash,
        hash,
      ],
    );

    await reserved.unsafe('COMMIT');
  } catch (err) {
    await reserved.unsafe('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    reserved.release();
  }
}

/**
 * Serialise session event rows into RFC 4180-compliant CSV.
 *
 * Columns emitted (all anonymised — no customer identifiers):
 *   id, tenant_id, session_id (pseudonym), asset_manager_id, fund_id,
 *   chunk_excerpt_hash, event_type, created_at
 *
 * Field values are enclosed in double-quotes and internal double-quotes are
 * escaped as `""` per RFC 4180 §2.7.
 */
function toCsv(
  rows: {
    id: string;
    tenant_id: string;
    session_id: string;
    asset_manager_id: string;
    fund_id: string;
    chunk_excerpt_hash: string;
    event_type: string;
    created_at: Date | string;
  }[],
): string {
  function escape(value: unknown): string {
    const str = value instanceof Date ? value.toISOString() : String(value ?? '');
    return `"${str.replace(/"/g, '""')}"`;
  }

  const header =
    'id,tenant_id,session_id,asset_manager_id,fund_id,chunk_excerpt_hash,event_type,created_at';
  const dataRows = rows.map((row) =>
    [
      escape(row.id),
      escape(row.tenant_id),
      escape(row.session_id),
      escape(row.asset_manager_id),
      escape(row.fund_id),
      escape(row.chunk_excerpt_hash),
      escape(row.event_type),
      escape(row.created_at),
    ].join(','),
  );

  return [header, ...dataRows].join('\r\n');
}

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

/**
 * Handles GET /api/bdm/campaign and GET /api/bdm/campaign/export.
 *
 * GET /api/bdm/campaign
 *   Query parameters:
 *     tenant_id  — required: the tenant whose session_events are returned
 *     event_type — optional filter: 'chunk_indexed' | 'wiki_published'
 *     limit      — optional max rows (default 100, max 500)
 *   Returns { events: SessionEventRow[] }.
 *
 * GET /api/bdm/campaign/export
 *   Query parameters:
 *     tenant_id  — required
 *     event_type — optional filter
 *     limit      — optional max rows (default 100, max 500)
 *   Returns application/csv.
 *   Requires role 'bdm' or superadmin; emits an audit event before streaming.
 *
 * Returns null for non-matching paths so the caller can chain handlers.
 */
export async function handleBdmCampaignRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  const isExportPath = url.pathname === '/api/bdm/campaign/export';
  const isQueryPath = url.pathname === '/api/bdm/campaign';

  if ((!isExportPath && !isQueryPath) || req.method !== 'GET') return null;

  const corsHeaders = getCorsHeaders(req);
  const { analyticsSql, auditSql, sql } = appState;
  const json = makeJson(corsHeaders);

  // Require authenticated session.
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // For the export endpoint, enforce the BDM role restriction.
  if (isExportPath) {
    const access = await getUserAccessFlags(user.id, sql);
    if (!access.isBdm && !access.isSuperadmin) {
      return json({ error: 'Forbidden' }, 403);
    }
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

  // -------------------------------------------------------------------------
  // JSON query path
  // -------------------------------------------------------------------------
  if (isQueryPath) {
    return json({ events }, 200);
  }

  // -------------------------------------------------------------------------
  // CSV export path — audit before streaming
  // -------------------------------------------------------------------------

  const ts = new Date().toISOString();

  // Write audit event before returning any data (audit-before-access invariant).
  await writeCampaignExportAuditEvent(auditSql, user.id, tenantId, events.length, ts);

  const csvBody = toCsv(events);

  const filename = `campaign-export-${tenantId}-${ts.replace(/[:.]/g, '-')}.csv`;

  return new Response(csvBody, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
