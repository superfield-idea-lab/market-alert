/**
 * @file retention-engine
 *
 * Phase 8 retention policy engine.
 *
 * ## Purpose
 *
 * This module is the public API surface for the Phase 8 retention policy
 * engine. It provides:
 *
 *   1. Named retention policy lookup and listing via the `retention_policies`
 *      catalogue.
 *   2. Per-entity-type retention floor overrides via
 *      `retention_policy_entity_overrides`.
 *   3. Tenant assignment of a named policy, restricted to the
 *      `compliance_officer` role.  Assignments are audit-logged via the
 *      injected `auditWriter` callback.
 *   4. Controlled deletion path: the retention scheduler verifies the floor
 *      has elapsed at the application layer before issuing the DELETE.
 *
 * ## Scout foundation (issue #78)
 *
 * The `guard_retention_floor` trigger (schema.sql) rejects any DELETE on an
 * entity whose `retention_class` maps to a policy whose floor has not elapsed.
 * The scout proved the trigger works; this issue builds the full policy library
 * and tenant assignment path on top.
 *
 * ## Role restriction
 *
 * `assignRetentionPolicyToTenant` requires the caller to pass `actorId` and
 * `actorRole`. If `actorRole` is not `compliance_officer` (and the caller is
 * not a superuser identified by `isSuperuser`), the function throws
 * `InsufficientRoleError` before touching the database.
 *
 * ## Audit trail
 *
 * Every successful call to `assignRetentionPolicyToTenant` records a row in
 * `tenant_retention_policy_assignments` (DB layer) and invokes the optional
 * `auditWriter` callback (server layer) to emit a hash-chained audit event.
 *
 * ## Integration risks
 *
 *   - The retention scheduler (future issue) must run as a role that either
 *     (a) is exempted from the trigger via a session-variable guard, or
 *     (b) always calls `deleteEntityPastRetention` so the floor check is
 *     duplicated at the application layer before the DELETE reaches the trigger.
 *     Option (b) is safer and what this module implements.
 *   - Legal hold (future issue) must extend `isWithinRetentionFloor` to also
 *     return `true` (blocked) when `legal_hold = true` regardless of the floor.
 *   - WORM mode (future issue) requires additional DDL — this module has no
 *     overlap with the WORM surface.
 *
 * Canonical docs:
 *   - docs/PRD.md §7a (retention policy requirement)
 *   - docs/implementation-plan-v1.md Phase 8
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/78
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/79
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

/**
 * Thrown when a caller without the `compliance_officer` role attempts to
 * assign a retention policy to a tenant.
 */
export class InsufficientRoleError extends Error {
  constructor(actorId: string, requiredRole: string, actualRole: string | null) {
    super(
      `Actor '${actorId}' (role=${actualRole ?? 'none'}) is not permitted to assign retention ` +
        `policies. Required role: ${requiredRole}.`,
    );
    this.name = 'InsufficientRoleError';
  }
}

// ---------------------------------------------------------------------------
// Audit writer callback
// ---------------------------------------------------------------------------

/**
 * Optional callback injected by the server layer to emit a hash-chained audit
 * event when a retention policy is assigned to a tenant. The db package does
 * not import the audit service directly; the server wires it in.
 */
export type RetentionAuditWriterFn = (event: {
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ts: string;
}) => Promise<void>;

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
// Policy catalogue listing
// ---------------------------------------------------------------------------

/**
 * Returns all named retention policies in the `retention_policies` catalogue,
 * ordered by name. Each entry includes its entity-type overrides (if any).
 */
export interface RetentionPolicyWithOverrides extends RetentionPolicy {
  /** Per-entity-type floor overrides. Empty when none are configured. */
  entityOverrides: RetentionPolicyEntityOverride[];
}

/**
 * A per-entity-type retention floor override within a named policy.
 */
export interface RetentionPolicyEntityOverride {
  entityType: string;
  retentionFloorDays: number;
  description: string;
}

export async function listRetentionPolicies(
  sql: SqlClient,
): Promise<RetentionPolicyWithOverrides[]> {
  const policies = await sql<{ name: string; description: string; retention_floor_days: number }[]>`
    SELECT name, description, retention_floor_days
    FROM retention_policies
    ORDER BY name
  `;

  const overrides = await sql<
    {
      policy_name: string;
      entity_type: string;
      retention_floor_days: number;
      description: string;
    }[]
  >`
    SELECT policy_name, entity_type, retention_floor_days, description
    FROM retention_policy_entity_overrides
    ORDER BY policy_name, entity_type
  `;

  const overridesByPolicy = new Map<string, RetentionPolicyEntityOverride[]>();
  for (const o of overrides) {
    if (!overridesByPolicy.has(o.policy_name)) {
      overridesByPolicy.set(o.policy_name, []);
    }
    overridesByPolicy.get(o.policy_name)!.push({
      entityType: o.entity_type,
      retentionFloorDays: o.retention_floor_days,
      description: o.description,
    });
  }

  return policies.map((p) => ({
    name: p.name,
    description: p.description,
    retentionFloorDays: p.retention_floor_days,
    entityOverrides: overridesByPolicy.get(p.name) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Per-entity-type override management
// ---------------------------------------------------------------------------

/**
 * Sets (upserts) a per-entity-type retention floor override for a named policy.
 *
 * When a row exists for (policyName, entityType), it is updated in place.
 * This allows a policy to enforce different floors for different entity types —
 * for example MiFID II may require 7 years for email but 5 years for corpus chunks.
 *
 * @throws {UnknownRetentionPolicyError} when `policyName` is not in the catalogue.
 */
export async function setEntityTypeRetentionOverride(
  sql: SqlClient,
  policyName: string,
  entityType: string,
  retentionFloorDays: number,
  description = '',
): Promise<void> {
  // Verify the policy exists.
  await lookupRetentionPolicy(sql, policyName);

  await sql`
    INSERT INTO retention_policy_entity_overrides
      (policy_name, entity_type, retention_floor_days, description)
    VALUES (${policyName}, ${entityType}, ${retentionFloorDays}, ${description})
    ON CONFLICT (policy_name, entity_type) DO UPDATE
      SET retention_floor_days = EXCLUDED.retention_floor_days,
          description          = EXCLUDED.description
  `;
}

// ---------------------------------------------------------------------------
// Tenant policy assignment
// ---------------------------------------------------------------------------

/**
 * Input for assigning a retention policy to a tenant.
 */
export interface AssignRetentionPolicyInput {
  tenantId: string;
  policyName: string;
  /** The user ID performing the assignment. Must have compliance_officer role. */
  actorId: string;
  /** The role of the actor, as stored in entities.properties.role. */
  actorRole: string | null;
  /** True when the actor is the system superuser (bypasses role check). */
  isSuperuser?: boolean;
  /** Optional callback to emit a hash-chained audit event. */
  auditWriter?: RetentionAuditWriterFn;
}

/**
 * Assigns a named retention policy to a tenant.
 *
 * - Validates that the named policy exists.
 * - Enforces that the actor has the `compliance_officer` role (or is superuser).
 * - Records the previous policy (if any) in `tenant_retention_policy_assignments`.
 * - Upserts `tenant_retention_policies` with the new `retention_class`.
 * - Invokes `auditWriter` (if provided) to emit a hash-chained audit event.
 *
 * @throws {UnknownRetentionPolicyError} when `policyName` is not in the catalogue.
 * @throws {InsufficientRoleError} when the actor lacks the required role.
 */
export async function assignRetentionPolicyToTenant(
  sql: SqlClient,
  input: AssignRetentionPolicyInput,
): Promise<void> {
  const { tenantId, policyName, actorId, actorRole, isSuperuser: superuser, auditWriter } = input;

  // Role guard — only compliance_officer or superuser may assign.
  if (!superuser && actorRole !== 'compliance_officer') {
    throw new InsufficientRoleError(actorId, 'compliance_officer', actorRole);
  }

  // Validate the named policy exists before writing.
  await lookupRetentionPolicy(sql, policyName);

  // Capture the previous policy so the audit log records the full before state.
  const existingRows = await sql<{ retention_class: string }[]>`
    SELECT retention_class
    FROM tenant_retention_policies
    WHERE tenant_id = ${tenantId}
  `;
  const previousPolicy = existingRows[0]?.retention_class ?? null;

  const ts = new Date().toISOString();

  // Invoke audit writer BEFORE the DB write (write-before-mutate invariant).
  if (auditWriter) {
    await auditWriter({
      actor_id: actorId,
      action: 'retention_policy.assign',
      entity_type: 'tenant',
      entity_id: tenantId,
      before: previousPolicy !== null ? { policyName: previousPolicy } : null,
      after: { policyName },
      ts,
    });
  }

  // Upsert the tenant policy assignment.
  await sql`
    INSERT INTO tenant_retention_policies (tenant_id, retention_class, legal_hold_default)
    VALUES (${tenantId}, ${policyName}, false)
    ON CONFLICT (tenant_id) DO UPDATE
      SET retention_class = EXCLUDED.retention_class,
          updated_at      = CURRENT_TIMESTAMP
  `;

  // Record the assignment in the audit table at the DB layer.
  await sql`
    INSERT INTO tenant_retention_policy_assignments
      (tenant_id, policy_name, actor_id, previous_policy, assigned_at)
    VALUES (${tenantId}, ${policyName}, ${actorId}, ${previousPolicy}, ${ts}::TIMESTAMPTZ)
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
