/**
 * Progressive lockout state helpers (AUTH-C-024, AUTH-C-032).
 *
 * Failed passkey assertion attempts are recorded per user. Each failure
 * doubles the mandatory wait time before the next attempt is processed:
 *
 *   attempt 1 fail → delay 1 s
 *   attempt 2 fail → delay 2 s
 *   attempt 3 fail → delay 4 s
 *   attempt 4 fail → delay 8 s
 *   attempt N ≥ 5  → 15-minute temporary lockout
 *
 * The counter resets to 0 on a successful assertion.
 *
 * All auth error responses are generic — callers must never reveal whether
 * the account exists or which credential was wrong (AUTH-C-032).
 */

import { sql } from './index';

/** How many consecutive failures trigger a full temporary lockout. */
const LOCKOUT_THRESHOLD = 5;

/** Duration of a full temporary lockout in seconds. */
const LOCKOUT_DURATION_SECONDS = 15 * 60; // 15 minutes

/**
 * Returns exponential delay in seconds for the given fail count.
 * Capped at the full-lockout threshold.
 */
function delaySecondsFor(failCount: number): number {
  if (failCount <= 0) return 0;
  // 1s, 2s, 4s, 8s, then lockout
  return Math.pow(2, failCount - 1);
}

export interface LockoutState {
  /** Whether the user is currently blocked from authenticating. */
  blocked: boolean;
  /** Seconds until the user may retry (0 when not blocked). */
  retryAfterSeconds: number;
  /** True if the account is in a full temporary lockout (≥ LOCKOUT_THRESHOLD failures). */
  lockedOut: boolean;
}

/**
 * Check whether a user may attempt authentication right now.
 * Returns the current lockout state without modifying any counters.
 */
export async function checkLockout(userId: string): Promise<LockoutState> {
  const rows = await sql`
    SELECT failed_count, delay_until, locked_until
    FROM auth_lockout
    WHERE user_id = ${userId}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return { blocked: false, retryAfterSeconds: 0, lockedOut: false };
  }

  const row = rows[0] as {
    failed_count: number;
    delay_until: Date | null;
    locked_until: Date | null;
  };

  const now = new Date();

  // Full temporary lockout takes precedence
  if (row.locked_until && row.locked_until > now) {
    const retryAfterSeconds = Math.ceil((row.locked_until.getTime() - now.getTime()) / 1000);
    return { blocked: true, retryAfterSeconds, lockedOut: true };
  }

  // Progressive delay
  if (row.delay_until && row.delay_until > now) {
    const retryAfterSeconds = Math.ceil((row.delay_until.getTime() - now.getTime()) / 1000);
    return { blocked: true, retryAfterSeconds, lockedOut: false };
  }

  return { blocked: false, retryAfterSeconds: 0, lockedOut: false };
}

/**
 * Record a failed authentication attempt for a user.
 * Updates the progressive delay or sets a full lockout when the threshold is reached.
 */
export async function recordFailedAttempt(userId: string): Promise<LockoutState> {
  // Upsert the lockout row, incrementing the counter
  const rows = await sql`
    INSERT INTO auth_lockout (user_id, failed_count, delay_until, locked_until, updated_at)
    VALUES (${userId}, 1, NOW() + INTERVAL '1 second', NULL, NOW())
    ON CONFLICT (user_id) DO UPDATE
      SET failed_count = auth_lockout.failed_count + 1,
          updated_at   = NOW()
    RETURNING failed_count
  `;

  const newCount = (rows[0] as { failed_count: number }).failed_count;

  if (newCount >= LOCKOUT_THRESHOLD) {
    // Set full temporary lockout
    await sql`
      UPDATE auth_lockout
      SET locked_until = NOW() + (${LOCKOUT_DURATION_SECONDS} || ' seconds')::INTERVAL,
          delay_until  = NULL,
          updated_at   = NOW()
      WHERE user_id = ${userId}
    `;
    return {
      blocked: true,
      retryAfterSeconds: LOCKOUT_DURATION_SECONDS,
      lockedOut: true,
    };
  }

  // Set exponential delay
  const delaySec = delaySecondsFor(newCount);
  await sql`
    UPDATE auth_lockout
    SET delay_until = NOW() + (${delaySec} || ' seconds')::INTERVAL,
        locked_until = NULL,
        updated_at   = NOW()
    WHERE user_id = ${userId}
  `;

  return {
    blocked: true,
    retryAfterSeconds: delaySec,
    lockedOut: false,
  };
}

/**
 * Reset the lockout counter on successful authentication.
 */
export async function resetLockout(userId: string): Promise<void> {
  await sql`
    INSERT INTO auth_lockout (user_id, failed_count, delay_until, locked_until, updated_at)
    VALUES (${userId}, 0, NULL, NULL, NOW())
    ON CONFLICT (user_id) DO UPDATE
      SET failed_count = 0,
          delay_until  = NULL,
          locked_until = NULL,
          updated_at   = NOW()
  `;
}
