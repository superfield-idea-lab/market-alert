/**
 * @file annotations.ts
 *
 * Annotation thread API — Phase 6 (issue #65).
 *
 * ## Routes
 *
 *   POST   /api/annotations
 *     Open a new annotation thread on a wiki page passage.
 *     Body: { wiki_page_version_id, passage_ref, comment }
 *     Calls the Anthropic API SDK to produce an agent reply.
 *     Returns: { id, wiki_page_version_id, passage_ref, state, thread, created_by, created_at }
 *
 *   GET    /api/annotations/:id
 *     Fetch a single annotation thread by ID.
 *
 *   POST   /api/annotations/:id/accept
 *     Accept the agent's proposed correction.
 *     Writes a new published WikiPageVersion and emits audit events.
 *     Returns: { annotation_id, new_wiki_version_id, state }
 *
 *   POST   /api/annotations/:id/reject
 *     Reject the agent's proposed correction.
 *     No new version is written.
 *     Returns: { annotation_id, state }
 *
 * ## Integration points
 *
 *   1. Anthropic API SDK (not Claude CLI — PRD §6, shorter interactive loop).
 *      Called when the RM opens an annotation; the API is asked to produce a
 *      suggested correction for the selected passage.
 *      SDK path: `@anthropic-ai/sdk` → `client.messages.create(…)`.
 *      Fixture: tests/fixtures/anthropic/annotation-reply_2026-04-12T00-00-00-000Z.json
 *
 *   2. wiki_annotation entity type (property graph, registered in Phase 1).
 *      Schema: { passage_ref: string, thread: AnnotationMessage[], state: AnnotationState }
 *      The `thread` field is encrypted (corpus-key) — see phase1-entity-types.ts.
 *
 *   3. WikiPageVersion write on accept.
 *      The accept path inserts a new entity of type `wiki_page_version` with
 *      `published = true` (the RM's explicit accept is the publication gate for
 *      the corrective flow — no citation-coverage check is required here).
 *      Emits `wiki_version.create` and `annotation.accepted` audit events.
 *
 *   4. Audit events — one per step:
 *      - `annotation.opened`   — RM opens a thread
 *      - `annotation.reply`    — agent replies via Anthropic API
 *      - `annotation.accepted` — RM accepts, new version published
 *      - `annotation.rejected` — RM rejects, no version written
 *
 * ## Blueprint references
 *
 *   - PRD §5.2   — inline annotation threads
 *   - PRD §4.3   — publication gate (corrective flow: RM accept = gate)
 *   - PRD §6     — Anthropic API SDK (annotation agent)
 *   - Implementation plan Phase 6 — annotation agent backed by Anthropic API SDK
 *
 * Canonical docs:
 *   - docs/implementation-plan-v1.md §Phase 6
 *   - docs/PRD.md §5.2, §4.3, §6
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/65
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { makeJson } from '../lib/response';
import { callAnnotationAgent } from './annotation-agent';
import { emitAuditEvent } from '../policies/audit-service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Lifecycle states for a wiki_annotation entity.
 *
 * OPEN         — thread created, awaiting agent reply or RM decision
 * AGENT_REPLIED — agent has replied via Anthropic API; awaiting RM decision
 * ACCEPTED     — RM accepted the correction; new WikiPageVersion published
 * REJECTED     — RM rejected the correction; no version change
 *
 * Additional states (AUTO_RESOLVED, DISMISSED, REOPENED) are out of scope for
 * this issue — see Phase 6 follow-on: annotation state machine.
 */
export type AnnotationState = 'OPEN' | 'AGENT_REPLIED' | 'ACCEPTED' | 'REJECTED';

/**
 * A single message in an annotation thread (stored encrypted in `thread` JSONB).
 */
export interface AnnotationMessage {
  /** 'rm' for Records Manager; 'agent' for Anthropic-API-authored replies. */
  role: 'rm' | 'agent';
  content: string;
  created_at: string;
}

/**
 * Request body shape for POST /api/annotations.
 */
export interface OpenAnnotationRequest {
  /** ID of the wiki_page_version entity this annotation targets. */
  wiki_page_version_id: string;
  /** Opaque reference to the passage within the version (e.g. character range or heading slug). */
  passage_ref: string;
  /** The RM's opening comment describing the perceived error or question. */
  comment: string;
}

/**
 * Response shape for a successfully opened annotation.
 */
export interface AnnotationResponse {
  id: string;
  wiki_page_version_id: string;
  passage_ref: string;
  state: AnnotationState;
  thread: AnnotationMessage[];
  created_by: string;
  created_at: string;
}

/**
 * Response shape for POST /api/annotations/:id/accept.
 */
export interface AcceptAnnotationResponse {
  annotation_id: string;
  new_wiki_version_id: string;
  state: 'ACCEPTED';
}

/**
 * Response shape for POST /api/annotations/:id/reject.
 */
export interface RejectAnnotationResponse {
  annotation_id: string;
  state: 'REJECTED';
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleAnnotationsRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/annotations')) return null;

  const corsHeaders = getCorsHeaders(req);
  const { sql } = appState;
  const json = makeJson(corsHeaders);

  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // ---------------------------------------------------------------------------
  // POST /api/annotations — open a new annotation thread
  // ---------------------------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/api/annotations') {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const b = body as Record<string, unknown>;
    if (
      typeof b.wiki_page_version_id !== 'string' ||
      typeof b.passage_ref !== 'string' ||
      typeof b.comment !== 'string'
    ) {
      return json(
        { error: 'wiki_page_version_id, passage_ref, and comment (all strings) are required' },
        400,
      );
    }

    const { wiki_page_version_id, passage_ref, comment } = b as {
      wiki_page_version_id: string;
      passage_ref: string;
      comment: string;
    };

    const now = new Date().toISOString();
    const annotationId = crypto.randomUUID();

    // Build the RM's opening message.
    const rmMessage: AnnotationMessage = {
      role: 'rm',
      content: comment,
      created_at: now,
    };

    // Emit annotation.opened audit event before DB write.
    await emitAuditEvent({
      actor_id: user.id,
      action: 'annotation.opened',
      entity_type: 'wiki_annotation',
      entity_id: annotationId,
      before: null,
      after: { wiki_page_version_id, passage_ref },
      ts: now,
    });

    // Call the Anthropic API to get the agent's reply.
    // The passage_ref is used as the passage text since the annotation targets
    // the passage identified by that ref. The comment is the RM's concern.
    let agentReplyText: string;
    try {
      agentReplyText = await callAnnotationAgent(passage_ref, comment);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: `Agent call failed: ${message}` }, 502);
    }

    const agentReplyAt = new Date().toISOString();
    const agentMessage: AnnotationMessage = {
      role: 'agent',
      content: agentReplyText,
      created_at: agentReplyAt,
    };

    const thread: AnnotationMessage[] = [rmMessage, agentMessage];

    // Persist the wiki_annotation entity.
    // Cast through unknown to satisfy postgres.js JSONValue typing — the runtime
    // serialises AnnotationMessage[] correctly via JSON.stringify.
    const threadJson = thread as unknown as import('postgres').JSONValue;
    await sql`
      INSERT INTO entities (id, type, properties)
      VALUES (
        ${annotationId},
        'wiki_annotation',
        ${sql.json({
          wiki_page_version_id,
          passage_ref,
          state: 'AGENT_REPLIED' as AnnotationState,
          thread: threadJson,
          created_by: user.id,
          created_at: now,
        })}
      )
    `;

    // Emit annotation.reply audit event after the agent reply is stored.
    await emitAuditEvent({
      actor_id: 'agent',
      action: 'annotation.reply',
      entity_type: 'wiki_annotation',
      entity_id: annotationId,
      before: null,
      after: { agent_reply: agentReplyText },
      ts: agentReplyAt,
    });

    return json(
      {
        id: annotationId,
        wiki_page_version_id,
        passage_ref,
        state: 'AGENT_REPLIED' as AnnotationState,
        thread,
        created_by: user.id,
        created_at: now,
        agent_visibility: 'agent',
      } satisfies AnnotationResponse & { agent_visibility: string },
      201,
    );
  }

  // ---------------------------------------------------------------------------
  // GET /api/annotations/:id — fetch an annotation thread
  // ---------------------------------------------------------------------------
  const getMatch = url.pathname.match(/^\/api\/annotations\/([^/]+)$/);
  if (req.method === 'GET' && getMatch) {
    const annotationId = getMatch[1];

    const rows = await sql<
      {
        id: string;
        properties: Record<string, unknown>;
        created_at: string;
      }[]
    >`
      SELECT id, properties, created_at
      FROM entities
      WHERE id   = ${annotationId}
        AND type = 'wiki_annotation'
    `;

    if (rows.length === 0) return json({ error: 'Not found' }, 404);

    const entity = rows[0];
    const props = entity.properties;

    return json({
      id: entity.id,
      wiki_page_version_id: props.wiki_page_version_id,
      passage_ref: props.passage_ref,
      state: props.state,
      thread: props.thread ?? [],
      created_by: props.created_by,
      created_at: props.created_at ?? entity.created_at,
    });
  }

  // ---------------------------------------------------------------------------
  // POST /api/annotations/:id/accept — accept agent reply, publish new version
  // ---------------------------------------------------------------------------
  const acceptMatch = url.pathname.match(/^\/api\/annotations\/([^/]+)\/accept$/);
  if (req.method === 'POST' && acceptMatch) {
    const annotationId = acceptMatch[1];

    // Fetch the annotation.
    const rows = await sql<{ id: string; properties: Record<string, unknown> }[]>`
      SELECT id, properties
      FROM entities
      WHERE id   = ${annotationId}
        AND type = 'wiki_annotation'
    `;

    if (rows.length === 0) return json({ error: 'Not found' }, 404);

    const entity = rows[0];
    const props = entity.properties;

    if (props.state !== 'AGENT_REPLIED') {
      return json({ error: `Cannot accept annotation in state: ${props.state}` }, 422);
    }

    // Extract the agent's suggested correction from the thread.
    const thread = (props.thread ?? []) as AnnotationMessage[];
    const agentMessage = thread.find((m) => m.role === 'agent');
    const correctedContent = agentMessage?.content ?? '';

    const newVersionId = crypto.randomUUID();
    const acceptedAt = new Date().toISOString();

    // Emit wiki_version.create audit event before insert.
    await emitAuditEvent({
      actor_id: user.id,
      action: 'wiki_version.create',
      entity_type: 'wiki_page_version',
      entity_id: newVersionId,
      before: null,
      after: { annotation_id: annotationId, published: true },
      ts: acceptedAt,
    });

    // Write the new published wiki_page_version.
    const sourceVersionId =
      typeof props.wiki_page_version_id === 'string' ? props.wiki_page_version_id : null;
    await sql`
      INSERT INTO entities (id, type, properties)
      VALUES (
        ${newVersionId},
        'wiki_page_version',
        ${sql.json({
          content: correctedContent,
          published: true,
          published_by: user.id,
          published_at: acceptedAt,
          source_annotation_id: annotationId,
          wiki_page_version_id: sourceVersionId,
        })}
      )
    `;

    // Update the annotation state to ACCEPTED.
    await sql`
      UPDATE entities
      SET
        properties = properties || ${sql.json({ state: 'ACCEPTED' as AnnotationState, accepted_by: user.id, accepted_at: acceptedAt })},
        updated_at = NOW()
      WHERE id = ${annotationId}
    `;

    // Emit annotation.accepted audit event.
    await emitAuditEvent({
      actor_id: user.id,
      action: 'annotation.accepted',
      entity_type: 'wiki_annotation',
      entity_id: annotationId,
      before: { state: 'AGENT_REPLIED' },
      after: { state: 'ACCEPTED', new_wiki_version_id: newVersionId },
      ts: acceptedAt,
    });

    return json(
      {
        annotation_id: annotationId,
        new_wiki_version_id: newVersionId,
        state: 'ACCEPTED',
      } satisfies AcceptAnnotationResponse,
      200,
    );
  }

  // ---------------------------------------------------------------------------
  // POST /api/annotations/:id/reject — reject agent reply
  // ---------------------------------------------------------------------------
  const rejectMatch = url.pathname.match(/^\/api\/annotations\/([^/]+)\/reject$/);
  if (req.method === 'POST' && rejectMatch) {
    const annotationId = rejectMatch[1];

    // Fetch the annotation.
    const rows = await sql<{ id: string; properties: Record<string, unknown> }[]>`
      SELECT id, properties
      FROM entities
      WHERE id   = ${annotationId}
        AND type = 'wiki_annotation'
    `;

    if (rows.length === 0) return json({ error: 'Not found' }, 404);

    const entity = rows[0];
    const props = entity.properties;

    if (props.state !== 'AGENT_REPLIED') {
      return json({ error: `Cannot reject annotation in state: ${props.state}` }, 422);
    }

    const rejectedAt = new Date().toISOString();

    // Update the annotation state to REJECTED.
    await sql`
      UPDATE entities
      SET
        properties = properties || ${sql.json({ state: 'REJECTED' as AnnotationState, rejected_by: user.id, rejected_at: rejectedAt })},
        updated_at = NOW()
      WHERE id = ${annotationId}
    `;

    // Emit annotation.rejected audit event.
    await emitAuditEvent({
      actor_id: user.id,
      action: 'annotation.rejected',
      entity_type: 'wiki_annotation',
      entity_id: annotationId,
      before: { state: 'AGENT_REPLIED' },
      after: { state: 'REJECTED' },
      ts: rejectedAt,
    });

    return json(
      {
        annotation_id: annotationId,
        state: 'REJECTED',
      } satisfies RejectAnnotationResponse,
      200,
    );
  }

  return null;
}
