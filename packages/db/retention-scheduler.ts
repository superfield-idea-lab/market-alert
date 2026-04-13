/**
 * @file retention-scheduler
 *
 * Phase 8 — Nightly retention scheduler with legal-hold and WORM awareness
 * (issue #83).
 *
 * ## Purpose
 *
 * This module implements the nightly retention scan that hard-deletes entities
 * whose retention window has elapsed, respecting legal holds and WORM mode.
 *
 * ## Eligibility rules
 *
 * An entity is eligible for scheduler deletion when ALL of the following hold:
 *
 *   1. `retention_class` is non-null and maps to a known policy.
 *   2. The retention floor has elapsed:
 *      `NOW() >= created_at + retention_floor_days * INTERVAL '1 day'`
 *   3. `legal_hold = false` or `legal_hold IS NULL` — held rows are exempt.
 *
 * WORM mode does NOT block deletion once the retention floor has elapsed.
 * The `guard_worm_update` trigger only blocks UPDATE, not DELETE, once the
 * floor has elapsed. The `guard_retention_floor` trigger blocks DELETE while
 * within the floor, which is orthogonal to WORM.
 *
 * ## Deletion path
 *
 * Every deletion goes through `deleteEntityPastRetention` which performs an
 * application-layer floor check before issuing the DELETE. This surfaces a
 * clear `RetentionFloorNotReachedError` if the scheduler has clock skew or
 * a bug, while the database-layer trigger provides a second defence.
 *
 * ## Audit events
 *
 * Every deletion emits an audit event with:
 *   - `actor_id`: `'scheduler'`
 *   - `action`: `'retention.delete'`
 *   - `entity_type`: the entity's type (e.g. `'corpus_chunk'`, `'email'`)
 *   - `entity_id`: the entity's UUID
 *   - `before`: `{ retention_class, tenant_id, entity_type }`
 *   - `after`: `null`
 *
 * ## Integration risks
 *
 *   - The scheduler must be the only caller of `deleteEntityPastRetention` —
 *     user-initiated deletions go through the application API layer.
 *   - Legal holds stored in the `legal_holds` table (issue #82, when merged)
 *     are respected here via the `legal_hold` column on entities, which is
 *     set at ingestion time from `tenant_retention_policies.legal_hold_default`.
 *     A tenant-level hold raises `legal_hold_default = true`, so all rows
 *     ingested under a held tenant carry `legal_hold = true`.
 *
 * Canonical docs: docs/PRD.md §7a, docs/implementation-plan-v1.md Phase 8
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/83
 */

import type postgres from 'postgres';
import { deleteEntityPastRetention } from './retention-engine';

// ---------------------------------------------------------------------------
// Internal type alias
// ---------------------------------------------------------------------------

type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Audit writer callback injected by the server layer to emit a hash-chained
 * audit event for each entity deleted by the scheduler. The db package does
 * not import the audit service directly; the server wires it in.
 */
export type SchedulerAuditWriterFn = (event: {
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ts: string;
}) => Promise<void>;

/**
 * Per-deletion result entry returned from `runRetentionScheduler`.
 */
export interface RetentionDeleteResult {
  /** Entity ID that was deleted (or skipped). */
  entityId: string;
  /** Entity type at time of deletion. */
  entityType: string;
  /** Tenant ID for the entity. */
  tenantId: string | null;
  /** Retention class for the entity. */
  retentionClass: string;
  /** Whether the deletion succeeded. */
  deleted: boolean;
  /** Error message when `deleted = false`. */
  error?: string;
}

/**
 * Summary returned from one `runRetentionScheduler` invocation.
 */
export interface RetentionSchedulerSummary {
  /** Number of entities successfully deleted. */
  deletedCount: number;
  /** Number of entities skipped due to errors or unexpected floor checks. */
  skippedCount: number;
  /** Per-entity results for observability. */
  results: RetentionDeleteResult[];
  /** ISO timestamp when the scan started. */
  startedAt: string;
  /** ISO timestamp when the scan completed. */
  completedAt: string;
}

// ---------------------------------------------------------------------------
// Core scheduler function
// ---------------------------------------------------------------------------

/**
 * Runs one complete retention scan.
 *
 * Fetches all entities that are:
 *   1. Past their retention floor (based on the policy-level floor; entity-type
 *      overrides are not applied in this query — overrides are checked separately
 *      by `deleteEntityPastRetention` via `isWithinRetentionFloor`).
 *   2. Not under a legal hold (`legal_hold IS NOT TRUE`).
 *
 * Deletes each eligible entity via `deleteEntityPastRetention` and emits an
 * audit event via the injected `auditWriter`.
 *
 * Errors on individual entities are caught and accumulated in `results` so
 * a single bad row does not abort the entire scan.
 *
 * @param sql          - Postgres client (app pool).
 * @param auditWriter  - Optional audit event writer. Strongly recommended in
 *                       production; omit only in unit tests.
 * @param batchSize    - Maximum number of entities to process per scan.
 *                       Defaults to 1000. Set lower for testing.
 */
export async function runRetentionScheduler(
  sql: SqlClient,
  auditWriter?: SchedulerAuditWriterFn,
  batchSize = 1000,
): Promise<RetentionSchedulerSummary> {
  const startedAt = new Date().toISOString();
  const results: RetentionDeleteResult[] = [];

  // ---------------------------------------------------------------------------
  // Eligibility query
  //
  // Selects entities that:
  //   1. Have a non-null retention_class mapping to a known policy.
  //   2. Have elapsed their retention floor (policy-level floor; entity-type
  //      overrides are not applied here — overrides may extend the floor, so
  //      omitting them means we may attempt a deletion that
  //      deleteEntityPastRetention will catch and skip as still-within-floor).
  //   3. Do NOT have entities.legal_hold = true (per-entity hold set at
  //      ingestion time from tenant_retention_policies.legal_hold_default).
  //   4. Do NOT belong to a tenant with an active or pending_removal legal hold
  //      in the legal_holds table (tenant-level hold placed by a Compliance
  //      Officer via the four-eyes flow, issue #82).
  //
  // Excluding held tenants at query time avoids unnecessary DB round-trips
  // inside the per-entity loop. The application-layer guard in
  // deleteEntityPastRetention / isWithinRetentionFloor provides a second
  // defence even if a hold is placed concurrently during the scan.
  // ---------------------------------------------------------------------------

  const eligibleRows = await sql<
    {
      id: string;
      type: string;
      tenant_id: string | null;
      retention_class: string;
    }[]
  >`
    SELECT e.id, e.type, e.tenant_id, e.retention_class
    FROM entities e
    JOIN retention_policies rp ON rp.name = e.retention_class
    WHERE e.retention_class IS NOT NULL
      AND (e.legal_hold IS NULL OR e.legal_hold = false)
      AND NOW() >= e.created_at + (rp.retention_floor_days * INTERVAL '1 day')
      AND (
        e.tenant_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM legal_holds lh
          WHERE lh.tenant_id = e.tenant_id
            AND lh.status IN ('active', 'pending_removal')
        )
      )
    ORDER BY e.created_at ASC
    LIMIT ${batchSize}
  `;

  for (const row of eligibleRows) {
    const { id, type, tenant_id, retention_class } = row;
    const ts = new Date().toISOString();

    try {
      // deleteEntityPastRetention performs a second application-layer floor
      // check before issuing the DELETE. If the entity is somehow still within
      // its floor (e.g. due to entity-type override or clock skew), this will
      // throw RetentionFloorNotReachedError.
      await deleteEntityPastRetention(sql, id);

      // Emit audit event for the deletion.
      if (auditWriter) {
        await auditWriter({
          actor_id: 'scheduler',
          action: 'retention.delete',
          entity_type: type,
          entity_id: id,
          before: {
            retention_class,
            tenant_id: tenant_id ?? null,
            entity_type: type,
          },
          after: null,
          ts,
        }).catch((auditErr: unknown) => {
          console.warn(`[retention-scheduler] audit write failed for entity ${id}:`, auditErr);
        });
      }

      results.push({
        entityId: id,
        entityType: type,
        tenantId: tenant_id,
        retentionClass: retention_class,
        deleted: true,
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.warn(`[retention-scheduler] skipping entity ${id}: ${errorMessage}`);
      results.push({
        entityId: id,
        entityType: type,
        tenantId: tenant_id,
        retentionClass: retention_class,
        deleted: false,
        error: errorMessage,
      });
    }
  }

  const completedAt = new Date().toISOString();
  const deletedCount = results.filter((r) => r.deleted).length;
  const skippedCount = results.filter((r) => !r.deleted).length;

  console.log(
    `[retention-scheduler] scan complete: deleted=${deletedCount} skipped=${skippedCount} elapsed=${Date.now() - new Date(startedAt).getTime()}ms`,
  );

  return {
    deletedCount,
    skippedCount,
    results,
    startedAt,
    completedAt,
  };
}
