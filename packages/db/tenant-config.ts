/**
 * @file tenant-config.ts
 *
 * Tenant configuration layer for the AssemblyAI legacy transcription gate.
 *
 * Blueprint ref: issue #60 — tenant configuration gate for AssemblyAI legacy
 * transcription path. US-hosted third-party; regulated tenants must be blocked
 * structurally at the config layer, not by policy alone.
 *
 * Keys stored in tenant_policies:
 *   - `regulated`                — value 'true' marks a tenant as regulated
 *                                  (MiFID II, FCA SYSC, FINRA, GDPR, FINMA, MAS).
 *                                  Regulated tenants cannot enable the AssemblyAI
 *                                  legacy path.
 *   - `assemblyai_legacy_enabled` — value 'true' enables the AssemblyAI path for
 *                                   a specific tenant. Defaults off. Cannot be set
 *                                   on regulated tenants.
 *
 * The `regulated` flag is a superuser-only write. The `assemblyai_legacy_enabled`
 * flag is a superuser-only write that is rejected at the config layer if the
 * tenant is regulated.
 */

import { sql as defaultSql } from './index';
import type postgres from 'postgres';
import { getTenantPolicy, upsertTenantPolicy } from './tenant-policies';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const POLICY_REGULATED = 'regulated';
export const POLICY_ASSEMBLYAI_LEGACY_ENABLED = 'assemblyai_legacy_enabled';

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the tenant has `regulated = 'true'` in their policy row.
 * Defaults to `false` (unregulated) when no row exists.
 */
export async function isTenantRegulated(
  tenantId: string,
  db: postgres.Sql = defaultSql,
): Promise<boolean> {
  const value = await getTenantPolicy(POLICY_REGULATED, tenantId, db);
  return value === 'true';
}

/**
 * Returns `true` when the tenant has `assemblyai_legacy_enabled = 'true'` in
 * their policy row. Defaults to `false` (disabled) when no row exists.
 *
 * This is the routing-layer check: the transcription worker calls this to
 * decide whether to allow the AssemblyAI path. It does NOT re-validate the
 * regulated constraint — that is enforced at write time.
 */
export async function isAssemblyAiLegacyEnabled(
  tenantId: string,
  db: postgres.Sql = defaultSql,
): Promise<boolean> {
  const value = await getTenantPolicy(POLICY_ASSEMBLYAI_LEGACY_ENABLED, tenantId, db);
  return value === 'true';
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

/**
 * Marks a tenant as regulated or unregulated.
 *
 * Setting `regulated = true` will also disable AssemblyAI legacy if it was
 * previously enabled, since regulated tenants may not use the path.
 *
 * @param tenantId  The tenant to configure.
 * @param regulated Whether the tenant is regulated.
 * @param db        Optional postgres client.
 */
export async function setTenantRegulated(
  tenantId: string,
  regulated: boolean,
  db: postgres.Sql = defaultSql,
): Promise<void> {
  await upsertTenantPolicy(
    { key: POLICY_REGULATED, value: regulated ? 'true' : 'false', tenantId },
    db,
  );

  // If the tenant is now regulated and AssemblyAI was enabled, disable it.
  if (regulated) {
    const assemblyAiEnabled = await isAssemblyAiLegacyEnabled(tenantId, db);
    if (assemblyAiEnabled) {
      await upsertTenantPolicy(
        { key: POLICY_ASSEMBLYAI_LEGACY_ENABLED, value: 'false', tenantId },
        db,
      );
    }
  }
}

/**
 * Error thrown when a regulated tenant attempts to enable the AssemblyAI
 * legacy transcription path.
 */
export class RegulatedTenantError extends Error {
  constructor(tenantId: string) {
    super(
      `Tenant ${tenantId} is regulated and cannot enable the AssemblyAI legacy transcription path.`,
    );
    this.name = 'RegulatedTenantError';
  }
}

/**
 * Sets the `assemblyai_legacy_enabled` flag for a tenant.
 *
 * Throws `RegulatedTenantError` if the tenant is marked as regulated — this is
 * the structural config-layer block required by the PRD and issue #60.
 *
 * @param tenantId  The tenant to configure.
 * @param enabled   Whether to enable the AssemblyAI legacy path.
 * @param db        Optional postgres client.
 * @throws {RegulatedTenantError} If the tenant is regulated and `enabled` is true.
 */
export async function setAssemblyAiLegacyEnabled(
  tenantId: string,
  enabled: boolean,
  db: postgres.Sql = defaultSql,
): Promise<void> {
  if (enabled) {
    const regulated = await isTenantRegulated(tenantId, db);
    if (regulated) {
      throw new RegulatedTenantError(tenantId);
    }
  }

  await upsertTenantPolicy(
    { key: POLICY_ASSEMBLYAI_LEGACY_ENABLED, value: enabled ? 'true' : 'false', tenantId },
    db,
  );
}

// ---------------------------------------------------------------------------
// Composite read: full tenant config snapshot
// ---------------------------------------------------------------------------

export interface TenantConfig {
  tenantId: string;
  regulated: boolean;
  assemblyai_legacy_enabled: boolean;
}

/**
 * Returns a snapshot of the tenant's configuration for the keys managed by
 * this module. All values default off when no policy row exists.
 */
export async function getTenantConfig(
  tenantId: string,
  db: postgres.Sql = defaultSql,
): Promise<TenantConfig> {
  const [regulated, assemblyAiEnabled] = await Promise.all([
    isTenantRegulated(tenantId, db),
    isAssemblyAiLegacyEnabled(tenantId, db),
  ]);
  return { tenantId, regulated, assemblyai_legacy_enabled: assemblyAiEnabled };
}
