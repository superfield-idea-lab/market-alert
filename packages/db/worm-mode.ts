/**
 * @file worm-mode.ts
 *
 * WORM (Write-Once-Read-Many) mode configuration for ground-truth tables.
 *
 * ## Purpose
 *
 * WORM mode is required for the highest-assurance tenants under MiFID II
 * Art. 16(6) and SEC 17a-4(f). When enabled for a tenant, the database-layer
 * trigger `trg_entities_worm_update` rejects any UPDATE on ground-truth
 * entities belonging to that tenant until the entity's retention floor has
 * elapsed.
 *
 * DELETE is independently blocked by `trg_entities_retention_floor` while
 * the entity is within its retention window. Together these two triggers
 * make ingested entities truly write-once for the duration of their
 * retention period.
 *
 * ## M-of-N approval requirement
 *
 * WORM mode can only be enabled through the M-of-N approval path (issue #24).
 * The `enableWorm` function requires a pre-approved approval request of type
 * `enable_worm`. Any attempt to enable WORM without an approved request is
 * rejected with `WormApprovalRequiredError`.
 *
 * ## Configuration storage
 *
 * The WORM flag is stored in `tenant_policies` using key `'worm_mode'`.
 * Value `'true'` enables WORM; the absence of a row (or any other value)
 * means WORM is disabled. The flag is written only by `enableWorm()`.
 *
 * ## Role restriction
 *
 * `enableWorm` requires:
 *   - `actorRole` to be `'compliance_officer'`, OR
 *   - `isSuperuser` to be `true`
 *
 * Any other role throws `InsufficientRoleError`.
 *
 * Canonical docs: docs/PRD.md §7a, docs/implementation-plan-v1.md Phase 8
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/81
 */

import type postgres from 'postgres';
import { getTenantPolicy, upsertTenantPolicy } from './tenant-policies';
import { assertApproved } from './approvals';

// ---------------------------------------------------------------------------
// Internal type alias
// ---------------------------------------------------------------------------

type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const POLICY_WORM_MODE = 'worm_mode';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when an attempt is made to enable WORM mode without a pre-approved
 * M-of-N approval request.
 */
export class WormApprovalRequiredError extends Error {
  constructor(tenantId: string) {
    super(
      `WORM mode cannot be enabled for tenant '${tenantId}' without a pre-approved ` +
        "M-of-N approval request of type 'enable_worm'. " +
        'Create and collect the required approvals before calling enableWorm().',
    );
    this.name = 'WormApprovalRequiredError';
  }
}

/**
 * Thrown when a caller without the `compliance_officer` role (or superuser)
 * attempts to enable WORM mode.
 */
export class InsufficientRoleError extends Error {
  constructor(actorId: string, actorRole: string | null) {
    super(
      `Actor '${actorId}' (role: ${actorRole ?? 'none'}) does not have permission to enable ` +
        "WORM mode. Required role: 'compliance_officer'.",
    );
    this.name = 'InsufficientRoleError';
  }
}

/**
 * Thrown when an UPDATE is attempted on a WORM-protected entity before the
 * retention floor has elapsed. This is the application-layer equivalent of
 * the database trigger error; callers can catch this before the DB raises.
 */
export class WormUpdateBlockedError extends Error {
  constructor(entityId: string, tenantId: string, eligibleAt: Date) {
    super(
      `WORM: entity '${entityId}' (tenant='${tenantId}') is immutable until ` +
        `${eligibleAt.toISOString()} (retention floor not reached).`,
    );
    this.name = 'WormUpdateBlockedError';
  }
}

// ---------------------------------------------------------------------------
// Audit writer callback type (mirrors approvals.ts / retention-engine.ts)
// ---------------------------------------------------------------------------

export type WormAuditWriterFn = (event: {
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ts: string;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` when WORM mode is enabled for the given tenant.
 * Defaults to `false` when no row exists in tenant_policies.
 *
 * @param tenantId  The tenant to check.
 * @param db        Optional postgres client.
 */
export async function isWormEnabled(tenantId: string, db: SqlClient): Promise<boolean> {
  const value = await getTenantPolicy(POLICY_WORM_MODE, tenantId, db);
  return value === 'true';
}

// ---------------------------------------------------------------------------
// enableWorm — the only write path for the WORM flag
// ---------------------------------------------------------------------------

export interface EnableWormInput {
  /** The tenant for which WORM mode should be enabled. */
  tenantId: string;
  /**
   * The ID of a pre-approved M-of-N approval request of type `enable_worm`.
   * `assertApproved` is called against this ID; if the request is not in
   * 'approved' status the function throws before writing anything.
   */
  approvalRequestId: string;
  /** ID of the actor performing the operation (recorded in the audit trail). */
  actorId: string;
  /**
   * The role of the actor. Must be `'compliance_officer'` unless `isSuperuser`
   * is `true`.
   */
  actorRole: string | null;
  /** When `true`, skips the role check. For use by system integrations only. */
  isSuperuser?: boolean;
  /** Optional audit event writer. Called after the flag is written. */
  auditWriter?: WormAuditWriterFn;
}

/**
 * Enables WORM mode for a tenant after verifying:
 *   1. The actor has the `compliance_officer` role (or is a superuser).
 *   2. The supplied approval request is in 'approved' status.
 *
 * Writing the flag is idempotent — calling enableWorm on an already-WORM
 * tenant is a no-op (the upsert is still applied but the value does not
 * change). The audit event is still emitted on every call so the audit trail
 * reflects every enforcement action.
 *
 * @throws {InsufficientRoleError}    If the actor lacks the required role.
 * @throws {WormApprovalRequiredError} If the approval request is not approved.
 */
export async function enableWorm(db: SqlClient, input: EnableWormInput): Promise<void> {
  const { tenantId, approvalRequestId, actorId, actorRole, isSuperuser = false } = input;

  // Role check first — fail fast before any DB reads.
  if (!isSuperuser && actorRole !== 'compliance_officer') {
    throw new InsufficientRoleError(actorId, actorRole);
  }

  // Verify the approval request is in 'approved' status.
  // assertApproved throws if the request is missing, not approved, or already executed.
  let approvalRequest;
  try {
    approvalRequest = await assertApproved(db, approvalRequestId);
  } catch (err) {
    if (err instanceof Error) {
      throw new WormApprovalRequiredError(tenantId);
    }
    throw err;
  }

  // Validate the approval request is for the correct operation type.
  if (approvalRequest.operation_type !== 'enable_worm') {
    throw new WormApprovalRequiredError(tenantId);
  }

  const before = { worm_mode: await isWormEnabled(tenantId, db) };

  // Write the WORM flag.
  await upsertTenantPolicy({ key: POLICY_WORM_MODE, value: 'true', tenantId }, db);

  // Emit audit event if a writer is provided.
  if (input.auditWriter) {
    await input
      .auditWriter({
        actor_id: actorId,
        action: 'worm_mode.enable',
        entity_type: 'tenant',
        entity_id: tenantId,
        before,
        after: { worm_mode: true, approval_request_id: approvalRequestId },
        ts: new Date().toISOString(),
      })
      .catch((err) => console.warn('[worm-mode] audit write failed for worm_mode.enable:', err));
  }
}

// ---------------------------------------------------------------------------
// Application-layer update guard
// ---------------------------------------------------------------------------

/**
 * Checks whether an UPDATE on a specific entity would be blocked by WORM mode.
 *
 * Callers can invoke this before issuing an UPDATE to surface a
 * `WormUpdateBlockedError` at the application layer rather than receiving a
 * raw database trigger exception.
 *
 * Returns `{ blocked: false }` when:
 *   - The entity has no tenant_id or no retention_class.
 *   - WORM is not enabled for the tenant.
 *   - The retention floor has elapsed.
 *
 * @param db        Postgres client.
 * @param entityId  The entity to check.
 */
export async function checkWormUpdateGuard(
  db: SqlClient,
  entityId: string,
): Promise<{ blocked: boolean; eligibleAt: Date | null }> {
  const rows = await db<
    {
      id: string;
      tenant_id: string | null;
      retention_class: string | null;
      created_at: Date;
    }[]
  >`
    SELECT id, tenant_id, retention_class, created_at
    FROM entities
    WHERE id = ${entityId}
  `;

  if (rows.length === 0) {
    return { blocked: false, eligibleAt: null };
  }

  const entity = rows[0];

  if (!entity.tenant_id || !entity.retention_class) {
    return { blocked: false, eligibleAt: null };
  }

  // Check WORM flag.
  const worm = await isWormEnabled(entity.tenant_id, db);
  if (!worm) {
    return { blocked: false, eligibleAt: null };
  }

  // Resolve retention floor.
  const policyRows = await db<{ retention_floor_days: number }[]>`
    SELECT retention_floor_days
    FROM retention_policies
    WHERE name = ${entity.retention_class}
  `;

  if (policyRows.length === 0) {
    return { blocked: false, eligibleAt: null };
  }

  const floorDays = policyRows[0].retention_floor_days;
  const eligibleAt = new Date(
    new Date(entity.created_at).getTime() + floorDays * 24 * 60 * 60 * 1000,
  );

  if (Date.now() < eligibleAt.getTime()) {
    return { blocked: true, eligibleAt };
  }

  return { blocked: false, eligibleAt };
}
