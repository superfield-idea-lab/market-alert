/**
 * Market-alert feature-flag evaluation helpers.
 *
 * PRUNE-D-002, PRUNE-A-003: all vendor source and outbound channel gates must
 * be backed by database rows. This module provides the pure evaluation logic
 * used by server middleware and the in-process scheduler.
 *
 * The database read layer lives in packages/db/mkt-feature-flags.ts.
 * This module is intentionally database-free so it can be unit-tested without
 * a running Postgres instance (TEST-C-018: no mocks required for pure functions).
 */

/**
 * Minimal shape of a mkt_feature_flags row needed for evaluation.
 * The full row type is MktFeatureFlag in packages/db/mkt-feature-flags.ts.
 */
export interface FlagRow {
  enabled: boolean;
  scheduled_disable_at: Date | null;
}

/**
 * Evaluate whether a feature flag row represents an enabled flag.
 *
 * Business rule (PRUNE-D-002):
 *   A flag is disabled when:
 *     (a) enabled is false, OR
 *     (b) scheduled_disable_at is non-null and <= now
 *
 * This is a pure function; it does not write back to the database.
 * The DB-backed evaluateFlag (packages/db/mkt-feature-flags.ts) calls this
 * after fetching the row and handles the side-effect write.
 *
 * @param flag  Row fetched from mkt_feature_flags, or null when not found
 * @param now   Current timestamp (defaults to Date.now(); injectable for tests)
 * @returns     true iff the flag exists and is currently enabled
 */
export function evaluateFlag(flag: FlagRow | null, now: Date = new Date()): boolean {
  if (flag === null) {
    return false;
  }
  if (!flag.enabled) {
    return false;
  }
  if (flag.scheduled_disable_at !== null && flag.scheduled_disable_at <= now) {
    return false;
  }
  return true;
}

/** The five v1 flag keys seeded by mkt-schema.sql. */
export const MKT_FLAG_KEYS = [
  'edgar_ingest',
  'alert_notify_email',
  'alert_notify_sms',
  'alert_notify_webhook',
  'trade_lifecycle',
] as const;

export type MktFlagKey = (typeof MKT_FLAG_KEYS)[number];
