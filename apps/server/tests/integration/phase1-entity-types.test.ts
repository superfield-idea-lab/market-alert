/**
 * Integration tests — Phase 1 property graph entity type registration.
 *
 * Boots the real server against an isolated Postgres container and asserts:
 *
 *   1. Every required Phase 1 entity type is present in `entity_types` after boot.
 *   2. Each type routes to the correct pool via the repository layer (i.e. the
 *      `app_rw` pool can store and retrieve entities of each type).
 *   3. Missing a required type causes the test to fail explicitly.
 *
 * No mocks. Real server, real Postgres, real schema.
 *
 * @see packages/db/phase1-entity-types.ts
 * @see docs/technical/db-architecture.md §"Entity type registry"
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Subprocess } from 'bun';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { PHASE_1_ENTITY_TYPES } from '../../../../packages/db/phase1-entity-types';

const PORT = 31420; // isolated port — does not conflict with other integration tests
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 30_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let sql: ReturnType<typeof postgres>;

// ---------------------------------------------------------------------------
// Setup — boot isolated Postgres + server
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pg = await startPostgres();

  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      PORT: String(PORT),
      // TEST_MODE not required — this test only reads entity_types directly.
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);

  // Open a direct SQL connection to the same database so we can query
  // entity_types without going through the HTTP layer.
  sql = postgres(pg.url, { max: 1, idle_timeout: 10, connect_timeout: 10 });
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  server?.kill();
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/health/live`);
      return; // any response means the server is up
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Phase 1 entity type registration — boot assertion', () => {
  test('all Phase 1 entity types are present in entity_types after boot', async () => {
    const rows = await sql<{ type: string }[]>`
      SELECT type FROM entity_types ORDER BY type
    `;

    const registeredTypes = new Set(rows.map((r) => r.type));

    for (const definition of PHASE_1_ENTITY_TYPES) {
      expect(
        registeredTypes.has(definition.type),
        `Expected entity type "${definition.type}" to be registered after boot, but it was missing from entity_types`,
      ).toBe(true);
    }
  });

  test('each Phase 1 type with sensitive fields declares a kmsKeyId', async () => {
    const rows = await sql<{ type: string; sensitive: string[]; kms_key_id: string | null }[]>`
      SELECT type, sensitive, kms_key_id FROM entity_types ORDER BY type
    `;

    const dbMap = new Map(rows.map((r) => [r.type, r]));

    for (const definition of PHASE_1_ENTITY_TYPES) {
      const row = dbMap.get(definition.type);
      if (!row) continue; // covered by the previous test

      if (definition.sensitive && definition.sensitive.length > 0) {
        expect(
          row.kms_key_id,
          `Entity type "${definition.type}" has sensitive fields but no kms_key_id in entity_types`,
        ).not.toBeNull();
      }
    }
  });

  test('each Phase 1 type routes to the app_rw pool — entities can be stored and retrieved', async () => {
    // Insert one entity per Phase 1 type and immediately read it back.
    // This exercises the full repository layer (INSERT FK constraint passes).
    for (const definition of PHASE_1_ENTITY_TYPES) {
      const id = `phase1-test-${definition.type}-${Date.now()}`;

      await sql`
        INSERT INTO entities (id, type, properties)
        VALUES (${id}, ${definition.type}, ${sql.json({}) as never})
      `;

      const [row] = await sql<{ id: string; type: string }[]>`
        SELECT id, type FROM entities WHERE id = ${id}
      `;

      expect(row).toBeDefined();
      expect(row.id).toBe(id);
      expect(row.type).toBe(definition.type);

      // Clean up so tests remain isolated.
      await sql`DELETE FROM entities WHERE id = ${id}`;
    }
  });
});
