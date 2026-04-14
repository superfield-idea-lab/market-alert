/**
 * @file retention-multi-entity.test.ts
 *
 * Integration tests for the Phase 8 database-layer retention deletion block
 * across all covered entity types (issue #80).
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 *
 * ## What is tested
 *
 * Acceptance criteria covered:
 *   AC-1  Deletion of a retention-protected row is blocked at the database
 *         layer for each covered entity type.
 *   AC-2  Deletion outside the retention window is allowed through controlled
 *         paths.
 *   AC-3  Every covered type has a dedicated integration test.
 *
 * Test plan items:
 *   TP-1  Integration: attempt deletion inside the window for each covered type
 *         and assert rejection via the `guard_retention_floor` trigger.
 *   TP-2  Integration: attempt deletion outside the window (backdated
 *         `created_at`) through the controlled path and assert success.
 *
 * ## Design notes
 *
 * - The `guard_retention_floor` trigger fires on the `entities` table for
 *   every DELETE, regardless of entity type.  All ground-truth and synthetic
 *   entity types are stored in `entities`, so the trigger covers them all by
 *   construction.
 *
 * - To test "past retention" without waiting years we backdate `created_at`
 *   to a point older than the floor via a raw UPDATE.  The immutability
 *   trigger only guards `retention_class` and `legal_hold`, not `created_at`,
 *   so backdating is safe in tests.
 *
 * - The parametric helper `assertBlockedInsideWindow` and
 *   `assertAllowedOutsideWindow` eliminate boilerplate for each entity type
 *   while keeping each assertion visible in the test output.
 *
 * - No mocks are used.  Real pg container, real schema, real trigger execution.
 *
 * Canonical docs: docs/PRD.md §7a, docs/implementation-plan-v1.md Phase 8
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate } from './index';
import { isWithinRetentionFloor, deleteEntityPastRetention } from './retention-engine';
import { RETENTION_COVERED_TYPES } from './retention-coverage';

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

const MIFID_TENANT = 'tenant-multi-entity-retention-test';
const MIFID_POLICY = 'mifid2-5yr';

// ---------------------------------------------------------------------------
// Suite setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5 });

  // Apply full schema (creates entities, retention_policies, trigger, etc.)
  await migrate({ databaseUrl: pg.url });

  // Register all entity types that appear in the covered set.
  // The FK on entities.type requires a row in entity_types before INSERT.
  for (const covered of RETENTION_COVERED_TYPES) {
    await sql`
      INSERT INTO entity_types (type, schema, sensitive)
      VALUES (${covered.type}, '{}', ARRAY[]::TEXT[])
      ON CONFLICT (type) DO NOTHING
    `;
  }
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inserts one entity of the given type with the MiFID retention class and
 * asserts that an immediate DELETE is rejected by the trigger.
 *
 * Cleans up (backdates + deletes) after itself so each test is independent.
 */
async function assertBlockedInsideWindow(entityType: string): Promise<void> {
  const entityId = `${entityType}-block-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  await sql`
    INSERT INTO entities (id, type, properties, tenant_id, retention_class, legal_hold)
    VALUES (
      ${entityId},
      ${entityType},
      ${'{}'},
      ${MIFID_TENANT},
      ${MIFID_POLICY},
      false
    )
  `;

  // Application-layer floor check must report blocked=true.
  const { blocked } = await isWithinRetentionFloor(sql, entityId);
  expect(blocked, `isWithinRetentionFloor should be true for ${entityType}`).toBe(true);

  // Database-layer trigger must reject the DELETE.
  await expect(
    sql`DELETE FROM entities WHERE id = ${entityId}`,
    `trigger should reject DELETE of ${entityType} inside retention window`,
  ).rejects.toThrow(/retention floor not reached/);

  // Cleanup: backdate and delete so subsequent tests are not affected.
  await sql`
    UPDATE entities
    SET created_at = NOW() - INTERVAL '1827 days'
    WHERE id = ${entityId}
  `;
  await sql`DELETE FROM entities WHERE id = ${entityId}`;
}

/**
 * Inserts one entity of the given type with the MiFID retention class,
 * backdates `created_at` past the floor, and asserts that the controlled
 * deletion path succeeds.
 */
async function assertAllowedOutsideWindow(entityType: string): Promise<void> {
  const entityId = `${entityType}-past-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  await sql`
    INSERT INTO entities (id, type, properties, tenant_id, retention_class, legal_hold)
    VALUES (
      ${entityId},
      ${entityType},
      ${'{}'},
      ${MIFID_TENANT},
      ${MIFID_POLICY},
      false
    )
  `;

  // Backdate to 1827 days ago (one day past the 1826-day MiFID II floor).
  await sql`
    UPDATE entities
    SET created_at = NOW() - INTERVAL '1827 days'
    WHERE id = ${entityId}
  `;

  // Application-layer floor check must now report blocked=false.
  const { blocked } = await isWithinRetentionFloor(sql, entityId);
  expect(blocked, `isWithinRetentionFloor should be false for ${entityType} past floor`).toBe(
    false,
  );

  // Controlled deletion must succeed.
  await expect(
    deleteEntityPastRetention(sql, entityId),
    `deleteEntityPastRetention should succeed for ${entityType} past floor`,
  ).resolves.toBeUndefined();

  // Row must be gone.
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM entities WHERE id = ${entityId}
  `;
  expect(rows.length, `entity ${entityId} (${entityType}) should be deleted`).toBe(0);
}

// ---------------------------------------------------------------------------
// AC-3: every covered type has a dedicated test
// ---------------------------------------------------------------------------

describe('retention coverage — RETENTION_COVERED_TYPES completeness', () => {
  test('RETENTION_COVERED_TYPES lists all six required entity types', () => {
    const types = RETENTION_COVERED_TYPES.map((e) => e.type).sort();
    expect(types).toEqual([
      'corpus_chunk',
      'email',
      'transcript',
      'wiki_annotation',
      'wiki_page',
      'wiki_page_version',
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC-1 + TP-1: deletion inside the window is blocked for each covered type
// ---------------------------------------------------------------------------

describe('deletion block inside retention window — AC-1, TP-1', () => {
  test('email: DELETE inside MiFID 5-year window is rejected by trigger', async () => {
    await assertBlockedInsideWindow('email');
  });

  test('corpus_chunk: DELETE inside MiFID 5-year window is rejected by trigger', async () => {
    await assertBlockedInsideWindow('corpus_chunk');
  });

  test('transcript: DELETE inside MiFID 5-year window is rejected by trigger', async () => {
    await assertBlockedInsideWindow('transcript');
  });

  test('wiki_page_version: DELETE inside MiFID 5-year window is rejected by trigger', async () => {
    await assertBlockedInsideWindow('wiki_page_version');
  });

  test('wiki_annotation: DELETE inside MiFID 5-year window is rejected by trigger', async () => {
    await assertBlockedInsideWindow('wiki_annotation');
  });

  test('wiki_page: DELETE inside MiFID 5-year window is rejected by trigger', async () => {
    await assertBlockedInsideWindow('wiki_page');
  });
});

// ---------------------------------------------------------------------------
// AC-2 + TP-2: deletion outside the window succeeds for each covered type
// ---------------------------------------------------------------------------

describe('deletion allowed outside retention window — AC-2, TP-2', () => {
  test('email: deleteEntityPastRetention succeeds when floor has elapsed', async () => {
    await assertAllowedOutsideWindow('email');
  });

  test('corpus_chunk: deleteEntityPastRetention succeeds when floor has elapsed', async () => {
    await assertAllowedOutsideWindow('corpus_chunk');
  });

  test('transcript: deleteEntityPastRetention succeeds when floor has elapsed', async () => {
    await assertAllowedOutsideWindow('transcript');
  });

  test('wiki_page_version: deleteEntityPastRetention succeeds when floor has elapsed', async () => {
    await assertAllowedOutsideWindow('wiki_page_version');
  });

  test('wiki_annotation: deleteEntityPastRetention succeeds when floor has elapsed', async () => {
    await assertAllowedOutsideWindow('wiki_annotation');
  });

  test('wiki_page: deleteEntityPastRetention succeeds when floor has elapsed', async () => {
    await assertAllowedOutsideWindow('wiki_page');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  test('entity with null retention_class is not affected by the trigger', async () => {
    // Use github_link — a PRD-aligned type seeded by schema.sql with no retention class.
    const entityId = `github-link-no-retention-${Date.now()}`;

    await sql`
      INSERT INTO entities (id, type, properties)
      VALUES (${entityId}, 'github_link', '{}')
    `;

    // DELETE must succeed — no retention_class, no floor check.
    await expect(sql`DELETE FROM entities WHERE id = ${entityId}`).resolves.toBeDefined();
  });

  test('entity with unknown retention_class (no matching policy) can be deleted', async () => {
    const entityId = `email-unknown-class-${Date.now()}`;

    await sql`
      INSERT INTO entities (id, type, properties, tenant_id, retention_class, legal_hold)
      VALUES (
        ${entityId},
        'email',
        ${'{}'},
        ${MIFID_TENANT},
        'unknown-policy-xyz',
        false
      )
    `;

    // No matching row in retention_policies → trigger allows deletion.
    await expect(sql`DELETE FROM entities WHERE id = ${entityId}`).resolves.toBeDefined();
  });
});
