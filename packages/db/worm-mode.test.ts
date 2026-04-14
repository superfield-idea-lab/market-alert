/**
 * @file worm-mode.test.ts
 *
 * Integration tests for WORM mode on ground-truth tables (issue #81).
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 *
 * Acceptance criteria covered:
 *   AC-1  A WORM-enabled tenant cannot UPDATE ground-truth rows until retention expires.
 *   AC-2  A WORM-enabled tenant cannot DELETE ground-truth rows until retention expires.
 *   AC-3  WORM can only be enabled through the M-of-N approval path.
 *   AC-4  Integration tests pass for MiFID II and SEC 17a-4(f) scenarios.
 *
 * Test plan items covered:
 *   TP-1  Integration: enable WORM via M-of-N and assert policies activate.
 *   TP-2  Integration: attempt UPDATE/DELETE on a WORM ground-truth row and assert rejection.
 *   TP-3  Integration: age the row past retention and assert controlled deletion succeeds.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate } from './index';
import { createApprovalRequest, castVote, PRIVILEGED_OPERATIONS } from './approvals';
import {
  isWormEnabled,
  enableWorm,
  checkWormUpdateGuard,
  WormApprovalRequiredError,
  InsufficientRoleError,
} from './worm-mode';

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

const MIFID_TENANT = 'tenant-worm-mifid2';
const SEC_TENANT = 'tenant-worm-sec17a4';
const MIFID_POLICY = 'mifid2-5yr';
const SEC_POLICY = 'sec17a4-6yr';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deletes an entity, bypassing all triggers by temporarily setting
 * session_replication_role = 'replica'. Used only for test cleanup of
 * WORM-protected rows that cannot be deleted via the normal path.
 */
async function forceDeleteEntity(db: ReturnType<typeof postgres>, entityId: string): Promise<void> {
  await db.unsafe("SET session_replication_role = 'replica'");
  await db`DELETE FROM entities WHERE id = ${entityId}`;
  await db.unsafe("SET session_replication_role = 'origin'");
}

/** Creates a fully approved enable_worm M-of-N request for a tenant. */
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

  await castVote(db, {
    request_id: request.id,
    approver_id: 'co-officer-1',
    decision: 'approved',
  });

  await castVote(db, {
    request_id: request.id,
    approver_id: 'co-officer-2',
    decision: 'approved',
  });

  return request.id;
}

/** Inserts a ground-truth entity for a tenant and returns its id. */
async function insertGroundTruthEntity(
  db: ReturnType<typeof postgres>,
  tenantId: string,
  retentionClass: string,
  suffix: string,
): Promise<string> {
  const entityId = `entity-worm-${suffix}-${Date.now()}`;
  await db`
    INSERT INTO entities (id, type, properties, tenant_id, retention_class, legal_hold)
    VALUES (
      ${entityId},
      'corpus_chunk',
      ${'{"content":"Anonymised ground-truth fragment."}'},
      ${tenantId},
      ${retentionClass},
      false
    )
  `;
  return entityId;
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
      ('email',        '{}', ARRAY['subject','body','headers'])
    ON CONFLICT (type) DO NOTHING
  `;

  // Seed tenant retention policies for the MiFID II and SEC tenants.
  for (const [tenantId, retentionClass] of [
    [MIFID_TENANT, MIFID_POLICY],
    [SEC_TENANT, SEC_POLICY],
  ] as const) {
    await sql`
      INSERT INTO tenant_retention_policies (tenant_id, retention_class, legal_hold_default)
      VALUES (${tenantId}, ${retentionClass}, false)
      ON CONFLICT (tenant_id) DO UPDATE
        SET retention_class = EXCLUDED.retention_class
    `;
  }
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// enable_worm privileged operation type
// ---------------------------------------------------------------------------

describe('PRIVILEGED_OPERATIONS includes enable_worm', () => {
  test('enable_worm is in the PRIVILEGED_OPERATIONS list', () => {
    expect(PRIVILEGED_OPERATIONS).toContain('enable_worm');
  });
});

// ---------------------------------------------------------------------------
// isWormEnabled — defaults
// ---------------------------------------------------------------------------

describe('isWormEnabled defaults', () => {
  test('returns false for a tenant that has never had WORM configured', async () => {
    const result = await isWormEnabled('tenant-fresh-worm-check', sql);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-3 + TP-1: WORM can only be enabled through the M-of-N approval path
// ---------------------------------------------------------------------------

describe('enableWorm — M-of-N approval gate (AC-3, TP-1)', () => {
  test('AC-3: throws InsufficientRoleError when actor lacks compliance_officer role', async () => {
    const approvalRequestId = await createApprovedWormRequest(sql, 'tenant-role-blocked');

    await expect(
      enableWorm(sql, {
        tenantId: 'tenant-role-blocked',
        approvalRequestId,
        actorId: 'analyst-user',
        actorRole: 'analyst',
        isSuperuser: false,
      }),
    ).rejects.toBeInstanceOf(InsufficientRoleError);
  });

  test('AC-3: throws WormApprovalRequiredError when no approval request exists', async () => {
    await expect(
      enableWorm(sql, {
        tenantId: 'tenant-no-approval',
        approvalRequestId: 'non-existent-approval-id',
        actorId: 'co-officer',
        actorRole: 'compliance_officer',
      }),
    ).rejects.toBeInstanceOf(WormApprovalRequiredError);
  });

  test('AC-3: throws WormApprovalRequiredError when approval request is still pending', async () => {
    const request = await createApprovalRequest(sql, {
      operation_type: 'enable_worm',
      payload: { tenant_id: 'tenant-pending-worm' },
      requested_by: 'co-officer-1',
      required_approvals: 2,
    });

    // Only one vote — quorum not reached.
    await castVote(sql, {
      request_id: request.id,
      approver_id: 'co-officer-1',
      decision: 'approved',
    });

    await expect(
      enableWorm(sql, {
        tenantId: 'tenant-pending-worm',
        approvalRequestId: request.id,
        actorId: 'co-officer-1',
        actorRole: 'compliance_officer',
      }),
    ).rejects.toBeInstanceOf(WormApprovalRequiredError);
  });

  test('AC-3: throws WormApprovalRequiredError when approval is for wrong operation type', async () => {
    // Create a bulk_export approval and try to use it for enable_worm.
    const request = await createApprovalRequest(sql, {
      operation_type: 'bulk_export',
      payload: {},
      requested_by: 'co-officer-1',
      required_approvals: 2,
    });

    await castVote(sql, {
      request_id: request.id,
      approver_id: 'co-officer-1',
      decision: 'approved',
    });
    await castVote(sql, {
      request_id: request.id,
      approver_id: 'co-officer-2',
      decision: 'approved',
    });

    await expect(
      enableWorm(sql, {
        tenantId: 'tenant-wrong-op-type',
        approvalRequestId: request.id,
        actorId: 'co-officer-1',
        actorRole: 'compliance_officer',
      }),
    ).rejects.toBeInstanceOf(WormApprovalRequiredError);
  });

  test('TP-1: compliance_officer can enable WORM after M-of-N approval is collected', async () => {
    const tenantId = `tenant-worm-enable-${Date.now()}`;
    const approvalRequestId = await createApprovedWormRequest(sql, tenantId);

    // Before enable: WORM is off.
    expect(await isWormEnabled(tenantId, sql)).toBe(false);

    await enableWorm(sql, {
      tenantId,
      approvalRequestId,
      actorId: 'co-officer-1',
      actorRole: 'compliance_officer',
    });

    // After enable: WORM is on.
    expect(await isWormEnabled(tenantId, sql)).toBe(true);
  });

  test('TP-1: superuser can enable WORM after M-of-N approval', async () => {
    const tenantId = `tenant-worm-su-${Date.now()}`;
    const approvalRequestId = await createApprovedWormRequest(sql, tenantId);

    await enableWorm(sql, {
      tenantId,
      approvalRequestId,
      actorId: 'system-admin',
      actorRole: null,
      isSuperuser: true,
    });

    expect(await isWormEnabled(tenantId, sql)).toBe(true);
  });

  test('TP-1: enableWorm emits an audit event via the auditWriter callback', async () => {
    const tenantId = `tenant-worm-audit-${Date.now()}`;
    const approvalRequestId = await createApprovedWormRequest(sql, tenantId);

    const auditEvents: string[] = [];

    await enableWorm(sql, {
      tenantId,
      approvalRequestId,
      actorId: 'co-officer-1',
      actorRole: 'compliance_officer',
      auditWriter: async (event) => {
        auditEvents.push(event.action);
      },
    });

    expect(auditEvents).toContain('worm_mode.enable');
  });

  test('TP-1: enableWorm is idempotent when called twice with separate approvals', async () => {
    const tenantId = `tenant-worm-idem-${Date.now()}`;

    const approvalId1 = await createApprovedWormRequest(sql, tenantId);
    await enableWorm(sql, {
      tenantId,
      approvalRequestId: approvalId1,
      actorId: 'co-officer-1',
      actorRole: 'compliance_officer',
    });

    const approvalId2 = await createApprovedWormRequest(sql, tenantId);
    // Second call must not throw.
    await expect(
      enableWorm(sql, {
        tenantId,
        approvalRequestId: approvalId2,
        actorId: 'co-officer-1',
        actorRole: 'compliance_officer',
      }),
    ).resolves.toBeUndefined();

    expect(await isWormEnabled(tenantId, sql)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-1 + TP-2: WORM-enabled tenant cannot UPDATE ground-truth rows until
// retention expires — MiFID II scenario
// ---------------------------------------------------------------------------

describe('WORM UPDATE block — MiFID II (AC-1, TP-2, AC-4)', () => {
  let wormTenantId: string;

  beforeAll(async () => {
    wormTenantId = `${MIFID_TENANT}-${Date.now()}`;

    // Seed retention policy for this dynamic tenant.
    await sql`
      INSERT INTO tenant_retention_policies (tenant_id, retention_class, legal_hold_default)
      VALUES (${wormTenantId}, ${MIFID_POLICY}, false)
      ON CONFLICT (tenant_id) DO UPDATE SET retention_class = EXCLUDED.retention_class
    `;

    // Enable WORM via M-of-N.
    const approvalRequestId = await createApprovedWormRequest(sql, wormTenantId);
    await enableWorm(sql, {
      tenantId: wormTenantId,
      approvalRequestId,
      actorId: 'co-officer-1',
      actorRole: 'compliance_officer',
    });
  });

  test('AC-1 MiFID II: UPDATE on a WORM ground-truth entity is rejected by the database trigger', async () => {
    const entityId = await insertGroundTruthEntity(sql, wormTenantId, MIFID_POLICY, 'mifid-update');

    // The trigger must reject the UPDATE.
    await expect(
      sql`UPDATE entities SET properties = '{"content":"tampered"}' WHERE id = ${entityId}`,
    ).rejects.toThrow(/WORM.*immutable.*retention floor not reached/i);

    // Cleanup: bypass triggers (superuser session) to remove the protected row.
    await forceDeleteEntity(sql, entityId);
  });

  test('AC-1 MiFID II: checkWormUpdateGuard reports blocked=true before retention floor', async () => {
    const entityId = await insertGroundTruthEntity(sql, wormTenantId, MIFID_POLICY, 'mifid-guard');

    const { blocked, eligibleAt } = await checkWormUpdateGuard(sql, entityId);
    expect(blocked).toBe(true);
    expect(eligibleAt).not.toBeNull();

    // Cleanup.
    await forceDeleteEntity(sql, entityId);
  });

  test('TP-3 MiFID II: UPDATE succeeds after entity ages past the retention floor', async () => {
    const entityId = `entity-worm-mifid-aged-${Date.now()}`;

    // Insert with a backdated created_at (1827 days ago — just past the 1826-day floor).
    // Inserting with backdated created_at is safe because the WORM trigger only fires
    // on UPDATE and DELETE, not on INSERT.
    await sql`
      INSERT INTO entities (id, type, properties, tenant_id, retention_class, legal_hold, created_at)
      VALUES (
        ${entityId},
        'corpus_chunk',
        ${'{"content":"Aged ground-truth fragment."}'},
        ${wormTenantId},
        ${MIFID_POLICY},
        false,
        NOW() - INTERVAL '1827 days'
      )
    `;

    // checkWormUpdateGuard must report unblocked (past retention floor).
    const { blocked } = await checkWormUpdateGuard(sql, entityId);
    expect(blocked).toBe(false);

    // The UPDATE must succeed through the trigger — floor has elapsed.
    await expect(
      sql`UPDATE entities SET properties = '{"content":"corrected after retention"}' WHERE id = ${entityId}`,
    ).resolves.toBeDefined();

    // Cleanup: DELETE must also succeed past the retention floor.
    await expect(sql`DELETE FROM entities WHERE id = ${entityId}`).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC-1 + AC-2 + TP-2: WORM-enabled tenant cannot UPDATE or DELETE ground-truth
// rows until retention expires — SEC 17a-4(f) scenario
// ---------------------------------------------------------------------------

describe('WORM UPDATE + DELETE block — SEC 17a-4(f) (AC-1, AC-2, TP-2, AC-4)', () => {
  let wormTenantId: string;

  beforeAll(async () => {
    wormTenantId = `${SEC_TENANT}-${Date.now()}`;

    await sql`
      INSERT INTO tenant_retention_policies (tenant_id, retention_class, legal_hold_default)
      VALUES (${wormTenantId}, ${SEC_POLICY}, false)
      ON CONFLICT (tenant_id) DO UPDATE SET retention_class = EXCLUDED.retention_class
    `;

    const approvalRequestId = await createApprovedWormRequest(sql, wormTenantId);
    await enableWorm(sql, {
      tenantId: wormTenantId,
      approvalRequestId,
      actorId: 'co-officer-1',
      actorRole: 'compliance_officer',
    });
  });

  test('AC-1 SEC: UPDATE on a WORM SEC ground-truth entity is rejected by the database trigger', async () => {
    const entityId = await insertGroundTruthEntity(sql, wormTenantId, SEC_POLICY, 'sec-update');

    await expect(
      sql`UPDATE entities SET properties = '{"content":"tampered"}' WHERE id = ${entityId}`,
    ).rejects.toThrow(/WORM.*immutable.*retention floor not reached/i);

    // Cleanup: bypass triggers to remove the protected row.
    await forceDeleteEntity(sql, entityId);
  });

  test('AC-2 SEC: DELETE on a WORM SEC ground-truth entity is rejected by the retention floor trigger', async () => {
    const entityId = await insertGroundTruthEntity(sql, wormTenantId, SEC_POLICY, 'sec-delete');

    // The retention floor trigger (trg_entities_retention_floor) rejects this.
    await expect(sql`DELETE FROM entities WHERE id = ${entityId}`).rejects.toThrow(
      /retention floor not reached/i,
    );

    // Cleanup: bypass triggers to remove the protected row.
    await forceDeleteEntity(sql, entityId);
  });

  test('TP-3 SEC: controlled deletion succeeds after entity ages past the 6-year floor', async () => {
    const entityId = `entity-worm-sec-aged-${Date.now()}`;

    // Insert with backdated created_at (2193 days ago — past the 2192-day SEC floor).
    await sql`
      INSERT INTO entities (id, type, properties, tenant_id, retention_class, legal_hold, created_at)
      VALUES (
        ${entityId},
        'corpus_chunk',
        ${'{"content":"Aged SEC ground-truth fragment."}'},
        ${wormTenantId},
        ${SEC_POLICY},
        false,
        NOW() - INTERVAL '2193 days'
      )
    `;

    const { blocked } = await checkWormUpdateGuard(sql, entityId);
    expect(blocked).toBe(false);

    // DELETE must succeed once past the floor.
    await expect(sql`DELETE FROM entities WHERE id = ${entityId}`).resolves.toBeDefined();

    const rows = await sql<{ id: string }[]>`SELECT id FROM entities WHERE id = ${entityId}`;
    expect(rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// WORM does not affect entities without a retention_class
// ---------------------------------------------------------------------------

describe('WORM does not block non-ground-truth entities', () => {
  let wormTenantId: string;

  beforeAll(async () => {
    wormTenantId = `tenant-worm-nort-${Date.now()}`;

    await sql`
      INSERT INTO tenant_retention_policies (tenant_id, retention_class, legal_hold_default)
      VALUES (${wormTenantId}, ${MIFID_POLICY}, false)
      ON CONFLICT (tenant_id) DO UPDATE SET retention_class = EXCLUDED.retention_class
    `;

    const approvalRequestId = await createApprovedWormRequest(sql, wormTenantId);
    await enableWorm(sql, {
      tenantId: wormTenantId,
      approvalRequestId,
      actorId: 'co-officer-1',
      actorRole: 'compliance_officer',
    });
  });

  test('UPDATE on an entity without retention_class is not blocked by WORM', async () => {
    const entityId = `github-link-no-retention-worm-${Date.now()}`;

    // Insert a github_link entity with no retention_class (not a ground-truth entity).
    await sql`
      INSERT INTO entities (id, type, properties, tenant_id)
      VALUES (${entityId}, 'github_link', '{"url":"https://github.com/example/repo"}', ${wormTenantId})
    `;

    // UPDATE must succeed — no retention_class means WORM trigger passes through.
    await expect(
      sql`UPDATE entities SET properties = '{"url":"https://github.com/example/updated"}' WHERE id = ${entityId}`,
    ).resolves.toBeDefined();

    // Cleanup.
    await sql`DELETE FROM entities WHERE id = ${entityId}`;
  });

  test('UPDATE on an entity without tenant_id is not blocked by WORM', async () => {
    const entityId = `github-link-no-tenant-worm-${Date.now()}`;

    await sql`
      INSERT INTO entities (id, type, properties)
      VALUES (${entityId}, 'github_link', '{"url":"https://github.com/example/global"}')
    `;

    await expect(
      sql`UPDATE entities SET properties = '{"url":"https://github.com/example/updated-global"}' WHERE id = ${entityId}`,
    ).resolves.toBeDefined();

    await sql`DELETE FROM entities WHERE id = ${entityId}`;
  });
});

// ---------------------------------------------------------------------------
// Non-WORM tenant is not affected
// ---------------------------------------------------------------------------

describe('Non-WORM tenant entities are not blocked', () => {
  test('UPDATE on a ground-truth entity for a non-WORM tenant succeeds', async () => {
    const tenantId = `tenant-noworm-${Date.now()}`;

    await sql`
      INSERT INTO tenant_retention_policies (tenant_id, retention_class, legal_hold_default)
      VALUES (${tenantId}, ${MIFID_POLICY}, false)
      ON CONFLICT (tenant_id) DO UPDATE SET retention_class = EXCLUDED.retention_class
    `;

    const entityId = await insertGroundTruthEntity(sql, tenantId, MIFID_POLICY, 'noworm-update');

    // WORM is not enabled for this tenant — UPDATE must succeed.
    await expect(
      sql`UPDATE entities SET properties = '{"content":"updated"}' WHERE id = ${entityId}`,
    ).resolves.toBeDefined();

    // Cleanup: entity has a retention_class, so we bypass triggers for deletion.
    await forceDeleteEntity(sql, entityId);
  });
});
