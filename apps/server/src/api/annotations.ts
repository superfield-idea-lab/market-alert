/**
 * @file annotations.ts
 *
 * Annotation thread API — Phase 6 scout stub (issue #62).
 *
 * ## Scout stub
 *
 * This file is a **no-op stub** for the dev-scout issue that proves the
 * single annotation thread end-to-end invariant. All routes are wired into the
 * router and return structured 501 Not Implemented responses, encoding the
 * expected request/response contracts without implementing the full runtime
 * behaviour.
 *
 * ## Routes
 *
 *   POST   /api/annotations
 *     Open a new annotation thread on a wiki page passage.
 *     Body: { wiki_page_version_id, passage_ref, comment }
 *     Returns: { id, wiki_page_version_id, passage_ref, comment, state, agent_reply, created_by, created_at }
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
 * ## Integration points (captured for follow-on issues)
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
 *      The accept path must insert a new entity of type `wiki_page_version` with
 *      `published = true` (the RM's explicit accept is the publication gate for
 *      the corrective flow — no citation-coverage check is required here).
 *      Emits a `wiki_version.create` audit event and a `annotation.accepted`
 *      audit event.
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
 *   - Implementation plan Phase 6 — single annotation thread end-to-end scout
 *
 * Canonical docs:
 *   - docs/implementation-plan-v1.md §Phase 6
 *   - docs/PRD.md §5.2, §4.3, §6
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/62
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { makeJson } from '../lib/response';

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
 * this scout — see Phase 6 follow-on: annotation state machine.
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
// Route handler (scout stub — all routes return 501)
// ---------------------------------------------------------------------------

export async function handleAnnotationsRequest(
  req: Request,
  url: URL,
  _appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/annotations')) return null;

  const corsHeaders = getCorsHeaders(req);
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

    // Scout stub: full implementation deferred to Phase 6 follow-on issues.
    // The 501 body encodes the expected success-response shape so integration
    // tests can assert against once the real implementation lands.
    return json(
      {
        error: 'Not Implemented — annotation thread open is a Phase 6 follow-on issue',
        expected_response_shape: {
          id: '<uuid>',
          wiki_page_version_id: b.wiki_page_version_id,
          passage_ref: b.passage_ref,
          state: 'AGENT_REPLIED',
          thread: [
            { role: 'rm', content: b.comment, created_at: '<iso8601>' },
            { role: 'agent', content: '<anthropic-api-reply>', created_at: '<iso8601>' },
          ],
          created_by: user.id,
          created_at: '<iso8601>',
        } satisfies Record<string, unknown>,
      },
      501,
    );
  }

  // ---------------------------------------------------------------------------
  // GET /api/annotations/:id — fetch an annotation thread
  // ---------------------------------------------------------------------------
  const getMatch = url.pathname.match(/^\/api\/annotations\/([^/]+)$/);
  if (req.method === 'GET' && getMatch) {
    const annotationId = getMatch[1];
    return json(
      {
        error: 'Not Implemented — annotation thread fetch is a Phase 6 follow-on issue',
        expected_response_shape: {
          id: annotationId,
          wiki_page_version_id: '<uuid>',
          passage_ref: '<opaque-ref>',
          state: 'OPEN' as AnnotationState,
          thread: [] as AnnotationMessage[],
          created_by: '<user-id>',
          created_at: '<iso8601>',
        } satisfies Record<string, unknown>,
      },
      501,
    );
  }

  // ---------------------------------------------------------------------------
  // POST /api/annotations/:id/accept — accept agent reply, publish new version
  // ---------------------------------------------------------------------------
  const acceptMatch = url.pathname.match(/^\/api\/annotations\/([^/]+)\/accept$/);
  if (req.method === 'POST' && acceptMatch) {
    const annotationId = acceptMatch[1];
    return json(
      {
        error:
          'Not Implemented — annotation accept + wiki version publish is a Phase 6 follow-on issue',
        expected_response_shape: {
          annotation_id: annotationId,
          new_wiki_version_id: '<uuid>',
          state: 'ACCEPTED',
        } satisfies Record<string, unknown>,
      },
      501,
    );
  }

  // ---------------------------------------------------------------------------
  // POST /api/annotations/:id/reject — reject agent reply
  // ---------------------------------------------------------------------------
  const rejectMatch = url.pathname.match(/^\/api\/annotations\/([^/]+)\/reject$/);
  if (req.method === 'POST' && rejectMatch) {
    const annotationId = rejectMatch[1];
    return json(
      {
        error: 'Not Implemented — annotation reject is a Phase 6 follow-on issue',
        expected_response_shape: {
          annotation_id: annotationId,
          state: 'REJECTED',
        } satisfies Record<string, unknown>,
      },
      501,
    );
  }

  return null;
}
