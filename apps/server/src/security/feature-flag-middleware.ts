/**
 * Feature-flag evaluation middleware.
 *
 * PRUNE-C-002: flag table exists and middleware is active on all feature-gated
 * routes. Any route guarded by requireFlag() will return 404 with a structured
 * error body when the named flag is disabled.
 *
 * Middleware design:
 *   - Reads flag state from the DB on every request (no in-process cache).
 *     This means a direct DB toggle (no deploy) changes live behaviour.
 *   - Returns 404 for disabled flags (hides the feature from callers).
 *   - A missing flag row is treated the same as disabled (safe default).
 *   - Returns 503 on DB error so the gated route is never silently reachable.
 */

import { getFlagState } from 'db/feature-flags';
import type postgres from 'postgres';

/**
 * Check whether a feature flag is enabled.
 *
 * @param name - The flag name (must match a row in feature_flags.name).
 * @param db   - Optional postgres connection; defaults to the module-level pool.
 * @returns    true when state = 'enabled', false otherwise (disabled/deprecated/missing).
 */
export async function isFlagEnabled(name: string, db?: postgres.Sql): Promise<boolean> {
  const state = await getFlagState(name, db);
  return state === 'enabled';
}

/**
 * Guard a handler behind a feature flag.
 *
 * Pass as the first check inside a route handler:
 *
 *   const guard = await requireFlag('assemblyai_transcription');
 *   if (guard) return guard;
 *   // ... proceed with the request ...
 *
 * @param name - Feature flag name.
 * @param db   - Optional postgres connection.
 * @returns    null when the flag is enabled (request may proceed),
 *             or a Response (404/503) that the caller must return immediately.
 */
export async function requireFlag(name: string, db?: postgres.Sql): Promise<Response | null> {
  let state: string | null;
  try {
    state = await getFlagState(name, db);
  } catch {
    return new Response(JSON.stringify({ error: 'Feature flag evaluation failed', flag: name }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (state !== 'enabled') {
    return new Response(JSON.stringify({ error: 'Feature not available', flag: name }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return null;
}
