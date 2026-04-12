/**
 * Integration tests for M-of-N approval for privileged operations (issue #24).
 *
 * All tests run against a real ephemeral Postgres container.
 * No mocks — zero vi.fn / vi.mock / vi.spyOn.
 *
 * Covers:
 *   - A privileged operation cannot execute with fewer than M approvals
 *   - Once M approvals are collected the request transitions to 'approved'
 *   - Approval and rejection events are audited
 *   - Direct execution paths are blocked (assertApproved throws when not approved)
 *   - Rejected operations cannot be executed
 *   - markExecuted transitions 'approved' → 'executed'
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate } from './index';
import {
  createApprovalRequest,
  castVote,
  markExecuted,
  getApprovalRequest,
  listApprovalRequests,
  assertApproved,
  type ApprovalAuditWriterFn,
  type ApprovalRequest,
} from './approvals';

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;
let auditSql: ReturnType<typeof postgres>;

// ---------------------------------------------------------------------------
// Minimal inline audit hash — mirrors audit-service.ts without depending on core
// ---------------------------------------------------------------------------
async function computeAuditHash(
  prevHash: string,
  payload: {
    actor_id: string;
    action: string;
    entity_type: string;
    entity_id: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    ts: string;
  },
): Promise<string> {
  const data =
    prevHash +
    `{"actor_id":${JSON.stringify(payload.actor_id)},"action":${JSON.stringify(payload.action)},"entity_type":${JSON.stringify(payload.entity_type)},"entity_id":${JSON.stringify(payload.entity_id)},"before":${JSON.stringify(payload.before)},"after":${JSON.stringify(payload.after)},"ts":${JSON.stringify(payload.ts)}}`;
  const enc = new TextEncoder();
  const buf = enc.encode(data);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function makeAuditWriter(): ApprovalAuditWriterFn {
  return async (event) => {
    const reserved = await auditSql.reserve();
    try {
      await reserved.unsafe('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const latestRows = (await reserved.unsafe(
        'SELECT hash FROM audit_events ORDER BY ts DESC, id DESC LIMIT 1 FOR UPDATE',
      )) as unknown as { hash: string }[];
      const genesisHash = '0'.repeat(64);
      const prevHash = latestRows[0]?.hash ?? genesisHash;
      const hash = await computeAuditHash(prevHash, {
        actor_id: event.actor_id,
        action: event.action,
        entity_type: event.entity_type,
        entity_id: event.entity_id,
        before: event.before,
        after: event.after,
        ts: event.ts,
      });
      await reserved.unsafe(
        `INSERT INTO audit_events
           (actor_id, action, entity_type, entity_id, before, after, ts, prev_hash, hash)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::timestamptz, $8, $9)`,
        [
          event.actor_id,
          event.action,
          event.entity_type,
          event.entity_id,
          event.before as unknown as string,
          event.after as unknown as string,
          event.ts,
          prevHash,
          hash,
        ],
      );
      await reserved.unsafe('COMMIT');
    } catch (err) {
      await reserved.unsafe('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      reserved.release();
    }
  };
}

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5 });
  auditSql = postgres(pg.url, { max: 3 });

  // Apply main schema (includes approval_requests, approval_votes tables)
  await migrate({ databaseUrl: pg.url });

  // Create the audit_events table in the same test database
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before JSONB,
      after JSONB,
      ip TEXT,
      user_agent TEXT,
      correlation_id TEXT,
      ts TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    )
  `);
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await auditSql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// createApprovalRequest
// ---------------------------------------------------------------------------

describe('createApprovalRequest', () => {
  test('creates a pending approval request with correct fields', async () => {
    const request = await createApprovalRequest(sql, {
      operation_type: 'bulk_export',
      payload: { tenant_id: 'tenant-001' },
      requested_by: 'user-001',
      required_approvals: 2,
    });

    expect(request.id).toBeTruthy();
    expect(request.operation_type).toBe('bulk_export');
    expect(request.requested_by).toBe('user-001');
    expect(request.required_approvals).toBe(2);
    expect(request.status).toBe('pending');
    expect(request.payload).toMatchObject({ tenant_id: 'tenant-001' });
  });

  test('rejects unknown operation types', async () => {
    await expect(
      createApprovalRequest(sql, {
        operation_type: 'drop_all_tables' as 'bulk_export',
        payload: {},
        requested_by: 'user-001',
      }),
    ).rejects.toThrow(/Unknown privileged operation type/);
  });

  test('emits an audit event on creation', async () => {
    const auditWriter = makeAuditWriter();
    const request = await createApprovalRequest(
      sql,
      {
        operation_type: 'root_key_rotate',
        payload: {},
        requested_by: 'user-audit-001',
        required_approvals: 1,
      },
      auditWriter,
    );

    const auditRows = await auditSql<{ action: string }[]>`
      SELECT action FROM audit_events
      WHERE entity_id = ${request.id}
        AND action = 'approval_request.create'
    `;
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// castVote — M-1 approvals do not allow execution
// ---------------------------------------------------------------------------

describe('castVote — quorum not yet reached', () => {
  test('M-1 approvals: request stays pending, assertApproved throws', async () => {
    const request = await createApprovalRequest(sql, {
      operation_type: 'bulk_export',
      payload: {},
      requested_by: 'user-002',
      required_approvals: 2,
    });

    // Cast 1 approval (M-1 = 1)
    const result = await castVote(sql, {
      request_id: request.id,
      approver_id: 'approver-001',
      decision: 'approved',
    });

    expect(result.vote.decision).toBe('approved');
    expect(result.request.status).toBe('pending');
    expect(result.quorum_reached).toBe(false);

    // assertApproved must throw — request is still pending
    await expect(assertApproved(sql, request.id)).rejects.toThrow(/not 'approved'/);
  });
});

// ---------------------------------------------------------------------------
// castVote — quorum reached
// ---------------------------------------------------------------------------

describe('castVote — quorum reached', () => {
  test('collecting M approvals transitions to approved and permits execution', async () => {
    const auditWriter = makeAuditWriter();

    const request = await createApprovalRequest(
      sql,
      {
        operation_type: 'bulk_export',
        payload: { dataset: 'full' },
        requested_by: 'user-003',
        required_approvals: 2,
      },
      auditWriter,
    );

    // First approval — still pending
    const first = await castVote(
      sql,
      { request_id: request.id, approver_id: 'approver-A', decision: 'approved' },
      auditWriter,
    );
    expect(first.request.status).toBe('pending');
    expect(first.quorum_reached).toBe(false);

    // Second approval — quorum reached
    const second = await castVote(
      sql,
      { request_id: request.id, approver_id: 'approver-B', decision: 'approved' },
      auditWriter,
    );
    expect(second.request.status).toBe('approved');
    expect(second.quorum_reached).toBe(true);

    // assertApproved must now succeed
    const approved = await assertApproved(sql, request.id);
    expect(approved.status).toBe('approved');

    // Audit events for approval votes must exist
    const voteAuditRows = await auditSql<{ action: string }[]>`
      SELECT action FROM audit_events
      WHERE entity_id = ${request.id}
        AND action LIKE 'approval_request.%'
    `;
    expect(voteAuditRows.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// castVote — rejection
// ---------------------------------------------------------------------------

describe('castVote — rejection', () => {
  test('a rejection immediately transitions to rejected and blocks execution', async () => {
    const auditWriter = makeAuditWriter();

    const request = await createApprovalRequest(
      sql,
      {
        operation_type: 'root_key_rotate',
        payload: {},
        requested_by: 'user-004',
        required_approvals: 2,
      },
      auditWriter,
    );

    // One approver approves
    await castVote(
      sql,
      { request_id: request.id, approver_id: 'approver-X', decision: 'approved' },
      auditWriter,
    );

    // Another approver rejects
    const rejectedResult = await castVote(
      sql,
      {
        request_id: request.id,
        approver_id: 'approver-Y',
        decision: 'rejected',
        comment: 'Not authorised at this time',
      },
      auditWriter,
    );

    expect(rejectedResult.request.status).toBe('rejected');
    expect(rejectedResult.quorum_reached).toBe(false);

    // assertApproved must throw
    await expect(assertApproved(sql, request.id)).rejects.toThrow(/not 'approved'/);

    // markExecuted must throw
    await expect(markExecuted(sql, request.id, 'user-004', auditWriter)).rejects.toThrow(
      /cannot be executed/,
    );

    // Rejection vote audit event must exist
    const rejectionAuditRows = await auditSql<{ action: string }[]>`
      SELECT action FROM audit_events
      WHERE entity_id = ${request.id}
        AND action = 'approval_request.rejected'
    `;
    expect(rejectionAuditRows.length).toBeGreaterThanOrEqual(1);
  });

  test('further votes are blocked after rejection', async () => {
    const request = await createApprovalRequest(sql, {
      operation_type: 'bulk_export',
      payload: {},
      requested_by: 'user-005',
      required_approvals: 2,
    });

    // Reject immediately
    await castVote(sql, {
      request_id: request.id,
      approver_id: 'approver-Z',
      decision: 'rejected',
    });

    // A subsequent vote must fail — request is no longer pending
    await expect(
      castVote(sql, {
        request_id: request.id,
        approver_id: 'approver-W',
        decision: 'approved',
      }),
    ).rejects.toThrow(/not pending/);
  });
});

// ---------------------------------------------------------------------------
// castVote — duplicate vote prevention
// ---------------------------------------------------------------------------

describe('castVote — duplicate vote', () => {
  test('an approver cannot vote twice on the same request', async () => {
    const request = await createApprovalRequest(sql, {
      operation_type: 'bulk_export',
      payload: {},
      requested_by: 'user-006',
      required_approvals: 3,
    });

    await castVote(sql, {
      request_id: request.id,
      approver_id: 'double-voter',
      decision: 'approved',
    });

    await expect(
      castVote(sql, {
        request_id: request.id,
        approver_id: 'double-voter',
        decision: 'approved',
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// markExecuted
// ---------------------------------------------------------------------------

describe('markExecuted', () => {
  test('transitions approved request to executed and audits the event', async () => {
    const auditWriter = makeAuditWriter();

    const request = await createApprovalRequest(
      sql,
      {
        operation_type: 'root_key_rotate',
        payload: {},
        requested_by: 'user-007',
        required_approvals: 1,
      },
      auditWriter,
    );

    await castVote(
      sql,
      { request_id: request.id, approver_id: 'approver-exec', decision: 'approved' },
      auditWriter,
    );

    const executed = await markExecuted(sql, request.id, 'user-007', auditWriter);
    expect(executed.status).toBe('executed');

    // Request can no longer be used — assertApproved must throw
    await expect(assertApproved(sql, request.id)).rejects.toThrow(/already been executed/);

    // Execution audit event must exist
    const execAuditRows = await auditSql<{ action: string }[]>`
      SELECT action FROM audit_events
      WHERE entity_id = ${request.id}
        AND action = 'approval_request.executed'
    `;
    expect(execAuditRows.length).toBeGreaterThanOrEqual(1);
  });

  test('throws when trying to execute a pending request', async () => {
    const request = await createApprovalRequest(sql, {
      operation_type: 'bulk_export',
      payload: {},
      requested_by: 'user-008',
      required_approvals: 2,
    });

    await expect(markExecuted(sql, request.id, 'user-008')).rejects.toThrow(/cannot be executed/);
  });
});

// ---------------------------------------------------------------------------
// getApprovalRequest and listApprovalRequests
// ---------------------------------------------------------------------------

describe('getApprovalRequest', () => {
  test('returns the request with vote details and tallies', async () => {
    const request = await createApprovalRequest(sql, {
      operation_type: 'bulk_export',
      payload: {},
      requested_by: 'user-009',
      required_approvals: 3,
    });

    await castVote(sql, {
      request_id: request.id,
      approver_id: 'tally-approver-A',
      decision: 'approved',
    });

    await castVote(sql, {
      request_id: request.id,
      approver_id: 'tally-approver-B',
      decision: 'rejected',
    });

    const result = await getApprovalRequest(sql, request.id);
    expect(result).not.toBeNull();
    expect(result!.votes).toHaveLength(2);
    // After rejection, status is 'rejected'
    expect(result!.status).toBe('rejected');
    expect(result!.approval_count).toBe(1);
    expect(result!.rejection_count).toBe(1);
  });

  test('returns null for a non-existent request', async () => {
    const result = await getApprovalRequest(sql, 'nonexistent-id-000');
    expect(result).toBeNull();
  });
});

describe('listApprovalRequests', () => {
  test('filters by status correctly', async () => {
    // Create two requests — one will be approved, one stays pending
    const pending = await createApprovalRequest(sql, {
      operation_type: 'bulk_export',
      payload: {},
      requested_by: 'user-010',
      required_approvals: 5, // very high, stays pending
    });

    const singleApproval = await createApprovalRequest(sql, {
      operation_type: 'root_key_rotate',
      payload: {},
      requested_by: 'user-010',
      required_approvals: 1,
    });
    await castVote(sql, {
      request_id: singleApproval.id,
      approver_id: 'list-approver',
      decision: 'approved',
    });

    const pendingList = await listApprovalRequests(sql, { status: 'pending' });
    const approvedList = await listApprovalRequests(sql, { status: 'approved' });

    const pendingIds = pendingList.map((r: ApprovalRequest) => r.id);
    const approvedIds = approvedList.map((r: ApprovalRequest) => r.id);

    expect(pendingIds).toContain(pending.id);
    expect(approvedIds).toContain(singleApproval.id);
  });
});
