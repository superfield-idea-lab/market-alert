/**
 * @file retention-engine
 *
 * Phase 8 retention policy engine — scout stub.
 *
 * ## Purpose
 *
 * This module is the planned public API surface for the Phase 8 retention
 * policy engine.  The scout establishes:
 *
 *   1. Named retention policy lookup via the `retention_policies` catalogue.
 *   2. Tenant assignment of a named policy via `tenant_retention_policies`.
 *   3. Controlled deletion path: the retention scheduler bypasses the
 *      database-layer block by verifying the floor has elapsed before calling
 *      the privileged deletion helper.
 *
 * ## What this scout proves
 *
 * The `guard_retention_floor` trigger (schema.sql) rejects any DELETE on an
 * entity whose `retention_class` maps to a policy whose floor has not elapsed.
 * This module provides the type-safe application-layer wrappers for:
 *
 *   - looking up a named policy and checking whether a given entity is within
 *     its retention window (`isWithinRetentionFloor`), and
 *   - executing a scheduler-controlled deletion that first verifies the floor
 *     before issuing the DELETE (`deleteEntityPastRetention`).
 *
 * ## Integration risks discovered during scout
 *
 *   - The retention scheduler (future issue) must run as a role that either
 *     (a) is exempted from the trigger via a session-variable guard, or
 *     (b) always calls `deleteEntityPastRetention` so the floor check is
 *     duplicated at the application layer before the DELETE reaches the trigger.
 *     Option (b) is safer and what this scout implements.
 *   - Legal hold (future issue) must extend `isWithinRetentionFloor` to also
 *     return `true` (blocked) when `legal_hold = true` regardless of the floor.
 *   - WORM mode (future issue) requires additional DDL — this module has no
 *     overlap with the WORM surface.
 *   - The `retention_class` FK is currently a soft reference (plain TEXT). A
 *     follow-on should add a FK constraint to `retention_policies.name` once all
 *     existing tenants have been migrated to named policies.
 *
 * ## Downstream issues to update
 *
 *   After this scout merges, the following same-phase issues should be aware of
 *   the `guard_retention_floor` trigger and the `retention_policies` table:
 *
 *   - Phase 8: retention scheduler (hard-deletes entities past retention)
 *   - Phase 8: legal hold entity + four-eyes removal
 *   - Phase 8: WORM mode (must not conflict with the floor trigger)
 *
 * Canonical docs:
 *   - docs/PRD.md §7a (retention policy requirement)
 *   - docs/implementation-plan-v1.md Phase 8
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/78
 */

import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// Internal type alias
// ---------------------------------------------------------------------------

type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/**
 * A named retention policy from the `retention_policies` catalogue.
 *
 * `retentionFloorDays` is the minimum number of days an entity must be
 * retained before it may be deleted. The database-layer trigger
 * `trg_entities_retention_floor` enforces this independently of any
 * application check.
 */
export interface RetentionPolicy {
  /** Unique name — the value stored in `entities.retention_class`. */
  name: string;
  /** Human-readable description (e.g. "MiFID II Art. 16(6) — 5-year minimum"). */
  description: string;
  /** Minimum retention floor in whole days. */
  retentionFloorDays: number;
}

/**
 * Thrown when `lookupRetentionPolicy` cannot find a row for the given name.
 */
export class UnknownRetentionPolicyError extends Error {
  constructor(name: string) {
    super(
      `No retention policy named '${name}' found in the retention_policies catalogue. ` +
        'Seed the policy row before assigning it to a tenant.',
    );
    this.name = 'UnknownRetentionPolicyError';
  }
}

/**
 * Thrown when `deleteEntityPastRetention` is called for an entity that is
 * still within its retention floor.
 */
export class RetentionFloorNotReachedError extends Error {
  constructor(entityId: string, retentionClass: string, eligibleAt: Date) {
    super(
      `Entity '${entityId}' (class=${retentionClass}) cannot be deleted: ` +
        `retention floor not reached until ${eligibleAt.toISOString().slice(0, 10)}.`,
    );
    this.name = 'RetentionFloorNotReachedError';
  }
}

// ---------------------------------------------------------------------------
// Policy catalogue lookup
// ---------------------------------------------------------------------------

/**
 * Fetches a named retention policy from the `retention_policies` catalogue.
 *
 * @throws {UnknownRetentionPolicyError} when no row exists for `name`.
 */
export async function lookupRetentionPolicy(
  sql: SqlClient,
  name: string,
): Promise<RetentionPolicy> {
  const rows = await sql<{ name: string; description: string; retention_floor_days: number }[]>`
    SELECT name, description, retention_floor_days
    FROM retention_policies
    WHERE name = ${name}
  `;

  if (rows.length === 0) {
    throw new UnknownRetentionPolicyError(name);
  }

  const row = rows[0];
  return {
    name: row.name,
    description: row.description,
    retentionFloorDays: row.retention_floor_days,
  };
}

// ---------------------------------------------------------------------------
// Tenant policy assignment
// ---------------------------------------------------------------------------

/**
 * Assigns a named retention policy to a tenant, updating
 * `tenant_retention_policies.retention_class` to point at the named policy.
 *
 * This is an upsert — calling it twice with the same arguments is idempotent.
 *
 * @throws {UnknownRetentionPolicyError} when `policyName` is not in the catalogue.
 */
export async function assignRetentionPolicyToTenant(
  sql: SqlClient,
  tenantId: string,
  policyName: string,
): Promise<void> {
  // Validate the named policy exists before writing.
  await lookupRetentionPolicy(sql, policyName);

  await sql`
    INSERT INTO tenant_retention_policies (tenant_id, retention_class, legal_hold_default)
    VALUES (${tenantId}, ${policyName}, false)
    ON CONFLICT (tenant_id) DO UPDATE
      SET retention_class = EXCLUDED.retention_class,
          updated_at      = CURRENT_TIMESTAMP
  `;
}

// ---------------------------------------------------------------------------
// Floor check helper
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the given entity is still within its retention floor
 * (i.e. deletion is blocked by the database-layer trigger).
 *
 * Returns `false` when the entity has no retention_class, when the class does
 * not map to a known policy, or when the floor has elapsed.
 *
 * This is the application-layer counterpart to the `guard_retention_floor`
 * trigger. Callers SHOULD call this before attempting a deletion so they can
 * surface a meaningful error to the user rather than catching a DB exception.
 */
export async function isWithinRetentionFloor(
  sql: SqlClient,
  entityId: string,
): Promise<{ blocked: boolean; eligibleAt: Date | null }> {
  const rows = await sql<{ retention_class: string | null; created_at: Date }[]>`
    SELECT retention_class, created_at
    FROM entities
    WHERE id = ${entityId}
  `;

  if (rows.length === 0) {
    return { blocked: false, eligibleAt: null };
  }

  const { retention_class, created_at } = rows[0];

  if (!retention_class) {
    return { blocked: false, eligibleAt: null };
  }

  const policyRows = await sql<{ retention_floor_days: number }[]>`
    SELECT retention_floor_days
    FROM retention_policies
    WHERE name = ${retention_class}
  `;

  if (policyRows.length === 0) {
    return { blocked: false, eligibleAt: null };
  }

  const floorDays = policyRows[0].retention_floor_days;
  const eligibleAt = new Date(created_at.getTime() + floorDays * 24 * 60 * 60 * 1000);
  const now = new Date();
  const blocked = now < eligibleAt;

  return { blocked, eligibleAt };
}

// ---------------------------------------------------------------------------
// Controlled deletion path (retention scheduler)
// ---------------------------------------------------------------------------

/**
 * Deletes an entity after verifying that its retention floor has elapsed.
 *
 * This is the **only** deletion path the retention scheduler should use.
 * It performs an application-layer floor check before issuing the DELETE,
 * ensuring a clear error surface if the scheduler has a clock skew or a bug.
 * The database-layer trigger `trg_entities_retention_floor` provides a
 * second defence even if this check is bypassed.
 *
 * @throws {RetentionFloorNotReachedError} when the floor has not elapsed.
 */
export async function deleteEntityPastRetention(sql: SqlClient, entityId: string): Promise<void> {
  const rows = await sql<{ retention_class: string | null; created_at: Date }[]>`
    SELECT retention_class, created_at
    FROM entities
    WHERE id = ${entityId}
  `;

  if (rows.length === 0) {
    // Entity doesn't exist — treat as already deleted.
    return;
  }

  const { blocked, eligibleAt } = await isWithinRetentionFloor(sql, entityId);

  if (blocked && eligibleAt !== null) {
    throw new RetentionFloorNotReachedError(entityId, rows[0].retention_class ?? '', eligibleAt);
  }

  await sql`DELETE FROM entities WHERE id = ${entityId}`;
}
