/**
 * @file legal-hold
 *
 * Phase 8 — LegalHold entity with four-eyes removal flow (issue #82).
 *
 * ## Purpose
 *
 * Provides the data-access layer for legal holds. A Compliance Officer places a
 * legal hold on all records belonging to a tenant. Held records are exempt from
 * retention-scheduler deletion. Removing a hold requires co-approval from a
 * second, distinct Compliance Officer (four-eyes principle).
 *
 * ## State machine
 *
 * legal_hold.status:
 *   active → pending_removal → (active | removed)
 *
 * legal_hold_removal_request.status:
 *   pending → approved → (hold becomes 'removed')
 *   pending → rejected → (hold returns to 'active')
 *
 * ## Business rules
 *
 *   1. Only Compliance Officers (actorRole === 'compliance_officer') may place holds.
 *   2. Removal requires two distinct Compliance Officers.
 *   3. The initiator of the removal request cannot be the co-approver (four-eyes).
 *   4. A hold in 'active' status can receive at most one pending removal request.
 *   5. Audit events are emitted on place and remove via the injected auditWriter.
 *
 * Canonical docs: docs/PRD.md, docs/implementation-plan-v1.md Phase 8
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/82
 */

import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// Internal type alias
// ---------------------------------------------------------------------------

type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type LegalHoldStatus = 'active' | 'pending_removal' | 'removed';
export type RemovalRequestStatus = 'pending' | 'approved' | 'rejected';

export interface LegalHold {
  id: string;
  tenant_id: string;
  placed_by: string;
  reason: string;
  status: LegalHoldStatus;
  placed_at: string;
  removed_at: string | null;
}

export interface LegalHoldRemovalRequest {
  id: string;
  hold_id: string;
  requested_by: string;
  co_approved_by: string | null;
  status: RemovalRequestStatus;
  created_at: string;
  resolved_at: string | null;
}

export interface LegalHoldWithRemovalRequest extends LegalHold {
  pending_removal_request: LegalHoldRemovalRequest | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LegalHoldInsufficientRoleError extends Error {
  constructor(actorId: string, requiredRole: string, actualRole: string | null) {
    super(
      `Actor '${actorId}' (role=${actualRole ?? 'none'}) is not permitted to perform legal hold operations. ` +
        `Required role: ${requiredRole}.`,
    );
    this.name = 'LegalHoldInsufficientRoleError';
  }
}

export class LegalHoldNotFoundError extends Error {
  constructor(holdId: string) {
    super(`Legal hold not found: ${holdId}`);
    this.name = 'LegalHoldNotFoundError';
  }
}

export class LegalHoldFourEyesViolationError extends Error {
  constructor() {
    super(
      'Four-eyes violation: the co-approver must be a different Compliance Officer than the removal requester.',
    );
    this.name = 'LegalHoldFourEyesViolationError';
  }
}

export class LegalHoldStatusError extends Error {
  constructor(holdId: string, expected: string, actual: string) {
    super(`Legal hold '${holdId}' is in status '${actual}', expected '${expected}'.`);
    this.name = 'LegalHoldStatusError';
  }
}

export class LegalHoldRemovalRequestNotFoundError extends Error {
  constructor(requestId: string) {
    super(`Legal hold removal request not found: ${requestId}`);
    this.name = 'LegalHoldRemovalRequestNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Audit writer callback
// ---------------------------------------------------------------------------

export type LegalHoldAuditWriterFn = (event: {
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ts: string;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// placeLegalHold
// ---------------------------------------------------------------------------

export interface PlaceLegalHoldInput {
  tenantId: string;
  placedBy: string;
  actorRole: string | null;
  reason?: string;
  isSuperuser?: boolean;
}

/**
 * Places a legal hold on all records belonging to the given tenant.
 *
 * Only a Compliance Officer (actorRole === 'compliance_officer') or a
 * superuser may place a hold.
 *
 * Emits a `legal_hold.place` audit event via `auditWriter` (if provided).
 *
 * @throws {LegalHoldInsufficientRoleError} when the actor lacks the required role.
 */
export async function placeLegalHold(
  sql: SqlClient,
  input: PlaceLegalHoldInput,
  auditWriter?: LegalHoldAuditWriterFn,
): Promise<LegalHold> {
  const { tenantId, placedBy, actorRole, reason = '', isSuperuser: superuser = false } = input;

  if (!superuser && actorRole !== 'compliance_officer') {
    throw new LegalHoldInsufficientRoleError(placedBy, 'compliance_officer', actorRole);
  }

  const [hold] = await sql<LegalHold[]>`
    INSERT INTO legal_holds (tenant_id, placed_by, reason, status)
    VALUES (${tenantId}, ${placedBy}, ${reason}, 'active')
    RETURNING id, tenant_id, placed_by, reason, status, placed_at, removed_at
  `;

  if (auditWriter) {
    await auditWriter({
      actor_id: placedBy,
      action: 'legal_hold.place',
      entity_type: 'legal_hold',
      entity_id: hold.id,
      before: null,
      after: { tenant_id: tenantId, reason, status: hold.status },
      ts: new Date().toISOString(),
    }).catch((err) => console.warn('[legal-hold] audit write failed for legal_hold.place:', err));
  }

  return hold;
}

// ---------------------------------------------------------------------------
// getLegalHold
// ---------------------------------------------------------------------------

/**
 * Fetches a single legal hold by ID, including any pending removal request.
 *
 * @returns null if not found.
 */
export async function getLegalHold(
  sql: SqlClient,
  holdId: string,
): Promise<LegalHoldWithRemovalRequest | null> {
  const [hold] = await sql<LegalHold[]>`
    SELECT id, tenant_id, placed_by, reason, status, placed_at, removed_at
    FROM legal_holds
    WHERE id = ${holdId}
  `;

  if (!hold) return null;

  const [removalRequest] = await sql<LegalHoldRemovalRequest[]>`
    SELECT id, hold_id, requested_by, co_approved_by, status, created_at, resolved_at
    FROM legal_hold_removal_requests
    WHERE hold_id = ${holdId} AND status = 'pending'
    ORDER BY created_at DESC
    LIMIT 1
  `;

  return {
    ...hold,
    pending_removal_request: removalRequest ?? null,
  };
}

// ---------------------------------------------------------------------------
// listLegalHolds
// ---------------------------------------------------------------------------

export interface ListLegalHoldsOptions {
  tenantId?: string;
  status?: LegalHoldStatus;
  limit?: number;
  offset?: number;
}

/**
 * Lists legal holds with optional filters.
 */
export async function listLegalHolds(
  sql: SqlClient,
  options: ListLegalHoldsOptions = {},
): Promise<LegalHold[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  const offset = options.offset ?? 0;
  const tenantFilter = options.tenantId ?? null;
  const statusFilter = options.status ?? null;

  if (tenantFilter && statusFilter) {
    return sql<LegalHold[]>`
      SELECT id, tenant_id, placed_by, reason, status, placed_at, removed_at
      FROM legal_holds
      WHERE tenant_id = ${tenantFilter} AND status = ${statusFilter}
      ORDER BY placed_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  if (tenantFilter) {
    return sql<LegalHold[]>`
      SELECT id, tenant_id, placed_by, reason, status, placed_at, removed_at
      FROM legal_holds
      WHERE tenant_id = ${tenantFilter}
      ORDER BY placed_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  if (statusFilter) {
    return sql<LegalHold[]>`
      SELECT id, tenant_id, placed_by, reason, status, placed_at, removed_at
      FROM legal_holds
      WHERE status = ${statusFilter}
      ORDER BY placed_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  return sql<LegalHold[]>`
    SELECT id, tenant_id, placed_by, reason, status, placed_at, removed_at
    FROM legal_holds
    ORDER BY placed_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

// ---------------------------------------------------------------------------
// requestHoldRemoval
// ---------------------------------------------------------------------------

export interface RequestHoldRemovalInput {
  holdId: string;
  requestedBy: string;
  actorRole: string | null;
  isSuperuser?: boolean;
}

/**
 * Initiates the four-eyes removal flow for an active legal hold.
 *
 * Only a Compliance Officer may request removal. The hold transitions to
 * 'pending_removal'. A second, distinct Compliance Officer must then call
 * `approveHoldRemoval` to complete the flow.
 *
 * At most one pending removal request may exist per hold. Creating a second
 * while one is pending is rejected with a LegalHoldStatusError.
 *
 * @throws {LegalHoldInsufficientRoleError} when the actor lacks the required role.
 * @throws {LegalHoldNotFoundError} when the hold does not exist.
 * @throws {LegalHoldStatusError} when the hold is not in 'active' status.
 */
export async function requestHoldRemoval(
  sql: SqlClient,
  input: RequestHoldRemovalInput,
  auditWriter?: LegalHoldAuditWriterFn,
): Promise<LegalHoldRemovalRequest> {
  const { holdId, requestedBy, actorRole, isSuperuser: superuser = false } = input;

  if (!superuser && actorRole !== 'compliance_officer') {
    throw new LegalHoldInsufficientRoleError(requestedBy, 'compliance_officer', actorRole);
  }

  // Fetch and lock the hold for atomic state transition.
  const [hold] = await sql<LegalHold[]>`
    SELECT id, status
    FROM legal_holds
    WHERE id = ${holdId}
    FOR UPDATE
  `;

  if (!hold) {
    throw new LegalHoldNotFoundError(holdId);
  }

  if (hold.status !== 'active') {
    throw new LegalHoldStatusError(holdId, 'active', hold.status);
  }

  // Transition hold to pending_removal.
  await sql`
    UPDATE legal_holds
    SET status = 'pending_removal'
    WHERE id = ${holdId}
  `;

  // Record the removal request.
  const [removalRequest] = await sql<LegalHoldRemovalRequest[]>`
    INSERT INTO legal_hold_removal_requests (hold_id, requested_by, status)
    VALUES (${holdId}, ${requestedBy}, 'pending')
    RETURNING id, hold_id, requested_by, co_approved_by, status, created_at, resolved_at
  `;

  if (auditWriter) {
    await auditWriter({
      actor_id: requestedBy,
      action: 'legal_hold.removal_requested',
      entity_type: 'legal_hold',
      entity_id: holdId,
      before: { status: 'active' },
      after: { status: 'pending_removal', removal_request_id: removalRequest.id },
      ts: new Date().toISOString(),
    }).catch((err) =>
      console.warn('[legal-hold] audit write failed for legal_hold.removal_requested:', err),
    );
  }

  return removalRequest;
}

// ---------------------------------------------------------------------------
// approveHoldRemoval
// ---------------------------------------------------------------------------

export interface ApproveHoldRemovalInput {
  removalRequestId: string;
  coApprovedBy: string;
  actorRole: string | null;
  isSuperuser?: boolean;
}

/**
 * Co-approves a pending legal hold removal request (four-eyes second step).
 *
 * The co-approver MUST be a different Compliance Officer than the requester.
 * On success, the hold transitions to 'removed' and `removed_at` is set.
 *
 * @throws {LegalHoldInsufficientRoleError} when the actor lacks the required role.
 * @throws {LegalHoldRemovalRequestNotFoundError} when the removal request is not found or not pending.
 * @throws {LegalHoldFourEyesViolationError} when the co-approver is the same as the requester.
 */
export async function approveHoldRemoval(
  sql: SqlClient,
  input: ApproveHoldRemovalInput,
  auditWriter?: LegalHoldAuditWriterFn,
): Promise<LegalHold> {
  const { removalRequestId, coApprovedBy, actorRole, isSuperuser: superuser = false } = input;

  if (!superuser && actorRole !== 'compliance_officer') {
    throw new LegalHoldInsufficientRoleError(coApprovedBy, 'compliance_officer', actorRole);
  }

  // Fetch and lock the removal request.
  const [removalRequest] = await sql<LegalHoldRemovalRequest[]>`
    SELECT id, hold_id, requested_by, co_approved_by, status, created_at, resolved_at
    FROM legal_hold_removal_requests
    WHERE id = ${removalRequestId}
    FOR UPDATE
  `;

  if (!removalRequest || removalRequest.status !== 'pending') {
    throw new LegalHoldRemovalRequestNotFoundError(removalRequestId);
  }

  // Four-eyes: co-approver must differ from requester.
  if (removalRequest.requested_by === coApprovedBy) {
    throw new LegalHoldFourEyesViolationError();
  }

  const now = new Date().toISOString();

  // Mark removal request as approved.
  await sql`
    UPDATE legal_hold_removal_requests
    SET status = 'approved', co_approved_by = ${coApprovedBy}, resolved_at = ${now}::TIMESTAMPTZ
    WHERE id = ${removalRequestId}
  `;

  // Lift the hold.
  const [updatedHold] = await sql<LegalHold[]>`
    UPDATE legal_holds
    SET status = 'removed', removed_at = ${now}::TIMESTAMPTZ
    WHERE id = ${removalRequest.hold_id}
    RETURNING id, tenant_id, placed_by, reason, status, placed_at, removed_at
  `;

  if (auditWriter) {
    await auditWriter({
      actor_id: coApprovedBy,
      action: 'legal_hold.remove',
      entity_type: 'legal_hold',
      entity_id: removalRequest.hold_id,
      before: { status: 'pending_removal', requested_by: removalRequest.requested_by },
      after: { status: 'removed', co_approved_by: coApprovedBy },
      ts: now,
    }).catch((err) => console.warn('[legal-hold] audit write failed for legal_hold.remove:', err));
  }

  return updatedHold;
}

// ---------------------------------------------------------------------------
// rejectHoldRemoval
// ---------------------------------------------------------------------------

export interface RejectHoldRemovalInput {
  removalRequestId: string;
  rejectedBy: string;
  actorRole: string | null;
  isSuperuser?: boolean;
}

/**
 * Rejects a pending legal hold removal request.
 *
 * The hold transitions back to 'active'. Only a Compliance Officer or superuser
 * may reject.
 *
 * @throws {LegalHoldInsufficientRoleError} when the actor lacks the required role.
 * @throws {LegalHoldRemovalRequestNotFoundError} when the removal request is not found or not pending.
 */
export async function rejectHoldRemoval(
  sql: SqlClient,
  input: RejectHoldRemovalInput,
  auditWriter?: LegalHoldAuditWriterFn,
): Promise<LegalHold> {
  const { removalRequestId, rejectedBy, actorRole, isSuperuser: superuser = false } = input;

  if (!superuser && actorRole !== 'compliance_officer') {
    throw new LegalHoldInsufficientRoleError(rejectedBy, 'compliance_officer', actorRole);
  }

  const [removalRequest] = await sql<LegalHoldRemovalRequest[]>`
    SELECT id, hold_id, requested_by, status
    FROM legal_hold_removal_requests
    WHERE id = ${removalRequestId}
    FOR UPDATE
  `;

  if (!removalRequest || removalRequest.status !== 'pending') {
    throw new LegalHoldRemovalRequestNotFoundError(removalRequestId);
  }

  const now = new Date().toISOString();

  // Mark removal request as rejected.
  await sql`
    UPDATE legal_hold_removal_requests
    SET status = 'rejected', resolved_at = ${now}::TIMESTAMPTZ
    WHERE id = ${removalRequestId}
  `;

  // Return hold to active.
  const [updatedHold] = await sql<LegalHold[]>`
    UPDATE legal_holds
    SET status = 'active'
    WHERE id = ${removalRequest.hold_id}
    RETURNING id, tenant_id, placed_by, reason, status, placed_at, removed_at
  `;

  if (auditWriter) {
    await auditWriter({
      actor_id: rejectedBy,
      action: 'legal_hold.removal_rejected',
      entity_type: 'legal_hold',
      entity_id: removalRequest.hold_id,
      before: { status: 'pending_removal' },
      after: { status: 'active', rejected_by: rejectedBy },
      ts: now,
    }).catch((err) =>
      console.warn('[legal-hold] audit write failed for legal_hold.removal_rejected:', err),
    );
  }

  return updatedHold;
}

// ---------------------------------------------------------------------------
// hasActiveLegalHold
// ---------------------------------------------------------------------------

/**
 * Returns true when the given tenant has at least one active (or pending_removal)
 * legal hold. Used by the retention engine to determine whether deletion is blocked.
 *
 * A hold in 'pending_removal' still blocks deletion — removal is not complete
 * until the second Compliance Officer co-approves.
 */
export async function hasActiveLegalHold(sql: SqlClient, tenantId: string): Promise<boolean> {
  const [row] = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count
    FROM legal_holds
    WHERE tenant_id = ${tenantId}
      AND status IN ('active', 'pending_removal')
  `;

  return parseInt(row.count, 10) > 0;
}

// ---------------------------------------------------------------------------
// listPendingRemovalRequests
// ---------------------------------------------------------------------------

/**
 * Lists all pending legal hold removal requests (the approval queue).
 * Intended for the admin UI compliance dashboard.
 */
export async function listPendingRemovalRequests(
  sql: SqlClient,
  options: { limit?: number; offset?: number } = {},
): Promise<(LegalHoldRemovalRequest & { hold: LegalHold })[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  const offset = options.offset ?? 0;

  type PendingRemovalRow = LegalHoldRemovalRequest & {
    hold_tenant_id: string;
    hold_placed_by: string;
    hold_reason: string;
    hold_status: LegalHoldStatus;
    hold_placed_at: string;
    hold_removed_at: string | null;
  };

  const rows = await sql<PendingRemovalRow[]>`
    SELECT
      r.id, r.hold_id, r.requested_by, r.co_approved_by, r.status,
      r.created_at, r.resolved_at,
      h.tenant_id AS hold_tenant_id,
      h.placed_by AS hold_placed_by,
      h.reason    AS hold_reason,
      h.status    AS hold_status,
      h.placed_at AS hold_placed_at,
      h.removed_at AS hold_removed_at
    FROM legal_hold_removal_requests r
    JOIN legal_holds h ON h.id = r.hold_id
    WHERE r.status = 'pending'
    ORDER BY r.created_at ASC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return rows.map((row: PendingRemovalRow) => ({
    id: row.id,
    hold_id: row.hold_id,
    requested_by: row.requested_by,
    co_approved_by: row.co_approved_by,
    status: row.status,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    hold: {
      id: row.hold_id,
      tenant_id: row.hold_tenant_id,
      placed_by: row.hold_placed_by,
      reason: row.hold_reason,
      status: row.hold_status,
      placed_at: row.hold_placed_at,
      removed_at: row.hold_removed_at,
    },
  }));
}
