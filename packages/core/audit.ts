/**
 * Audit event types and hash computation for the append-only hash-chained audit log.
 *
 * Hash chain invariant:
 *   hash = SHA-256(prev_hash + canonical_json({ actor_id, action, entity_type, entity_id, before, after, ts }))
 *
 * canonical_json uses sorted object keys so the hash is stable across
 * PostgreSQL JSONB round-trips, which normalise key order on storage.
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
 * Produces a canonical (sorted-key) JSON string for a value.
 * Object keys are sorted recursively so the output is stable regardless of
 * insertion order — matching the behaviour of PostgreSQL JSONB which sorts
 * keys on storage.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const sorted = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k]))
    .join(',');
  return '{' + sorted + '}';
}

/**
 * Computes the SHA-256 hash for an audit row.
 * Input is prev_hash concatenated with the canonical JSON-serialised payload fields.
 * Canonical (sorted-key) JSON is used for `before` and `after` so that the
 * computed hash is stable across PostgreSQL JSONB round-trips, which normalise
 * key order on storage.
 */
export async function computeAuditHash(
  prevHash: string,
  payload: Pick<
    AuditEventInput,
    'actor_id' | 'action' | 'entity_type' | 'entity_id' | 'before' | 'after' | 'ts'
  >,
): Promise<string> {
  // Build canonical JSON manually so JSONB round-trip key reordering does not
  // invalidate previously stored hashes.
  const data =
    prevHash +
    `{"actor_id":${JSON.stringify(payload.actor_id)},"action":${JSON.stringify(payload.action)},"entity_type":${JSON.stringify(payload.entity_type)},"entity_id":${JSON.stringify(payload.entity_id)},"before":${canonicalJson(payload.before)},"after":${canonicalJson(payload.after)},"ts":${JSON.stringify(payload.ts)}}`;

  const encoder = new TextEncoder();
  const buf = encoder.encode(data);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map((b) => b.toString(16).padStart(2, '0')).join('');
}
