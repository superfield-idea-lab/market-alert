/**
 * @file tenant-policies.ts
 *
 * Read and write tenant-overridable policy rows from the `tenant_policies`
 * table.
 *
 * Resolution order:
 *   1. Tenant-specific row (tenant_id = given value, key = given key)
 *   2. Global default row (tenant_id IS NULL, key = given key)
 *   3. Hard-coded fallback supplied by the caller
 *
 * Blueprint ref: PRUNE-A-003 (frequency is tenant-overridable via policy row,
 * not a hard-coded constant).
 */

import { sql as defaultSql } from './index';
import type postgres from 'postgres';

export interface TenantPolicyRow {
  id: string;
  tenant_id: string | null;
  key: string;
  value: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Looks up the effective policy value for a given key and optional tenant.
 *
 * Returns the tenant-specific override if one exists; otherwise falls back to
 * the global default (tenant_id IS NULL). Returns `null` when no row is found
 * (the caller decides the application-level default).
 *
 * @param key       Policy name (e.g. `'autolearn_cron_interval'`).
 * @param tenantId  Optional tenant identifier. When supplied, a tenant-specific
 *                  row takes precedence over the global default.
 * @param db        Optional postgres client. Defaults to the shared app pool.
 */
export async function getTenantPolicy(
  key: string,
  tenantId?: string | null,
  db: postgres.Sql = defaultSql,
): Promise<string | null> {
  if (tenantId) {
    // Try tenant-specific row first.
    const [tenantRow] = await db<TenantPolicyRow[]>`
      SELECT * FROM tenant_policies
      WHERE key = ${key} AND tenant_id = ${tenantId}
      LIMIT 1
    `;
    if (tenantRow) return tenantRow.value;
  }

  // Fall back to global default.
  const [globalRow] = await db<TenantPolicyRow[]>`
    SELECT * FROM tenant_policies
    WHERE key = ${key} AND tenant_id IS NULL
    LIMIT 1
  `;
  return globalRow?.value ?? null;
}

export interface UpsertTenantPolicyOptions {
  key: string;
  value: string;
  /** NULL means global default. */
  tenantId?: string | null;
}

/**
 * Inserts or updates a policy row.
 *
 * Uses ON CONFLICT … DO UPDATE so the call is idempotent and safe to
 * re-apply on re-deploy.
 *
 * @param options  Policy key/value/tenant triple.
 * @param db       Optional postgres client. Defaults to the shared app pool.
 */
export async function upsertTenantPolicy(
  options: UpsertTenantPolicyOptions,
  db: postgres.Sql = defaultSql,
): Promise<TenantPolicyRow> {
  const { key, value, tenantId = null } = options;

  const [row] = await db<TenantPolicyRow[]>`
    INSERT INTO tenant_policies (tenant_id, key, value)
    VALUES (${tenantId}, ${key}, ${value})
    ON CONFLICT (tenant_id, key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = NOW()
    RETURNING *
  `;
  return row;
}
