/**
 * @file worker-tokens.test.ts
 *
 * Integration tests for the scoped single-use worker token DB layer (issue #36).
 *
 * Validates:
 *  - persistWorkerToken stores a row with correct fields
 *  - consumeWorkerToken returns the row on first call and null on second call
 *  - consumeWorkerToken returns null for an expired token
 *  - consumeWorkerToken returns null for an invalidated token
 *  - consumeWorkerToken mirrors JTI into revoked_tokens on consumption
 *  - invalidateWorkerTokensForPod stamps invalidated_at on all unused rows
 *    and mirrors JTIs into revoked_tokens
 *  - fetchWorkerTokenByJti retrieves a stored row
 *
 * No mocks — real ephemeral Postgres via pg-container.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate } from './index';
import {
  persistWorkerToken,
  consumeWorkerToken,
  invalidateWorkerTokensForPod,
  fetchWorkerTokenByJti,
} from './worker-tokens';

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5 });
  await migrate({ databaseUrl: pg.url });
}, 60_000);

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeJti(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------

describe('persistWorkerToken', () => {
  test('stores a row with correct fields', async () => {
    const jti = makeJti();
    const expires = new Date(Date.now() + 3600 * 1000);

    const row = await persistWorkerToken({
      podId: 'pod-persist-1',
      agentType: 'coding',
      taskScope: 'task-persist-1',
      jti,
      expiresAt: expires,
      sql,
    });

    expect(row.pod_id).toBe('pod-persist-1');
    expect(row.agent_type).toBe('coding');
    expect(row.task_scope).toBe('task-persist-1');
    expect(row.jti).toBe(jti);
    expect(row.consumed_at).toBeNull();
    expect(row.invalidated_at).toBeNull();
    expect(new Date(row.expires_at).getTime()).toBeCloseTo(expires.getTime(), -3);
  });
});

// ---------------------------------------------------------------------------

describe('consumeWorkerToken', () => {
  test('returns the row on first call', async () => {
    const jti = makeJti();
    await persistWorkerToken({
      podId: 'pod-consume-1',
      agentType: 'coding',
      taskScope: 'task-consume-1',
      jti,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      sql,
    });

    const result = await consumeWorkerToken(jti, sql);
    expect(result).not.toBeNull();
    expect(result!.jti).toBe(jti);
    expect(result!.consumed_at).not.toBeNull();
  });

  test('returns null on second call (single-use enforcement)', async () => {
    const jti = makeJti();
    await persistWorkerToken({
      podId: 'pod-consume-2',
      agentType: 'coding',
      taskScope: 'task-consume-2',
      jti,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      sql,
    });

    const first = await consumeWorkerToken(jti, sql);
    expect(first).not.toBeNull();

    const second = await consumeWorkerToken(jti, sql);
    expect(second).toBeNull();
  });

  test('returns null for an expired token', async () => {
    const jti = makeJti();
    // expires_at in the past
    await persistWorkerToken({
      podId: 'pod-consume-exp',
      agentType: 'coding',
      taskScope: 'task-consume-exp',
      jti,
      expiresAt: new Date(Date.now() - 1000),
      sql,
    });

    const result = await consumeWorkerToken(jti, sql);
    expect(result).toBeNull();
  });

  test('returns null for an invalidated token', async () => {
    const jti = makeJti();
    const podId = `pod-invalidated-${Date.now()}`;
    await persistWorkerToken({
      podId,
      agentType: 'coding',
      taskScope: 'task-inv-1',
      jti,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      sql,
    });

    // Invalidate via pod terminate
    await invalidateWorkerTokensForPod(podId, sql);

    const result = await consumeWorkerToken(jti, sql);
    expect(result).toBeNull();
  });

  test('mirrors JTI into revoked_tokens on consumption', async () => {
    const jti = makeJti();
    await persistWorkerToken({
      podId: 'pod-revoke-1',
      agentType: 'coding',
      taskScope: 'task-revoke-1',
      jti,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      sql,
    });

    await consumeWorkerToken(jti, sql);

    const revoked = await sql<{ jti: string }[]>`
      SELECT jti FROM revoked_tokens WHERE jti = ${jti}
    `;
    expect(revoked.length).toBe(1);
    expect(revoked[0].jti).toBe(jti);
  });
});

// ---------------------------------------------------------------------------

describe('invalidateWorkerTokensForPod', () => {
  test('invalidates all unused tokens for the pod', async () => {
    const podId = `pod-inv-multi-${Date.now()}`;
    const jti1 = makeJti();
    const jti2 = makeJti();

    await persistWorkerToken({
      podId,
      agentType: 'coding',
      taskScope: 'task-inv-a',
      jti: jti1,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      sql,
    });
    await persistWorkerToken({
      podId,
      agentType: 'coding',
      taskScope: 'task-inv-b',
      jti: jti2,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      sql,
    });

    const count = await invalidateWorkerTokensForPod(podId, sql);
    expect(count).toBe(2);
  });

  test('returns 0 when no active tokens exist', async () => {
    const count = await invalidateWorkerTokensForPod(`pod-empty-${Date.now()}`, sql);
    expect(count).toBe(0);
  });

  test('mirrors invalidated JTIs into revoked_tokens', async () => {
    const podId = `pod-inv-rev-${Date.now()}`;
    const jti = makeJti();
    await persistWorkerToken({
      podId,
      agentType: 'coding',
      taskScope: 'task-inv-rev',
      jti,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      sql,
    });

    await invalidateWorkerTokensForPod(podId, sql);

    const revoked = await sql<{ jti: string }[]>`
      SELECT jti FROM revoked_tokens WHERE jti = ${jti}
    `;
    expect(revoked.length).toBe(1);
  });

  test('does not invalidate tokens for a different pod', async () => {
    const podA = `pod-iso-A-${Date.now()}`;
    const podB = `pod-iso-B-${Date.now()}`;
    const jtiA = makeJti();
    const jtiB = makeJti();

    await persistWorkerToken({
      podId: podA,
      agentType: 'coding',
      taskScope: 'task-iso-a',
      jti: jtiA,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      sql,
    });
    await persistWorkerToken({
      podId: podB,
      agentType: 'coding',
      taskScope: 'task-iso-b',
      jti: jtiB,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      sql,
    });

    // Invalidate only pod B
    const count = await invalidateWorkerTokensForPod(podB, sql);
    expect(count).toBe(1);

    // Pod A's token should still be consumable
    const result = await consumeWorkerToken(jtiA, sql);
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('fetchWorkerTokenByJti', () => {
  test('returns the row for a known JTI', async () => {
    const jti = makeJti();
    await persistWorkerToken({
      podId: 'pod-fetch-1',
      agentType: 'coding',
      taskScope: 'task-fetch-1',
      jti,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      sql,
    });

    const row = await fetchWorkerTokenByJti(jti, sql);
    expect(row).not.toBeNull();
    expect(row!.jti).toBe(jti);
  });

  test('returns null for an unknown JTI', async () => {
    const row = await fetchWorkerTokenByJti(makeJti(), sql);
    expect(row).toBeNull();
  });
});
