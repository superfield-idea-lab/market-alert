/**
 * @file e-discovery
 *
 * Phase 8 — e-discovery export bundle for Compliance Officers (issue #84).
 *
 * ## Purpose
 *
 * Provides the data-access layer for building a structured e-discovery export
 * bundle. A Compliance Officer selects a scope (customerId, date range, entity
 * types) and this module assembles the bundle from:
 *
 *   1. Ground truth — entities in scope (by tenant / customer / date range).
 *   2. Wiki versions — all wiki_page_versions rows for the customer / date range.
 *   3. Annotations — annotation_threads (and replies) anchored to in-scope
 *      wiki versions.
 *   4. Audit trail — audit_events rows whose entity_id or actor_id appears in
 *      the scoped entity set, constrained to the date range.
 *
 * ## Role restriction
 *
 * `buildEDiscoveryBundle` requires the caller to pass `actorRole`. If the role
 * is not `compliance_officer` (and the caller is not a superuser), the function
 * throws `EDiscoveryInsufficientRoleError` before touching the database.
 *
 * ## Audit
 *
 * Every successful export invokes the optional `auditWriter` callback to emit a
 * hash-chained `e_discovery.export` audit event.
 *
 * Canonical docs: docs/PRD.md, docs/implementation-plan-v1.md Phase 8
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/84
 */

import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// Internal type alias
// ---------------------------------------------------------------------------

type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a caller without the `compliance_officer` role attempts to
 * trigger an e-discovery export.
 */
export class EDiscoveryInsufficientRoleError extends Error {
  constructor(actorId: string, actualRole: string | null) {
    super(
      `Actor '${actorId}' (role=${actualRole ?? 'none'}) is not permitted to trigger an ` +
        `e-discovery export. Required role: compliance_officer.`,
    );
    this.name = 'EDiscoveryInsufficientRoleError';
  }
}

// ---------------------------------------------------------------------------
// Audit writer callback
// ---------------------------------------------------------------------------

export type EDiscoveryAuditWriterFn = (event: {
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ts: string;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface EDiscoveryScope {
  /** Customer / tenant identifier to scope the export. */
  customerId: string;
  /** ISO-8601 start date (inclusive). Defaults to the epoch when omitted. */
  dateFrom?: string;
  /** ISO-8601 end date (inclusive). Defaults to now when omitted. */
  dateTo?: string;
  /**
   * Entity types to include in ground-truth section.
   * When absent, all entity types for the customer are included.
   */
  entityTypes?: string[];
}

export interface EDiscoveryGroundTruthEntity {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  tenant_id: string | null;
  created_at: string;
}

export interface EDiscoveryWikiVersion {
  id: string;
  page_id: string;
  dept: string;
  customer: string;
  content: string;
  state: string;
  created_by: string;
  created_at: string;
}

export interface EDiscoveryAnnotationReply {
  id: string;
  body: string;
  created_by: string;
  created_at: string;
}

export interface EDiscoveryAnnotation {
  id: string;
  wiki_version_id: string;
  anchor_text: string;
  body: string;
  created_by: string;
  resolved: boolean;
  created_at: string;
  replies: EDiscoveryAnnotationReply[];
}

export interface EDiscoveryAuditEvent {
  id: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ts: string;
}

/**
 * The structured e-discovery export bundle.
 *
 * All sections are scoped to the requested customerId and date range.
 */
export interface EDiscoveryBundle {
  /** Metadata about this export. */
  meta: {
    exportedAt: string;
    exportedBy: string;
    scope: EDiscoveryScope;
  };
  /** Ground-truth entities scoped to the customer. */
  groundTruth: EDiscoveryGroundTruthEntity[];
  /** Wiki page versions for the customer. */
  wikiVersions: EDiscoveryWikiVersion[];
  /** Annotation threads (with replies) anchored to in-scope wiki versions. */
  annotations: EDiscoveryAnnotation[];
  /** Audit trail relevant to in-scope entities. */
  auditTrail: EDiscoveryAuditEvent[];
}

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export interface BuildEDiscoveryBundleInput {
  /** The ID of the actor performing the export. */
  actorId: string;
  /** The role of the actor (must be 'compliance_officer'). */
  actorRole: string | null;
  /** True when the actor is the system superuser (bypasses role check). */
  isSuperuser?: boolean;
  /** Scope parameters for the export. */
  scope: EDiscoveryScope;
  /** Optional callback to emit a hash-chained audit event on success. */
  auditWriter?: EDiscoveryAuditWriterFn;
  /** Separate audit database connection (optional; omit to skip audit trail). */
  auditSql?: SqlClient;
}

// ---------------------------------------------------------------------------
// buildEDiscoveryBundle
// ---------------------------------------------------------------------------

/**
 * Builds a structured e-discovery bundle for the given scope.
 *
 * Enforces that the actor has the `compliance_officer` role (or is superuser).
 * Emits an `e_discovery.export` audit event via `auditWriter` (if provided).
 *
 * @throws {EDiscoveryInsufficientRoleError} when the actor lacks the required role.
 */
export async function buildEDiscoveryBundle(
  sql: SqlClient,
  input: BuildEDiscoveryBundleInput,
): Promise<EDiscoveryBundle> {
  const { actorId, actorRole, isSuperuser: superuser, scope, auditWriter, auditSql } = input;

  // Role guard — only compliance_officer or superuser may export.
  if (!superuser && actorRole !== 'compliance_officer') {
    throw new EDiscoveryInsufficientRoleError(actorId, actorRole);
  }

  const exportedAt = new Date().toISOString();
  const dateFrom = scope.dateFrom ?? '1970-01-01T00:00:00.000Z';
  const dateTo = scope.dateTo ?? exportedAt;

  // -------------------------------------------------------------------------
  // 1. Ground truth — entities scoped to customer (via tenant_id) and date range
  // -------------------------------------------------------------------------

  let groundTruthRows: EDiscoveryGroundTruthEntity[];

  if (scope.entityTypes && scope.entityTypes.length > 0) {
    groundTruthRows = await sql<EDiscoveryGroundTruthEntity[]>`
      SELECT id, type, properties, tenant_id, created_at::TEXT AS created_at
      FROM entities
      WHERE tenant_id = ${scope.customerId}
        AND type = ANY(${scope.entityTypes}::TEXT[])
        AND created_at >= ${dateFrom}::TIMESTAMPTZ
        AND created_at <= ${dateTo}::TIMESTAMPTZ
      ORDER BY created_at ASC
    `;
  } else {
    groundTruthRows = await sql<EDiscoveryGroundTruthEntity[]>`
      SELECT id, type, properties, tenant_id, created_at::TEXT AS created_at
      FROM entities
      WHERE tenant_id = ${scope.customerId}
        AND created_at >= ${dateFrom}::TIMESTAMPTZ
        AND created_at <= ${dateTo}::TIMESTAMPTZ
      ORDER BY created_at ASC
    `;
  }

  // -------------------------------------------------------------------------
  // 2. Wiki versions — scoped to customer and date range
  // -------------------------------------------------------------------------

  const wikiRows = await sql<EDiscoveryWikiVersion[]>`
    SELECT id, page_id, dept, customer, content, state, created_by,
           created_at::TEXT AS created_at
    FROM wiki_page_versions
    WHERE customer = ${scope.customerId}
      AND created_at >= ${dateFrom}::TIMESTAMPTZ
      AND created_at <= ${dateTo}::TIMESTAMPTZ
    ORDER BY created_at ASC
  `;

  // -------------------------------------------------------------------------
  // 3. Annotations — threads and replies for in-scope wiki versions
  // -------------------------------------------------------------------------

  const wikiVersionIds = wikiRows.map((w: EDiscoveryWikiVersion) => w.id);

  let annotations: EDiscoveryAnnotation[] = [];

  if (wikiVersionIds.length > 0) {
    type ThreadRow = {
      id: string;
      wiki_version_id: string;
      anchor_text: string;
      body: string;
      created_by: string;
      resolved: boolean;
      created_at: string;
    };

    const threadRows = await sql<ThreadRow[]>`
      SELECT id, wiki_version_id, anchor_text, body, created_by,
             resolved, created_at::TEXT AS created_at
      FROM annotation_threads
      WHERE wiki_version_id = ANY(${wikiVersionIds}::TEXT[])
      ORDER BY created_at ASC
    `;

    const threadIds = threadRows.map((t: ThreadRow) => t.id);

    type ReplyRow = {
      id: string;
      thread_id: string;
      body: string;
      created_by: string;
      created_at: string;
    };

    let replyRows: ReplyRow[] = [];
    if (threadIds.length > 0) {
      replyRows = await sql<ReplyRow[]>`
        SELECT id, thread_id, body, created_by, created_at::TEXT AS created_at
        FROM annotation_replies
        WHERE thread_id = ANY(${threadIds}::TEXT[])
        ORDER BY created_at ASC
      `;
    }

    // Group replies by thread_id.
    const repliesByThread = new Map<string, EDiscoveryAnnotationReply[]>();
    for (const reply of replyRows) {
      if (!repliesByThread.has(reply.thread_id)) {
        repliesByThread.set(reply.thread_id, []);
      }
      repliesByThread.get(reply.thread_id)!.push({
        id: reply.id,
        body: reply.body,
        created_by: reply.created_by,
        created_at: reply.created_at,
      });
    }

    annotations = threadRows.map((t: ThreadRow) => ({
      id: t.id,
      wiki_version_id: t.wiki_version_id,
      anchor_text: t.anchor_text,
      body: t.body,
      created_by: t.created_by,
      resolved: t.resolved,
      created_at: t.created_at,
      replies: repliesByThread.get(t.id) ?? [],
    }));
  }

  // -------------------------------------------------------------------------
  // 4. Audit trail — events for in-scope entity IDs within the date range
  //    Falls back to empty when auditSql is not provided.
  // -------------------------------------------------------------------------

  let auditTrail: EDiscoveryAuditEvent[] = [];

  if (auditSql) {
    const scopedEntityIds = groundTruthRows.map((e) => e.id);

    if (scopedEntityIds.length > 0) {
      type AuditRow = {
        id: string;
        actor_id: string;
        action: string;
        entity_type: string;
        entity_id: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
        ts: string;
      };

      auditTrail = await auditSql<AuditRow[]>`
        SELECT id::TEXT AS id, actor_id, action, entity_type, entity_id,
               before, after, ts::TEXT AS ts
        FROM audit_events
        WHERE entity_id = ANY(${scopedEntityIds}::TEXT[])
          AND ts >= ${dateFrom}::TIMESTAMPTZ
          AND ts <= ${dateTo}::TIMESTAMPTZ
        ORDER BY ts ASC
      `;
    }
  }

  // -------------------------------------------------------------------------
  // Emit audit event for the export itself.
  // -------------------------------------------------------------------------

  if (auditWriter) {
    await auditWriter({
      actor_id: actorId,
      action: 'e_discovery.export',
      entity_type: 'tenant',
      entity_id: scope.customerId,
      before: null,
      after: {
        customerId: scope.customerId,
        dateFrom,
        dateTo,
        entityCount: groundTruthRows.length,
        wikiVersionCount: wikiRows.length,
        annotationCount: annotations.length,
        auditEventCount: auditTrail.length,
      },
      ts: exportedAt,
    }).catch((err) =>
      console.warn('[e-discovery] audit write failed for e_discovery.export:', err),
    );
  }

  return {
    meta: {
      exportedAt,
      exportedBy: actorId,
      scope,
    },
    groundTruth: groundTruthRows,
    wikiVersions: wikiRows,
    annotations,
    auditTrail,
  };
}
