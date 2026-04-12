/**
 * @file approvals
 *
 * M-of-N approval data layer for privileged operations (issue #24).
 *
 * Protected operation types:
 *   - 'root_key_rotate' — KMS root-key rotation
 *   - 'bulk_export'     — bulk data export
 *
 * A privileged operation cannot execute until at least `required_approvals`
 * (M) designated approvers have cast an 'approved' vote.  A single 'rejected'
 * vote from any approver transitions the request to 'rejected', permanently
 * blocking execution.
 *
 * State machine:
 *   pending → (approved | rejected) → executed   (only from 'approved')
 *
 * All state transitions are recorded via the audit-log callback injected by
 * the server layer to keep this package free of a direct `core` dependency.
 *
 * Canonical docs: docs/implementation-plan-v1.md
 * Blueprint reference: calypso-blueprint/rules/blueprints/auth.yaml
 */

import postgres from 'postgres';

// ---------------------------------------------------------------------------
// Internal type alias
// ---------------------------------------------------------------------------

type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executed';
export type ApprovalDecision = 'approved' | 'rejected';

/** The set of operation types that require M-of-N approval. */
export const PRIVILEGED_OPERATIONS = ['root_key_rotate', 'bulk_export', 'enable_worm'] as const;
export type PrivilegedOperationType = (typeof PRIVILEGED_OPERATIONS)[number];

export interface ApprovalRequest {
  id: string;
  operation_type: string;
  payload: Record<string, unknown>;
  requested_by: string;
  required_approvals: number;
  status: ApprovalStatus;
  created_at: string;
  updated_at: string;
}

export interface ApprovalVote {
  id: string;
  request_id: string;
  approver_id: string;
  decision: ApprovalDecision;
  comment: string | null;
  created_at: string;
}

export interface ApprovalRequestWithVotes extends ApprovalRequest {
  votes: ApprovalVote[];
  approval_count: number;
  rejection_count: number;
}

// ---------------------------------------------------------------------------
// Audit writer callback (mirrors governance.ts pattern)
// ---------------------------------------------------------------------------

export type ApprovalAuditWriterFn = (event: {
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ts: string;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// createApprovalRequest
// ---------------------------------------------------------------------------

export interface CreateApprovalRequestInput {
  operation_type: PrivilegedOperationType;
  /** Operation-specific parameters required at execution time. */
  payload: Record<string, unknown>;
  requested_by: string;
  /**
   * M — number of approvals required before the operation may execute.
   * Defaults to 2.
   */
  required_approvals?: number;
}

/**
 * Creates a new pending approval request for a privileged operation.
 *
 * @throws if `operation_type` is not in PRIVILEGED_OPERATIONS.
 */
export async function createApprovalRequest(
  sql: SqlClient,
  input: CreateApprovalRequestInput,
  auditWriter?: ApprovalAuditWriterFn,
): Promise<ApprovalRequest> {
  if (!PRIVILEGED_OPERATIONS.includes(input.operation_type)) {
    throw new Error(
      `Unknown privileged operation type: ${input.operation_type}. ` +
        `Must be one of: ${PRIVILEGED_OPERATIONS.join(', ')}`,
    );
  }

  const requiredApprovals = input.required_approvals ?? 2;
  if (requiredApprovals < 1) {
    throw new Error('required_approvals must be at least 1');
  }

  const [row] = await sql<ApprovalRequest[]>`
    INSERT INTO approval_requests (operation_type, payload, requested_by, required_approvals)
    VALUES (
      ${input.operation_type},
      ${sql.json(input.payload as never)},
      ${input.requested_by},
      ${requiredApprovals}
    )
    RETURNING id, operation_type, payload, requested_by, required_approvals,
              status, created_at, updated_at
  `;

  if (auditWriter) {
    await auditWriter({
      actor_id: input.requested_by,
      action: 'approval_request.create',
      entity_type: 'approval_request',
      entity_id: row.id,
      before: null,
      after: {
        operation_type: row.operation_type,
        required_approvals: row.required_approvals,
        status: row.status,
      },
      ts: new Date().toISOString(),
    }).catch((err) =>
      console.warn('[approvals] audit write failed for approval_request.create:', err),
    );
  }

  return row;
}

// ---------------------------------------------------------------------------
// castVote
// ---------------------------------------------------------------------------

export interface CastVoteInput {
  request_id: string;
  approver_id: string;
  decision: ApprovalDecision;
  comment?: string;
}

export interface CastVoteResult {
  vote: ApprovalVote;
  /** The updated state of the request after this vote was applied. */
  request: ApprovalRequest;
  /** True when this vote caused the request to transition to 'approved'. */
  quorum_reached: boolean;
}

/**
 * Records an approval or rejection vote on a pending request.
 *
 * Business rules enforced:
 *   1. The request must be in 'pending' status.
 *   2. Each approver may only cast one vote per request.
 *   3. A 'rejected' vote immediately transitions the request to 'rejected'.
 *   4. When the approval vote count reaches `required_approvals` the request
 *      transitions to 'approved' (ready for execution).
 *
 * @throws if the request is not found or is not in 'pending' status.
 * @throws if the approver has already voted on this request.
 */
export async function castVote(
  sql: SqlClient,
  input: CastVoteInput,
  auditWriter?: ApprovalAuditWriterFn,
): Promise<CastVoteResult> {
  // Fetch the request — lock for update to prevent concurrent vote races
  const [request] = await sql<ApprovalRequest[]>`
    SELECT id, operation_type, payload, requested_by, required_approvals,
           status, created_at, updated_at
    FROM approval_requests
    WHERE id = ${input.request_id}
    FOR UPDATE
  `;

  if (!request) {
    throw new Error(`Approval request not found: ${input.request_id}`);
  }

  if (request.status !== 'pending') {
    throw new Error(
      `Approval request ${input.request_id} is not pending (current status: ${request.status})`,
    );
  }

  // Insert the vote — unique constraint prevents duplicates
  const [vote] = await sql<ApprovalVote[]>`
    INSERT INTO approval_votes (request_id, approver_id, decision, comment)
    VALUES (
      ${input.request_id},
      ${input.approver_id},
      ${input.decision},
      ${input.comment ?? null}
    )
    RETURNING id, request_id, approver_id, decision, comment, created_at
  `;

  if (auditWriter) {
    await auditWriter({
      actor_id: input.approver_id,
      action: `approval_request.${input.decision}`,
      entity_type: 'approval_request',
      entity_id: input.request_id,
      before: { status: request.status },
      after: { vote_id: vote.id, decision: input.decision },
      ts: new Date().toISOString(),
    }).catch((err) =>
      console.warn(`[approvals] audit write failed for approval_request.${input.decision}:`, err),
    );
  }

  // Determine new request status
  let newStatus: ApprovalStatus = 'pending';
  let quorumReached = false;

  if (input.decision === 'rejected') {
    newStatus = 'rejected';
  } else {
    // Count current approvals (including this one)
    const [{ approval_count }] = await sql<{ approval_count: string }[]>`
      SELECT COUNT(*) AS approval_count
      FROM approval_votes
      WHERE request_id = ${input.request_id}
        AND decision = 'approved'
    `;
    const approvalCount = parseInt(approval_count, 10);
    if (approvalCount >= request.required_approvals) {
      newStatus = 'approved';
      quorumReached = true;
    }
  }

  // Update request status if it changed
  let updatedRequest = request;
  if (newStatus !== 'pending') {
    const [updated] = await sql<ApprovalRequest[]>`
      UPDATE approval_requests
      SET status = ${newStatus}, updated_at = NOW()
      WHERE id = ${input.request_id}
      RETURNING id, operation_type, payload, requested_by, required_approvals,
                status, created_at, updated_at
    `;
    updatedRequest = updated;

    if (auditWriter) {
      await auditWriter({
        actor_id: input.approver_id,
        action: `approval_request.status_change`,
        entity_type: 'approval_request',
        entity_id: input.request_id,
        before: { status: 'pending' },
        after: { status: newStatus },
        ts: new Date().toISOString(),
      }).catch((err) =>
        console.warn('[approvals] audit write failed for approval_request.status_change:', err),
      );
    }
  }

  return { vote, request: updatedRequest, quorum_reached: quorumReached };
}

// ---------------------------------------------------------------------------
// markExecuted
// ---------------------------------------------------------------------------

/**
 * Marks an approved request as executed after the privileged operation has
 * been carried out. Only transitions from 'approved' → 'executed'.
 *
 * @throws if the request is not found or is not in 'approved' status.
 */
export async function markExecuted(
  sql: SqlClient,
  requestId: string,
  actorId: string,
  auditWriter?: ApprovalAuditWriterFn,
): Promise<ApprovalRequest> {
  const [request] = await sql<ApprovalRequest[]>`
    SELECT id, operation_type, payload, requested_by, required_approvals,
           status, created_at, updated_at
    FROM approval_requests
    WHERE id = ${requestId}
    FOR UPDATE
  `;

  if (!request) {
    throw new Error(`Approval request not found: ${requestId}`);
  }

  if (request.status !== 'approved') {
    throw new Error(
      `Approval request ${requestId} cannot be executed — ` +
        `current status: ${request.status} (must be 'approved')`,
    );
  }

  const [updated] = await sql<ApprovalRequest[]>`
    UPDATE approval_requests
    SET status = 'executed', updated_at = NOW()
    WHERE id = ${requestId}
    RETURNING id, operation_type, payload, requested_by, required_approvals,
              status, created_at, updated_at
  `;

  if (auditWriter) {
    await auditWriter({
      actor_id: actorId,
      action: 'approval_request.executed',
      entity_type: 'approval_request',
      entity_id: requestId,
      before: { status: 'approved' },
      after: { status: 'executed' },
      ts: new Date().toISOString(),
    }).catch((err) =>
      console.warn('[approvals] audit write failed for approval_request.executed:', err),
    );
  }

  return updated;
}

// ---------------------------------------------------------------------------
// getApprovalRequest
// ---------------------------------------------------------------------------

/**
 * Fetches an approval request with its current vote tallies.
 *
 * @returns null if the request does not exist.
 */
export async function getApprovalRequest(
  sql: SqlClient,
  requestId: string,
): Promise<ApprovalRequestWithVotes | null> {
  const [request] = await sql<ApprovalRequest[]>`
    SELECT id, operation_type, payload, requested_by, required_approvals,
           status, created_at, updated_at
    FROM approval_requests
    WHERE id = ${requestId}
  `;

  if (!request) return null;

  const votes = await sql<ApprovalVote[]>`
    SELECT id, request_id, approver_id, decision, comment, created_at
    FROM approval_votes
    WHERE request_id = ${requestId}
    ORDER BY created_at ASC
  `;

  const approvalCount = votes.filter((v) => v.decision === 'approved').length;
  const rejectionCount = votes.filter((v) => v.decision === 'rejected').length;

  return {
    ...request,
    votes,
    approval_count: approvalCount,
    rejection_count: rejectionCount,
  };
}

// ---------------------------------------------------------------------------
// listApprovalRequests
// ---------------------------------------------------------------------------

export interface ListApprovalRequestsOptions {
  status?: ApprovalStatus;
  operation_type?: string;
  limit?: number;
  offset?: number;
}

/**
 * Lists approval requests with optional filters.
 */
export async function listApprovalRequests(
  sql: SqlClient,
  options: ListApprovalRequestsOptions = {},
): Promise<ApprovalRequest[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  const offset = options.offset ?? 0;
  const statusFilter = options.status ?? null;
  const opTypeFilter = options.operation_type ?? null;

  if (statusFilter && opTypeFilter) {
    return sql<ApprovalRequest[]>`
      SELECT id, operation_type, payload, requested_by, required_approvals,
             status, created_at, updated_at
      FROM approval_requests
      WHERE status = ${statusFilter}
        AND operation_type = ${opTypeFilter}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  if (statusFilter) {
    return sql<ApprovalRequest[]>`
      SELECT id, operation_type, payload, requested_by, required_approvals,
             status, created_at, updated_at
      FROM approval_requests
      WHERE status = ${statusFilter}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  if (opTypeFilter) {
    return sql<ApprovalRequest[]>`
      SELECT id, operation_type, payload, requested_by, required_approvals,
             status, created_at, updated_at
      FROM approval_requests
      WHERE operation_type = ${opTypeFilter}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  return sql<ApprovalRequest[]>`
    SELECT id, operation_type, payload, requested_by, required_approvals,
           status, created_at, updated_at
    FROM approval_requests
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

// ---------------------------------------------------------------------------
// assertApproved (enforcement middleware helper)
// ---------------------------------------------------------------------------

/**
 * Asserts that the given approval request is in 'approved' status, meaning
 * the quorum has been met and the operation is cleared for execution.
 *
 * This function is called by the enforcement middleware before allowing a
 * privileged operation to proceed.
 *
 * @throws if the request is not found, not 'approved', or already 'executed'.
 */
export async function assertApproved(sql: SqlClient, requestId: string): Promise<ApprovalRequest> {
  const [request] = await sql<ApprovalRequest[]>`
    SELECT id, operation_type, payload, requested_by, required_approvals,
           status, created_at, updated_at
    FROM approval_requests
    WHERE id = ${requestId}
  `;

  if (!request) {
    throw new Error(`Approval request not found: ${requestId}`);
  }

  if (request.status === 'executed') {
    throw new Error(`Approval request ${requestId} has already been executed and cannot be reused`);
  }

  if (request.status !== 'approved') {
    throw new Error(
      `Privileged operation blocked: approval request ${requestId} is '${request.status}', ` +
        `not 'approved'. The operation requires ${request.required_approvals} approval(s).`,
    );
  }

  return request;
}
