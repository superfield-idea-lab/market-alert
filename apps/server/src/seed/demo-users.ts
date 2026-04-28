/**
 * @file seed/demo-users
 * Idempotent seeding of demo role accounts for DEMO_MODE deployments.
 *
 * Seeds one user per demo role that doesn't already exist:
 *   - account_manager  → "Account Manager" role
 *   - supervisor       → "Supervisor" role
 *
 * The superuser account is seeded separately by seedSuperuser().
 * This function is a no-op when DEMO_MODE is not set.
 */

import type { sql as SqlPool } from 'db';
import { log } from 'core';
import { isDemoMode } from '../api/demo-session';

export interface SeedDemoUsersOptions {
  /** postgres.js connection pool to the app database */
  sql: typeof SqlPool;
}

const DEMO_ROLES = [
  { role: 'account_manager', username: 'demo-account-manager' },
  { role: 'supervisor', username: 'demo-supervisor' },
] as const;

/**
 * Seed demo role accounts if running in DEMO_MODE and they don't already exist.
 *
 * This must be called after migrate() so that the entities table exists.
 */
export async function seedDemoUsers({ sql }: SeedDemoUsersOptions): Promise<void> {
  if (!isDemoMode()) {
    return;
  }

  for (const { role, username } of DEMO_ROLES) {
    const existing = await sql`
      SELECT id
      FROM entities
      WHERE type = 'user'
        AND properties->>'role' = ${role}
      LIMIT 1
    `;

    if (existing.length > 0) {
      log('info', `[seed] Demo user with role '${role}' already exists — skipping.`);
      continue;
    }

    const id = crypto.randomUUID();
    const properties = {
      username,
      role,
    };

    await sql`
      INSERT INTO entities (id, type, properties, tenant_id)
      VALUES (${id}, 'user', ${sql.json(properties as never)}, null)
    `;

    log('info', `[seed] Demo user created`, { role, username, id });
  }
}
