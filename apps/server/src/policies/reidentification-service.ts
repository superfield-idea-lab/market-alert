/**
 * Re-identification service — sole authority for resolving anonymisation tokens.
 *
 * Architecture:
 *   - Uses dictionarySql (dict_rw role) to read identity_tokens in kb_dictionary.
 *   - Uses emitAuditEvent to write a hash-chained audit row BEFORE returning the
 *     resolved identity. If the audit write fails the resolution is aborted.
 *   - Decrypts encrypted columns (real_name, real_email, real_org) using the
 *     IDENTITY key domain via decryptField from core/encryption.
 *
 * Access control:
 *   - This module is the ONLY code path that may call dictionarySql directly.
 *   - The app_rw role has no CONNECT privilege on kb_dictionary (DATA-D-006).
 *   - All other modules must never import dictionarySql.
 *
 * Scope limit (issue #20):
 *   - Single-token resolution only.
 *   - Bulk resolution is blocked until Phase 7 BDM work explicitly opens it.
 */

import { dictionarySql } from 'db';
import { decryptField } from 'core';
import { emitAuditEvent } from './audit-service';

export interface ResolvedIdentity {
  token: string;
  real_name: string;
  real_email: string;
  real_org: string;
  resolved_at: string;
}

export interface ResolveTokenOptions {
  /** The anonymisation token to resolve. */
  token: string;
  /** Actor ID (authenticated caller) — written to the audit event. */
  actorId: string;
  /** Correlation ID forwarded from the request trace header, if present. */
  correlationId?: string;
  /** Caller IP address, forwarded to the audit event. */
  ip?: string;
}

/**
 * Resolves an anonymisation token to a real-world identity.
 *
 * Resolution steps:
 *  1. SELECT the row from identity_tokens as dict_rw.
 *  2. Decrypt sensitive columns using the IDENTITY key domain.
 *  3. Emit an audit event (token.resolved) — abort if the write fails.
 *  4. Return the decrypted identity.
 *
 * Returns `null` when no row exists for the token (caller gets 404).
 * Throws if the audit event write fails (caller gets 500).
 */
export async function resolveToken(opts: ResolveTokenOptions): Promise<ResolvedIdentity | null> {
  const { token, actorId, correlationId, ip } = opts;

  // Step 1: resolve the token row via the dict_rw pool.
  const rows = await dictionarySql<
    {
      token: string;
      real_name: string;
      real_email: string;
      real_org: string;
    }[]
  >`
    SELECT token, real_name, real_email, real_org
    FROM identity_tokens
    WHERE token = ${token}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];

  // Step 2: decrypt the encrypted identity fields.
  const realName = await decryptField('identity_token', row.real_name);
  const realEmail = await decryptField('identity_token', row.real_email);
  const realOrg = await decryptField('identity_token', row.real_org);

  const resolvedAt = new Date().toISOString();

  // Step 3: emit an audit event BEFORE returning data to the caller.
  // If this write fails the resolution is aborted (emitAuditEvent throws).
  await emitAuditEvent({
    actor_id: actorId,
    action: 'token.resolved',
    entity_type: 'identity_token',
    entity_id: token,
    before: null,
    after: { token, resolved_at: resolvedAt },
    ip,
    correlation_id: correlationId,
    ts: resolvedAt,
  });

  // Step 4: return the decrypted identity.
  return {
    token,
    real_name: realName,
    real_email: realEmail,
    real_org: realOrg,
    resolved_at: resolvedAt,
  };
}
