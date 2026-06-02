/**
 * Admin API — superuser-only endpoints.
 *
 * POST   /api/admin/keys        — generates a new API key, returns raw key once
 * GET    /api/admin/keys        — lists API key metadata (no raw values)
 * DELETE /api/admin/keys/:id    — revokes an API key
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
import { emitAuditEvent } from '../policies/audit-service';
import { isSuperuser, makeJson } from '../lib/response';
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

  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);
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
