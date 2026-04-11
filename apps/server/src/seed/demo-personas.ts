/**
 * @file seed/demo-personas
 * Idempotent demo persona seeding for DEMO_MODE.
 *
 * When `DEMO_MODE=true` is set in the environment, this module seeds two fixed
 * demo personas on startup:
 *
 *   1. A demo superadmin  — email: demo-admin@calypso.local, password: demo-admin-pass
 *   2. A demo regular user — email: demo-user@calypso.local,  password: demo-user-pass
 *
 * Seeding is idempotent: if a persona with the matching email already exists, it
 * is skipped. When DEMO_MODE is not set or is any value other than "true", no
 * demo data is created and the function returns immediately.
 *
 * Demo credentials are logged to the console on startup so operators can use
 * them for walk-throughs without consulting documentation.
 */

import type { sql as SqlPool } from 'db';
import { log } from 'core';

export interface SeedDemoPersonasOptions {
  /** postgres.js connection pool to the app database */
  sql: typeof SqlPool;
}

/** Fixed demo persona definitions. */
export const DEMO_PERSONAS = [
  {
    email: 'demo-admin@calypso.local',
    password: 'demo-admin-pass',
    role: 'superuser' as const,
    label: 'Demo Superadmin',
  },
  {
    email: 'demo-user@calypso.local',
    password: 'demo-user-pass',
    role: 'user' as const,
    label: 'Demo Regular User',
  },
] as const;

/**
 * Seed demo personas when DEMO_MODE is enabled.
 *
 * Must be called after migrations so the entities table exists.
 */
export async function seedDemoPersonas({ sql }: SeedDemoPersonasOptions): Promise<void> {
  if (process.env.DEMO_MODE !== 'true') {
    return;
  }

  log('info', '[demo] DEMO_MODE is enabled — seeding demo personas.');

  for (const persona of DEMO_PERSONAS) {
    const existing = await sql`
      SELECT id
      FROM entities
      WHERE type = 'user'
        AND properties->>'email' = ${persona.email}
      LIMIT 1
    `;

    if (existing.length > 0) {
      log('info', `[demo] ${persona.label} already exists — skipping.`);
      continue;
    }

    const passwordHash = await Bun.password.hash(persona.password);
    const id = crypto.randomUUID();
    const properties = {
      username: persona.email,
      email: persona.email,
      password_hash: passwordHash,
      role: persona.role,
    };

    await sql`
      INSERT INTO entities (id, type, properties, tenant_id)
      VALUES (${id}, 'user', ${sql.json(properties as never)}, null)
    `;

    log('info', `[demo] ${persona.label} created`, { id });
  }

  // Log that demo credentials are available — the actual values are omitted
  // to prevent PII (email + password) from appearing in server logs.
  log('info', '[demo] Demo personas seeded. Credentials are defined in DEMO_PERSONAS constant.');
}
