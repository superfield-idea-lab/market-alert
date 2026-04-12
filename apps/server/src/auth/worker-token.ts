/**
 * Scoped single-use worker token auth (issue #36).
 *
 * issueWorkerToken produces a short-lived JWT that authorises exactly one
 * wiki-write operation for a specific pod + task scope.  The token is consumed
 * on first use by stamping consumed_at in worker_tokens and inserting the jti
 * into revoked_tokens; a second use is rejected at the DB layer.
 *
 * Token payload shape:
 *   { sub: pod_id, agent_type, task_scope, jti, scope: 'worker_task', exp }
 *
 * Verification checks (in order):
 *   1. Signature valid (ES256)
 *   2. scope === 'worker_task'
 *   3. JTI present in worker_tokens and not consumed/invalidated/expired
 *   4. token.agent_type matches expected (optional caller check)
 *   5. token.task_scope matches expected (optional caller check)
 *
 * Pod-terminate invalidation:
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

export { invalidateWorkerTokensForPod };

/** TTL in hours derived from the canonical seconds constant. */
const WORKER_TOKEN_TTL_HOURS = WORKER_TOKEN_TTL_SECONDS / 3600;

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
 * Mint a scoped single-use worker JWT and persist the backing row.
 *
 * The JWT is signed with the server's ES256 key.  The row is written before
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
 * Verify a worker token and consume it (single-use enforcement).
 *
 * Returns the token payload on success.  Throws on any failure:
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
