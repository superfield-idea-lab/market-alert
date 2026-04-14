/**
 * @file retention-scheduler.test.ts
 *
 * Integration tests for the nightly retention scheduler (issue #83).
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 *
 * ## Acceptance criteria covered
 *
 *   AC-1  The scheduler deletes retention-eligible unheld rows past their window.
 *   AC-2  Held rows (legal_hold = true) are skipped.
 *   AC-3  WORM-bound rows outside their window are still deleted through the
 *          controlled path (WORM only blocks UPDATE, not DELETE past the floor).
 *   AC-4  Every deletion emits an audit event.
 *
 * ## Test plan
 *
 *   TP-1  Seed expired, held, and WORM rows; run the scheduler; assert the
 *          correct set is deleted (expired yes, held no, WORM past window yes).
 *   TP-2  Assert audit events are recorded for every deleted entity.
 *
 * Canonical docs: docs/PRD.md §7a, docs/implementation-plan-v1.md Phase 8
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate } from './index';
import { assignRetentionPolicyToTenant } from './retention-engine';
import { enableWorm } from './worm-mode';
import { placeLegalHold } from './legal-hold';
import { createApprovalRequest, castVote } from './approvals';
import { runRetentionScheduler, type SchedulerAuditWriterFn } from './retention-scheduler';

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

const TENANT_A = 'tenant-scheduler-a'; // Normal tenant — has expired rows
const TENANT_B = 'tenant-scheduler-b'; // Tenant with per-entity held rows (legal_hold = true)
const TENANT_C = 'tenant-scheduler-c'; // WORM tenant with rows past the floor
const TENANT_D = 'tenant-scheduler-d'; // Tenant with a legal_holds table hold (four-eyes)
const POLICY = 'mifid2-5yr';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Inserts an entity and returns its id. */
async function insertEntity(
  db: ReturnType<typeof postgres>,
  opts: {
    id: string;
    tenantId: string;
    retentionClass: string;
    legalHold: boolean;
    type?: string;
    /** Pre-backdated created_at offset in days. When set, inserts with an old timestamp. */
    backdateDays?: number;
  },
): Promise<string> {
  const type = opts.type ?? 'corpus_chunk';

  if (opts.backdateDays !== undefined) {
    // Insert with a pre-set created_at so no subsequent UPDATE is needed.
    // This is required for WORM-protected entities (UPDATE is blocked by the trigger).
    await db.unsafe(
      `INSERT INTO entities (id, type, properties, tenant_id, retention_class, legal_hold, created_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, NOW() - ($7 * INTERVAL '1 day'))`,
      [
        opts.id,
        type,
        '{"content":"test entity"}',
        opts.tenantId,
        opts.retentionClass,
        opts.legalHold,
        opts.backdateDays,
      ],
    );
  } else {
    await db`
      INSERT INTO entities (id, type, properties, tenant_id, retention_class, legal_hold)
      VALUES (
        ${opts.id},
        ${type},
        ${'{"content":"test entity"}'},
        ${opts.tenantId},
        ${opts.retentionClass},
        ${opts.legalHold}
      )
    `;
  }
  return opts.id;
}

/** Backdates an entity's created_at by the given number of days. */
async function backdateEntity(
  db: ReturnType<typeof postgres>,
  entityId: string,
  daysAgo: number,
): Promise<void> {
  await db`
    UPDATE entities
    SET created_at = NOW() - (${daysAgo} * INTERVAL '1 day')
    WHERE id = ${entityId}
  `;
}

/** Creates a fully approved enable_worm M-of-N request. */
async function createApprovedWormRequest(
  db: ReturnType<typeof postgres>,
  tenantId: string,
): Promise<string> {
  const request = await createApprovalRequest(db, {
    operation_type: 'enable_worm',
    payload: { tenant_id: tenantId },
    requested_by: 'co-officer-1',
    required_approvals: 2,
  });
  await castVote(db, { request_id: request.id, approver_id: 'co-officer-1', decision: 'approved' });
  await castVote(db, { request_id: request.id, approver_id: 'co-officer-2', decision: 'approved' });
  return request.id;
}

/** Force-deletes an entity, bypassing all triggers (test cleanup only). */
async function forceDeleteEntity(db: ReturnType<typeof postgres>, entityId: string): Promise<void> {
  await db.unsafe("SET session_replication_role = 'replica'");
  await db`DELETE FROM entities WHERE id = ${entityId}`;
  await db.unsafe("SET session_replication_role = 'origin'");
}

/** Returns true when the entity exists in the entities table. */
async function entityExists(db: ReturnType<typeof postgres>, entityId: string): Promise<boolean> {
  const rows = await db<{ id: string }[]>`SELECT id FROM entities WHERE id = ${entityId}`;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 10 });

  await migrate({ databaseUrl: pg.url });

  // Register entity types needed by tests.
  await sql`
    INSERT INTO entity_types (type, schema, sensitive)
    VALUES
      ('corpus_chunk', '{}', ARRAY['content']),
      ('email', '{}', ARRAY['subject', 'body', 'headers'])
    ON CONFLICT (type) DO NOTHING
  `;

  // Assign the MiFID II policy to all test tenants.
  for (const tenantId of [TENANT_A, TENANT_B, TENANT_C, TENANT_D]) {
    await assignRetentionPolicyToTenant(sql, {
      tenantId,
      policyName: POLICY,
      actorId: 'test-setup',
      actorRole: 'compliance_officer',
      isSuperuser: false,
    });
  }

  // Enable WORM for TENANT_C.
  const wormApprovalId = await createApprovedWormRequest(sql, TENANT_C);
  await enableWorm(sql, {
    tenantId: TENANT_C,
    approvalRequestId: wormApprovalId,
    actorId: 'co-officer-1',
    actorRole: 'compliance_officer',
    isSuperuser: false,
  });
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// TP-1: scheduler deletes eligible rows, skips held rows, deletes WORM past window
// ---------------------------------------------------------------------------

describe('runRetentionScheduler — TP-1 (eligibility and legal-hold)', () => {
  test('AC-1: deletes an expired unheld row (Tenant A)', async () => {
    const entityId = `sched-expired-${Date.now()}`;
    await insertEntity(sql, {
      id: entityId,
      tenantId: TENANT_A,
      retentionClass: POLICY,
      legalHold: false,
    });

    // Backdate to one day past the MiFID II 1826-day floor.
    await backdateEntity(sql, entityId, 1827);

    expect(await entityExists(sql, entityId)).toBe(true);

    const summary = await runRetentionScheduler(sql, undefined, 1000);

    // The entity should have been deleted.
    expect(await entityExists(sql, entityId)).toBe(false);
    expect(summary.deletedCount).toBeGreaterThanOrEqual(1);

    const result = summary.results.find((r) => r.entityId === entityId);
    expect(result).toBeDefined();
    expect(result?.deleted).toBe(true);
  });

  test('AC-2: skips a held row (legal_hold = true, Tenant B)', async () => {
    const entityId = `sched-held-${Date.now()}`;
    await insertEntity(sql, {
      id: entityId,
      tenantId: TENANT_B,
      retentionClass: POLICY,
      legalHold: true, // Legal hold is set
    });

    // Backdate to past the floor — would be eligible except for the hold.
    await backdateEntity(sql, entityId, 1827);

    expect(await entityExists(sql, entityId)).toBe(true);

    await runRetentionScheduler(sql, undefined, 1000);

    // The held entity must NOT have been deleted.
    expect(await entityExists(sql, entityId)).toBe(true);

    // Cleanup: force-delete the held entity since it can't be deleted normally.
    await forceDeleteEntity(sql, entityId);
  });

  test('AC-1/AC-3: deletes a WORM-bound row past its retention window (Tenant C)', async () => {
    const entityId = `sched-worm-past-${Date.now()}`;
    // Insert with a pre-backdated created_at — WORM blocks UPDATE on entities within
    // the retention floor, so we cannot backdateEntity() after insert for WORM tenants.
    // The entity is inserted already 1827 days old (one day past the 1826-day MiFID floor).
    await insertEntity(sql, {
      id: entityId,
      tenantId: TENANT_C,
      retentionClass: POLICY,
      legalHold: false,
      backdateDays: 1827,
    });

    expect(await entityExists(sql, entityId)).toBe(true);

    const summary = await runRetentionScheduler(sql, undefined, 1000);

    // The WORM entity past its window should have been deleted.
    expect(await entityExists(sql, entityId)).toBe(false);
    const result = summary.results.find((r) => r.entityId === entityId);
    expect(result).toBeDefined();
    expect(result?.deleted).toBe(true);
  });

  test('AC-2: skips a row when the tenant has an active legal hold in legal_holds table (Tenant D)', async () => {
    const entityId = `sched-tenant-held-${Date.now()}`;
    await insertEntity(sql, {
      id: entityId,
      tenantId: TENANT_D,
      retentionClass: POLICY,
      legalHold: false, // Per-entity hold is false, but tenant-level hold exists
    });
    await backdateEntity(sql, entityId, 1827);

    // Place a tenant-level legal hold on TENANT_D.
    await placeLegalHold(sql, {
      tenantId: TENANT_D,
      placedBy: 'co-officer',
      actorRole: 'compliance_officer',
      reason: 'litigation hold',
    });

    expect(await entityExists(sql, entityId)).toBe(true);

    await runRetentionScheduler(sql, undefined, 1000);

    // Entity must NOT be deleted — the tenant has an active legal hold.
    expect(await entityExists(sql, entityId)).toBe(true);

    // Cleanup: force-delete since the hold prevents normal deletion.
    await forceDeleteEntity(sql, entityId);
    // Remove the hold for future tests.
    await sql`DELETE FROM legal_holds WHERE tenant_id = ${TENANT_D}`;
  });

  test('scheduler does not delete a row still within its retention window', async () => {
    const entityId = `sched-within-window-${Date.now()}`;
    await insertEntity(sql, {
      id: entityId,
      tenantId: TENANT_A,
      retentionClass: POLICY,
      legalHold: false,
    });

    // Do NOT backdate — created_at is NOW(), so the 1826-day floor has NOT elapsed.

    await runRetentionScheduler(sql, undefined, 1000);

    // Entity must still exist — it is within the retention window.
    expect(await entityExists(sql, entityId)).toBe(true);

    // Cleanup.
    await backdateEntity(sql, entityId, 1827);
    await sql`DELETE FROM entities WHERE id = ${entityId}`;
  });

  test('scheduler does not delete an entity with no retention_class', async () => {
    // Use github_link — a PRD-aligned type seeded by schema.sql with no retention class.
    const entityId = `sched-no-class-${Date.now()}`;
    await sql`
      INSERT INTO entities (id, type, properties)
      VALUES (${entityId}, 'github_link', '{"url":"https://github.com/example/repo"}')
    `;

    await runRetentionScheduler(sql, undefined, 1000);

    // Entity with no retention_class is not picked up by the eligibility query.
    expect(await entityExists(sql, entityId)).toBe(true);

    // Cleanup.
    await sql`DELETE FROM entities WHERE id = ${entityId}`;
  });
});

// ---------------------------------------------------------------------------
// TP-2: audit events are emitted for every deletion
// ---------------------------------------------------------------------------

describe('runRetentionScheduler — TP-2 (audit events)', () => {
  test('AC-4: emits an audit event for each deleted entity', async () => {
    const entityId1 = `sched-audit-1-${Date.now()}`;
    const entityId2 = `sched-audit-2-${Date.now() + 1}`;

    await insertEntity(sql, {
      id: entityId1,
      tenantId: TENANT_A,
      retentionClass: POLICY,
      legalHold: false,
    });
    await insertEntity(sql, {
      id: entityId2,
      tenantId: TENANT_A,
      retentionClass: POLICY,
      legalHold: false,
    });

    await backdateEntity(sql, entityId1, 1827);
    await backdateEntity(sql, entityId2, 1827);

    const auditEvents: {
      actor_id: string;
      action: string;
      entity_id: string;
      entity_type: string;
    }[] = [];

    const auditWriter: SchedulerAuditWriterFn = async (event) => {
      auditEvents.push({
        actor_id: event.actor_id,
        action: event.action,
        entity_id: event.entity_id,
        entity_type: event.entity_type,
      });
    };

    await runRetentionScheduler(sql, auditWriter, 1000);

    // Both entities should be deleted.
    expect(await entityExists(sql, entityId1)).toBe(false);
    expect(await entityExists(sql, entityId2)).toBe(false);

    // An audit event must have been emitted for each deleted entity.
    const auditForEntity1 = auditEvents.find((e) => e.entity_id === entityId1);
    const auditForEntity2 = auditEvents.find((e) => e.entity_id === entityId2);

    expect(auditForEntity1).toBeDefined();
    expect(auditForEntity1?.actor_id).toBe('scheduler');
    expect(auditForEntity1?.action).toBe('retention.delete');

    expect(auditForEntity2).toBeDefined();
    expect(auditForEntity2?.actor_id).toBe('scheduler');
    expect(auditForEntity2?.action).toBe('retention.delete');
  });

  test('AC-4: no audit event is emitted for a held (skipped) entity', async () => {
    const entityId = `sched-audit-held-${Date.now()}`;
    await insertEntity(sql, {
      id: entityId,
      tenantId: TENANT_B,
      retentionClass: POLICY,
      legalHold: true,
    });
    await backdateEntity(sql, entityId, 1827);

    const auditEvents: { entity_id: string }[] = [];
    const auditWriter: SchedulerAuditWriterFn = async (event) => {
      auditEvents.push({ entity_id: event.entity_id });
    };

    await runRetentionScheduler(sql, auditWriter, 1000);

    // The held entity must not appear in audit events.
    const auditForHeld = auditEvents.find((e) => e.entity_id === entityId);
    expect(auditForHeld).toBeUndefined();

    // Cleanup.
    await forceDeleteEntity(sql, entityId);
  });

  test('audit event contains correct before/after shape', async () => {
    const entityId = `sched-audit-shape-${Date.now()}`;
    await insertEntity(sql, {
      id: entityId,
      tenantId: TENANT_A,
      retentionClass: POLICY,
      legalHold: false,
      type: 'email',
    });
    await backdateEntity(sql, entityId, 1827);

    let capturedEvent: Parameters<SchedulerAuditWriterFn>[0] | undefined;
    const auditWriter: SchedulerAuditWriterFn = async (event) => {
      if (event.entity_id === entityId) {
        capturedEvent = event;
      }
    };

    await runRetentionScheduler(sql, auditWriter, 1000);

    expect(capturedEvent).toBeDefined();
    expect(capturedEvent?.actor_id).toBe('scheduler');
    expect(capturedEvent?.action).toBe('retention.delete');
    expect(capturedEvent?.entity_type).toBe('email');
    expect(capturedEvent?.entity_id).toBe(entityId);
    expect(capturedEvent?.before).toMatchObject({
      retention_class: POLICY,
      tenant_id: TENANT_A,
      entity_type: 'email',
    });
    expect(capturedEvent?.after).toBeNull();
    expect(capturedEvent?.ts).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Summary shape
// ---------------------------------------------------------------------------

describe('runRetentionScheduler — summary shape', () => {
  test('returns a valid summary when no eligible rows exist', async () => {
    // Run on a clean state — any remaining rows should be within their window.
    const summary = await runRetentionScheduler(sql, undefined, 1000);

    expect(summary).toHaveProperty('deletedCount');
    expect(summary).toHaveProperty('skippedCount');
    expect(summary).toHaveProperty('results');
    expect(summary).toHaveProperty('startedAt');
    expect(summary).toHaveProperty('completedAt');
    expect(typeof summary.deletedCount).toBe('number');
    expect(typeof summary.skippedCount).toBe('number');
    expect(Array.isArray(summary.results)).toBe(true);
  });
});
