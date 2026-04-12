/**
 * @file ingestion.ts
 *
 * POST /internal/ingestion/email — API-mediated email ingestion write endpoint.
 *
 * Security model
 * ---------------
 * - Bearer scoped ingestion token (minted by mintIngestionToken).
 * - Token is single-use: consumed on first successful verification.
 * - Token carries tenant_id so the endpoint does not trust a caller-supplied
 *   tenant; it reads the authoritative value from the token payload.
 * - Sensitive fields (subject, body, headers) are encrypted with AES-256-GCM
 *   before the entity row is written. ENCRYPTION_DISABLED=true skips encryption
 *   in dev/test environments.
 * - Every successful write emits an audit event BEFORE the DB insert commits.
 *   If the audit write fails the email row is not persisted.
 *
 * Worker DB role constraint
 * -------------------------
 * The email_ingest agent DB role has no INSERT privilege on the entities table.
 * Workers that attempt a direct INSERT are denied at the PostgreSQL layer.
 * The only write path is through this endpoint.
 *
 * Blueprint: WORKER-P-001, API-W-001 (API-gateway is sole writer for ingestion).
 * Issue: #28 — API-mediated Email ingestion write with scoped worker token
 */

import type { AppState } from '../index';
import { getCorsHeaders } from './auth';
import { makeJson } from '../lib/response';
import { verifyIngestionToken } from 'db/ingestion-token';
import { encryptProperties } from 'core';
import { emitAuditEvent } from '../policies/audit-service';
import { extractTraceId } from 'core';

// ---------------------------------------------------------------------------
// Request body type
// ---------------------------------------------------------------------------

export interface IngestEmailBody {
  /** Opaque stable message identifier (e.g. Gmail message ID). */
  message_id: string;
  /** Email subject line. Encrypted at rest. */
  subject: string;
  /** Plain-text or HTML email body. Encrypted at rest. */
  body: string;
  /** Serialised RFC-2822 headers. Encrypted at rest. */
  headers: string;
  /** ISO-8601 timestamp when the email was received by the mail server. */
  received_at: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles POST /internal/ingestion/email.
 *
 * Returns null for non-matching paths so the caller can chain handlers.
 */
export async function handleIngestionRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (url.pathname !== '/internal/ingestion/email' || req.method !== 'POST') return null;

  const corsHeaders = getCorsHeaders(req);
  const { sql } = appState;
  const json = makeJson(corsHeaders);

  // ---------------------------------------------------------------------------
  // 1. Extract and verify Bearer ingestion token
  // ---------------------------------------------------------------------------

  const authHeader = req.headers.get('Authorization') ?? '';
  const tokenMatch = authHeader.match(/^Bearer (.+)$/);
  if (!tokenMatch) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const rawToken = tokenMatch[1];

  // ---------------------------------------------------------------------------
  // 2. Parse and validate request body
  // ---------------------------------------------------------------------------

  let body: IngestEmailBody;
  try {
    body = (await req.json()) as IngestEmailBody;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const requiredFields: (keyof IngestEmailBody)[] = [
    'message_id',
    'subject',
    'body',
    'headers',
    'received_at',
  ];
  const missing = requiredFields.filter((f) => !body[f]);
  if (missing.length > 0) {
    return json({ error: `Missing required fields: ${missing.join(', ')}` }, 400);
  }

  // Validate received_at is a valid ISO-8601 timestamp
  const receivedAt = new Date(body.received_at);
  if (isNaN(receivedAt.getTime())) {
    return json({ error: 'received_at must be a valid ISO-8601 timestamp' }, 400);
  }

  // ---------------------------------------------------------------------------
  // 3. Verify the ingestion token
  // ---------------------------------------------------------------------------

  // We need the tenant_id from the token to scope the entity write.
  // First do a fast decode to extract tenant_id without consuming the token,
  // then verify (which consumes it).
  let tenantId: string;
  try {
    // Decode payload without signature check to extract tenant_id early.
    // Full verification (including single-use consumption) follows immediately.
    const parts = rawToken.split('.');
    if (parts.length !== 3) throw new Error('Malformed token');
    const claimsJson = atob(
      parts[1]
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(parts[1].length + ((4 - (parts[1].length % 4)) % 4), '='),
    );
    const claims = JSON.parse(claimsJson) as { tenant_id?: string };
    if (!claims.tenant_id) throw new Error('Token missing tenant_id');
    tenantId = claims.tenant_id;
  } catch (_err) {
    return json({ error: 'Invalid token' }, 401);
  }

  try {
    await verifyIngestionToken(rawToken, { expectedTenantId: tenantId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token verification failed';
    return json({ error: message }, 401);
  }

  // ---------------------------------------------------------------------------
  // 4. Encrypt sensitive fields
  // ---------------------------------------------------------------------------

  const encryptedProperties = await encryptProperties('email', {
    subject: body.subject,
    body: body.body,
    headers: body.headers,
  });

  // ---------------------------------------------------------------------------
  // 5. Emit audit event BEFORE the primary write
  // ---------------------------------------------------------------------------

  const entityId = crypto.randomUUID();
  const now = new Date().toISOString();
  const correlationId = extractTraceId(req) ?? crypto.randomUUID();

  await emitAuditEvent({
    actor_id: tenantId,
    action: 'email.ingest',
    entity_type: 'email',
    entity_id: entityId,
    before: null,
    after: {
      message_id: body.message_id,
      received_at: body.received_at,
    },
    ip: req.headers.get('x-forwarded-for') ?? undefined,
    user_agent: req.headers.get('user-agent') ?? undefined,
    correlation_id: correlationId,
    ts: now,
  });

  // ---------------------------------------------------------------------------
  // 6. Persist the Email entity
  // ---------------------------------------------------------------------------

  const properties = {
    message_id: body.message_id,
    subject: encryptedProperties.subject,
    body: encryptedProperties.body,
    headers: encryptedProperties.headers,
    received_at: body.received_at,
  };

  await sql`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES (
      ${entityId},
      'email',
      ${JSON.stringify(properties)},
      ${tenantId}
    )
  `;

  return json({ id: entityId }, 201);
}
