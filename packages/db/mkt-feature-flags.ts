/**
 * Market-alert feature-flag data access layer.
 *
 * PRUNE-D-002, PRUNE-A-003: all vendor source and outbound channel gates must
 * be backed by database rows — no hard-coded booleans or env-var gates.
 *
 * evaluateFlag(key, sql?) — the single public surface used by the cron producer
 * and delivery worker. Returns false when:
 *   - the flag row does not exist
 *   - enabled is false
 *   - scheduled_disable_at is non-null and in the past (and flips enabled to
 *     false as a side-effect so subsequent reads are consistent)
 *
 * No ORM. Raw SQL only (blueprint rule).
 */

import postgres from 'postgres';
import { sql as defaultSql } from './index';

export interface MktFeatureFlag {
  key: string;
  enabled: boolean;
  scheduled_disable_at: Date | null;
  updated_at: Date;
}

/**
 * Evaluate whether a named feature flag is currently enabled.
 *
 * Business rule (PRUNE-D-002):
 *   A flag is considered disabled if:
 *     (a) no row exists for the key, OR
 *     (b) enabled = false, OR
 *     (c) scheduled_disable_at is non-null and <= now()
 *
 * When (c) applies the flag is flipped to enabled=false in the database so
 * subsequent reads are consistent without re-evaluating the timestamp.
 *
 * @param key  Stable flag identifier, e.g. 'edgar_ingest'
 * @param db   Optional postgres connection (defaults to the shared app pool)
 * @returns    true iff the flag exists and is currently enabled
 */
export async function evaluateFlag(key: string, db: postgres.Sql = defaultSql): Promise<boolean> {
  const rows = await db<MktFeatureFlag[]>`
    SELECT key, enabled, scheduled_disable_at, updated_at
    FROM mkt_feature_flags
    WHERE key = ${key}
  `;

  if (rows.length === 0) {
    return false;
  }

  const flag = rows[0];

  // Check scheduled_disable_at: if set and in the past, treat as disabled.
  if (flag.scheduled_disable_at !== null && flag.scheduled_disable_at <= new Date()) {
    // Flip the flag to disabled in the DB so reads are consistent going forward.
    await db`
      UPDATE mkt_feature_flags
      SET enabled = false, updated_at = CURRENT_TIMESTAMP
      WHERE key = ${key} AND enabled = true
    `;
    return false;
  }

  return flag.enabled;
}

/**
 * Read a flag row by key. Returns null when not found.
 */
export async function getMktFlag(
  key: string,
  db: postgres.Sql = defaultSql,
): Promise<MktFeatureFlag | null> {
  const rows = await db<MktFeatureFlag[]>`
    SELECT key, enabled, scheduled_disable_at, updated_at
    FROM mkt_feature_flags
    WHERE key = ${key}
  `;
  return rows[0] ?? null;
}

/**
 * Set a flag's enabled value directly (used in tests and admin operations).
 */
export async function setMktFlag(
  key: string,
  enabled: boolean,
  db: postgres.Sql = defaultSql,
): Promise<void> {
  await db`
    UPDATE mkt_feature_flags
    SET enabled = ${enabled}, updated_at = CURRENT_TIMESTAMP
    WHERE key = ${key}
  `;
}

/**
 * Return the names of all flags whose scheduled_disable_at is in the past
 * and that are still enabled. Used by the in-process scheduler to enqueue
 * prune tasks.
 */
export async function getMktFlagsDueForDisable(db: postgres.Sql = defaultSql): Promise<string[]> {
  const rows = await db<{ key: string }[]>`
    SELECT key
    FROM mkt_feature_flags
    WHERE enabled = true
      AND scheduled_disable_at IS NOT NULL
      AND scheduled_disable_at <= CURRENT_TIMESTAMP
  `;
  return rows.map((r) => r.key);
}
