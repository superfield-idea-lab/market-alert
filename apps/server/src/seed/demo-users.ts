/**
 * @file seed/demo-users
 * Idempotent seeding of demo fixture data for DEMO_MODE deployments.
 *
 * Delegates to the canonical `seedDemoFixtures` function in `packages/db/demo-seed.ts`
 * so that the demo and e2e test environments always start from identical data.
 * This function is a no-op when DEMO_MODE is not set.
 *
 * @see packages/db/demo-seed.ts — single source of truth for fixture data
 */

import type { sql as SqlPool } from 'db';
import { seedDemoFixtures } from 'db';
import { log } from 'core';
import { isDemoMode } from '../api/demo-session';

export interface SeedDemoUsersOptions {
  /** postgres.js connection pool to the app database */
  sql: typeof SqlPool;
}

/**
 * Seed the canonical demo fixtures if running in DEMO_MODE.
 *
 * Must be called after migrate() and migrateMkt() so all tables exist.
 */
export async function seedDemoUsers({ sql }: SeedDemoUsersOptions): Promise<void> {
  if (!isDemoMode()) {
    return;
  }

  log('info', '[seed] Applying demo fixtures...');
  await seedDemoFixtures(sql);
  log('info', '[seed] Demo fixtures applied.');
}
