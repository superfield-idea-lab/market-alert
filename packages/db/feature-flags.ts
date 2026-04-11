/**
 * Feature-flag data access layer.
 *
 * PRUNE-D-002, PRUNE-D-003, PRUNE-C-002: all shipped-but-gated features must
 * be backed by database-driven feature flags. This module exposes the minimal
 * read/write surface needed by the middleware and the scheduled transition job.
 *
 * No ORM. Raw SQL only (blueprint rule).
 */

import { sql as defaultSql } from './index';
import type postgres from 'postgres';

export type FlagState = 'enabled' | 'deprecated' | 'disabled';

export interface FeatureFlag {
  name: string;
  state: FlagState;
  owner: string;
  created_at: Date;
  scheduled_disable_at: Date | null;
  disabled_at: Date | null;
  removal_eligible_at: Date | null;
}

/**
 * Returns the current state of a named feature flag.
 * Returns null when the flag row does not exist (treat as disabled).
 */
export async function getFlagState(
  name: string,
  db: postgres.Sql = defaultSql,
): Promise<FlagState | null> {
  const rows = await db<{ state: FlagState }[]>`
    SELECT state FROM feature_flags WHERE name = ${name}
  `;
  return rows[0]?.state ?? null;
}

/**
 * Returns a feature flag row by name, or null when not found.
 */
export async function getFlag(
  name: string,
  db: postgres.Sql = defaultSql,
): Promise<FeatureFlag | null> {
  const rows = await db<FeatureFlag[]>`
    SELECT name, state, owner, created_at, scheduled_disable_at, disabled_at, removal_eligible_at
    FROM feature_flags
    WHERE name = ${name}
  `;
  return rows[0] ?? null;
}

/**
 * Returns all flags whose scheduled_disable_at is in the past and whose
 * state is still 'enabled'. These are candidates for the scheduler to flip
 * to 'disabled'.
 */
export async function getFlagsDueForDisable(db: postgres.Sql = defaultSql): Promise<FeatureFlag[]> {
  return db<FeatureFlag[]>`
    SELECT name, state, owner, created_at, scheduled_disable_at, disabled_at, removal_eligible_at
    FROM feature_flags
    WHERE state = 'enabled'
      AND scheduled_disable_at IS NOT NULL
      AND scheduled_disable_at <= NOW()
  `;
}

/**
 * Flip a flag to 'disabled' and record disabled_at = NOW().
 * Idempotent: if the flag is already disabled the UPDATE is a no-op.
 */
export async function disableFlag(name: string, db: postgres.Sql = defaultSql): Promise<void> {
  await db`
    UPDATE feature_flags
    SET state = 'disabled',
        disabled_at = NOW()
    WHERE name = ${name}
      AND state != 'disabled'
  `;
}

/**
 * Set a flag's state directly. Used for direct DB toggles (no deploy required)
 * and in tests.
 */
export async function setFlagState(
  name: string,
  state: FlagState,
  db: postgres.Sql = defaultSql,
): Promise<void> {
  await db`
    UPDATE feature_flags
    SET state = ${state},
        disabled_at = CASE WHEN ${state} = 'disabled' THEN NOW() ELSE disabled_at END
    WHERE name = ${name}
  `;
}

/**
 * Insert or update a feature flag row. Used in seeding and tests.
 */
export async function upsertFlag(
  flag: Pick<FeatureFlag, 'name' | 'state' | 'owner'> &
    Partial<Pick<FeatureFlag, 'scheduled_disable_at' | 'disabled_at' | 'removal_eligible_at'>>,
  db: postgres.Sql = defaultSql,
): Promise<void> {
  await db`
    INSERT INTO feature_flags (name, state, owner, scheduled_disable_at, disabled_at, removal_eligible_at)
    VALUES (
      ${flag.name},
      ${flag.state},
      ${flag.owner},
      ${flag.scheduled_disable_at ?? null},
      ${flag.disabled_at ?? null},
      ${flag.removal_eligible_at ?? null}
    )
    ON CONFLICT (name) DO UPDATE SET
      state = EXCLUDED.state,
      owner = EXCLUDED.owner,
      scheduled_disable_at = EXCLUDED.scheduled_disable_at,
      disabled_at = EXCLUDED.disabled_at,
      removal_eligible_at = EXCLUDED.removal_eligible_at
  `;
}
