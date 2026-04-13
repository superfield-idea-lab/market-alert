/**
 * @file api/compliance
 *
 * Compliance Officer API — retention policy management (issue #79) and
 * e-discovery export bundle (issue #84).
 *
 * GET  /api/compliance/retention-policies
 *   List all named retention policies in the catalogue with their entity-type
 *   overrides. Open to any authenticated user (read-only).
 *
 * POST /api/compliance/tenants/:tenantId/retention-policy
 *   Assign a named retention policy to a tenant.
 *   Body: { policyName: string }
 *   Auth: compliance_officer role or superuser.
 *   Emits an audit event before the DB write (write-before-mutate invariant).
 *
 * POST /api/compliance/export
 *   Trigger an e-discovery export for the given scope.
 *   Body: { customerId: string, dateFrom?: string, dateTo?: string, entityTypes?: string[] }
 *   Auth: compliance_officer role or superuser.
 *   Emits an e_discovery.export audit event.
 *   Returns the structured bundle as JSON.
 *
 * Canonical docs: docs/PRD.md §7a, docs/implementation-plan-v1.md Phase 8
 * Related issues: #79, #84
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser, parseCookies } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import { emitAuditEvent } from '../policies/audit-service';
import { verifyCsrfAndAudit } from '../auth/csrf';
import {
  listRetentionPolicies,
  assignRetentionPolicyToTenant,
  InsufficientRoleError,
  UnknownRetentionPolicyError,
} from 'db/retention-engine';
import { buildEDiscoveryBundle, EDiscoveryInsufficientRoleError } from 'db/e-discovery';

export async function handleComplianceRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/compliance')) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  // ---------------------------------------------------------------------------
  // GET /api/compliance/retention-policies
  // ---------------------------------------------------------------------------

  if (req.method === 'GET' && url.pathname === '/api/compliance/retention-policies') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const policies = await listRetentionPolicies(sql);
    return json({ policies });
  }

  // ---------------------------------------------------------------------------
  // POST /api/compliance/tenants/:tenantId/retention-policy
  // ---------------------------------------------------------------------------

  const assignMatch = url.pathname.match(/^\/api\/compliance\/tenants\/([^/]+)\/retention-policy$/);
  if (req.method === 'POST' && assignMatch) {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const cookies = parseCookies(req.headers.get('Cookie'));
    const csrfError = await verifyCsrfAndAudit(req, cookies, {
      actorId: user.id,
      path: url.pathname,
    });
    if (csrfError) return csrfError;

    const tenantId = assignMatch[1];

    let body: { policyName?: unknown };
    try {
      body = (await req.json()) as { policyName?: unknown };
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (typeof body.policyName !== 'string' || !body.policyName.trim()) {
      return json({ error: 'policyName is required' }, 400);
    }

    const policyName = body.policyName.trim();

    // Resolve the actor's role from the entities table.
    const actorRows = await sql<{ properties: { role?: string } }[]>`
      SELECT properties
      FROM entities
      WHERE id = ${user.id} AND type = 'user'
      LIMIT 1
    `;
    const actorRole = actorRows[0]?.properties?.role ?? null;
    const actorIsSuperuser = isSuperuser(user.id);

    try {
      await assignRetentionPolicyToTenant(sql, {
        tenantId,
        policyName,
        actorId: user.id,
        actorRole: actorRole ?? null,
        isSuperuser: actorIsSuperuser,
        auditWriter: async (event) => {
          await emitAuditEvent(event);
        },
      });
    } catch (err) {
      if (err instanceof InsufficientRoleError) {
        return json({ error: 'Forbidden: compliance_officer role required' }, 403);
      }
      if (err instanceof UnknownRetentionPolicyError) {
        return json({ error: `Unknown policy: ${policyName}` }, 422);
      }
      throw err;
    }

    return json({ tenantId, policyName, assigned: true }, 200);
  }

  // ---------------------------------------------------------------------------
  // POST /api/compliance/export
  // ---------------------------------------------------------------------------

  if (req.method === 'POST' && url.pathname === '/api/compliance/export') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const cookies = parseCookies(req.headers.get('Cookie'));
    const csrfError = await verifyCsrfAndAudit(req, cookies, {
      actorId: user.id,
      path: url.pathname,
    });
    if (csrfError) return csrfError;

    let body: {
      customerId?: unknown;
      dateFrom?: unknown;
      dateTo?: unknown;
      entityTypes?: unknown;
    };
    try {
      body = (await req.json()) as {
        customerId?: unknown;
        dateFrom?: unknown;
        dateTo?: unknown;
        entityTypes?: unknown;
      };
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (typeof body.customerId !== 'string' || !body.customerId.trim()) {
      return json({ error: 'customerId is required' }, 400);
    }

    if (body.dateFrom !== undefined && typeof body.dateFrom !== 'string') {
      return json({ error: 'dateFrom must be an ISO-8601 string' }, 400);
    }

    if (body.dateTo !== undefined && typeof body.dateTo !== 'string') {
      return json({ error: 'dateTo must be an ISO-8601 string' }, 400);
    }

    if (
      body.entityTypes !== undefined &&
      (!Array.isArray(body.entityTypes) ||
        (body.entityTypes as unknown[]).some((t) => typeof t !== 'string'))
    ) {
      return json({ error: 'entityTypes must be an array of strings' }, 400);
    }

    const actorRows = await sql<{ properties: { role?: string } }[]>`
      SELECT properties
      FROM entities
      WHERE id = ${user.id} AND type = 'user'
      LIMIT 1
    `;
    const actorRole = actorRows[0]?.properties?.role ?? null;
    const actorIsSuperuser = isSuperuser(user.id);

    const scope = {
      customerId: (body.customerId as string).trim(),
      dateFrom: body.dateFrom as string | undefined,
      dateTo: body.dateTo as string | undefined,
      entityTypes: body.entityTypes as string[] | undefined,
    };

    let bundle;
    try {
      bundle = await buildEDiscoveryBundle(sql, {
        actorId: user.id,
        actorRole,
        isSuperuser: actorIsSuperuser,
        scope,
        auditSql: appState.auditSql,
        auditWriter: async (event) => {
          await emitAuditEvent(event);
        },
      });
    } catch (err) {
      if (err instanceof EDiscoveryInsufficientRoleError) {
        return json({ error: 'Forbidden: compliance_officer role required' }, 403);
      }
      throw err;
    }

    return json(bundle, 200);
  }

  return null;
}
