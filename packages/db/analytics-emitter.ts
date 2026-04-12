/**
 * @file analytics-emitter
 *
 * Phase 7 analytics event emitter for BDM campaign queries.
 *
 * Writes pseudonymised session events to `kb_analytics.session_events`.
 * Session pseudonyms use HMAC-SHA256 rotation: one pseudonym per session,
 * keyed per tenant. No direct read path from session_id back to kb_app.
 *
 * Event types emitted:
 *   - `chunk_indexed`  — written at Phase 2 corpus chunk indexing
 *   - `wiki_published` — written at Phase 3 autolearn wiki version publish
 *
 * Isolation guarantee (DATA-C-031):
 *   The analytics emitter only holds a reference to `analyticsSql` (the
 *   `analytics_w` pool bound to `kb_analytics`). It never imports or
 *   references `sql` (the `app_rw` pool bound to `kb_app`). Any code path
 *   that wishes to emit an event must supply the `analyticsSql` pool
 *   explicitly — there is no module-level `sql` import here.
 *
 * Cross-tenant isolation (DATA-C-035):
 *   `tenant_id` is stored on every `session_events` row. The `analytics_w`
 *   role is the only login that can INSERT into `session_events`. The BDM
 *   campaign query endpoint must always filter by `tenant_id`.
 *
 * Canonical docs:
 *   - docs/implementation-plan-v1.md § Phase 7
 *   - calypso-blueprint/rules/blueprints/data.yaml
 *   - DATA-D-006, DATA-D-007, DATA-C-010/011, DATA-X-003
 */

import postgres from 'postgres';

// ---------------------------------------------------------------------------
// Session pseudonym
// ---------------------------------------------------------------------------

/**
 * Derives a per-session HMAC-SHA256 pseudonym for `sessionId`, keyed on
 * `tenantId`.
 *
 * The pseudonym is deterministic for the same (tenantId, sessionId) pair,
 * meaning the same ingestion session always maps to the same pseudonym within
 * one tenant's key space. Across tenants the keys differ, preventing
 * cross-tenant correlation.
 *
 * No reversal path: `tenantId` is never stored in `session_events` in a form
 * that allows recovery of the original `sessionId` without the HMAC key.
 * The actual user or asset-manager identity lives only in `kb_app` — there is
 * no foreign key or join path from `session_events` back to `kb_app`.
 */
export async function deriveSessionPseudonym(tenantId: string, sessionId: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(tenantId),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', keyMaterial, encoder.encode(sessionId));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionEventType = 'chunk_indexed' | 'wiki_published';

export interface EmitSessionEventOptions {
  /** `analytics_w` pool bound to `kb_analytics`. Never supply the app pool. */
  analyticsSql: postgres.Sql;
  /** Tenant the event belongs to. Stored on the row for cross-tenant isolation. */
  tenantId: string;
  /**
   * Opaque session identifier scoped to the ingestion or publish operation.
   * This value is HMAC-hashed before storage — it never appears in the database.
   */
  sessionId: string;
  /** Asset manager entity ID (from kb_app entities). Never joins back to kb_app. */
  assetManagerId: string;
  /** Fund entity ID associated with the session (from kb_app entities). */
  fundId: string;
  /**
   * SHA-256 hex hash of the corpus chunk content excerpt.
   * The chunk content is hashed before storage so no raw text lives in kb_analytics.
   */
  chunkExcerptHash: string;
  /** Type of event being recorded. */
  eventType: SessionEventType;
}

export interface SessionEventRow {
  id: string;
  tenant_id: string;
  session_id: string;
  asset_manager_id: string;
  fund_id: string;
  chunk_excerpt_hash: string;
  event_type: SessionEventType;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

/**
 * Writes one pseudonymised session event to `kb_analytics.session_events`.
 *
 * The `sessionId` is converted to an HMAC-SHA256 pseudonym before insertion.
 * The raw session ID never reaches the database.
 *
 * @param opts - Event options including the `analytics_w` pool.
 * @returns The persisted row.
 */
export async function emitSessionEvent(opts: EmitSessionEventOptions): Promise<SessionEventRow> {
  const sessionPseudonym = await deriveSessionPseudonym(opts.tenantId, opts.sessionId);

  const [row] = await opts.analyticsSql<SessionEventRow[]>`
    INSERT INTO session_events
      (tenant_id, session_id, asset_manager_id, fund_id, chunk_excerpt_hash, event_type)
    VALUES
      (${opts.tenantId}, ${sessionPseudonym}, ${opts.assetManagerId},
       ${opts.fundId}, ${opts.chunkExcerptHash}, ${opts.eventType})
    RETURNING *
  `;
  return row;
}

// ---------------------------------------------------------------------------
// Chunk excerpt hash helper
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex hash of a corpus chunk's content excerpt.
 *
 * Store this hash (not the raw content) in `session_events.chunk_excerpt_hash`
 * so that no raw customer text is written into the analytics tier.
 *
 * @param content - Raw chunk content string.
 */
export async function hashChunkExcerpt(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(content));
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// BDM campaign query
// ---------------------------------------------------------------------------

export interface BdmCampaignQueryOptions {
  /** `analytics_w` pool bound to `kb_analytics`. Never supply the app pool. */
  analyticsSql: postgres.Sql;
  /** Tenant whose events are queried. Cross-tenant rows are structurally excluded. */
  tenantId: string;
  /** Optional filter by event type. */
  eventType?: SessionEventType;
  /** Maximum rows to return. Default 100. */
  limit?: number;
}

/**
 * Query `kb_analytics.session_events` for BDM campaign analysis.
 *
 * This function must only receive an `analytics_w` pool. It must never be
 * called with an `app_rw` pool — that would violate DATA-C-031 (no code path
 * from analytics agent to kb_app).
 *
 * Cross-tenant guarantee (DATA-C-035): the WHERE clause always filters by
 * `tenant_id` supplied by the caller. The `analytics_w` role has no CONNECT
 * privilege on `kb_app`, so even if the caller omits the filter the query can
 * only read rows in `kb_analytics`.
 */
export async function queryBdmCampaignEvents(
  opts: BdmCampaignQueryOptions,
): Promise<SessionEventRow[]> {
  const limit = opts.limit ?? 100;
  if (opts.eventType !== undefined) {
    return opts.analyticsSql<SessionEventRow[]>`
      SELECT id, tenant_id, session_id, asset_manager_id, fund_id,
             chunk_excerpt_hash, event_type, created_at
      FROM session_events
      WHERE tenant_id = ${opts.tenantId}
        AND event_type = ${opts.eventType}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  }
  return opts.analyticsSql<SessionEventRow[]>`
    SELECT id, tenant_id, session_id, asset_manager_id, fund_id,
           chunk_excerpt_hash, event_type, created_at
    FROM session_events
    WHERE tenant_id = ${opts.tenantId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}
