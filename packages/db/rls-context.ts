/**
 * @file rls-context
 * Session-context binding for Postgres restrictive RLS policies.
 *
 * `withRlsContext()` wraps a database operation in a transaction that first
 * sets `app.current_user_id` and `app.current_tenant_id` as session-local
 * Postgres config variables so that RLS policies on customer-scoped tables
 * (`entities`, `relations`) can reference them via `current_setting(...)`.
 *
 * Using `SET LOCAL` scoping means each variable is automatically reset when
 * the transaction ends — there is no risk of leaking a stale context into
 * subsequent queries on the same connection.
 *
 * Usage:
 * ```ts
 * import { withRlsContext, sql } from 'db';
 *
 * const rows = await withRlsContext(sql, { userId: 'u1', tenantId: 'tenant-a' }, async (tx) => {
 *   return tx<Row[]>`SELECT * FROM entities WHERE id = ${id}`;
 * });
 * ```
 *
 * Blueprint: DATA blueprint — restrictive RLS, structural DB blocks replace
 * application-layer filtering (PRD §7).
 */

import postgres from 'postgres';

type Sql = postgres.Sql;

/**
 * `postgres.TransactionSql` extends `Omit<Sql, ...>` which strips the call
 * signatures that make tagged-template queries work. Typing the callback as
 * `Sql` preserves those signatures while remaining structurally compatible at
 * runtime (TransactionSql is a strict subset).
 */
type TxSql = Sql;

export interface RlsSessionContext {
  /** The authenticated user's entity ID. */
  userId: string;
  /** The tenant the user belongs to. Null for superusers or system operations. */
  tenantId: string | null;
  /**
   * Pipe-delimited list of customer IDs the RM is allowed to access.
   *
   * Set this when querying `wiki_page_versions` to enforce my-customers-only
   * visibility at the database layer via the `wiki_page_versions_rm_isolation`
   * RLS policy.
   *
   * Pass an empty array (or omit) to grant zero wiki access for this session.
   *
   * Issue #50 — RLS-enforced my-customers-only wiki visibility.
   */
  rmCustomerIds?: string[];
  /**
   * Phase 7 scout seam for BDM campaign-analysis sessions.
   *
   * The follow-on BDM issue will thread this through the session binding so a
   * BDM-scoped transaction can be distinguished from an RM-scoped one without
   * changing the underlying app_rw database role yet.
   */
  bdmDepartmentId?: string;
}

/**
 * Escapes a string value for safe embedding in a `SET LOCAL` statement.
 * Replaces single quotes with doubled single quotes (standard SQL escaping).
 */
function escapeConfigValue(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Executes `callback` inside a PostgreSQL transaction that opens with:
 *   SET LOCAL app.current_user_id  = '<userId>'
 *   SET LOCAL app.current_tenant_id = '<tenantId>'
 *
 * The `SET LOCAL` scoping ensures the variables are reset when the transaction
 * ends, so no stale context leaks across requests on the same connection.
 *
 * Restrictive RLS policies on `entities` and `relations` reference these
 * variables via `current_setting('app.current_tenant_id', true)` to enforce
 * that every query can only see rows belonging to the current tenant.
 *
 * @param sqlPool  - A `postgres` connection pool (e.g. `sql` from `db`).
 * @param context  - Session context supplying userId and tenantId.
 * @param callback - A function that receives the transaction client and returns a Promise.
 */
export function withRlsContext<T>(
  sqlPool: Sql,
  context: RlsSessionContext,
  callback: (tx: TxSql) => Promise<T>,
): Promise<T> {
  const { userId, tenantId, rmCustomerIds, bdmDepartmentId } = context;
  return sqlPool.begin(async (tx) => {
    const userIdEsc = escapeConfigValue(userId);
    const tenantIdEsc = tenantId !== null ? escapeConfigValue(tenantId) : '';
    // Pipe-delimited customer IDs for wiki_page_versions_rm_isolation policy.
    // Each ID is escaped individually to guard against injection via customer names.
    const customerIdsEsc =
      rmCustomerIds && rmCustomerIds.length > 0
        ? rmCustomerIds.map(escapeConfigValue).join('|')
        : '';
    await tx.unsafe(`SET LOCAL app.current_user_id = '${userIdEsc}'`);
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantIdEsc}'`);
    await tx.unsafe(`SET LOCAL app.current_rm_customer_ids = '${customerIdsEsc}'`);

    if (bdmDepartmentId !== undefined) {
      await tx.unsafe(
        `SET LOCAL app.current_bdm_department_id = '${escapeConfigValue(bdmDepartmentId)}'`,
      );
    }

    return callback(tx as unknown as Sql);
  }) as unknown as Promise<T>;
}
