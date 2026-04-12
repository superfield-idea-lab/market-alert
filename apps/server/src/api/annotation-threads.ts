/**
 * @file annotation-threads.ts
 *
 * Annotation thread API — inline anchored threads on wiki page versions.
 *
 * Routes:
 *
 *   POST   /api/wiki/pages/:customerId/versions/:versionId/annotations
 *     Create a new annotation thread anchored to a text selection.
 *
 *   GET    /api/wiki/pages/:customerId/versions/:versionId/annotations
 *     List all annotation threads for a wiki page version (with replies).
 *
 *   POST   /api/wiki/pages/:customerId/versions/:versionId/annotations/:threadId/replies
 *     Post a reply to an existing thread.
 *
 *   PATCH  /api/wiki/pages/:customerId/versions/:versionId/annotations/:threadId
 *     Update a thread (currently: resolve / unresolve).
 *
 * Authentication:
 *   All routes require an authenticated session cookie (RM role or above).
 *
 * Anchoring:
 *   The anchor is stored as (start_offset, end_offset) character positions
 *   within the version content, plus anchor_text (the selected excerpt) for
 *   fuzzy re-anchoring when the content changes modestly.
 *
 * Blueprint references:
 * - PRD §5.2 — annotation threads
 * - docs/technical/ux-flows/phase6-annotation-threads.md
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/63
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { makeJson } from '../lib/response';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnnotationReply {
  id: string;
  thread_id: string;
  body: string;
  created_by: string;
  created_at: string;
}

export interface AnnotationThread {
  id: string;
  wiki_version_id: string;
  anchor_text: string;
  start_offset: number;
  end_offset: number;
  body: string;
  created_by: string;
  resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  replies: AnnotationReply[];
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Annotation thread route patterns:
 *
 *   /api/wiki/pages/:cId/versions/:vId/annotations
 *   /api/wiki/pages/:cId/versions/:vId/annotations/:tId
 *   /api/wiki/pages/:cId/versions/:vId/annotations/:tId/replies
 */
const THREAD_LIST_RE = /^\/api\/wiki\/pages\/([^/]+)\/versions\/([^/]+)\/annotations$/;
const THREAD_DETAIL_RE = /^\/api\/wiki\/pages\/([^/]+)\/versions\/([^/]+)\/annotations\/([^/]+)$/;
const REPLIES_RE =
  /^\/api\/wiki\/pages\/([^/]+)\/versions\/([^/]+)\/annotations\/([^/]+)\/replies$/;

export async function handleAnnotationThreadsRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.includes('/annotations')) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // ── POST /api/wiki/pages/:cId/versions/:vId/annotations ──────────────────
  // Create a new annotation thread.

  const listMatch = THREAD_LIST_RE.exec(url.pathname);
  if (listMatch) {
    const versionId = listMatch[2];

    // GET — list all threads for this version.
    if (req.method === 'GET') {
      const threadRows = await sql<
        {
          id: string;
          wiki_version_id: string;
          anchor_text: string;
          start_offset: number;
          end_offset: number;
          body: string;
          created_by: string;
          resolved: boolean;
          resolved_by: string | null;
          resolved_at: Date | null;
          created_at: Date;
          updated_at: Date;
        }[]
      >`
        SELECT id, wiki_version_id, anchor_text, start_offset, end_offset,
               body, created_by, resolved, resolved_by, resolved_at,
               created_at, updated_at
        FROM annotation_threads
        WHERE wiki_version_id = ${versionId}
        ORDER BY start_offset ASC, created_at ASC
      `;

      // Fetch replies for all threads in a single query.
      const threadIds = threadRows.map((t) => t.id);
      const replyRows =
        threadIds.length > 0
          ? await sql<
              {
                id: string;
                thread_id: string;
                body: string;
                created_by: string;
                created_at: Date;
              }[]
            >`
              SELECT id, thread_id, body, created_by, created_at
              FROM annotation_replies
              WHERE thread_id = ANY(${threadIds})
              ORDER BY created_at ASC
            `
          : [];

      // Group replies by thread_id.
      const repliesByThread = new Map<string, AnnotationReply[]>();
      for (const r of replyRows) {
        const list = repliesByThread.get(r.thread_id) ?? [];
        list.push({
          id: r.id,
          thread_id: r.thread_id,
          body: r.body,
          created_by: r.created_by,
          created_at:
            r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        });
        repliesByThread.set(r.thread_id, list);
      }

      const threads: AnnotationThread[] = threadRows.map((t) => ({
        id: t.id,
        wiki_version_id: t.wiki_version_id,
        anchor_text: t.anchor_text,
        start_offset: t.start_offset,
        end_offset: t.end_offset,
        body: t.body,
        created_by: t.created_by,
        resolved: t.resolved,
        resolved_by: t.resolved_by,
        resolved_at: t.resolved_at instanceof Date ? t.resolved_at.toISOString() : t.resolved_at,
        created_at:
          t.created_at instanceof Date ? t.created_at.toISOString() : String(t.created_at),
        updated_at:
          t.updated_at instanceof Date ? t.updated_at.toISOString() : String(t.updated_at),
        replies: repliesByThread.get(t.id) ?? [],
      }));

      return json({ threads });
    }

    // POST — create a new thread.
    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }

      const {
        anchor_text,
        start_offset,
        end_offset,
        body: threadBody,
      } = body as Record<string, unknown>;

      if (typeof anchor_text !== 'string' || anchor_text.length === 0) {
        return json({ error: 'anchor_text (non-empty string) is required' }, 400);
      }
      if (typeof start_offset !== 'number' || start_offset < 0) {
        return json({ error: 'start_offset (non-negative number) is required' }, 400);
      }
      if (typeof end_offset !== 'number' || end_offset <= start_offset) {
        return json({ error: 'end_offset must be a number greater than start_offset' }, 400);
      }
      if (typeof threadBody !== 'string' || threadBody.length === 0) {
        return json({ error: 'body (non-empty string) is required' }, 400);
      }

      // Verify the wiki_page_version exists.
      const versionRows = await sql<{ id: string }[]>`
        SELECT id FROM wiki_page_versions WHERE id = ${versionId}
      `;
      if (versionRows.length === 0) {
        return json({ error: 'Wiki page version not found' }, 404);
      }

      const newRows = await sql<
        {
          id: string;
          created_at: Date;
          updated_at: Date;
        }[]
      >`
        INSERT INTO annotation_threads
          (wiki_version_id, anchor_text, start_offset, end_offset, body, created_by)
        VALUES (
          ${versionId},
          ${anchor_text as string},
          ${start_offset as number},
          ${end_offset as number},
          ${threadBody as string},
          ${user.id}
        )
        RETURNING id, created_at, updated_at
      `;

      const row = newRows[0];
      const thread: AnnotationThread = {
        id: row.id,
        wiki_version_id: versionId,
        anchor_text: anchor_text as string,
        start_offset: start_offset as number,
        end_offset: end_offset as number,
        body: threadBody as string,
        created_by: user.id,
        resolved: false,
        resolved_by: null,
        resolved_at: null,
        created_at:
          row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        updated_at:
          row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
        replies: [],
      };

      return json(thread, 201);
    }

    return null;
  }

  // ── POST /api/wiki/pages/:cId/versions/:vId/annotations/:tId/replies ─────
  // Post a reply to a thread.

  const repliesMatch = REPLIES_RE.exec(url.pathname);
  if (repliesMatch && req.method === 'POST') {
    const threadId = repliesMatch[3];

    // Verify thread exists.
    const threadRows = await sql<{ id: string }[]>`
      SELECT id FROM annotation_threads WHERE id = ${threadId}
    `;
    if (threadRows.length === 0) {
      return json({ error: 'Thread not found' }, 404);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { body: replyBody } = body as Record<string, unknown>;
    if (typeof replyBody !== 'string' || replyBody.length === 0) {
      return json({ error: 'body (non-empty string) is required' }, 400);
    }

    const newRows = await sql<
      {
        id: string;
        created_at: Date;
      }[]
    >`
      INSERT INTO annotation_replies (thread_id, body, created_by)
      VALUES (${threadId}, ${replyBody as string}, ${user.id})
      RETURNING id, created_at
    `;

    const row = newRows[0];
    const reply: AnnotationReply = {
      id: row.id,
      thread_id: threadId,
      body: replyBody as string,
      created_by: user.id,
      created_at:
        row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };

    // Update thread updated_at.
    await sql`
      UPDATE annotation_threads
      SET updated_at = NOW()
      WHERE id = ${threadId}
    `;

    return json(reply, 201);
  }

  // ── PATCH /api/wiki/pages/:cId/versions/:vId/annotations/:tId ────────────
  // Resolve or unresolve a thread.

  const detailMatch = THREAD_DETAIL_RE.exec(url.pathname);
  if (detailMatch && req.method === 'PATCH') {
    const threadId = detailMatch[3];

    const threadRows = await sql<{ id: string; created_by: string }[]>`
      SELECT id, created_by FROM annotation_threads WHERE id = ${threadId}
    `;
    if (threadRows.length === 0) {
      return json({ error: 'Thread not found' }, 404);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { resolved } = body as Record<string, unknown>;
    if (typeof resolved !== 'boolean') {
      return json({ error: 'resolved (boolean) is required' }, 400);
    }

    if (resolved) {
      await sql`
        UPDATE annotation_threads
        SET resolved = true,
            resolved_by = ${user.id},
            resolved_at = NOW(),
            updated_at = NOW()
        WHERE id = ${threadId}
      `;
    } else {
      await sql`
        UPDATE annotation_threads
        SET resolved = false,
            resolved_by = NULL,
            resolved_at = NULL,
            updated_at = NOW()
        WHERE id = ${threadId}
      `;
    }

    return json({ id: threadId, resolved });
  }

  return null;
}
