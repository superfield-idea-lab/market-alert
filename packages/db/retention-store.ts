/**
 * @file retention-store
 *
 * Repository-layer helpers for writing Email and CorpusChunk entities with
 * their retention metadata populated from the tenant's default retention policy.
 *
 * ## Responsibility
 *
 * Phase 8 builds the full retention policy engine. Phase 2 (this module) only
 * ensures that every row written during ingestion carries non-null
 * `retention_class` and `legal_hold` values sourced from
 * `tenant_retention_policies`. Phase 8 can then operate on a uniformly
 * labelled corpus without needing to backfill any rows.
 *
 * ## Immutability
 *
 * The `retention_class` and `legal_hold` columns on `entities` are protected
 * by the `trg_entities_retention_immutable` trigger defined in `schema.sql`.
 * Once set on INSERT (i.e. once non-null), the trigger raises an exception if
 * any UPDATE attempts to change either field. The `app_rw` role therefore
 * cannot alter these fields after the initial write — only a privileged admin
 * role used by the Phase 8 engine may do so.
 *
 * ## Tenant default lookup
 *
 * `lookupTenantDefaultPolicy` fetches the row from `tenant_retention_policies`
 * for the given `tenant_id`. It throws `MissingTenantRetentionPolicyError` if
 * no row exists, so the ingestion path is blocked with a clear error rather
 * than silently writing null metadata.
 *
 * Canonical docs: docs/PRD.md §7a, docs/implementation-plan-v1.md Phase 2
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/33
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
 * The default retention policy configured for a tenant.
 *
 * `retention_class` is an opaque policy pointer (e.g. "standard", "mifid2-7yr").
 *   The Phase 8 retention engine interprets this value.
 *
 * `legal_hold_default` controls whether newly ingested entities start under a
 *   legal hold. Typically `false`; set `true` when a hold is raised tenant-wide.
 */
export interface TenantRetentionPolicy {
  tenantId: string;
  retentionClass: string;
  legalHoldDefault: boolean;
}

/**
 * Thrown when an ingestion write is attempted for a tenant that has no default
 * retention policy configured. Ingestion must be blocked — there is no safe
 * fall-through default.
 */
export class MissingTenantRetentionPolicyError extends Error {
  constructor(tenantId: string) {
    super(
      `No default retention policy found for tenant '${tenantId}'. ` +
        'Configure a row in tenant_retention_policies before ingesting.',
    );
    this.name = 'MissingTenantRetentionPolicyError';
  }
}

// ---------------------------------------------------------------------------
// Tenant policy lookup
// ---------------------------------------------------------------------------

/**
 * Fetches the default retention policy for the given tenant.
 *
 * @throws {MissingTenantRetentionPolicyError} when no row exists for `tenantId`.
 */
export async function lookupTenantDefaultPolicy(
  sql: SqlClient,
  tenantId: string,
): Promise<TenantRetentionPolicy> {
  const rows = await sql<
    { tenant_id: string; retention_class: string; legal_hold_default: boolean }[]
  >`
    SELECT tenant_id, retention_class, legal_hold_default
    FROM tenant_retention_policies
    WHERE tenant_id = ${tenantId}
  `;

  if (rows.length === 0) {
    throw new MissingTenantRetentionPolicyError(tenantId);
  }

  const row = rows[0];
  return {
    tenantId: row.tenant_id,
    retentionClass: row.retention_class,
    legalHoldDefault: row.legal_hold_default,
  };
}

// ---------------------------------------------------------------------------
// Email ingestion write
// ---------------------------------------------------------------------------

/**
 * Input for writing a new Email entity with retention metadata.
 */
export interface WriteEmailInput {
  /** Caller-assigned entity ID (UUID or stable deterministic ID). */
  id: string;
  /** Tenant ID — used to resolve the default retention policy. */
  tenantId: string;
  /** JSONB properties for the email entity (subject, body, headers, etc.). */
  properties: Record<string, unknown>;
}

/**
 * Result of a successful email write.
 */
export interface WriteEmailResult {
  id: string;
  tenantId: string;
  retentionClass: string;
  legalHold: boolean;
}

/**
 * Inserts an Email entity with `retention_class` and `legal_hold` populated
 * from the tenant's default retention policy.
 *
 * @throws {MissingTenantRetentionPolicyError} when no policy row exists for the tenant.
 */
export async function writeEmailWithRetention(
  sql: SqlClient,
  input: WriteEmailInput,
): Promise<WriteEmailResult> {
  const policy = await lookupTenantDefaultPolicy(sql, input.tenantId);

  await sql`
    INSERT INTO entities (id, type, properties, tenant_id, retention_class, legal_hold)
    VALUES (
      ${input.id},
      'email',
      ${sql.json(input.properties as never)},
      ${input.tenantId},
      ${policy.retentionClass},
      ${policy.legalHoldDefault}
    )
  `;

  return {
    id: input.id,
    tenantId: input.tenantId,
    retentionClass: policy.retentionClass,
    legalHold: policy.legalHoldDefault,
  };
}

// ---------------------------------------------------------------------------
// CorpusChunk ingestion write
// ---------------------------------------------------------------------------

/**
 * Input for writing a new CorpusChunk entity with retention metadata.
 */
export interface WriteCorpusChunkInput {
  /** Caller-assigned entity ID. */
  id: string;
  /** Tenant ID — used to resolve the default retention policy. */
  tenantId: string;
  /** JSONB properties for the corpus chunk entity (content, source ref, etc.). */
  properties: Record<string, unknown>;
}

/**
 * Result of a successful corpus chunk write.
 */
export interface WriteCorpusChunkResult {
  id: string;
  tenantId: string;
  retentionClass: string;
  legalHold: boolean;
}

/**
 * Inserts a CorpusChunk entity with `retention_class` and `legal_hold`
 * populated from the tenant's default retention policy.
 *
 * @throws {MissingTenantRetentionPolicyError} when no policy row exists for the tenant.
 */
export async function writeCorpusChunkWithRetention(
  sql: SqlClient,
  input: WriteCorpusChunkInput,
): Promise<WriteCorpusChunkResult> {
  const policy = await lookupTenantDefaultPolicy(sql, input.tenantId);

  await sql`
    INSERT INTO entities (id, type, properties, tenant_id, retention_class, legal_hold)
    VALUES (
      ${input.id},
      'corpus_chunk',
      ${sql.json(input.properties as never)},
      ${input.tenantId},
      ${policy.retentionClass},
      ${policy.legalHoldDefault}
    )
  `;

  return {
    id: input.id,
    tenantId: input.tenantId,
    retentionClass: policy.retentionClass,
    legalHold: policy.legalHoldDefault,
  };
}
