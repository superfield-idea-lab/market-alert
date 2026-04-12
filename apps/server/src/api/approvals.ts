/**
 * Approvals API — M-of-N approval for privileged operations (issue #24).
 *
 * POST   /api/approvals
 *   Create a new pending ApprovalRequest for a privileged operation.
 *   Body: { operation_type, payload?, required_approvals? }
 *   Auth: authenticated user (any).
 *
 * GET    /api/approvals
 *   List approval requests.
 *   Query: ?status=, ?operation_type=, ?limit=, ?offset=
 *   Auth: superuser only.
 *
 * GET    /api/approvals/:id
 *   Fetch a single ApprovalRequest with all votes.
 *   Auth: authenticated user.
 *
 * POST   /api/approvals/:id/vote
 *   Cast an approval or rejection vote on a pending request.
 *   Body: { decision: 'approved' | 'rejected', comment? }
 *   Auth: designated approvers only (determined by APPROVER_IDS env var).
 *
 * POST   /api/approvals/:id/execute
 *   Mark an approved request as executed (called after the privileged
 *   operation has been carried out).
 *   Auth: superuser only.
 *
 * Direct execution paths for root_key_rotate and bulk_export are blocked by
 * the approval-middleware (`requireApproval`) imported from
 * `../security/approval-middleware`. Each privileged route must call
 * `requireApproval` before processing.
 *
 * Approver designation: the APPROVER_IDS environment variable holds a
 * comma-separated list of user IDs that are authorised to cast votes.
 * When APPROVER_IDS is not set, only superusers may vote.
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import { emitAuditEvent } from '../policies/audit-service';
import {
  createApprovalRequest,
  castVote,
  markExecuted,
  getApprovalRequest,
  listApprovalRequests,
  PRIVILEGED_OPERATIONS,
  type ApprovalStatus,
  type ApprovalDecision,
} from 'db/approvals';

/**
 * Returns the list of user IDs that are authorised to cast approval votes.
 * Falls back to an empty array when APPROVER_IDS is not configured.
 */
function getDesignatedApprovers(): string[] {
  const raw = process.env.APPROVER_IDS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isDesignatedApprover(userId: string): boolean {
  if (isSuperuser(userId)) return true;
  const approvers = getDesignatedApprovers();
  return approvers.includes(userId);
}

/**
 * Builds an ApprovalAuditWriterFn backed by the server-layer audit service.
 * Bridges the injected-callback pattern in db/approvals with emitAuditEvent.
 */
function makeAuditWriter(_appState: AppState) {
  return async (event: {
    actor_id: string;
    action: string;
    entity_type: string;
    entity_id: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    ts: string;
  }) => {
    await emitAuditEvent({
      actor_id: event.actor_id,
      action: event.action,
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      before: event.before,
      after: event.after,
      ts: event.ts,
    });
  };
}

export async function handleApprovalsRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/approvals')) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const auditWriter = makeAuditWriter(appState);

  // -------------------------------------------------------------------------
  // POST /api/approvals — create a new approval request
  // -------------------------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/api/approvals') {
    let body: { operation_type?: unknown; payload?: unknown; required_approvals?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const operationType = body.operation_type;
    if (typeof operationType !== 'string' || !operationType.trim()) {
      return json(
        {
          error: 'operation_type is required',
          allowed: PRIVILEGED_OPERATIONS,
        },
        400,
      );
    }

    if (!PRIVILEGED_OPERATIONS.includes(operationType as (typeof PRIVILEGED_OPERATIONS)[number])) {
      return json(
        {
          error: `Unknown operation_type '${operationType}'`,
          allowed: PRIVILEGED_OPERATIONS,
        },
        400,
      );
    }

    const payload =
      body.payload !== undefined && typeof body.payload === 'object' && body.payload !== null
        ? (body.payload as Record<string, unknown>)
        : {};

    const requiredApprovals =
      typeof body.required_approvals === 'number' ? body.required_approvals : 2;

    if (!Number.isInteger(requiredApprovals) || requiredApprovals < 1) {
      return json({ error: 'required_approvals must be a positive integer' }, 400);
    }

    try {
      const request = await createApprovalRequest(
        sql,
        {
          operation_type: operationType as (typeof PRIVILEGED_OPERATIONS)[number],
          payload,
          requested_by: user.id,
          required_approvals: requiredApprovals,
        },
        auditWriter,
      );
      return json(request, 201);
    } catch (err) {
      console.error('[approvals] create failed:', err);
      return json({ error: 'Failed to create approval request' }, 500);
    }
  }

  // -------------------------------------------------------------------------
  // GET /api/approvals — list (superuser only)
  // -------------------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/api/approvals') {
    if (!isSuperuser(user.id)) return json({ error: 'Forbidden' }, 403);

    const statusParam = url.searchParams.get('status') ?? undefined;
    const opTypeParam = url.searchParams.get('operation_type') ?? undefined;
    const limitParam = url.searchParams.get('limit');
    const offsetParam = url.searchParams.get('offset');

    const allowedStatuses: ApprovalStatus[] = ['pending', 'approved', 'rejected', 'executed'];
    if (statusParam && !allowedStatuses.includes(statusParam as ApprovalStatus)) {
      return json({ error: `Invalid status. Must be one of: ${allowedStatuses.join(', ')}` }, 400);
    }

    const limit = Math.min(Math.max(parseInt(limitParam ?? '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(offsetParam ?? '0', 10) || 0, 0);

    const requests = await listApprovalRequests(sql, {
      status: statusParam as ApprovalStatus | undefined,
      operation_type: opTypeParam,
      limit,
      offset,
    });

    return json({ requests, limit, offset });
  }

  // -------------------------------------------------------------------------
  // Routes that require an :id path segment
  // -------------------------------------------------------------------------
  const idMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)(\/[^/]+)?$/);
  if (!idMatch) return null;

  const requestId = idMatch[1];
  const subpath = idMatch[2] ?? '';

  // GET /api/approvals/:id — fetch with votes (any authenticated user)
  if (req.method === 'GET' && subpath === '') {
    const result = await getApprovalRequest(sql, requestId);
    if (!result) return json({ error: 'Not found' }, 404);
    return json(result);
  }

  // POST /api/approvals/:id/vote — cast a vote (designated approvers only)
  if (req.method === 'POST' && subpath === '/vote') {
    if (!isDesignatedApprover(user.id)) {
      return json({ error: 'Forbidden — not a designated approver' }, 403);
    }

    let body: { decision?: unknown; comment?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const decision = body.decision;
    if (decision !== 'approved' && decision !== 'rejected') {
      return json({ error: "decision must be 'approved' or 'rejected'" }, 400);
    }

    const comment =
      typeof body.comment === 'string' && body.comment.trim() ? body.comment.trim() : undefined;

    try {
      const result = await castVote(
        sql,
        {
          request_id: requestId,
          approver_id: user.id,
          decision: decision as ApprovalDecision,
          comment,
        },
        auditWriter,
      );
      return json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Distinguish "already voted" (duplicate key) vs other errors
      if (message.toLowerCase().includes('unique') || message.includes('duplicate')) {
        return json({ error: 'You have already voted on this request' }, 409);
      }
      if (message.includes('not pending') || message.includes('not found')) {
        return json({ error: message }, 422);
      }
      console.error('[approvals] castVote failed:', err);
      return json({ error: 'Failed to record vote' }, 500);
    }
  }

  // POST /api/approvals/:id/execute — mark as executed (superuser only)
  if (req.method === 'POST' && subpath === '/execute') {
    if (!isSuperuser(user.id)) return json({ error: 'Forbidden' }, 403);

    try {
      const updated = await markExecuted(sql, requestId, user.id, auditWriter);
      return json(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) {
        return json({ error: message }, 404);
      }
      if (message.includes('cannot be executed')) {
        return json({ error: message }, 422);
      }
      console.error('[approvals] markExecuted failed:', err);
      return json({ error: 'Failed to mark request as executed' }, 500);
    }
  }

  return null;
}
