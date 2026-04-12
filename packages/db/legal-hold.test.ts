/**
 * @file legal-hold.test.ts
 *
 * Integration tests for Phase 8 LegalHold entity and four-eyes removal flow
 * (issue #82).
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 *
 * ## Acceptance criteria covered
 *
 *   AC-1  A Compliance Officer can place a legal hold on records.
 *   AC-2  Held records are exempt from retention deletion.
 *   AC-3  Removing a hold requires a second distinct Compliance Officer.
 *   AC-4  Audit events are emitted on place and remove.
 *
 * ## Test plan
 *
 *   TP-1  Integration: place a hold, attempt retention deletion, assert the
 *         hold blocks it.
 *   TP-2  Integration: attempt single-actor removal and assert rejection.
 *   TP-3  Integration: complete four-eyes removal and assert the hold is lifted.
 *
 * Canonical docs: docs/PRD.md, docs/implementation-plan-v1.md Phase 8
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate } from './index';
import {
  placeLegalHold,
  getLegalHold,
  listLegalHolds,
  requestHoldRemoval,
  approveHoldRemoval,
  rejectHoldRemoval,
  listPendingRemovalRequests,
  hasActiveLegalHold,
  LegalHoldInsufficientRoleError,
  LegalHoldNotFoundError,
  LegalHoldFourEyesViolationError,
  LegalHoldStatusError,
  LegalHoldRemovalRequestNotFoundError,
} from './legal-hold';
import { isWithinRetentionFloor, deleteEntityPastRetention } from './retention-engine';

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

const TENANT_A = 'tenant-legal-hold-test-a';
const TENANT_B = 'tenant-legal-hold-test-b';
const CO1 = 'compliance-officer-1';
const CO2 = 'compliance-officer-2';
const ANALYST = 'analyst-user-1';
const MIFID_POLICY = 'mifid2-5yr';

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5 });

  await migrate({ databaseUrl: pg.url });

  // Seed entity types and tenant retention policies used by TP-1 / AC-2.
  await sql`
    INSERT INTO entity_types (type, schema, sensitive)
    VALUES ('corpus_chunk', '{}', ARRAY['content'])
    ON CONFLICT (type) DO NOTHING
  `;

  await sql`
    INSERT INTO tenant_retention_policies (tenant_id, retention_class, legal_hold_default)
    VALUES (${TENANT_A}, ${MIFID_POLICY}, false)
    ON CONFLICT (tenant_id) DO NOTHING
  `;
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// AC-1: A Compliance Officer can place a legal hold
// ---------------------------------------------------------------------------

describe('placeLegalHold — AC-1', () => {
  test('AC-1: compliance_officer can place a hold', async () => {
    const hold = await placeLegalHold(sql, {
      tenantId: TENANT_A,
      placedBy: CO1,
      actorRole: 'compliance_officer',
      reason: 'Regulatory investigation REF-001',
    });

    expect(hold.id).toBeTruthy();
    expect(hold.tenant_id).toBe(TENANT_A);
    expect(hold.placed_by).toBe(CO1);
    expect(hold.status).toBe('active');
    expect(hold.removed_at).toBeNull();
  });

  test('audit writer is called on place', async () => {
    const auditCalls: string[] = [];

    await placeLegalHold(
      sql,
      {
        tenantId: `${TENANT_B}-audit-test`,
        placedBy: CO1,
        actorRole: 'compliance_officer',
        reason: 'Audit test',
      },
      async (event) => {
        auditCalls.push(event.action);
      },
    );

    expect(auditCalls).toContain('legal_hold.place');
  });

  test('throws LegalHoldInsufficientRoleError for non-compliance_officer', async () => {
    await expect(
      placeLegalHold(sql, {
        tenantId: TENANT_A,
        placedBy: ANALYST,
        actorRole: 'analyst',
      }),
    ).rejects.toBeInstanceOf(LegalHoldInsufficientRoleError);
  });

  test('superuser can place a hold without compliance_officer role', async () => {
    const hold = await placeLegalHold(sql, {
      tenantId: `${TENANT_B}-superuser`,
      placedBy: 'superuser',
      actorRole: null,
      isSuperuser: true,
      reason: 'Superuser test',
    });

    expect(hold.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// getLegalHold and listLegalHolds
// ---------------------------------------------------------------------------

describe('getLegalHold and listLegalHolds', () => {
  test('getLegalHold returns null for a non-existent hold', async () => {
    const result = await getLegalHold(sql, 'non-existent-id');
    expect(result).toBeNull();
  });

  test('getLegalHold returns the hold with no pending_removal_request initially', async () => {
    const placed = await placeLegalHold(sql, {
      tenantId: `${TENANT_A}-get-test`,
      placedBy: CO1,
      actorRole: 'compliance_officer',
    });

    const fetched = await getLegalHold(sql, placed.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(placed.id);
    expect(fetched!.pending_removal_request).toBeNull();
  });

  test('listLegalHolds filters by status', async () => {
    const tenant = `${TENANT_A}-list-test-${Date.now()}`;
    await placeLegalHold(sql, {
      tenantId: tenant,
      placedBy: CO1,
      actorRole: 'compliance_officer',
    });

    const activeHolds = await listLegalHolds(sql, { status: 'active', tenantId: tenant });
    expect(activeHolds.length).toBeGreaterThan(0);
    expect(activeHolds.every((h) => h.status === 'active')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-2 + TP-1: Held records are exempt from retention deletion
// ---------------------------------------------------------------------------

describe('hasActiveLegalHold and retention block — AC-2, TP-1', () => {
  test('TP-1: legal hold blocks retention deletion via isWithinRetentionFloor', async () => {
    const holdTenant = `${TENANT_A}-retention-block-${Date.now()}`;

    // Seed tenant retention policy.
    await sql`
      INSERT INTO tenant_retention_policies (tenant_id, retention_class, legal_hold_default)
      VALUES (${holdTenant}, ${MIFID_POLICY}, false)
      ON CONFLICT (tenant_id) DO NOTHING
    `;

    // Insert an entity with the tenant and backdate it past the retention floor.
    const entityId = `entity-hold-block-${Date.now()}`;
    await sql`
      INSERT INTO entities (id, type, properties, tenant_id, retention_class, legal_hold)
      VALUES (
        ${entityId},
        'corpus_chunk',
        '{"content":"test"}',
        ${holdTenant},
        ${MIFID_POLICY},
        false
      )
    `;

    // Backdate to past retention floor so the floor itself doesn't block.
    await sql`
      UPDATE entities
      SET created_at = NOW() - INTERVAL '1827 days'
      WHERE id = ${entityId}
    `;

    // Without a legal hold, deletion should succeed.
    const beforeHold = await isWithinRetentionFloor(sql, entityId);
    expect(beforeHold.blocked).toBe(false);

    // Place a legal hold on the tenant.
    await placeLegalHold(sql, {
      tenantId: holdTenant,
      placedBy: CO1,
      actorRole: 'compliance_officer',
    });

    // With a legal hold, isWithinRetentionFloor should report blocked=true.
    const afterHold = await isWithinRetentionFloor(sql, entityId);
    expect(afterHold.blocked).toBe(true);
    expect(afterHold.legalHoldActive).toBe(true);

    // deleteEntityPastRetention must throw for the held entity.
    await expect(deleteEntityPastRetention(sql, entityId)).rejects.toThrow(/active legal hold/);

    // Cleanup: remove entity without going through retention path (test teardown).
    await sql`
      UPDATE entities
      SET created_at = NOW() - INTERVAL '1827 days'
      WHERE id = ${entityId}
    `;
    // We can't delete through the controlled path while hold is active; leave it.
  });

  test('hasActiveLegalHold returns false when no holds exist for tenant', async () => {
    const result = await hasActiveLegalHold(sql, 'tenant-no-holds');
    expect(result).toBe(false);
  });

  test('hasActiveLegalHold returns true when active hold exists', async () => {
    const holdTenant = `${TENANT_A}-has-hold-${Date.now()}`;
    await placeLegalHold(sql, {
      tenantId: holdTenant,
      placedBy: CO1,
      actorRole: 'compliance_officer',
    });

    const result = await hasActiveLegalHold(sql, holdTenant);
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-3 + TP-2: Single-actor removal is rejected
// ---------------------------------------------------------------------------

describe('four-eyes enforcement — AC-3, TP-2', () => {
  test('TP-2: same actor as requester cannot co-approve (four-eyes violation)', async () => {
    const tenant = `${TENANT_A}-four-eyes-${Date.now()}`;
    const hold = await placeLegalHold(sql, {
      tenantId: tenant,
      placedBy: CO1,
      actorRole: 'compliance_officer',
    });

    // CO1 initiates removal.
    const removalRequest = await requestHoldRemoval(sql, {
      holdId: hold.id,
      requestedBy: CO1,
      actorRole: 'compliance_officer',
    });

    expect(removalRequest.status).toBe('pending');
    expect(removalRequest.requested_by).toBe(CO1);

    // CO1 attempts to also co-approve — must be rejected.
    await expect(
      approveHoldRemoval(sql, {
        removalRequestId: removalRequest.id,
        coApprovedBy: CO1,
        actorRole: 'compliance_officer',
      }),
    ).rejects.toBeInstanceOf(LegalHoldFourEyesViolationError);
  });

  test('non-compliance_officer cannot request removal', async () => {
    const tenant = `${TENANT_A}-role-guard-${Date.now()}`;
    const hold = await placeLegalHold(sql, {
      tenantId: tenant,
      placedBy: CO1,
      actorRole: 'compliance_officer',
    });

    await expect(
      requestHoldRemoval(sql, {
        holdId: hold.id,
        requestedBy: ANALYST,
        actorRole: 'analyst',
      }),
    ).rejects.toBeInstanceOf(LegalHoldInsufficientRoleError);
  });

  test('requestHoldRemoval throws LegalHoldNotFoundError for unknown hold', async () => {
    await expect(
      requestHoldRemoval(sql, {
        holdId: 'non-existent-hold',
        requestedBy: CO1,
        actorRole: 'compliance_officer',
      }),
    ).rejects.toBeInstanceOf(LegalHoldNotFoundError);
  });

  test('requestHoldRemoval throws LegalHoldStatusError when hold is not active', async () => {
    const tenant = `${TENANT_A}-status-guard-${Date.now()}`;
    const hold = await placeLegalHold(sql, {
      tenantId: tenant,
      placedBy: CO1,
      actorRole: 'compliance_officer',
    });

    // Transition to pending_removal.
    await requestHoldRemoval(sql, {
      holdId: hold.id,
      requestedBy: CO1,
      actorRole: 'compliance_officer',
    });

    // Second request must fail because hold is already pending_removal.
    await expect(
      requestHoldRemoval(sql, {
        holdId: hold.id,
        requestedBy: CO2,
        actorRole: 'compliance_officer',
      }),
    ).rejects.toBeInstanceOf(LegalHoldStatusError);
  });
});

// ---------------------------------------------------------------------------
// AC-3 + TP-3: Successful four-eyes removal
// ---------------------------------------------------------------------------

describe('complete four-eyes removal — AC-3, TP-3', () => {
  test('TP-3: two distinct Compliance Officers can complete the removal flow', async () => {
    const tenant = `${TENANT_A}-full-removal-${Date.now()}`;
    const auditActions: string[] = [];

    const hold = await placeLegalHold(
      sql,
      {
        tenantId: tenant,
        placedBy: CO1,
        actorRole: 'compliance_officer',
      },
      async (event) => {
        auditActions.push(event.action);
      },
    );

    expect(hold.status).toBe('active');

    // CO1 initiates removal.
    const removalRequest = await requestHoldRemoval(
      sql,
      {
        holdId: hold.id,
        requestedBy: CO1,
        actorRole: 'compliance_officer',
      },
      async (event) => {
        auditActions.push(event.action);
      },
    );

    expect(removalRequest.status).toBe('pending');
    expect(removalRequest.requested_by).toBe(CO1);

    // Hold should now show pending_removal status.
    const holdAfterRequest = await getLegalHold(sql, hold.id);
    expect(holdAfterRequest!.status).toBe('pending_removal');
    expect(holdAfterRequest!.pending_removal_request).not.toBeNull();

    // CO2 co-approves — different actor.
    const removedHold = await approveHoldRemoval(
      sql,
      {
        removalRequestId: removalRequest.id,
        coApprovedBy: CO2,
        actorRole: 'compliance_officer',
      },
      async (event) => {
        auditActions.push(event.action);
      },
    );

    expect(removedHold.status).toBe('removed');
    expect(removedHold.removed_at).not.toBeNull();

    // hasActiveLegalHold must now return false.
    const stillActive = await hasActiveLegalHold(sql, tenant);
    expect(stillActive).toBe(false);
  });

  test('AC-4: audit events are emitted — place and remove', async () => {
    const tenant = `${TENANT_A}-audit-full-${Date.now()}`;
    const auditActions: string[] = [];
    const writer = async (event: { action: string }) => {
      auditActions.push(event.action);
    };

    const hold = await placeLegalHold(
      sql,
      { tenantId: tenant, placedBy: CO1, actorRole: 'compliance_officer' },
      writer,
    );

    const req = await requestHoldRemoval(
      sql,
      { holdId: hold.id, requestedBy: CO1, actorRole: 'compliance_officer' },
      writer,
    );

    await approveHoldRemoval(
      sql,
      { removalRequestId: req.id, coApprovedBy: CO2, actorRole: 'compliance_officer' },
      writer,
    );

    expect(auditActions).toContain('legal_hold.place');
    expect(auditActions).toContain('legal_hold.removal_requested');
    expect(auditActions).toContain('legal_hold.remove');
  });
});

// ---------------------------------------------------------------------------
// rejectHoldRemoval
// ---------------------------------------------------------------------------

describe('rejectHoldRemoval', () => {
  test('rejection returns hold to active status', async () => {
    const tenant = `${TENANT_A}-reject-${Date.now()}`;

    const hold = await placeLegalHold(sql, {
      tenantId: tenant,
      placedBy: CO1,
      actorRole: 'compliance_officer',
    });

    const removalRequest = await requestHoldRemoval(sql, {
      holdId: hold.id,
      requestedBy: CO1,
      actorRole: 'compliance_officer',
    });

    const rejectedHold = await rejectHoldRemoval(sql, {
      removalRequestId: removalRequest.id,
      rejectedBy: CO2,
      actorRole: 'compliance_officer',
    });

    expect(rejectedHold.status).toBe('active');
    expect(rejectedHold.removed_at).toBeNull();

    // Hold should be active again.
    const active = await hasActiveLegalHold(sql, tenant);
    expect(active).toBe(true);
  });

  test('throws LegalHoldRemovalRequestNotFoundError for unknown request', async () => {
    await expect(
      rejectHoldRemoval(sql, {
        removalRequestId: 'non-existent-request',
        rejectedBy: CO2,
        actorRole: 'compliance_officer',
      }),
    ).rejects.toBeInstanceOf(LegalHoldRemovalRequestNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// listPendingRemovalRequests
// ---------------------------------------------------------------------------

describe('listPendingRemovalRequests', () => {
  test('returns pending removal requests with hold details', async () => {
    const tenant = `${TENANT_A}-pending-list-${Date.now()}`;

    const hold = await placeLegalHold(sql, {
      tenantId: tenant,
      placedBy: CO1,
      actorRole: 'compliance_officer',
    });

    await requestHoldRemoval(sql, {
      holdId: hold.id,
      requestedBy: CO1,
      actorRole: 'compliance_officer',
    });

    const pending = await listPendingRemovalRequests(sql);
    const mine = pending.find((r) => r.hold_id === hold.id);

    expect(mine).toBeDefined();
    expect(mine!.status).toBe('pending');
    expect(mine!.hold.tenant_id).toBe(tenant);
  });
});
