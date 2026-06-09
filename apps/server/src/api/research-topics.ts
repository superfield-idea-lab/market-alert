/**
 * @file research-topics.ts
 *
 * CRUD REST API for research topics and topic membership management (issue #121).
 *
 * ## Routes
 *
 *   POST   /api/research-topics
 *     Body: { tenant_id, name, description? }
 *     Returns: 201 with the created topic; creator is inserted as role='owner'
 *
 *   GET    /api/research-topics?tenant_id=<id>
 *     Returns: { topics: ResearchTopicRow[] }
 *     Lists only topics the authenticated researcher is a member of.
 *
 *   GET    /api/research-topics/:id
 *     Returns: { topic: ResearchTopicRow, members: TopicMemberRow[] }
 *
 *   PATCH  /api/research-topics/:id
 *     Body: { name?, description? }
 *     Returns: 200 with updated topic; 403 if caller is not owner; 404 if not found.
 *
 *   POST   /api/research-topics/:id/members
 *     Body: { researcher_id, role? }
 *     Returns: 200 with the added member row; 403 if caller is not owner.
 *
 *   DELETE /api/research-topics/:id/members/:researcher_id
 *     Returns: 200 on success; 403 if non-owner tries to remove others.
 *
 * ## Security model
 *
 * Session cookie authentication is required. Worker Bearer tokens receive 403.
 * Unauthenticated requests receive 401.
 *
 * ## Canonical docs
 *
 * - packages/db/research-topics-store.ts — DB store
 * - packages/db/mkt-research-topics.sql  — DDL
 * - packages/db/rls-context.ts           — topicId in RlsSessionContext
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/121
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { makeJson } from '../lib/response';
import {
  createResearchTopic,
  getResearchTopic,
  listResearchTopicsForResearcher,
  listTopicMembers,
  getTopicMember,
  updateResearchTopic,
  addTopicMember,
  removeTopicMember,
} from 'db/research-topics-store';

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleResearchTopicsRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);

  // Only handle /api/research-topics paths
  if (!url.pathname.startsWith('/api/research-topics')) {
    return null;
  }

  // Authentication — session cookie only (worker Bearer tokens rejected)
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // Block worker Bearer tokens (they use token-based auth rather than session)
  if ((user as { isWorker?: boolean }).isWorker) {
    return json({ error: 'Forbidden' }, 403);
  }

  const { sql } = appState;

  // ---------------------------------------------------------------------------
  // POST /api/research-topics — create a new research topic
  // ---------------------------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/api/research-topics') {
    let body: { tenant_id?: string; name?: string; description?: string | null };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.tenant_id || !body.name) {
      return json({ error: 'tenant_id and name are required' }, 400);
    }

    const topic = await createResearchTopic(sql, {
      tenant_id: body.tenant_id,
      name: body.name,
      description: body.description ?? null,
      created_by: user.id,
    });

    return json({ topic }, 201);
  }

  // ---------------------------------------------------------------------------
  // GET /api/research-topics?tenant_id=<id> — list topics for this researcher
  // ---------------------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/api/research-topics') {
    const tenantId = url.searchParams.get('tenant_id') ?? undefined;
    const topics = await listResearchTopicsForResearcher(sql, user.id, tenantId);
    return json({ topics });
  }

  // ---------------------------------------------------------------------------
  // Paths below require a topic :id segment
  // ---------------------------------------------------------------------------
  const memberDeleteMatch = url.pathname.match(
    /^\/api\/research-topics\/([^/]+)\/members\/([^/]+)$/,
  );
  const memberPostMatch = url.pathname.match(/^\/api\/research-topics\/([^/]+)\/members$/);
  const topicIdMatch = url.pathname.match(/^\/api\/research-topics\/([^/]+)$/);

  // ---------------------------------------------------------------------------
  // DELETE /api/research-topics/:id/members/:researcher_id
  // ---------------------------------------------------------------------------
  if (req.method === 'DELETE' && memberDeleteMatch) {
    const topicId = memberDeleteMatch[1]!;
    const targetResearcherId = memberDeleteMatch[2]!;

    // Check that topic exists
    const topic = await getResearchTopic(sql, topicId);
    if (!topic) {
      return json({ error: 'Topic not found' }, 404);
    }

    // A researcher may remove themselves (self-remove). Otherwise, only owners
    // may remove others.
    const isSelfRemove = targetResearcherId === user.id;
    if (!isSelfRemove) {
      const callerMembership = await getTopicMember(sql, topicId, user.id);
      if (!callerMembership || callerMembership.role !== 'owner') {
        return json({ error: 'Forbidden: only owners may remove other members' }, 403);
      }
    }

    const removed = await removeTopicMember(sql, topicId, targetResearcherId);
    if (!removed) {
      return json({ error: 'Member not found' }, 404);
    }
    return json({ ok: true });
  }

  // ---------------------------------------------------------------------------
  // POST /api/research-topics/:id/members — add a researcher to a topic
  // ---------------------------------------------------------------------------
  if (req.method === 'POST' && memberPostMatch) {
    const topicId = memberPostMatch[1]!;

    // Check that topic exists
    const topic = await getResearchTopic(sql, topicId);
    if (!topic) {
      return json({ error: 'Topic not found' }, 404);
    }

    // Only owners may add members
    const callerMembership = await getTopicMember(sql, topicId, user.id);
    if (!callerMembership || callerMembership.role !== 'owner') {
      return json({ error: 'Forbidden: only owners may add members' }, 403);
    }

    let body: { researcher_id?: string; role?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.researcher_id) {
      return json({ error: 'researcher_id is required' }, 400);
    }

    const role = (body.role === 'owner' ? 'owner' : 'member') as 'owner' | 'member';
    const member = await addTopicMember(sql, {
      topic_id: topicId,
      researcher_id: body.researcher_id,
      role,
    });

    return json({ member });
  }

  // ---------------------------------------------------------------------------
  // GET /api/research-topics/:id — fetch a single topic with its members
  // ---------------------------------------------------------------------------
  if (req.method === 'GET' && topicIdMatch) {
    const topicId = topicIdMatch[1]!;

    const topic = await getResearchTopic(sql, topicId);
    if (!topic) {
      return json({ error: 'Topic not found' }, 404);
    }

    // Only members may read the topic
    const membership = await getTopicMember(sql, topicId, user.id);
    if (!membership) {
      return json({ error: 'Forbidden' }, 403);
    }

    const members = await listTopicMembers(sql, topicId);
    return json({ topic, members });
  }

  // ---------------------------------------------------------------------------
  // PATCH /api/research-topics/:id — update name or description
  // ---------------------------------------------------------------------------
  if (req.method === 'PATCH' && topicIdMatch) {
    const topicId = topicIdMatch[1]!;

    const topic = await getResearchTopic(sql, topicId);
    if (!topic) {
      return json({ error: 'Topic not found' }, 404);
    }

    // Only owners may update
    const membership = await getTopicMember(sql, topicId, user.id);
    if (!membership || membership.role !== 'owner') {
      return json({ error: 'Forbidden: only owners may update topics' }, 403);
    }

    let body: { name?: string; description?: string | null };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const updated = await updateResearchTopic(sql, topicId, {
      name: body.name,
      description: body.description,
    });

    if (!updated) {
      return json({ error: 'Topic not found' }, 404);
    }

    return json({ topic: updated });
  }

  return null;
}
