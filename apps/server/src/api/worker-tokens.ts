/**
 * Worker token mint endpoint (issue #36).
 *
 * POST /internal/worker/tokens
 *   Accepts a bootstrap identity (pod_id, agent_type) and a task scope,
 *   returns a single-use task-scoped JWT with pod-lifetime TTL.
 *
 * DELETE /internal/worker/tokens/:podId
 *   Pod-terminate hook: invalidates all still-unused tokens for the pod.
 *   Emits an audit event for each invalidated token.
 *
 * Auth model:
 *   Both routes require a valid session cookie or API-key Bearer token.
 *   In production the caller is the platform control plane that provisions
 *   pods; in tests the TEST_MODE session backdoor is used.
 *
 * Audit events:
 *   worker_token.issued     — on successful mint
 *   worker_token.consumed   — emitted from verifyAndConsumeWorkerToken caller
 *   worker_token.invalidated — on pod-terminate
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUserOrApiKey } from './auth';
import { issueWorkerToken, invalidateWorkerTokensForPod } from '../auth/worker-token';
import { emitAuditEvent } from '../policies/audit-service';
import { makeJson } from '../lib/response';

export async function handleWorkerTokensRequest(
  req: Request,
  url: URL,
  _appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/internal/worker/tokens')) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);

  // All routes on this prefix require authentication.
  const user = await getAuthenticatedUserOrApiKey(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // POST /internal/worker/tokens — mint a new token
  if (req.method === 'POST' && url.pathname === '/internal/worker/tokens') {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { pod_id, agent_type, task_scope } = body as Record<string, unknown>;

    if (!pod_id || typeof pod_id !== 'string') {
      return json({ error: 'pod_id is required and must be a string' }, 400);
    }
    if (!agent_type || typeof agent_type !== 'string') {
      return json({ error: 'agent_type is required and must be a string' }, 400);
    }
    if (!task_scope || typeof task_scope !== 'string') {
      return json({ error: 'task_scope is required and must be a string' }, 400);
    }

    const { token, row } = await issueWorkerToken({
      podId: pod_id,
      agentType: agent_type,
      taskScope: task_scope,
    });

    // Audit: token issuance
    await emitAuditEvent({
      actor_id: user.id,
      action: 'worker_token.issued',
      entity_type: 'worker_token',
      entity_id: row.id,
      before: null,
      after: {
        id: row.id,
        pod_id: row.pod_id,
        agent_type: row.agent_type,
        task_scope: row.task_scope,
        jti: row.jti,
        expires_at: row.expires_at.toISOString(),
      },
      ts: new Date().toISOString(),
    }).catch((err) => console.error('[worker-tokens] audit emit failed for issued event:', err));

    return json(
      {
        token,
        token_id: row.id,
        expires_at: row.expires_at.toISOString(),
      },
      201,
    );
  }

  // DELETE /internal/worker/tokens/:podId — pod-terminate invalidation
  const deleteMatch = url.pathname.match(/^\/internal\/worker\/tokens\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    const podId = deleteMatch[1];

    const count = await invalidateWorkerTokensForPod(podId);

    // Audit: pod-terminate invalidation (one event summarising the pod)
    await emitAuditEvent({
      actor_id: user.id,
      action: 'worker_token.invalidated',
      entity_type: 'worker_token',
      entity_id: podId,
      before: null,
      after: { pod_id: podId, tokens_invalidated: count },
      ts: new Date().toISOString(),
    }).catch((err) =>
      console.error('[worker-tokens] audit emit failed for invalidated event:', err),
    );

    return json({ ok: true, pod_id: podId, tokens_invalidated: count });
  }

  return null;
}
