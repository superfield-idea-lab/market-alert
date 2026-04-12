/**
 * Scoped single-use worker token auth (issues #36 and #39).
 *
 * Two token families are managed here:
 *
 * 1. Pod-scoped task tokens (scope: 'worker_task') — issue #36
 *    issueWorkerToken produces a short-lived JWT that authorises exactly one
 *    task operation for a specific pod + task scope. The token is consumed on
 *    first use by stamping consumed_at in worker_tokens and inserting the jti
 *    into revoked_tokens; a second use is rejected at the DB layer.
 *
 *    Token payload shape:
 *      { sub: pod_id, agent_type, task_scope, jti, scope: 'worker_task', exp }
 *
 * 2. Wiki-write tokens (scope: 'wiki_write') — issue #39
 *    issueWikiWorkerToken produces a short-lived JWT authorising one draft
 *    WikiPageVersion write for a specific (dept, customer) pair. Single-use
 *    enforcement is done via revoked_tokens alone (no worker_tokens row).
 *
 *    Token payload shape:
 *      { sub: issuedTo, dept, customer, task_id?, jti, scope: 'wiki_write', exp }
 *
 * Pod-terminate invalidation (issue #36):
 *   The caller invokes invalidateWorkerTokensForPod(podId) which stamps
 *   invalidated_at on all still-unused rows for the pod and mirrors each JTI
 *   into revoked_tokens.
 */

import { signJwt, verifyJwt } from './jwt';
import {
  persistWorkerToken,
  consumeWorkerToken,
  invalidateWorkerTokensForPod,
  WORKER_TOKEN_TTL_SECONDS,
  type WorkerTokenRow,
} from 'db/worker-tokens';
import { sql as defaultSql } from 'db';
import type postgres from 'postgres';

export { invalidateWorkerTokensForPod };

/** TTL in hours derived from the canonical seconds constant (issue #36). */
const WORKER_TOKEN_TTL_HOURS = WORKER_TOKEN_TTL_SECONDS / 3600;

/** TTL for wiki-write tokens in hours (1 hour — pod-lifetime). */
const WIKI_WORKER_TOKEN_TTL_HOURS = 1;

// ============================================================================
// Issue #36 — pod-scoped task tokens
// ============================================================================

export interface WorkerTokenPayload {
  /** pod_id — identifies the worker pod that minted the token. */
  sub: string;
  agent_type: string;
  task_scope: string;
  jti: string;
  scope: 'worker_task';
  exp: number;
}

export interface IssueWorkerTokenInput {
  /** Kubernetes pod name or UUID — becomes token.sub. */
  podId: string;
  agentType: string;
  taskScope: string;
}

/**
 * Mint a scoped single-use worker JWT and persist the backing row (issue #36).
 *
 * The JWT is signed with the server's ES256 key. The row is written before
 * the token string is returned so there is no window where a token exists but
 * has no backing row.
 */
export async function issueWorkerToken(input: IssueWorkerTokenInput): Promise<{
  token: string;
  row: WorkerTokenRow;
}> {
  // Sign the JWT first so we have the jti from the signed payload.
  const payload: Omit<WorkerTokenPayload, 'exp' | 'jti'> = {
    sub: input.podId,
    agent_type: input.agentType,
    task_scope: input.taskScope,
    scope: 'worker_task',
  };
  const token = await signJwt(payload, WORKER_TOKEN_TTL_HOURS);

  // Decode the jti from the signed token (signJwt embeds it in the payload).
  const parts = token.split('.');
  const tokenPayload = JSON.parse(
    Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
  ) as WorkerTokenPayload;

  const expiresAt = new Date(tokenPayload.exp * 1000);

  const row = await persistWorkerToken({
    podId: input.podId,
    agentType: input.agentType,
    taskScope: input.taskScope,
    jti: tokenPayload.jti,
    expiresAt,
  });

  return { token, row };
}

export interface VerifyWorkerTokenOptions {
  /** When provided, the token's agent_type must match (optional cross-check). */
  expectedAgentType?: string;
  /** When provided, the token's task_scope must match (optional cross-check). */
  expectedTaskScope?: string;
}

/**
 * Verify a worker token and consume it (single-use enforcement) — issue #36.
 *
 * Returns the token payload on success. Throws on any failure:
 *  - Invalid/expired/revoked JWT
 *  - Wrong scope
 *  - Token already consumed or invalidated
 *  - agent_type / task_scope mismatch (when options supplied)
 */
export async function verifyAndConsumeWorkerToken(
  token: string,
  options: VerifyWorkerTokenOptions = {},
): Promise<WorkerTokenPayload> {
  // Check 1: signature, expiry, and JTI revocation (via isRevoked in verifyJwt).
  const payload = await verifyJwt<WorkerTokenPayload>(token);

  // Check 2: scope pinning.
  if (payload.scope !== 'worker_task') {
    throw new Error('Token scope is not worker_task');
  }

  // Check 3: consume the backing row (enforces single-use + invalidation checks).
  const row = await consumeWorkerToken(payload.jti);
  if (!row) {
    throw new Error('Token already consumed, invalidated, or expired');
  }

  // Check 4: optional agent_type cross-check.
  if (options.expectedAgentType !== undefined && payload.agent_type !== options.expectedAgentType) {
    throw new Error('Token agent_type mismatch');
  }

  // Check 5: optional task_scope cross-check.
  if (options.expectedTaskScope !== undefined && payload.task_scope !== options.expectedTaskScope) {
    throw new Error('Token task_scope mismatch');
  }

  return payload;
}

// ============================================================================
// Issue #39 — wiki-write tokens (dept/customer-scoped)
// ============================================================================

export interface WikiWorkerTokenPayload {
  sub: string;
  dept: string;
  customer: string;
  task_id?: string;
  jti: string;
  scope: 'wiki_write';
  exp: number;
}

export interface IssueWikiWorkerTokenInput {
  /** Actor issuing the token (user or service identity). */
  issuedTo: string;
  dept: string;
  customer: string;
  taskId?: string;
  /** Optional SQL pool — defaults to the global app pool. */
  sql?: postgres.Sql;
}

/**
 * Issue a single-use scoped wiki-write JWT for the given (dept, customer) pair.
 *
 * The token is signed with the shared EC key used by the rest of the
 * application. Its TTL is 1 hour from issuance. The jti is a random UUID to
 * support JTI-based single-use enforcement via revoked_tokens.
 *
 * Note: this token family does NOT write to worker_tokens (which is scoped to
 * pod-based task tokens from issue #36). Single-use is enforced purely via
 * revoked_tokens — no separate issuance log row is created.
 */
export async function issueWikiWorkerToken(input: IssueWikiWorkerTokenInput): Promise<string> {
  const jti = crypto.randomUUID();
  const payload: Omit<WikiWorkerTokenPayload, 'exp'> = {
    sub: input.issuedTo,
    dept: input.dept,
    customer: input.customer,
    jti,
    scope: 'wiki_write',
    ...(input.taskId ? { task_id: input.taskId } : {}),
  };

  return signJwt(payload, WIKI_WORKER_TOKEN_TTL_HOURS);
}

export interface VerifyWikiWorkerTokenOptions {
  /** Expected dept — must match token.dept (check 4). */
  expectedDept: string;
  /** Expected customer — must match token.customer (check 5). */
  expectedCustomer: string;
  /** Optional SQL pool — defaults to the global app pool. */
  sql?: postgres.Sql;
}

/**
 * Verifies a scoped wiki-write worker token against all checks described in
 * issue #39.
 *
 * On success the jti is inserted into revoked_tokens so the token cannot be
 * reused. Throws a descriptive Error on any failed check.
 */
export async function verifyWorkerToken(
  token: string,
  options: VerifyWikiWorkerTokenOptions,
): Promise<WikiWorkerTokenPayload> {
  const db = options.sql ?? defaultSql;

  // Check 1: signature valid (verifyJwt also checks exp)
  const payload = await verifyJwt<WikiWorkerTokenPayload>(token);

  // Check 2: scope must be 'wiki_write'
  if (payload.scope !== 'wiki_write') {
    throw new Error('Token scope is not wiki_write');
  }

  // Check 3: JTI not already revoked (consumed)
  const revoked = await db<{ jti: string }[]>`
    SELECT jti FROM revoked_tokens WHERE jti = ${payload.jti}
  `;
  if (revoked.length > 0) {
    throw new Error('Token already used');
  }

  // Check 4: dept matches
  if (payload.dept !== options.expectedDept) {
    throw new Error('Token dept mismatch');
  }

  // Check 5: customer matches
  if (payload.customer !== options.expectedCustomer) {
    throw new Error('Token customer mismatch');
  }

  // Consume: insert jti into revoked_tokens so this token cannot be reused.
  const expiresAt = new Date(payload.exp * 1000).toISOString();
  await db`
    INSERT INTO revoked_tokens (jti, expires_at)
    VALUES (${payload.jti}, ${expiresAt})
    ON CONFLICT (jti) DO NOTHING
  `;

  return payload;
}
