/**
 * @file ingestion-token.ts
 *
 * Scoped, single-use ingestion tokens for API-mediated email writes.
 *
 * An ingestion token is a short-lived JWT that authorises exactly one
 * POST /internal/ingestion/email call. The token carries:
 *
 *   { sub: actor_id, scope: 'email_ingestion', tenant_id, jti, exp }
 *
 * Verification checks (in order):
 *   1. Signature valid (ES256)
 *   2. Token not expired
 *   3. JTI not in revoked_tokens (single-use enforcement)
 *   4. scope === 'email_ingestion'
 *   5. tenant_id present and matches expected tenant
 *
 * On successful verification the JTI is immediately inserted into
 * revoked_tokens so the token cannot be reused.
 *
 * Blueprint: WORKER-P-001 (read-only worker DB access), API mediates writes.
 * Issue: #28 — API-mediated Email ingestion write with scoped worker token
 */

import { signJwt, verifyJwt } from '../../apps/server/src/auth/jwt';
import { sql } from './index';

/** TTL for ingestion tokens in hours (15 minutes). */
const INGESTION_TOKEN_TTL_HOURS = 15 / 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngestionTokenPayload {
  sub: string;
  scope: 'email_ingestion';
  tenant_id: string;
  jti: string;
  exp: number;
}

export interface MintIngestionTokenInput {
  /** The actor (user or service) requesting the token. */
  actorId: string;
  /** Tenant that owns the incoming email data. */
  tenantId: string;
}

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

/**
 * Mints a short-lived, single-use ingestion token for email writes.
 *
 * The token is signed with the application EC private key and expires in
 * 15 minutes. The caller stores or forwards it to the worker; the worker
 * presents it to POST /internal/ingestion/email.
 */
export async function mintIngestionToken(input: MintIngestionTokenInput): Promise<string> {
  const payload: Omit<IngestionTokenPayload, 'jti' | 'exp'> = {
    sub: input.actorId,
    scope: 'email_ingestion',
    tenant_id: input.tenantId,
  };
  return signJwt(payload, INGESTION_TOKEN_TTL_HOURS);
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export interface VerifyIngestionTokenOptions {
  /** Expected tenant_id — must match token.tenant_id. */
  expectedTenantId: string;
}

/**
 * Verifies an ingestion token and consumes it (single-use).
 *
 * Throws a descriptive Error on any failed check. On success, inserts
 * the JTI into revoked_tokens so the token cannot be presented again.
 */
export async function verifyIngestionToken(
  token: string,
  options: VerifyIngestionTokenOptions,
): Promise<IngestionTokenPayload> {
  // Check 1 + 2: signature valid, token not expired (verifyJwt checks both)
  const payload = await verifyJwt<IngestionTokenPayload>(token);

  // Check 3: JTI not already revoked (single-use enforcement)
  const rows = await sql<{ jti: string }[]>`
    SELECT jti FROM revoked_tokens WHERE jti = ${payload.jti}
  `;
  if (rows.length > 0) {
    throw new Error('Ingestion token already used');
  }

  // Check 4: scope must be 'email_ingestion'
  if (payload.scope !== 'email_ingestion') {
    throw new Error(`Token scope is not email_ingestion (got: ${payload.scope})`);
  }

  // Check 5: tenant_id must match expected tenant
  if (!payload.tenant_id || payload.tenant_id !== options.expectedTenantId) {
    throw new Error('Token tenant_id mismatch');
  }

  // Consume: insert jti so this token cannot be reused
  const expiresAt = new Date(payload.exp * 1000).toISOString();
  await sql`
    INSERT INTO revoked_tokens (jti, expires_at)
    VALUES (${payload.jti}, ${expiresAt})
    ON CONFLICT (jti) DO NOTHING
  `;

  return payload;
}
