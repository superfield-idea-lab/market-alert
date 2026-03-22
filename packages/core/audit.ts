/**
 * Audit event types and hash computation for the append-only hash-chained audit log.
 *
 * Hash chain invariant:
 *   hash = SHA-256(prev_hash + JSON.stringify({ actor_id, action, entity_type, entity_id, before, after, ts }))
 *
 * The first row uses AUDIT_GENESIS_HASH from env as its prev_hash.
 */

export interface AuditEventInput {
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip?: string;
  user_agent?: string;
  ts: string; // ISO 8601
}

export interface AuditEventRow extends AuditEventInput {
  id: string;
  prev_hash: string;
  hash: string;
}

/**
 * Computes the SHA-256 hash for an audit row.
 * Input is prev_hash concatenated with the JSON-serialised payload fields.
 */
export async function computeAuditHash(
  prevHash: string,
  payload: Pick<
    AuditEventInput,
    'actor_id' | 'action' | 'entity_type' | 'entity_id' | 'before' | 'after' | 'ts'
  >,
): Promise<string> {
  const data =
    prevHash +
    JSON.stringify({
      actor_id: payload.actor_id,
      action: payload.action,
      entity_type: payload.entity_type,
      entity_id: payload.entity_id,
      before: payload.before,
      after: payload.after,
      ts: payload.ts,
    });

  const encoder = new TextEncoder();
  const buf = encoder.encode(data);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map((b) => b.toString(16).padStart(2, '0')).join('');
}
