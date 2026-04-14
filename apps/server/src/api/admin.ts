/**
 * Admin API — superuser-only endpoints.
 *
 * POST   /api/admin/keys        — generates a new API key, returns raw key once
 * GET    /api/admin/keys        — lists API key metadata (no raw values)
 * DELETE /api/admin/keys/:id    — revokes an API key
 * GET    /api/admin/task-queue   — lists recent task queue entries for monitoring
 *
 * GET    /api/admin/users       — paginated user list, optional ?role= filter
 * PATCH  /api/admin/users/:id   — change role or active status of a user
 *
 * GET    /api/admin/tenants/:id/rate-policy — retrieve effective tenant rate policy
 * PUT    /api/admin/tenants/:id/rate-policy — override per-tenant rate limits at runtime
 *                                             (send null body to revert to safe defaults)
 *
 * GET    /api/admin/tenants/:id/config           — retrieve tenant configuration flags
 * PUT    /api/admin/tenants/:id/config/regulated — set regulated status for a tenant
 * PUT    /api/admin/tenants/:id/config/assemblyai-legacy — enable/disable AssemblyAI
 *                                                          legacy path (blocked for
 *                                                          regulated tenants)
 *
 * Superuser is determined by the SUPERUSER_ID environment variable.
 * All create, revoke, role-change, deactivation, and rate-policy-update operations
 * are audit-logged.
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { createApiKey, listApiKeys, deleteApiKey } from 'db/api-keys';
import { listTasksForAdmin, type TaskQueueStatus } from 'db/task-queue';
import { emitAuditEvent } from '../policies/audit-service';
import { isSuperuser, makeJson } from '../lib/response';
import { canManageCrmEntities } from '../lib/access';
import {
  setTenantRatePolicy,
  getTenantRatePolicy,
  type TenantRatePolicy,
} from '../security/rate-limiter';
import {
  getTenantConfig,
  setTenantRegulated,
  setAssemblyAiLegacyEnabled,
  RegulatedTenantError,
} from 'db/tenant-config';

// Re-export isSuperuser so existing importers (e.g. users.ts) continue to work
// without an immediate cascading change.  Prefer importing directly from
// '../lib/response' in new code.
export { isSuperuser };

export async function handleAdminRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/admin')) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const hasCrmAccess = await canManageCrmEntities(user.id, sql).catch(() => false);

  // -----------------------------------------------------------------------
  // CRM entity management endpoints
  // -----------------------------------------------------------------------

  if (req.method === 'GET' && url.pathname === '/api/admin/crm/entities') {
    if (!hasCrmAccess) return json({ error: 'Forbidden' }, 403);

    const type = url.searchParams.get('type');
    const allowedTypes = ['asset_manager', 'fund'] as const;
    if (!type || !allowedTypes.includes(type as (typeof allowedTypes)[number])) {
      return json({ error: 'type is required and must be asset_manager or fund' }, 400);
    }

    interface CrmEntityRow {
      id: string;
      type: string;
      properties: Record<string, unknown>;
      created_at: string;
      updated_at: string;
    }

    const rows = await sql<CrmEntityRow[]>`
      SELECT id, type, properties, created_at, updated_at
      FROM entities
      WHERE type = ${type}
      ORDER BY created_at DESC
    `;
    const totalRows = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count
      FROM entities
      WHERE type = ${type}
    `;
    return json({
      type,
      total: Number(totalRows[0]?.count ?? 0),
      entities: rows,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/crm/entities') {
    if (!hasCrmAccess) return json({ error: 'Forbidden' }, 403);

    let body: { type?: string; properties?: Record<string, unknown> };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const allowedTypes = ['asset_manager', 'fund'] as const;
    if (!body.type || !allowedTypes.includes(body.type as (typeof allowedTypes)[number])) {
      return json({ error: 'type must be asset_manager or fund' }, 400);
    }

    const properties = body.properties ?? {};
    if (typeof properties.name !== 'string' || !properties.name.trim()) {
      return json({ error: 'properties.name is required' }, 400);
    }

    const id = `${body.type}-${crypto.randomUUID()}`;
    const storedProperties = {
      ...properties,
      name: properties.name.trim(),
    };

    await sql`
      INSERT INTO entities (id, type, properties, tenant_id)
      VALUES (${id}, ${body.type}, ${sql.json(storedProperties as never)}, null)
    `;

    const [entity] = await sql<
      {
        id: string;
        type: string;
        properties: Record<string, unknown>;
        created_at: string;
        updated_at: string;
      }[]
    >`
      SELECT id, type, properties, created_at, updated_at
      FROM entities
      WHERE id = ${id}
      LIMIT 1
    `;

    await emitAuditEvent({
      actor_id: user.id,
      action: 'crm_entity.create',
      entity_type: body.type,
      entity_id: id,
      before: null,
      after: { type: body.type, properties: storedProperties },
      ts: new Date().toISOString(),
    }).catch((err) => console.warn('[audit] crm_entity.create audit write failed:', err));

    return json({ entity }, 201);
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/admin\/crm\/entities\/[^/]+$/)) {
    if (!hasCrmAccess) return json({ error: 'Forbidden' }, 403);

    const entityId = url.pathname.split('/')[5];
    if (!entityId) return json({ error: 'Missing entity id' }, 400);

    let body: { properties?: Record<string, unknown> };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const [existing] = await sql<
      {
        id: string;
        type: string;
        properties: Record<string, unknown>;
        created_at: string;
        updated_at: string;
      }[]
    >`
      SELECT id, type, properties, created_at, updated_at
      FROM entities
      WHERE id = ${entityId}
        AND type IN ('asset_manager', 'fund')
      LIMIT 1
    `;

    if (!existing) return json({ error: 'Not found' }, 404);

    const updatedProperties = {
      ...existing.properties,
      ...(body.properties ?? {}),
    };
    if (typeof updatedProperties.name === 'string') {
      updatedProperties.name = updatedProperties.name.trim();
    }
    if (typeof updatedProperties.name !== 'string' || !updatedProperties.name.trim()) {
      return json({ error: 'properties.name is required' }, 400);
    }

    await sql`
      UPDATE entities
      SET properties = ${sql.json(updatedProperties as never)},
          updated_at = NOW()
      WHERE id = ${entityId}
    `;

    const [entity] = await sql<
      {
        id: string;
        type: string;
        properties: Record<string, unknown>;
        created_at: string;
        updated_at: string;
      }[]
    >`
      SELECT id, type, properties, created_at, updated_at
      FROM entities
      WHERE id = ${entityId}
      LIMIT 1
    `;

    await emitAuditEvent({
      actor_id: user.id,
      action: 'crm_entity.update',
      entity_type: existing.type,
      entity_id: entityId,
      before: { properties: existing.properties },
      after: { properties: updatedProperties },
      ts: new Date().toISOString(),
    }).catch((err) => console.warn('[audit] crm_entity.update audit write failed:', err));

    return json({ entity });
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/admin\/crm\/entities\/[^/]+$/)) {
    if (!hasCrmAccess) return json({ error: 'Forbidden' }, 403);

    const entityId = url.pathname.split('/')[5];
    if (!entityId) return json({ error: 'Missing entity id' }, 400);

    const [existing] = await sql<
      { id: string; type: string; properties: Record<string, unknown> }[]
    >`
      SELECT id, type, properties
      FROM entities
      WHERE id = ${entityId}
        AND type IN ('asset_manager', 'fund')
      LIMIT 1
    `;
    if (!existing) return json({ error: 'Not found' }, 404);

    await sql`DELETE FROM entities WHERE id = ${entityId}`;

    await emitAuditEvent({
      actor_id: user.id,
      action: 'crm_entity.delete',
      entity_type: existing.type,
      entity_id: entityId,
      before: { properties: existing.properties },
      after: null,
      ts: new Date().toISOString(),
    }).catch((err) => console.warn('[audit] crm_entity.delete audit write failed:', err));

    return json({ success: true });
  }

  if (!isSuperuser(user.id)) return json({ error: 'Forbidden' }, 403);

  // POST /api/admin/keys — create a new API key
  if (req.method === 'POST' && url.pathname === '/api/admin/keys') {
    let label: string;
    try {
      const body = await req.json();
      label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : '';
    } catch {
      label = '';
    }
    if (!label) {
      return json({ error: 'label is required' }, 400);
    }

    const { rawKey, row } = await createApiKey(label, user.id);

    // Audit the creation — never log the raw key, only the key id
    await emitAuditEvent({
      actor_id: user.id,
      action: 'api_key.create',
      entity_type: 'api_key',
      entity_id: row.id,
      before: null,
      after: { id: row.id, label: row.label, created_by: row.created_by },
      ts: new Date().toISOString(),
    }).catch((err) => console.warn('[audit] api_key.create audit write failed:', err));

    return json({ key: rawKey, id: row.id, label: row.label, created_at: row.created_at }, 201);
  }

  // GET /api/admin/keys — list API key metadata
  if (req.method === 'GET' && url.pathname === '/api/admin/keys') {
    const keys = await listApiKeys();
    return json(keys);
  }

  // DELETE /api/admin/keys/:id — revoke an API key
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/admin/keys/')) {
    const id = url.pathname.split('/')[4];
    if (!id) return json({ error: 'Missing key id' }, 400);

    const deleted = await deleteApiKey(id);
    if (!deleted) return json({ error: 'Not found' }, 404);

    // Audit the revocation
    await emitAuditEvent({
      actor_id: user.id,
      action: 'api_key.revoke',
      entity_type: 'api_key',
      entity_id: id,
      before: { id },
      after: null,
      ts: new Date().toISOString(),
    }).catch((err) => console.warn('[audit] api_key.revoke audit write failed:', err));

    return json({ success: true });
  }

  // GET /api/admin/task-queue — list recent task queue entries for monitoring.
  // Supports optional query parameters:
  //   ?status=<pending|claimed|running|submitting|completed|failed|dead>
  //   ?agent_type=<string>
  //   ?limit=<number>   (default 50, max 200)
  //   ?offset=<number>  (default 0)
  // Response excludes sensitive fields (payload, delegated_token).
  if (req.method === 'GET' && url.pathname === '/api/admin/task-queue') {
    const statusParam = url.searchParams.get('status') ?? undefined;
    const agentTypeParam = url.searchParams.get('agent_type') ?? undefined;
    const limitParam = url.searchParams.get('limit');
    const offsetParam = url.searchParams.get('offset');

    // Validate status if provided
    const allowedStatuses: TaskQueueStatus[] = [
      'pending',
      'claimed',
      'running',
      'submitting',
      'completed',
      'failed',
      'dead',
    ];
    if (statusParam && !allowedStatuses.includes(statusParam as TaskQueueStatus)) {
      return json({ error: `Invalid status. Must be one of: ${allowedStatuses.join(', ')}` }, 400);
    }

    const limit = Math.min(Math.max(parseInt(limitParam ?? '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(offsetParam ?? '0', 10) || 0, 0);

    const tasks = await listTasksForAdmin({
      status: statusParam as TaskQueueStatus | undefined,
      agent_type: agentTypeParam,
      limit,
      offset,
    });

    return json({ tasks, limit, offset });
  }

  // -----------------------------------------------------------------------
  // User management endpoints
  // -----------------------------------------------------------------------

  // GET /api/admin/users — paginated user list with optional role filter and ?q= search
  //
  // Query parameters:
  //   ?q=<string>    — case-insensitive partial match on username, email, or display_name
  //   ?role=<string> — exact match on properties.role
  //   ?page=<number> — 1-based page number (default 1)
  //   ?limit=<number>— page size (default 20, max 100)
  if (req.method === 'GET' && url.pathname === '/api/admin/users') {
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
    const offset = (page - 1) * limit;
    const roleFilter = url.searchParams.get('role') ?? null;
    const searchTerm = url.searchParams.get('q')?.trim() ?? null;

    interface UserRow {
      id: string;
      properties: Record<string, unknown>;
      created_at: string;
      updated_at: string;
    }

    let users: UserRow[];
    let totalRows: { count: string }[];

    if (searchTerm && roleFilter) {
      const pattern = `%${searchTerm}%`;
      users = await sql<UserRow[]>`
        SELECT id, properties, created_at, updated_at
        FROM entities
        WHERE type = 'user'
          AND properties->>'role' = ${roleFilter}
          AND (
            LOWER(properties->>'username') LIKE LOWER(${pattern})
            OR LOWER(properties->>'email') LIKE LOWER(${pattern})
            OR LOWER(properties->>'display_name') LIKE LOWER(${pattern})
          )
        ORDER BY created_at ASC
        LIMIT ${limit} OFFSET ${offset}
      `;
      totalRows = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count
        FROM entities
        WHERE type = 'user'
          AND properties->>'role' = ${roleFilter}
          AND (
            LOWER(properties->>'username') LIKE LOWER(${pattern})
            OR LOWER(properties->>'email') LIKE LOWER(${pattern})
            OR LOWER(properties->>'display_name') LIKE LOWER(${pattern})
          )
      `;
    } else if (searchTerm) {
      const pattern = `%${searchTerm}%`;
      users = await sql<UserRow[]>`
        SELECT id, properties, created_at, updated_at
        FROM entities
        WHERE type = 'user'
          AND (
            LOWER(properties->>'username') LIKE LOWER(${pattern})
            OR LOWER(properties->>'email') LIKE LOWER(${pattern})
            OR LOWER(properties->>'display_name') LIKE LOWER(${pattern})
          )
        ORDER BY created_at ASC
        LIMIT ${limit} OFFSET ${offset}
      `;
      totalRows = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count
        FROM entities
        WHERE type = 'user'
          AND (
            LOWER(properties->>'username') LIKE LOWER(${pattern})
            OR LOWER(properties->>'email') LIKE LOWER(${pattern})
            OR LOWER(properties->>'display_name') LIKE LOWER(${pattern})
          )
      `;
    } else if (roleFilter) {
      users = await sql<UserRow[]>`
        SELECT id, properties, created_at, updated_at
        FROM entities
        WHERE type = 'user'
          AND properties->>'role' = ${roleFilter}
        ORDER BY created_at ASC
        LIMIT ${limit} OFFSET ${offset}
      `;
      totalRows = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count
        FROM entities
        WHERE type = 'user'
          AND properties->>'role' = ${roleFilter}
      `;
    } else {
      users = await sql<UserRow[]>`
        SELECT id, properties, created_at, updated_at
        FROM entities
        WHERE type = 'user'
        ORDER BY created_at ASC
        LIMIT ${limit} OFFSET ${offset}
      `;
      totalRows = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count
        FROM entities
        WHERE type = 'user'
      `;
    }

    const total = Number(totalRows[0]?.count ?? 0);

    // Strip password hashes from the response
    const sanitized = users.map((u) => {
      const { password_hash: _pwHash, ...safeProps } = u.properties as Record<string, unknown> & {
        password_hash?: string;
      };
      void _pwHash;
      return {
        id: u.id,
        properties: safeProps,
        created_at: u.created_at,
        updated_at: u.updated_at,
      };
    });

    return json({ users: sanitized, total, page, limit });
  }

  // PATCH /api/admin/users/:id — change role or active status
  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/admin\/users\/[^/]+$/)) {
    const targetId = url.pathname.split('/')[4];
    if (!targetId) return json({ error: 'Missing user id' }, 400);

    let body: { role?: string; active?: boolean };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    // Validate that at least one field is provided
    if (body.role === undefined && body.active === undefined) {
      return json({ error: 'At least one of role or active must be provided' }, 400);
    }

    // Look up the target user
    const [target] = await sql<{ id: string; properties: Record<string, unknown> }[]>`
      SELECT id, properties
      FROM entities
      WHERE id = ${targetId} AND type = 'user'
    `;

    if (!target) return json({ error: 'Not found' }, 404);

    const beforeProps = { ...target.properties };
    const updatedProps = { ...target.properties };

    if (body.role !== undefined) {
      updatedProps.role = body.role;
    }

    if (body.active !== undefined) {
      updatedProps.active = body.active;
    }

    await sql`
      UPDATE entities
      SET properties = ${sql.json(updatedProps as never)},
          updated_at = NOW()
      WHERE id = ${targetId}
    `;

    // Audit log — role changes
    if (body.role !== undefined && body.role !== beforeProps.role) {
      await emitAuditEvent({
        actor_id: user.id,
        action: 'user.role_change',
        entity_type: 'user',
        entity_id: targetId,
        before: { role: beforeProps.role ?? null },
        after: { role: body.role },
        ts: new Date().toISOString(),
      }).catch((err) => console.warn('[audit] user.role_change audit write failed:', err));
    }

    // Audit log — activation / deactivation
    if (body.active !== undefined && body.active !== beforeProps.active) {
      await emitAuditEvent({
        actor_id: user.id,
        action: body.active ? 'user.reactivate' : 'user.deactivate',
        entity_type: 'user',
        entity_id: targetId,
        before: { active: beforeProps.active ?? null },
        after: { active: body.active },
        ts: new Date().toISOString(),
      }).catch((err) => console.warn('[audit] user.active_change audit write failed:', err));
    }

    // Return updated user without password hash
    const { password_hash: _pwHash2, ...safeProps } = updatedProps as Record<string, unknown> & {
      password_hash?: string;
    };
    void _pwHash2;
    return json({ id: targetId, properties: safeProps });
  }

  // -----------------------------------------------------------------------
  // Tenant rate policy endpoints (issue #89)
  // -----------------------------------------------------------------------

  // GET /api/admin/tenants/:id/rate-policy — retrieve the effective rate policy
  if (req.method === 'GET' && url.pathname.match(/^\/api\/admin\/tenants\/[^/]+\/rate-policy$/)) {
    const tenantId = url.pathname.split('/')[4];
    if (!tenantId) return json({ error: 'Missing tenant id' }, 400);
    const policy = getTenantRatePolicy(tenantId);
    return json({ tenantId, policy });
  }

  // PUT /api/admin/tenants/:id/rate-policy — set a per-tenant rate policy override
  //
  // Body (all fields optional):
  //   { authMaxAttempts, authWindowMs, embeddingMaxReads, embeddingWindowMs }
  //
  // Send `null` as the body to clear the override and revert to safe defaults.
  // Changes take effect immediately without restart.
  if (req.method === 'PUT' && url.pathname.match(/^\/api\/admin\/tenants\/[^/]+\/rate-policy$/)) {
    const tenantId = url.pathname.split('/')[4];
    if (!tenantId) return json({ error: 'Missing tenant id' }, 400);

    let body: TenantRatePolicy | null;
    try {
      const raw = await req.json();
      body = raw === null ? null : (raw as TenantRatePolicy);
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    // Validate numeric fields when provided
    if (body !== null) {
      const numFields = [
        'authMaxAttempts',
        'authWindowMs',
        'embeddingMaxReads',
        'embeddingWindowMs',
      ] as const;
      for (const field of numFields) {
        if (body[field] !== undefined) {
          const v = body[field];
          if (typeof v !== 'number' || v <= 0 || !Number.isFinite(v)) {
            return json({ error: `${field} must be a positive finite number` }, 400);
          }
        }
      }
    }

    setTenantRatePolicy(tenantId, body);

    const effectivePolicy = getTenantRatePolicy(tenantId);

    await emitAuditEvent({
      actor_id: user.id,
      action: 'tenant.rate_policy.update',
      entity_type: 'tenant',
      entity_id: tenantId,
      before: null,
      after: { tenantId, policy: effectivePolicy },
      ts: new Date().toISOString(),
    }).catch((err) => console.warn('[audit] tenant.rate_policy.update audit write failed:', err));

    return json({ tenantId, policy: effectivePolicy });
  }

  // ── GET /api/admin/tenants/:id/config ──────────────────────────────────────
  // Returns the current tenant configuration snapshot (regulated flag,
  // assemblyai_legacy_enabled flag). Both default to false when not set.
  if (req.method === 'GET' && url.pathname.match(/^\/api\/admin\/tenants\/[^/]+\/config$/)) {
    const tenantId = url.pathname.split('/')[4];
    if (!tenantId) return json({ error: 'Missing tenant id' }, 400);

    const config = await getTenantConfig(tenantId, appState.sql);
    return json(config);
  }

  // ── PUT /api/admin/tenants/:id/config/regulated ────────────────────────────
  // Sets the regulated status for a tenant.
  // Body: { regulated: boolean }
  // Side-effect: setting regulated=true also disables assemblyai_legacy_enabled
  // if it was previously enabled.
  if (
    req.method === 'PUT' &&
    url.pathname.match(/^\/api\/admin\/tenants\/[^/]+\/config\/regulated$/)
  ) {
    const tenantId = url.pathname.split('/')[4];
    if (!tenantId) return json({ error: 'Missing tenant id' }, 400);

    let body: { regulated?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (typeof body.regulated !== 'boolean') {
      return json({ error: 'regulated must be a boolean' }, 400);
    }

    await setTenantRegulated(tenantId, body.regulated, appState.sql);

    await emitAuditEvent({
      actor_id: user.id,
      action: 'tenant.config.regulated.update',
      entity_type: 'tenant',
      entity_id: tenantId,
      before: null,
      after: { tenantId, regulated: body.regulated },
      ts: new Date().toISOString(),
    }).catch((err) =>
      console.warn('[audit] tenant.config.regulated.update audit write failed:', err),
    );

    const config = await getTenantConfig(tenantId, appState.sql);
    return json(config);
  }

  // ── PUT /api/admin/tenants/:id/config/assemblyai-legacy ───────────────────
  // Enables or disables the AssemblyAI legacy transcription path for a tenant.
  // Body: { enabled: boolean }
  // Returns 422 if the tenant is regulated — regulated tenants cannot enable
  // this path (blocked structurally at the config layer, not by policy).
  if (
    req.method === 'PUT' &&
    url.pathname.match(/^\/api\/admin\/tenants\/[^/]+\/config\/assemblyai-legacy$/)
  ) {
    const tenantId = url.pathname.split('/')[4];
    if (!tenantId) return json({ error: 'Missing tenant id' }, 400);

    let body: { enabled?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (typeof body.enabled !== 'boolean') {
      return json({ error: 'enabled must be a boolean' }, 400);
    }

    try {
      await setAssemblyAiLegacyEnabled(tenantId, body.enabled, appState.sql);
    } catch (err) {
      if (err instanceof RegulatedTenantError) {
        return json({ error: err.message }, 422);
      }
      throw err;
    }

    await emitAuditEvent({
      actor_id: user.id,
      action: 'tenant.config.assemblyai_legacy.update',
      entity_type: 'tenant',
      entity_id: tenantId,
      before: null,
      after: { tenantId, assemblyai_legacy_enabled: body.enabled },
      ts: new Date().toISOString(),
    }).catch((err) =>
      console.warn('[audit] tenant.config.assemblyai_legacy.update audit write failed:', err),
    );

    const config = await getTenantConfig(tenantId, appState.sql);
    return json(config);
  }

  return null;
}
