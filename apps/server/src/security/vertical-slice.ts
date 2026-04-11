/**
 * Security vertical slice — dev-scout stubs.
 *
 * This file contains no-op stubs for the full security vertical slice:
 *   passkey login → session → RLS-scoped read → audit-before-read → field encryption.
 *
 * Each stub declares the interface that Phase 1 follow-on issues will implement.
 * No real behaviour is wired here; every function throws NotImplementedError so
 * callers can detect an incomplete deployment at runtime.
 *
 * Follow-on issues:
 *   - Passkey registration/login: already partially wired in api/passkey.ts
 *   - RLS session context: set_config('app.current_user_id', …) before queries
 *   - Audit-before-read guarantee: emitAuditEvent must commit before the read
 *   - Field-level AES-256-GCM: encryptField / decryptField from packages/core
 */

// ---------------------------------------------------------------------------
// Shared error sentinel
// ---------------------------------------------------------------------------

export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`[security-vertical-slice] ${feature} is not yet implemented`);
    this.name = 'NotImplementedError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome of an RLS-scoped entity read for the security vertical slice. */
export interface SecureReadResult<T = Record<string, unknown>> {
  /** The decrypted entity data if the read was authorised. */
  data: T | null;
  /** True when the requesting identity was denied at the database layer. */
  deniedByRls: boolean;
  /** True when an audit write failure caused the read to be denied. */
  deniedByAuditFailure: boolean;
}

/** Minimal session context required to perform a scoped read. */
export interface SessionContext {
  userId: string;
  tenantId: string | null;
}

// ---------------------------------------------------------------------------
// Stub: bind session context as Postgres app-local variables for RLS
// ---------------------------------------------------------------------------

/**
 * STUB — sets `app.current_user_id` and `app.current_tenant_id` as session-local
 * Postgres config so that RLS policies on the `entities` table can reference them.
 *
 * Real implementation: call `SET LOCAL app.current_user_id = $1` inside the
 * transaction that wraps every scoped query.
 *
 * @throws NotImplementedError always — follow-on issue will implement this.
 */
export async function bindSessionContext(_session: SessionContext): Promise<void> {
  throw new NotImplementedError('bindSessionContext');
}

// ---------------------------------------------------------------------------
// Stub: audit-before-read guarantee
// ---------------------------------------------------------------------------

/**
 * STUB — emits a `read` audit event for the given entity and confirms it was
 * durably stored BEFORE the read is allowed to proceed.
 *
 * Real implementation: call emitAuditEvent() inside the same transaction as the
 * read. If the audit write fails the transaction is rolled back and the read is
 * denied with a 500.
 *
 * @throws NotImplementedError always — follow-on issue will implement this.
 */
export async function auditBeforeRead(
  _session: SessionContext,
  _entityType: string,
  _entityId: string,
): Promise<void> {
  throw new NotImplementedError('auditBeforeRead');
}

// ---------------------------------------------------------------------------
// Stub: RLS-scoped entity read with audit and decryption
// ---------------------------------------------------------------------------

/**
 * STUB — reads a single entity row using:
 *   1. `bindSessionContext` to set RLS variables
 *   2. `auditBeforeRead` to write the audit event before the read commits
 *   3. A SELECT scoped by the entity id (Postgres RLS enforces identity isolation)
 *   4. `decryptProperties` for any sensitive columns
 *
 * Returns { data: null, deniedByRls: true } when Postgres RLS returns no rows
 * for the requesting identity. Returns { data: null, deniedByAuditFailure: true }
 * when the audit write fails.
 *
 * @throws NotImplementedError always — follow-on issue will implement this.
 */
export async function secureReadEntity(
  _session: SessionContext,
  _entityType: string,
  _entityId: string,
): Promise<SecureReadResult> {
  throw new NotImplementedError('secureReadEntity');
}
