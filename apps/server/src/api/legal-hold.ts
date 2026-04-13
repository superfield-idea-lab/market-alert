/**
 * @file api/legal-hold
 *
 * Legal Hold API — placement and four-eyes removal flow (issue #82).
 *
 * POST /api/legal-holds
 *   Place a legal hold on a tenant's records.
 *   Body: { tenantId: string, reason?: string }
 *   Auth: compliance_officer role or superuser.
 *   Emits a `legal_hold.place` audit event.
 *
 * GET /api/legal-holds
 *   List legal holds.
 *   Query: ?tenantId=, ?status=, ?limit=, ?offset=
 *   Auth: authenticated user.
 *
 * GET /api/legal-holds/:holdId
 *   Fetch a single legal hold with its pending removal request.
 *   Auth: authenticated user.
 *
 * POST /api/legal-holds/:holdId/removal-request
 *   Initiate the four-eyes removal flow (first Compliance Officer).
 *   Auth: compliance_officer role.
 *   Emits a `legal_hold.removal_requested` audit event.
 *
 * POST /api/legal-holds/removal-requests/:requestId/approve
 *   Co-approve a pending removal request (second distinct Compliance Officer).
 *   Auth: compliance_officer role (must differ from requester).
 *   Emits a `legal_hold.remove` audit event.
 *
 * POST /api/legal-holds/removal-requests/:requestId/reject
 *   Reject a pending removal request (hold returns to active).
 *   Auth: compliance_officer role.
 *   Emits a `legal_hold.removal_rejected` audit event.
 *
 * GET /api/legal-holds/pending-removals
 *   List all pending removal requests (the approval queue).
 *   Auth: compliance_officer role or superuser.
 *
 * Canonical docs: docs/PRD.md, docs/implementation-plan-v1.md Phase 8
 * Related issue: #82
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser, parseCookies } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import { emitAuditEvent } from '../policies/audit-service';
import { verifyCsrfAndAudit } from '../auth/csrf';
import {
  placeLegalHold,
  getLegalHold,
  listLegalHolds,
  requestHoldRemoval,
  approveHoldRemoval,
  rejectHoldRemoval,
  listPendingRemovalRequests,
  LegalHoldInsufficientRoleError,
  LegalHoldNotFoundError,
  LegalHoldFourEyesViolationError,
  LegalHoldStatusError,
  LegalHoldRemovalRequestNotFoundError,
  type LegalHoldStatus,
} from 'db/legal-hold';

/**
 * Builds a LegalHoldAuditWriterFn backed by the server-layer audit service.
 */
function makeAuditWriter() {
  return async (event: {
    actor_id: string;
    action: string;
    entity_type: string;
    entity_id: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    ts: string;
  }) => {
    await emitAuditEvent(event);
  };
}

/**
 * Resolves the actor's role from the entities table.
 */
async function resolveActorRole(sql: AppState['sql'], userId: string): Promise<string | null> {
  const actorRows = await sql<{ properties: { role?: string } }[]>`
    SELECT properties
    FROM entities
    WHERE id = ${userId} AND type = 'user'
    LIMIT 1
  `;
  return actorRows[0]?.properties?.role ?? null;
}

export async function handleLegalHoldRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/legal-holds')) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const auditWriter = makeAuditWriter();

  // -------------------------------------------------------------------------
  // GET /api/legal-holds/pending-removals
  // -------------------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/api/legal-holds/pending-removals') {
    const actorRole = await resolveActorRole(sql, user.id);
    if (!isSuperuser(user.id) && actorRole !== 'compliance_officer') {
      return json({ error: 'Forbidden: compliance_officer role required' }, 403);
    }

    const limitParam = url.searchParams.get('limit');
    const offsetParam = url.searchParams.get('offset');
    const limit = Math.min(Math.max(parseInt(limitParam ?? '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(offsetParam ?? '0', 10) || 0, 0);

    const requests = await listPendingRemovalRequests(sql, { limit, offset });
    return json({ requests, limit, offset });
  }

  // -------------------------------------------------------------------------
  // POST /api/legal-holds/removal-requests/:requestId/approve
  // -------------------------------------------------------------------------
  const approveMatch = url.pathname.match(
    /^\/api\/legal-holds\/removal-requests\/([^/]+)\/approve$/,
  );
  if (req.method === 'POST' && approveMatch) {
    const cookies = parseCookies(req.headers.get('Cookie'));
    const csrfError = await verifyCsrfAndAudit(req, cookies, {
      actorId: user.id,
      path: url.pathname,
    });
    if (csrfError) return csrfError;

    const requestId = approveMatch[1];
    const actorRole = await resolveActorRole(sql, user.id);

    try {
      const updatedHold = await approveHoldRemoval(
        sql,
        {
          removalRequestId: requestId,
          coApprovedBy: user.id,
          actorRole,
          isSuperuser: isSuperuser(user.id),
        },
        auditWriter,
      );
      return json({ hold: updatedHold }, 200);
    } catch (err) {
      if (err instanceof LegalHoldInsufficientRoleError) {
        return json({ error: 'Forbidden: compliance_officer role required' }, 403);
      }
      if (err instanceof LegalHoldFourEyesViolationError) {
        return json({ error: err.message }, 422);
      }
      if (err instanceof LegalHoldRemovalRequestNotFoundError) {
        return json({ error: err.message }, 404);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // POST /api/legal-holds/removal-requests/:requestId/reject
  // -------------------------------------------------------------------------
  const rejectMatch = url.pathname.match(/^\/api\/legal-holds\/removal-requests\/([^/]+)\/reject$/);
  if (req.method === 'POST' && rejectMatch) {
    const cookies = parseCookies(req.headers.get('Cookie'));
    const csrfError = await verifyCsrfAndAudit(req, cookies, {
      actorId: user.id,
      path: url.pathname,
    });
    if (csrfError) return csrfError;

    const requestId = rejectMatch[1];
    const actorRole = await resolveActorRole(sql, user.id);

    try {
      const updatedHold = await rejectHoldRemoval(
        sql,
        {
          removalRequestId: requestId,
          rejectedBy: user.id,
          actorRole,
          isSuperuser: isSuperuser(user.id),
        },
        auditWriter,
      );
      return json({ hold: updatedHold }, 200);
    } catch (err) {
      if (err instanceof LegalHoldInsufficientRoleError) {
        return json({ error: 'Forbidden: compliance_officer role required' }, 403);
      }
      if (err instanceof LegalHoldRemovalRequestNotFoundError) {
        return json({ error: err.message }, 404);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // POST /api/legal-holds/:holdId/removal-request
  // -------------------------------------------------------------------------
  const removalRequestMatch = url.pathname.match(/^\/api\/legal-holds\/([^/]+)\/removal-request$/);
  if (req.method === 'POST' && removalRequestMatch) {
    const cookies = parseCookies(req.headers.get('Cookie'));
    const csrfError = await verifyCsrfAndAudit(req, cookies, {
      actorId: user.id,
      path: url.pathname,
    });
    if (csrfError) return csrfError;

    const holdId = removalRequestMatch[1];
    const actorRole = await resolveActorRole(sql, user.id);

    try {
      const removalRequest = await requestHoldRemoval(
        sql,
        {
          holdId,
          requestedBy: user.id,
          actorRole,
          isSuperuser: isSuperuser(user.id),
        },
        auditWriter,
      );
      return json({ removalRequest }, 201);
    } catch (err) {
      if (err instanceof LegalHoldInsufficientRoleError) {
        return json({ error: 'Forbidden: compliance_officer role required' }, 403);
      }
      if (err instanceof LegalHoldNotFoundError) {
        return json({ error: err.message }, 404);
      }
      if (err instanceof LegalHoldStatusError) {
        return json({ error: err.message }, 422);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // GET /api/legal-holds/:holdId
  // -------------------------------------------------------------------------
  const holdMatch = url.pathname.match(/^\/api\/legal-holds\/([^/]+)$/);
  if (req.method === 'GET' && holdMatch) {
    const actorRole = await resolveActorRole(sql, user.id);
    if (!isSuperuser(user.id) && actorRole !== 'compliance_officer') {
      return json({ error: 'Forbidden: compliance_officer role required' }, 403);
    }

    const holdId = holdMatch[1];
    const hold = await getLegalHold(sql, holdId);
    if (!hold) return json({ error: 'Not found' }, 404);
    return json(hold);
  }

  // -------------------------------------------------------------------------
  // POST /api/legal-holds
  // -------------------------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/api/legal-holds') {
    const cookies = parseCookies(req.headers.get('Cookie'));
    const csrfError = await verifyCsrfAndAudit(req, cookies, {
      actorId: user.id,
      path: url.pathname,
    });
    if (csrfError) return csrfError;

    let body: { tenantId?: unknown; reason?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (typeof body.tenantId !== 'string' || !body.tenantId.trim()) {
      return json({ error: 'tenantId is required' }, 400);
    }

    const tenantId = body.tenantId.trim();
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const actorRole = await resolveActorRole(sql, user.id);

    try {
      const hold = await placeLegalHold(
        sql,
        {
          tenantId,
          placedBy: user.id,
          actorRole,
          reason,
          isSuperuser: isSuperuser(user.id),
        },
        auditWriter,
      );
      return json({ hold }, 201);
    } catch (err) {
      if (err instanceof LegalHoldInsufficientRoleError) {
        return json({ error: 'Forbidden: compliance_officer role required' }, 403);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // GET /api/legal-holds
  // -------------------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/api/legal-holds') {
    const actorRole = await resolveActorRole(sql, user.id);
    if (!isSuperuser(user.id) && actorRole !== 'compliance_officer') {
      return json({ error: 'Forbidden: compliance_officer role required' }, 403);
    }

    const tenantId = url.searchParams.get('tenantId') ?? undefined;
    const statusParam = url.searchParams.get('status') ?? undefined;
    const limitParam = url.searchParams.get('limit');
    const offsetParam = url.searchParams.get('offset');

    const allowedStatuses: LegalHoldStatus[] = ['active', 'pending_removal', 'removed'];
    if (statusParam && !allowedStatuses.includes(statusParam as LegalHoldStatus)) {
      return json({ error: `Invalid status. Must be one of: ${allowedStatuses.join(', ')}` }, 400);
    }

    const limit = Math.min(Math.max(parseInt(limitParam ?? '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(offsetParam ?? '0', 10) || 0, 0);

    const holds = await listLegalHolds(sql, {
      tenantId,
      status: statusParam as LegalHoldStatus | undefined,
      limit,
      offset,
    });

    return json({ holds, limit, offset });
  }

  return null;
}
