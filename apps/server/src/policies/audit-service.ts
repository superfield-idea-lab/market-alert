/**
 * Audit service — append-only, hash-chained audit event writer.
 *
 * Every call to emitAuditEvent:
 *  1. Fetches the hash from the most recently inserted audit row (or the
 *     genesis hash when the table is empty).
 *  2. Computes the SHA-256 hash chain entry for the new event.
 *  3. Inserts the row into the audit_events table.
 *
 * The caller MUST invoke this BEFORE committing the primary database write.
 * If the audit write fails the primary write must not proceed.
 */

import { auditSql } from 'db';
import { computeAuditHash, type AuditEventInput, type AuditEventRow } from 'core';

const DEFAULT_GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

function resolveGenesisHash(): string {
  return process.env.AUDIT_GENESIS_HASH ?? DEFAULT_GENESIS_HASH;
}

/**
 * Writes one audit event to the append-only hash-chained audit log.
 *
 * Uses a serializable transaction via auditSql.unsafe() to ensure no two
 * concurrent writers can select the same prev_hash.
 *
 * @throws if the insert fails — callers must treat this as fatal and abort
 *         the associated primary database write.
 */
export async function emitAuditEvent(event: AuditEventInput): Promise<AuditEventRow> {
  // Run inside a serializable transaction so concurrent inserts cannot race
  // on the prev_hash selection (SELECT ... FOR UPDATE + INSERT in one round-trip).
  const reserved = await auditSql.reserve();

  try {
    await reserved.unsafe('BEGIN ISOLATION LEVEL SERIALIZABLE');

    const latestRows = (await reserved.unsafe(
      'SELECT hash FROM audit_events ORDER BY ts DESC, id DESC LIMIT 1 FOR UPDATE',
    )) as unknown as { hash: string }[];

    const prevHash = latestRows[0]?.hash ?? resolveGenesisHash();
    const hash = await computeAuditHash(prevHash, event);

    // Pass before/after as JS objects (not JSON strings) so postgres.js sends
    // them with the correct type oid and PostgreSQL stores them as JSONB objects.
    // Using JSON.stringify() here would cause postgres.js to store a JSON string
    // value inside JSONB, breaking hash-chain verification on readback.
    const beforeVal = event.before;
    const afterVal = event.after;

    const insertRows = (await reserved.unsafe(
      `INSERT INTO audit_events
         (actor_id, action, entity_type, entity_id, before, after, ip, user_agent, ts, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9::timestamptz, $10, $11)
       RETURNING id, actor_id, action, entity_type, entity_id, before, after, ip, user_agent, ts, prev_hash, hash`,
      [
        event.actor_id,
        event.action,
        event.entity_type,
        event.entity_id,
        beforeVal,
        afterVal,
        event.ip ?? null,
        event.user_agent ?? null,
        event.ts,
        prevHash,
        hash,
      ],
    )) as unknown as AuditEventRow[];

    await reserved.unsafe('COMMIT');

    return insertRows[0];
  } catch (err) {
    await reserved.unsafe('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    reserved.release();
  }
}
