/**
 * @file internal-wiki-versions.ts
 *
 * POST /internal/wiki/versions — worker-facing endpoint for writing draft
 * WikiPageVersion rows.
 *
 * Auth model: Bearer scoped worker token (scope: 'wiki_write', dept, customer
 * claims). The token is single-use and is consumed on success via JTI
 * insertion into revoked_tokens.
 *
 * Security invariants:
 * - Only a token whose (dept, customer) exactly matches the payload is accepted.
 * - The worker DB role (agent_autolearn) has INSERT denied on wiki_page_versions;
 *   all writes go through this API layer.
 * - An audit event is emitted for every accepted write, before the DB write
 *   commits.
 * - After draft creation, the content is embedded via the Phase 2 embedding
 *   abstraction and the vector stored in the same row (issue #44, PRD §7).
 *   The embedding column is never serialised into any API response.
 *
 * Issues: #39, #44
 */

import type { AppState } from '../index';
import { getCorsHeaders } from './auth';
import { verifyWorkerToken } from '../auth/worker-token';
import { emitAuditEvent } from '../policies/audit-service';
import { makeJson } from '../lib/response';
import { getEmbeddingService } from 'embedding';

/** Fields required in the POST body. */
interface WikiVersionPayload {
  page_id: string;
  dept: string;
  customer: string;
  content: string;
  /** Optional — correlates the write back to the task that triggered it. */
  source_task?: string;
}

/**
 * Handles POST /internal/wiki/versions.
 *
 * Returns null when the route does not match so the caller can fall through to
 * the next handler.
 */
export async function handleInternalWikiVersionsRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (url.pathname !== '/internal/wiki/versions') return null;
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
  let body: WikiVersionPayload;
  try {
    body = (await req.json()) as WikiVersionPayload;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  // ── Validate required fields ──────────────────────────────────────────────
  const { page_id, dept, customer, content, source_task } = body;

  if (!page_id || typeof page_id !== 'string') {
    return json({ error: 'page_id is required' }, 400);
  }
  if (!dept || typeof dept !== 'string') {
    return json({ error: 'dept is required' }, 400);
  }
  if (!customer || typeof customer !== 'string') {
    return json({ error: 'customer is required' }, 400);
  }
  if (!content || typeof content !== 'string') {
    return json({ error: 'content is required' }, 400);
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

  // ── Emit audit event BEFORE writing (audit failure aborts the write) ──────
  await emitAuditEvent({
    actor_id: tokenPayload.sub,
    action: 'wiki_version.create',
    entity_type: 'wiki_page_version',
    entity_id: page_id,
    before: null,
    after: { page_id, dept, customer, state: 'draft', source_task: source_task ?? null },
    ip: req.headers.get('x-forwarded-for') ?? undefined,
    user_agent: req.headers.get('user-agent') ?? undefined,
    ts: new Date().toISOString(),
  });

  // ── Persist the draft WikiPageVersion ────────────────────────────────────
  const rows = await sql<{ id: string; state: string; created_at: Date }[]>`
    INSERT INTO wiki_page_versions
      (page_id, dept, customer, content, state, created_by, source_task)
    VALUES (
      ${page_id},
      ${dept},
      ${customer},
      ${content},
      'draft',
      ${tokenPayload.sub},
      ${source_task ?? null}
    )
    RETURNING id, state, created_at
  `;

  const version = rows[0];

  // ── Embed the draft content and store the vector (issue #44, PRD §7) ─────
  // Embeddings reuse the Phase 2 abstraction (getEmbeddingService).
  // The embedding column is only stored — it is never serialised in the
  // response body (compensating control 3: no public API exposure).
  // Embedding failure is non-fatal: the draft is already persisted and the
  // worker can retry or the next autolearn run will pick up the content.
  try {
    const embeddingSvc = getEmbeddingService();
    const [vector] = await embeddingSvc.embed([content]);
    if (vector && vector.length > 0) {
      const vectorLiteral = `[${vector.join(',')}]`;
      await sql`
        UPDATE wiki_page_versions
        SET embedding = ${vectorLiteral}::vector
        WHERE id = ${version.id}
      `;
    }
  } catch (embedErr) {
    // Log but do not fail the request — draft row is already committed.
    console.error('[wiki-versions] embedding failed for version', version.id, embedErr);
  }

  return json(
    {
      id: version.id,
      page_id,
      dept,
      customer,
      state: version.state,
      created_by: tokenPayload.sub,
      source_task: source_task ?? null,
      created_at: version.created_at,
      // embedding is intentionally omitted — PRD §7 compensating control 3
    },
    201,
  );
}
