/**
 * @file retention-engine.test.ts
 *
 * Integration tests for the Phase 8 retention policy engine scout (issue #78).
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 *
 * ## What is tested
 *
 * Acceptance criteria covered:
 *   AC-1  A tenant can be assigned a 5-year MiFID II policy.
 *   AC-2  A CorpusChunk within retention cannot be deleted via any application role.
 *   AC-3  The block is enforced at the database layer (trigger, not application).
 *   AC-4  A chunk past retention can be deleted through the controlled path.
 *
 * Test plan items:
 *   TP-1  Integration: assign the policy, attempt deletion inside the window,
 *         assert database-layer rejection.
 *   TP-2  Integration: age a chunk past retention and assert controlled deletion
 *         succeeds.
 *
 * ## Design notes
 *
 * - The `guard_retention_floor` trigger compares NOW() against
 *   `entities.created_at + retention_floor_days * INTERVAL '1 day'`.
 * - To test "past retention" without waiting years we backdating `created_at`
 *   to a point older than the floor via a raw UPDATE before attempting deletion.
 *   The immutability trigger only guards `retention_class` and `legal_hold`, not
 *   `created_at`, so this backdating is safe in tests.
 * - No mocks are used. Real pg container, real schema, real trigger execution.
 *
 * Canonical docs: docs/PRD.md §7a, docs/implementation-plan-v1.md Phase 8
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate } from './index';
import {
  lookupRetentionPolicy,
  assignRetentionPolicyToTenant,
  isWithinRetentionFloor,
  deleteEntityPastRetention,
  UnknownRetentionPolicyError,
  RetentionFloorNotReachedError,
} from './retention-engine';

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

const MIFID_TENANT = 'tenant-mifid2-scout-test';
const MIFID_POLICY = 'mifid2-5yr';

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5 });

  // Apply full schema (creates retention_policies, seed fixture, trigger, etc.)
  await migrate({ databaseUrl: pg.url });

  // Register entity types needed by tests.
  await sql`
    INSERT INTO entity_types (type, schema, sensitive)
    VALUES
      ('corpus_chunk', '{}', ARRAY['content']),
      ('email',        '{}', ARRAY['subject','body','headers'])
    ON CONFLICT (type) DO NOTHING
  `;
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// retention_policies catalogue
// ---------------------------------------------------------------------------

describe('retention_policies catalogue', () => {
  test('mifid2-5yr seed fixture is present after migration', async () => {
    const policy = await lookupRetentionPolicy(sql, MIFID_POLICY);

    expect(policy.name).toBe(MIFID_POLICY);
    expect(policy.retentionFloorDays).toBe(1826);
    expect(policy.description).toMatch(/MiFID II/);
  });

  test('throws UnknownRetentionPolicyError for an unrecognised policy name', async () => {
    await expect(lookupRetentionPolicy(sql, 'not-a-real-policy')).rejects.toBeInstanceOf(
      UnknownRetentionPolicyError,
    );
  });
});

// ---------------------------------------------------------------------------
// AC-1: tenant can be assigned a 5-year MiFID II policy
// ---------------------------------------------------------------------------

describe('assignRetentionPolicyToTenant — AC-1', () => {
  test('AC-1: assigns mifid2-5yr to a tenant and the row is readable', async () => {
    await assignRetentionPolicyToTenant(sql, MIFID_TENANT, MIFID_POLICY);

    const [row] = await sql<{ retention_class: string }[]>`
      SELECT retention_class FROM tenant_retention_policies
      WHERE tenant_id = ${MIFID_TENANT}
    `;

    expect(row.retention_class).toBe(MIFID_POLICY);
  });

  test('assignment is idempotent (upsert)', async () => {
    // Second call must not throw.
    await expect(
      assignRetentionPolicyToTenant(sql, MIFID_TENANT, MIFID_POLICY),
    ).resolves.toBeUndefined();
  });

  test('throws UnknownRetentionPolicyError for an unknown policy name', async () => {
    await expect(
      assignRetentionPolicyToTenant(sql, MIFID_TENANT, 'nonexistent-policy'),
    ).rejects.toBeInstanceOf(UnknownRetentionPolicyError);
  });
});

// ---------------------------------------------------------------------------
// AC-2 + AC-3: CorpusChunk within retention cannot be deleted (database layer)
// ---------------------------------------------------------------------------

describe('retention floor deletion block — AC-2, AC-3, TP-1', () => {
  test('TP-1: DELETE of a corpus_chunk within the MiFID 5-year floor is rejected by the trigger', async () => {
    const chunkId = `chunk-block-test-${Date.now()}`;

    // Insert a corpus_chunk with the MiFID retention class.
    await sql`
      INSERT INTO entities (id, type, properties, tenant_id, retention_class, legal_hold)
      VALUES (
        ${chunkId},
        'corpus_chunk',
        ${'{"content":"Anonymised call transcript fragment."}'},
        ${MIFID_TENANT},
        ${MIFID_POLICY},
        false
      )
    `;

    // isWithinRetentionFloor must report blocked=true.
    const { blocked, eligibleAt } = await isWithinRetentionFloor(sql, chunkId);
    expect(blocked).toBe(true);
    expect(eligibleAt).not.toBeNull();

    // AC-3: the trigger must reject a raw DELETE from any role.
    await expect(sql`DELETE FROM entities WHERE id = ${chunkId}`).rejects.toThrow(
      /retention floor not reached/,
    );

    // Cleanup: backdate created_at so the floor has elapsed, then delete.
    await sql`
      UPDATE entities
      SET created_at = NOW() - INTERVAL '1827 days'
      WHERE id = ${chunkId}
    `;
    await sql`DELETE FROM entities WHERE id = ${chunkId}`;
  });

  test('AC-2: deletion attempt surfaces RetentionFloorNotReachedError at the application layer', async () => {
    const chunkId = `chunk-app-block-test-${Date.now()}`;

    await sql`
      INSERT INTO entities (id, type, properties, tenant_id, retention_class, legal_hold)
      VALUES (
        ${chunkId},
        'corpus_chunk',
        ${'{"content":"Within-window chunk."}'},
        ${MIFID_TENANT},
        ${MIFID_POLICY},
        false
      )
    `;

    // deleteEntityPastRetention must throw before reaching the DB trigger.
    await expect(deleteEntityPastRetention(sql, chunkId)).rejects.toBeInstanceOf(
      RetentionFloorNotReachedError,
    );

    // Cleanup.
    await sql`
      UPDATE entities
      SET created_at = NOW() - INTERVAL '1827 days'
      WHERE id = ${chunkId}
    `;
    await sql`DELETE FROM entities WHERE id = ${chunkId}`;
  });

  test('entities with no retention_class are not affected by the trigger', async () => {
    // Insert an entity type that doesn't require retention metadata.
    await sql`
      INSERT INTO entity_types (type, schema, sensitive)
      VALUES ('task', '{}', ARRAY[]::TEXT[])
      ON CONFLICT (type) DO NOTHING
    `;

    const taskId = `task-no-retention-${Date.now()}`;

    await sql`
      INSERT INTO entities (id, type, properties)
      VALUES (${taskId}, 'task', '{"name":"ephemeral task"}')
    `;

    // DELETE must succeed — no retention_class, no floor check.
    await expect(sql`DELETE FROM entities WHERE id = ${taskId}`).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC-4 + TP-2: chunk past retention can be deleted through the controlled path
// ---------------------------------------------------------------------------

describe('controlled deletion past retention — AC-4, TP-2', () => {
  test('TP-2: deleteEntityPastRetention succeeds when created_at is older than the floor', async () => {
    const chunkId = `chunk-past-retention-${Date.now()}`;

    // Insert the chunk.
    await sql`
      INSERT INTO entities (id, type, properties, tenant_id, retention_class, legal_hold)
      VALUES (
        ${chunkId},
        'corpus_chunk',
        ${'{"content":"Past-retention corpus chunk."}'},
        ${MIFID_TENANT},
        ${MIFID_POLICY},
        false
      )
    `;

    // Backdate created_at to 1827 days ago (one day past the 1826-day floor).
    await sql`
      UPDATE entities
      SET created_at = NOW() - INTERVAL '1827 days'
      WHERE id = ${chunkId}
    `;

    // isWithinRetentionFloor must now report blocked=false.
    const { blocked } = await isWithinRetentionFloor(sql, chunkId);
    expect(blocked).toBe(false);

    // AC-4: the controlled deletion path must succeed.
    await expect(deleteEntityPastRetention(sql, chunkId)).resolves.toBeUndefined();

    // Confirm the row is gone.
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM entities WHERE id = ${chunkId}
    `;
    expect(rows.length).toBe(0);
  });

  test('deleteEntityPastRetention is a no-op for an entity that does not exist', async () => {
    await expect(
      deleteEntityPastRetention(sql, 'entity-that-does-not-exist'),
    ).resolves.toBeUndefined();
  });
});
