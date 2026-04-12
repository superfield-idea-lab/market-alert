/**
 * @file worker-tokens.ts
 *
 * Scoped single-use worker token store (issue #36).
 *
 * Each token is minted for a specific pod + task scope combination.
 * Tokens are single-use: consumed_at is stamped on first use and any
 * subsequent use is rejected.  Pod-terminate invalidates all still-unused
 * tokens for the given pod.
 *
 * Security model
 * ---------------
 * - A token is bound to one pod_id and one task_scope.
 * - The token carries a JTI which is inserted into revoked_tokens on consumption
 *   so the JWT layer also rejects replayed tokens.
 * - expires_at enforces the pod-lifetime TTL ceiling.
 * - Pod terminate calls invalidateWorkerTokensForPod() which stamps
 *   invalidated_at on all unused rows for the pod.
 *
 * Injectable sql
 * ---------------
 * All exported functions accept an optional `sqlClient` parameter so that
 * tests can pass an ephemeral Postgres connection without affecting the
 * module-level singleton.  Production callers omit the parameter and the
 * module-level pool (from ./index) is used automatically.
 */

import { sql as defaultSql } from './index';
import type postgres from 'postgres';

/** TTL for worker tokens in seconds — 1 hour default (pod lifetime ceiling). */
export const WORKER_TOKEN_TTL_SECONDS = 60 * 60;

/** Minimal sql-tagged-template type accepted by all exported functions. */
export type SqlClient = postgres.Sql;

export interface WorkerTokenRow {
  id: string;
  pod_id: string;
  agent_type: string;
  task_scope: string;
  jti: string;
  expires_at: Date;
  consumed_at: Date | null;
  invalidated_at: Date | null;
  created_at: Date;
}

export interface MintWorkerTokenOptions {
  podId: string;
  agentType: string;
  taskScope: string;
  /** JTI from the signed JWT — stored here for cross-reference. */
  jti: string;
  /** Token expiry (defaults to WORKER_TOKEN_TTL_SECONDS from now). */
  expiresAt?: Date;
  /** Optional sql client override (for tests). */
  sql?: SqlClient;
}

/**
 * Persist a newly minted worker token row.
 *
 * Called by the mint endpoint after signing the JWT so the token is
 * registered before the response leaves the server.
 */
export async function persistWorkerToken(options: MintWorkerTokenOptions): Promise<WorkerTokenRow> {
  const db = options.sql ?? defaultSql;
  const expiresAt = options.expiresAt ?? new Date(Date.now() + WORKER_TOKEN_TTL_SECONDS * 1000);

  const rows = await db<WorkerTokenRow[]>`
    INSERT INTO worker_tokens (pod_id, agent_type, task_scope, jti, expires_at)
    VALUES (${options.podId}, ${options.agentType}, ${options.taskScope}, ${options.jti}, ${expiresAt})
    RETURNING *
  `;
  return rows[0];
}

/**
 * Mark a token as consumed (single-use enforcement).
 *
 * Returns the updated row, or null when the token does not exist, has already
 * been consumed, has been invalidated, or has expired.  The caller must treat
 * null as a rejection.
 *
 * The JTI is also inserted into revoked_tokens so the JWT layer rejects any
 * further use even if the worker_tokens row is unavailable.
 */
export async function consumeWorkerToken(
  jti: string,
  sqlClient?: SqlClient,
): Promise<WorkerTokenRow | null> {
  const db = sqlClient ?? defaultSql;
  const rows = await db<WorkerTokenRow[]>`
    UPDATE worker_tokens
    SET consumed_at = NOW()
    WHERE jti = ${jti}
      AND consumed_at IS NULL
      AND invalidated_at IS NULL
      AND expires_at > NOW()
    RETURNING *
  `;

  if (rows.length === 0) return null;

  const row = rows[0];

  // Mirror into revoked_tokens so verifyJwt's isRevoked check also blocks replay.
  await db`
    INSERT INTO revoked_tokens (jti, expires_at)
    VALUES (${row.jti}, ${row.expires_at})
    ON CONFLICT (jti) DO NOTHING
  `;

  return row;
}

/**
 * Invalidate all unused tokens for the given pod.
 *
 * Called on pod-terminate to ensure tokens that were never consumed cannot be
 * used after the pod has stopped running.
 *
 * Returns the number of rows invalidated.
 */
export async function invalidateWorkerTokensForPod(
  podId: string,
  sqlClient?: SqlClient,
): Promise<number> {
  const db = sqlClient ?? defaultSql;
  const rows = await db<{ jti: string; expires_at: Date }[]>`
    UPDATE worker_tokens
    SET invalidated_at = NOW()
    WHERE pod_id = ${podId}
      AND consumed_at IS NULL
      AND invalidated_at IS NULL
    RETURNING jti, expires_at
  `;

  if (rows.length === 0) return 0;

  // Mirror each invalidated JTI into revoked_tokens.
  for (const { jti, expires_at } of rows) {
    await db`
      INSERT INTO revoked_tokens (jti, expires_at)
      VALUES (${jti}, ${expires_at})
      ON CONFLICT (jti) DO NOTHING
    `;
  }

  return rows.length;
}

/**
 * Fetch a worker token row by JTI.
 *
 * Used by the verify path to obtain the stored scope metadata for cross-checks.
 * Returns null when no row matches.
 */
export async function fetchWorkerTokenByJti(
  jti: string,
  sqlClient?: SqlClient,
): Promise<WorkerTokenRow | null> {
  const db = sqlClient ?? defaultSql;
  const rows = await db<WorkerTokenRow[]>`
    SELECT * FROM worker_tokens WHERE jti = ${jti} LIMIT 1
  `;
  return rows[0] ?? null;
}
