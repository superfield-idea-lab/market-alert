/**
 * @file trace
 * Database-level trace ID propagation.
 *
 * `withTraceId()` wraps a database operation in a transaction that first sets
 * the PostgreSQL session variable `app.trace_id` to the provided trace ID.
 * The variable is visible in `pg_stat_activity.query` and appears in
 * PostgreSQL statement logs, making it trivial to correlate a DB query with
 * the HTTP request that triggered it.
 *
 * Usage:
 * ```ts
 * import { withTraceId, sql } from 'db';
 *
 * const rows = await withTraceId(sql, traceId, async (tx) => {
 *   return tx<Row[]>`SELECT * FROM entities WHERE id = ${id}`;
 * });
 * ```
 */

import postgres from 'postgres';

type Sql = postgres.Sql;
type TransactionSql = postgres.TransactionSql;

/**
 * Executes `callback` inside a PostgreSQL transaction that opens with
 * `SET LOCAL app.trace_id = '<traceId>'`.
 *
 * The `SET LOCAL` scoping means the variable is automatically reset when the
 * transaction ends, so there is no risk of leaking a stale trace ID into
 * subsequent queries on the same connection.
 *
 * @param sqlPool  - A `postgres` connection pool (sql / auditSql / analyticsSql).
 * @param traceId  - The trace ID for this request.
 * @param callback - A function that receives the transaction client and returns a Promise.
 */
export function withTraceId<T>(
  sqlPool: Sql,
  traceId: string,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  // postgres's begin() signature uses UnwrapPromiseArray<T> as the return type,
  // but at runtime the resolved value matches T for all our use-cases (the
  // callback returns a plain Promise<T> rather than an array-of-promises).
  // We cast here to keep the public API ergonomic without duplicating the
  // complex UnwrapPromiseArray helper type from the postgres library.
  return sqlPool.begin((tx: TransactionSql) => {
    return tx
      .unsafe(`SET LOCAL app.trace_id = '${traceId.replace(/'/g, "''")}'`)
      .then(() => callback(tx));
  }) as unknown as Promise<T>;
}
