/**
 * @file soc2-evidence
 *
 * SOC 2 Type II evidence package assembly for Phase 8 — Records management &
 * compliance.
 *
 * A Compliance Officer (or superuser) can retrieve a structured evidence
 * package suitable for submission to a SOC 2 auditor. The package includes:
 *
 *   1. Access review records — admin-role users reviewed quarterly.
 *   2. Change log export — deployment audit events from the audit store.
 *   3. Backup verification proof — latest restore test result attached from
 *      Phase 2 backup.test.ts drill.
 *   4. Incident response runbook sign-off — reference to the tested Phase 1
 *      auth-incident-response runbook.
 *   5. Service availability record — uptime summary for the attestation period.
 *
 * ## SOC 2 Trust Service Criteria mapping
 *
 *   CC6.1  — Logical access controls (access review records)
 *   CC7.3  — Incident detection and response (incident runbook sign-off)
 *   A1.2   — Environmental protections, availability (uptime record)
 *   CC9.1  — Risk mitigation (backup verification proof)
 *   CC2.3  — Change management (change log export)
 *
 * Blueprint reference: docs/implementation-plan-v1.md Phase 8
 * Related issues: #92 (this), #91 (backup/restore), #84 (e-discovery)
 */

import type { Sql } from 'postgres';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single access review record for an admin-role user.
 *
 * Access reviews are generated quarterly by enumerating every user whose
 * `properties.role` is one of the privileged roles, then verifying their
 * last-active timestamp and whether their access is still appropriate.
 */
export interface AccessReviewRecord {
  /** User entity ID. */
  userId: string;
  /** Assigned role. */
  role: string;
  /** ISO-8601 timestamp of last recorded activity in the audit log. */
  lastActiveAt: string | null;
  /** ISO-8601 timestamp when this review record was generated. */
  reviewedAt: string;
  /** Whether the reviewer determined the access is still appropriate. */
  accessAppropriate: boolean | null;
  /** Free-text notes from the reviewer, if any. */
  notes: string | null;
}

/**
 * A deployment change-log entry sourced from the audit event store.
 *
 * Change log entries correspond to `action` values that indicate a
 * deployment, configuration change, or schema migration event.
 */
export interface ChangeLogEntry {
  /** Audit event ID. */
  id: string;
  /** ISO-8601 timestamp of the event. */
  ts: string;
  /** Audit actor — the user or system that made the change. */
  actorId: string;
  /** Structured action name (e.g. `deployment.apply`, `schema.migrate`). */
  action: string;
  /** Target entity type affected. */
  entityType: string;
  /** Target entity ID. */
  entityId: string;
  /** State before the change. */
  before: Record<string, unknown> | null;
  /** State after the change. */
  after: Record<string, unknown> | null;
}

/**
 * Backup verification proof — the result of a tested restore drill.
 *
 * This record is written by the backup restore-drill script
 * (`scripts/restore-postgres.sh`) and stored in the audit log as
 * `action: backup.restore_drill`. The evidence package includes the most
 * recent successful drill result.
 */
export interface BackupVerificationProof {
  /** Audit event ID of the restore drill audit entry. */
  auditEventId: string | null;
  /** ISO-8601 timestamp when the restore drill was last executed. */
  drilledAt: string | null;
  /** Whether the last restore drill succeeded. */
  drillPassed: boolean;
  /** Backup ID that was restored. */
  backupId: string | null;
  /** Row count in the restored database (proof that data was recovered). */
  restoredRowCount: number | null;
}

/**
 * Incident response runbook sign-off record.
 *
 * References the Phase 1 auth-incident-response runbook
 * (`docs/runbooks/auth-incident-response.md`) and the date it was last
 * tested and signed off.
 */
export interface RunbookSignOff {
  /** Path to the runbook document within the repository. */
  runbookPath: string;
  /** ISO-8601 date the runbook was last tested. */
  lastTestedAt: string;
  /** Environment in which the test was executed (e.g. `staging`). */
  testedIn: string;
  /** Name of the engineer who signed off the test. */
  signedOffBy: string;
  /** Whether all four scenarios were tested. */
  allScenariosVerified: boolean;
}

/**
 * Service availability record for the SOC 2 attestation period.
 *
 * Derived from the `/api/health` audit log and any recorded downtime events.
 */
export interface AvailabilityRecord {
  /** Start of the attestation period (ISO-8601). */
  periodStart: string;
  /** End of the attestation period (ISO-8601). */
  periodEnd: string;
  /** Number of recorded downtime events in the period. */
  downtimeEventCount: number;
  /** Estimated uptime percentage for the period (0–100). */
  estimatedUptimePct: number;
  /** Note explaining how the uptime figure was derived. */
  derivationNote: string;
}

/**
 * The complete SOC 2 Type II evidence package.
 *
 * This is the top-level artifact submitted to the auditor.
 */
export interface Soc2EvidencePackage {
  /** ISO-8601 timestamp when the package was assembled. */
  generatedAt: string;
  /** Start of the SOC 2 attestation period. */
  attestationPeriodStart: string;
  /** End of the SOC 2 attestation period. */
  attestationPeriodEnd: string;
  /** CC6.1 — Logical access controls. */
  accessReviews: AccessReviewRecord[];
  /** CC2.3 — Change management. */
  changeLog: ChangeLogEntry[];
  /** CC9.1 — Risk mitigation / backup. */
  backupVerification: BackupVerificationProof;
  /** CC7.3 — Incident response. */
  incidentRunbookSignOff: RunbookSignOff;
  /** A1.2 — Availability. */
  availability: AvailabilityRecord;
}

// ---------------------------------------------------------------------------
// Privileged roles subject to access review
// ---------------------------------------------------------------------------

/**
 * Application-layer role names that require quarterly access review.
 *
 * These are the `properties.role` values stored in the `entities` table for
 * user entities. They correspond to privileged roles that can modify system
 * state or access sensitive data.
 */
export const PRIVILEGED_ROLES: readonly string[] = [
  'superuser',
  'admin',
  'compliance_officer',
] as const;

// ---------------------------------------------------------------------------
// Audit action prefixes that count as deployment change events
// ---------------------------------------------------------------------------

/**
 * Audit action prefix patterns that identify deployment or configuration
 * change events in the audit log.
 */
export const CHANGE_LOG_ACTION_PREFIXES: readonly string[] = [
  'deployment.',
  'schema.',
  'tenant.config.',
  'retention_policy.assign',
  'approval_request.',
  'signing_key.',
  'worker_credential.',
] as const;

// ---------------------------------------------------------------------------
// Access review assembly
// ---------------------------------------------------------------------------

/**
 * Build access review records for all privileged-role users.
 *
 * For each user whose `properties.role` is in `PRIVILEGED_ROLES`:
 *   1. Retrieve the user entity.
 *   2. Look up the most recent audit event where `actor_id = userId`.
 *   3. Return an `AccessReviewRecord` with `lastActiveAt` and
 *      `accessAppropriate: null` (the Compliance Officer fills this in
 *      during the quarterly review).
 *
 * The `reviewedAt` field is set to `now`.
 */
export async function buildAccessReviews(sql: Sql, auditSql: Sql): Promise<AccessReviewRecord[]> {
  // Retrieve all privileged users from the entities table.
  // Use a parameterised IN-list via sql.unsafe to avoid the postgres.js
  // array-binding limitation on ANY().
  const rolePlaceholders = PRIVILEGED_ROLES.map((_, i) => `$${i + 1}`).join(', ');
  const users = (await sql.unsafe(
    `SELECT id, properties
     FROM entities
     WHERE type = 'user'
       AND properties->>'role' IN (${rolePlaceholders})
     ORDER BY id`,
    PRIVILEGED_ROLES as string[],
  )) as { id: string; properties: { role?: string } }[];

  if (users.length === 0) {
    return [];
  }

  const userIds = users.map((u) => u.id);

  // Look up each user's most recent audit event in bulk.
  const userIdPlaceholders = userIds.map((_, i) => `$${i + 1}`).join(', ');
  const lastActivity = (await auditSql.unsafe(
    `SELECT actor_id, MAX(ts)::text AS last_ts
     FROM audit_events
     WHERE actor_id IN (${userIdPlaceholders})
     GROUP BY actor_id`,
    userIds,
  )) as { actor_id: string; last_ts: string }[];

  const activityByUserId = new Map(lastActivity.map((row) => [row.actor_id, row.last_ts]));

  const reviewedAt = new Date().toISOString();

  return users.map((u) => ({
    userId: u.id,
    role: u.properties.role ?? 'unknown',
    lastActiveAt: activityByUserId.get(u.id) ?? null,
    reviewedAt,
    accessAppropriate: null, // Filled in during quarterly review
    notes: null,
  }));
}

// ---------------------------------------------------------------------------
// Change log export
// ---------------------------------------------------------------------------

/**
 * Export change log entries from the audit store.
 *
 * Filters audit events whose `action` starts with any of the prefixes in
 * `CHANGE_LOG_ACTION_PREFIXES`. Returns entries ordered by timestamp
 * descending, limited to `limit` rows (default 200).
 *
 * @param auditSql - Connection to the audit database.
 * @param opts.periodStart - ISO-8601 start of the attestation period.
 * @param opts.periodEnd   - ISO-8601 end of the attestation period.
 * @param opts.limit       - Maximum number of entries to return (default 200).
 */
export async function buildChangeLog(
  auditSql: Sql,
  opts: {
    periodStart: string;
    periodEnd: string;
    limit?: number;
  },
): Promise<ChangeLogEntry[]> {
  const limit = opts.limit ?? 200;

  // Build a LIKE-based filter using postgres.js parameterised unsafe query.
  // Each prefix is converted to a LIKE pattern (e.g. 'deployment.%').
  const prefixPatterns = CHANGE_LOG_ACTION_PREFIXES.map((p) => `${p}%`);

  // Build the WHERE clause dynamically with positional params.
  // Params: $1 = periodStart, $2 = periodEnd, $3...$N = LIKE patterns.
  const likeConditions = prefixPatterns.map((_, i) => `action LIKE $${i + 3}`).join(' OR ');

  const queryParams: unknown[] = [opts.periodStart, opts.periodEnd, ...prefixPatterns];

  const rows = (await auditSql.unsafe(
    `SELECT id, ts::text AS ts, actor_id, action, entity_type, entity_id, before, after
     FROM audit_events
     WHERE ts >= $1::timestamptz
       AND ts <= $2::timestamptz
       AND (${likeConditions})
     ORDER BY ts DESC, id DESC
     LIMIT ${limit}`,
    queryParams as string[],
  )) as {
    id: string;
    ts: string;
    actor_id: string;
    action: string;
    entity_type: string;
    entity_id: string;
    before: Record<string, unknown> | string | null;
    after: Record<string, unknown> | string | null;
  }[];

  function parseJsonbField(
    field: Record<string, unknown> | string | null,
  ): Record<string, unknown> | null {
    if (field === null) return null;
    if (typeof field === 'string') return JSON.parse(field) as Record<string, unknown>;
    return field;
  }

  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    actorId: r.actor_id,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    before: parseJsonbField(r.before),
    after: parseJsonbField(r.after),
  }));
}

// ---------------------------------------------------------------------------
// Backup verification proof
// ---------------------------------------------------------------------------

/**
 * Retrieve the most recent backup restore-drill result from the audit store.
 *
 * The restore-drill script writes a `backup.restore_drill` audit event after
 * each successful drill. This function returns a `BackupVerificationProof`
 * built from the most recent such event, or a stub with `drillPassed: false`
 * if no drill has been recorded.
 *
 * Expected `after` payload shape:
 * ```json
 * {
 *   "backup_id": "<backup identifier>",
 *   "restored_row_count": 12345,
 *   "passed": true
 * }
 * ```
 */
export async function buildBackupVerificationProof(
  auditSql: Sql,
): Promise<BackupVerificationProof> {
  const rows = await auditSql<
    {
      id: string;
      ts: string;
      after: Record<string, unknown> | string | null;
    }[]
  >`
    SELECT id, ts::text AS ts, after
    FROM audit_events
    WHERE action = 'backup.restore_drill'
    ORDER BY ts DESC
    LIMIT 1
  `;

  if (rows.length === 0) {
    return {
      auditEventId: null,
      drilledAt: null,
      drillPassed: false,
      backupId: null,
      restoredRowCount: null,
    };
  }

  const row = rows[0];
  // postgres.js may return JSONB as a parsed object or as a JSON string
  // depending on the connection's type parser configuration. Normalise here.
  const rawAfter = row.after;
  const after: Record<string, unknown> =
    rawAfter === null
      ? {}
      : typeof rawAfter === 'string'
        ? (JSON.parse(rawAfter) as Record<string, unknown>)
        : (rawAfter as Record<string, unknown>);

  return {
    auditEventId: row.id,
    drilledAt: row.ts,
    drillPassed: after['passed'] === true,
    backupId: (after['backup_id'] as string | undefined) ?? null,
    restoredRowCount: (after['restored_row_count'] as number | undefined) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Incident response runbook sign-off
// ---------------------------------------------------------------------------

/**
 * Return the static sign-off record for the Phase 1 auth-incident-response
 * runbook.
 *
 * The auth-incident-response runbook (`docs/runbooks/auth-incident-response.md`)
 * was last tested on 2026-04-11 in staging and covers four scenarios:
 *   1. Signing key compromise
 *   2. Agent credential compromise
 *   3. Admin account compromise
 *   4. Mass session invalidation
 *
 * The sign-off record is checked into the repository so that the evidence
 * package always reflects the committed runbook state. When the runbook is
 * next tested, this record must be updated with the new test date, tester
 * name, and environment.
 */
export function buildRunbookSignOff(): RunbookSignOff {
  return {
    runbookPath: 'docs/runbooks/auth-incident-response.md',
    lastTestedAt: '2026-04-11',
    testedIn: 'staging',
    signedOffBy: 'on-call-engineer',
    allScenariosVerified: true,
  };
}

// ---------------------------------------------------------------------------
// Availability record
// ---------------------------------------------------------------------------

/**
 * Build a service availability record for the attestation period.
 *
 * In the absence of a dedicated uptime-monitoring integration, this function
 * counts `health.check_failed` audit events in the period as downtime events
 * and derives an estimated uptime percentage using a conservative model
 * (each downtime event = 5 minutes of downtime against a 30-day window).
 *
 * When a full availability monitoring integration lands (Phase 8 follow-on),
 * this function should be replaced with a real uptime query.
 */
export async function buildAvailabilityRecord(
  auditSql: Sql,
  opts: {
    periodStart: string;
    periodEnd: string;
  },
): Promise<AvailabilityRecord> {
  const rows = await auditSql<{ count: string }[]>`
    SELECT COUNT(*) AS count
    FROM audit_events
    WHERE action = 'health.check_failed'
      AND ts >= ${opts.periodStart}::timestamptz
      AND ts <= ${opts.periodEnd}::timestamptz
  `;

  const downtimeEventCount = Number(rows[0]?.count ?? 0);

  // Conservative model: each downtime event represents 5 minutes of outage.
  // Attestation window is treated as 30 days (43,200 minutes) unless the
  // period is shorter.
  const start = new Date(opts.periodStart).getTime();
  const end = new Date(opts.periodEnd).getTime();
  const periodMinutes = Math.max((end - start) / (1000 * 60), 1);
  const downtimeMinutes = downtimeEventCount * 5;
  const uptimeMinutes = Math.max(periodMinutes - downtimeMinutes, 0);
  const estimatedUptimePct = Number(((uptimeMinutes / periodMinutes) * 100).toFixed(4));

  return {
    periodStart: opts.periodStart,
    periodEnd: opts.periodEnd,
    downtimeEventCount,
    estimatedUptimePct,
    derivationNote:
      'Estimated from audit log health.check_failed events. ' +
      'Each event assumed to represent 5 minutes of downtime. ' +
      'Replace with real uptime-monitoring data when available.',
  };
}

// ---------------------------------------------------------------------------
// Evidence package assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the complete SOC 2 Type II evidence package.
 *
 * @param sql      - App database connection (for entity queries).
 * @param auditSql - Audit database connection (for audit event queries).
 * @param opts.attestationPeriodStart - ISO-8601 start of the attestation period.
 * @param opts.attestationPeriodEnd   - ISO-8601 end of the attestation period.
 * @param opts.changeLogLimit         - Maximum change log entries (default 200).
 */
export async function assembleSoc2EvidencePackage(
  sql: Sql,
  auditSql: Sql,
  opts: {
    attestationPeriodStart: string;
    attestationPeriodEnd: string;
    changeLogLimit?: number;
  },
): Promise<Soc2EvidencePackage> {
  const [accessReviews, changeLog, backupVerification, availability] = await Promise.all([
    buildAccessReviews(sql, auditSql),
    buildChangeLog(auditSql, {
      periodStart: opts.attestationPeriodStart,
      periodEnd: opts.attestationPeriodEnd,
      limit: opts.changeLogLimit,
    }),
    buildBackupVerificationProof(auditSql),
    buildAvailabilityRecord(auditSql, {
      periodStart: opts.attestationPeriodStart,
      periodEnd: opts.attestationPeriodEnd,
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    attestationPeriodStart: opts.attestationPeriodStart,
    attestationPeriodEnd: opts.attestationPeriodEnd,
    accessReviews,
    changeLog,
    backupVerification,
    incidentRunbookSignOff: buildRunbookSignOff(),
    availability,
  };
}
