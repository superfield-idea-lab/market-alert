/**
 * @file internal-relations.ts
 *
 * POST /internal/relations — worker-facing endpoint for writing `discussed_in`
 * relation rows from the autolearn worker.
 *
 * ## Purpose
 *
 * After an autolearn run identifies AssetManager or Fund entities mentioned in
 * a transcript, the worker POSTs here to create `discussed_in` graph edges
 * linking the transcript entity to each observed entity. These edges feed the
 * Phase 7 BDM campaign analysis pipeline (issue #72).
 *
 * ## Auth model
 *
 * Bearer wiki-write token (scope: 'wiki_write', dept + customer claims).
 * The same token family used by POST /internal/wiki/versions. The token is
 * single-use and is consumed on success via JTI insertion into revoked_tokens.
 *
 * ## Security invariants
 *
 * - Only a token whose (dept, customer) exactly matches the payload is accepted.
 * - The worker DB role (agent_autolearn) has INSERT denied on the `relations`
 *   table; all writes go through this API layer (WORKER-P-001, API-W-001).
 * - Only entity types 'asset_manager' and 'fund' are accepted as relation
 *   targets — no arbitrary entity types can be tagged.
 * - Relations are scoped to the calling token's (dept, customer) pair so RLS
 *   restricts visibility to authorised queries only.
 * - An audit event is emitted for every accepted batch write.
 * - Source entity id must belong to a 'transcript' typed entity in the
 *   `entities` table to prevent arbitrary relation injection.
 *
 * ## Request body
 *
 * ```json
 * {
 *   "dept":      "engineering",
 *   "customer":  "acme",
 *   "source_id": "<transcript entity id>",
 *   "targets":   [
 *     { "entity_id": "asset_manager-<uuid>", "entity_type": "asset_manager" },
 *     { "entity_id": "fund-<uuid>",          "entity_type": "fund"          }
 *   ]
 * }
 * ```
 *
 * ## Response (201)
 *
 * ```json
 * {
 *   "written": 2,
 *   "relation_ids": ["rel-uuid-1", "rel-uuid-2"]
 * }
 * ```
 *
 * Issues: #72
 */

import type { AppState } from '../index';
import { getCorsHeaders } from './auth';
import { verifyWorkerToken } from '../auth/worker-token';
import { emitAuditEvent } from '../policies/audit-service';
import { makeJson } from '../lib/response';

/** Allowed entity types as relation targets for discussed_in. */
const ALLOWED_TARGET_TYPES = ['asset_manager', 'fund'] as const;
type AllowedTargetType = (typeof ALLOWED_TARGET_TYPES)[number];

/** One target in the discussed_in batch. */
interface DiscussedInTarget {
  entity_id: string;
  entity_type: AllowedTargetType;
}

/** POST body shape for /internal/relations. */
interface RelationsPayload {
  dept: string;
  customer: string;
  /** Transcript entity id — source of all `discussed_in` relations written. */
  source_id: string;
  /** List of asset_manager / fund entities the transcript discusses. */
  targets: DiscussedInTarget[];
}

/**
 * Handles POST /internal/relations.
 *
 * Returns null for non-matching paths so the caller can chain handlers.
 */
export async function handleInternalRelationsRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (url.pathname !== '/internal/relations') return null;
  if (req.method !== 'POST') return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? '';
  const tokenMatch = authHeader.match(/^Bearer (.+)$/);
  if (!tokenMatch) return json({ error: 'Unauthorized' }, 401);
  const token = tokenMatch[1];

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: RelationsPayload;
  try {
    body = (await req.json()) as RelationsPayload;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  // ── Validate required fields ──────────────────────────────────────────────
  const { dept, customer, source_id, targets } = body;

  if (!dept || typeof dept !== 'string') {
    return json({ error: 'dept is required' }, 400);
  }
  if (!customer || typeof customer !== 'string') {
    return json({ error: 'customer is required' }, 400);
  }
  if (!source_id || typeof source_id !== 'string') {
    return json({ error: 'source_id is required' }, 400);
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    return json({ error: 'targets must be a non-empty array' }, 400);
  }

  // Validate each target.
  for (const t of targets) {
    if (!t.entity_id || typeof t.entity_id !== 'string') {
      return json({ error: 'Each target must have a string entity_id' }, 400);
    }
    if (!ALLOWED_TARGET_TYPES.includes(t.entity_type as AllowedTargetType)) {
      return json(
        {
          error: `entity_type must be one of: ${ALLOWED_TARGET_TYPES.join(', ')}`,
        },
        400,
      );
    }
  }

  // ── Verify token scope matches the payload (dept, customer) ───────────────
  let tokenPayload: Awaited<ReturnType<typeof verifyWorkerToken>>;
  try {
    tokenPayload = await verifyWorkerToken(token, {
      expectedDept: dept,
      expectedCustomer: customer,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid token';
    return json({ error: message }, 401);
  }

  // ── Verify source entity is a transcript ─────────────────────────────────
  const sourceRows = await sql<{ id: string; type: string }[]>`
    SELECT id, type FROM entities WHERE id = ${source_id} LIMIT 1
  `;
  if (sourceRows.length === 0) {
    return json({ error: `Source entity "${source_id}" not found` }, 404);
  }
  if (sourceRows[0].type !== 'transcript') {
    return json(
      {
        error: `Source entity "${source_id}" must be of type "transcript", got "${sourceRows[0].type}"`,
      },
      400,
    );
  }

  // ── Verify all target entities exist and have the expected types ──────────
  const targetIds = targets.map((t) => t.entity_id);
  const existingTargets = await sql<{ id: string; type: string }[]>`
    SELECT id, type FROM entities WHERE id = ANY(${targetIds})
  `;
  const existingTargetMap = new Map(
    existingTargets.map((r: { id: string; type: string }) => [r.id, r.type]),
  );

  for (const t of targets) {
    const existingType = existingTargetMap.get(t.entity_id);
    if (!existingType) {
      return json({ error: `Target entity "${t.entity_id}" not found` }, 404);
    }
    if (existingType !== t.entity_type) {
      return json(
        {
          error: `Target entity "${t.entity_id}" has type "${existingType}", expected "${t.entity_type}"`,
        },
        400,
      );
    }
  }

  // ── Emit audit event BEFORE writing ───────────────────────────────────────
  await emitAuditEvent({
    actor_id: tokenPayload.sub,
    action: 'relation.discussed_in.create',
    entity_type: 'relation',
    entity_id: source_id,
    before: null,
    after: {
      source_id,
      dept,
      customer,
      target_count: targets.length,
      target_ids: targetIds,
    },
    ts: new Date().toISOString(),
  });

  // ── Write the discussed_in relations ─────────────────────────────────────
  const relationIds: string[] = [];

  for (const t of targets) {
    const relId = `rel-discussed_in-${crypto.randomUUID()}`;
    await sql`
      INSERT INTO relations (id, source_id, target_id, type, properties)
      VALUES (
        ${relId},
        ${source_id},
        ${t.entity_id},
        'discussed_in',
        ${sql.json({
          dept,
          customer,
          entity_type: t.entity_type,
        } as never)}
      )
      ON CONFLICT DO NOTHING
    `;
    relationIds.push(relId);
  }

  return json(
    {
      written: relationIds.length,
      relation_ids: relationIds,
    },
    201,
  );
}
