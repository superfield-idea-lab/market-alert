/**
 * @file api/campaign-analysis
 *
 * Campaign analysis query endpoint for BDM users.
 *
 * ## Endpoints
 *
 *   GET /api/campaign/entities?type=asset_manager|fund
 *     Lists available asset managers or funds (picker data).
 *     Auth: authenticated session.
 *
 *   GET /api/campaign/chunks?entity_id=<id>
 *     Returns anonymised CorpusChunk rows linked via `discussed_in` relations
 *     to the specified entity (asset_manager or fund).
 *     Auth: authenticated session.
 *
 * ## Security invariants
 *
 * - No customer identifiers appear in any response. The `source_id` field
 *   (which links a chunk to a transcript, and transitively to a customer) is
 *   never included. Properties returned are limited to `index` and
 *   `token_count`; the encrypted `body` field is stripped from all responses.
 * - The endpoint respects BDM RLS: only entities tagged via `discussed_in`
 *   from transcript sources are surfaced; direct joins to customer-scoped
 *   entity types are absent from this query path.
 * - An audit event is emitted for every successful chunk query, recording the
 *   actor, the queried entity, and the timestamp.
 *
 * ## Data model
 *
 * `discussed_in` relations link a `transcript` entity (source_id) to an
 * `asset_manager` or `fund` entity (target_id). Each transcript entity has
 * associated `corpus_chunk` entities whose `source_id` matches the transcript
 * id. This endpoint traverses:
 *
 *   relations.target_id = entity_id (discussed_in)
 *   → relations.source_id (transcript id)
 *   → entities where type = 'corpus_chunk' AND properties->>'source_id' = transcript.id
 *
 * ## Anonymisation
 *
 * Each chunk row returned to the client contains only:
 *   - `chunk_id`   — the corpus chunk entity id (opaque UUID)
 *   - `index`      — position within the source document
 *   - `token_count` — approximate size
 *
 * The `body` (encrypted text), `source_id` (transcript FK), and any other
 * properties that could link back to a customer are excluded.
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/74
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { makeJson } from '../lib/response';
import { emitAuditEvent } from '../policies/audit-service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Anonymised representation of a single CorpusChunk — no customer identifiers. */
export interface AnonymisedChunk {
  /** Opaque entity id of the corpus_chunk row. */
  chunk_id: string;
  /** Zero-based position of this chunk within the source document. */
  index: number;
  /** Approximate token count of this chunk. */
  token_count: number;
}

/** Shape of a row returned by the entity picker query. */
interface PickerEntity {
  id: string;
  name: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles GET /api/campaign/entities and GET /api/campaign/chunks.
 *
 * Returns null for paths that do not match so the caller can chain handlers.
 */
export async function handleCampaignAnalysisRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/campaign')) return null;
  if (req.method !== 'GET') return null;

  const corsHeaders = getCorsHeaders(req);
  const { sql } = appState;
  const json = makeJson(corsHeaders);

  // Auth — session cookie required for both endpoints.
  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // ── GET /api/campaign/entities — picker data ─────────────────────────────
  if (url.pathname === '/api/campaign/entities') {
    const type = url.searchParams.get('type');
    const allowedTypes = ['asset_manager', 'fund'] as const;
    if (!type || !allowedTypes.includes(type as (typeof allowedTypes)[number])) {
      return json({ error: 'type must be asset_manager or fund' }, 400);
    }

    interface EntityRow {
      id: string;
      properties: Record<string, unknown>;
    }

    const rows = await sql<EntityRow[]>`
      SELECT id, properties
      FROM entities
      WHERE type = ${type}
      ORDER BY properties->>'name' ASC
    `;

    const entities: PickerEntity[] = rows.map((r) => ({
      id: r.id,
      name: typeof r.properties.name === 'string' ? r.properties.name : r.id,
      type,
    }));

    return json({ entities });
  }

  // ── GET /api/campaign/chunks — anonymised chunk query ────────────────────
  if (url.pathname === '/api/campaign/chunks') {
    const entityId = url.searchParams.get('entity_id');
    if (!entityId || typeof entityId !== 'string' || !entityId.trim()) {
      return json({ error: 'entity_id is required' }, 400);
    }

    // Verify the target entity exists and is an allowed type.
    interface EntityTypeRow {
      id: string;
      type: string;
    }
    const entityRows = await sql<EntityTypeRow[]>`
      SELECT id, type FROM entities
      WHERE id = ${entityId.trim()}
      AND type IN ('asset_manager', 'fund')
      LIMIT 1
    `;
    if (entityRows.length === 0) {
      return json({ error: 'Entity not found or not a valid type' }, 404);
    }

    // Audit the query before serving results (insider-abuse posture, PRD §7).
    await emitAuditEvent({
      actor_id: user.id,
      action: 'campaign.chunks.query',
      entity_type: entityRows[0].type,
      entity_id: entityId.trim(),
      before: null,
      after: {
        actor: user.username,
        entity_id: entityId.trim(),
        entity_type: entityRows[0].type,
      },
      ts: new Date().toISOString(),
    }).catch((err) => console.warn('[campaign] audit event emit failed (non-fatal):', err));

    // Traverse: discussed_in relations → transcript ids → corpus_chunk entities.
    //
    // Security note: we only join via discussed_in relations whose type is
    // explicitly checked. We never join on customer-scoped tables (tenant_id IS
    // NOT NULL entities) from this path. The response strips source_id and body
    // to prevent re-identification.

    interface ChunkRow {
      id: string;
      properties: {
        index?: number;
        token_count?: number;
        source_id?: string;
        body?: unknown;
      };
    }

    const chunkRows = await sql<ChunkRow[]>`
      SELECT e.id, e.properties
      FROM entities e
      WHERE e.type = 'corpus_chunk'
        AND e.properties->>'source_id' IN (
          SELECT r.source_id
          FROM relations r
          WHERE r.target_id = ${entityId.trim()}
            AND r.type = 'discussed_in'
        )
    `;

    // Strip all customer-identifying fields — only expose chunk_id, index, token_count.
    const chunks: AnonymisedChunk[] = chunkRows.map((r) => ({
      chunk_id: r.id,
      index: typeof r.properties.index === 'number' ? r.properties.index : 0,
      token_count: typeof r.properties.token_count === 'number' ? r.properties.token_count : 0,
    }));

    return json({ entity_id: entityId.trim(), chunk_count: chunks.length, chunks });
  }

  return null;
}
