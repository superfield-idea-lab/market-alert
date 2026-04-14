/**
 * @file retention-store.test.ts
 *
 * Integration tests for the retention-store module (issue #33).
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 *
 * Acceptance criteria covered:
 *   AC-1  Every ingested Email and CorpusChunk row has non-null retention_class
 *         and legal_hold.
 *   AC-2  The application role cannot UPDATE either field after write.
 *   AC-3  The fields are populated from the tenant's default policy.
 *   AC-4  A missing tenant default blocks ingestion with a clear error.
 *
 * Test plan items:
 *   TP-1  Ingest an email and assert both fields are populated from the tenant default.
 *   TP-2  Attempt to UPDATE either field as the application role and assert rejection.
 *   TP-3  Remove the tenant default and assert ingestion blocks with a clear error.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate } from './index';
import {
  lookupTenantDefaultPolicy,
  writeEmailWithRetention,
  writeCorpusChunkWithRetention,
  MissingTenantRetentionPolicyError,
} from './retention-store';

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

const TEST_TENANT = 'tenant-retention-test';
const RETENTION_CLASS = 'standard-7yr';

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5 });

  // Apply schema (creates entities, tenant_retention_policies, and the immutability trigger)
  await migrate({ databaseUrl: pg.url });

  // Register entity types used in tests — the FK on entities.type requires rows
  // in entity_types before we can insert email or corpus_chunk entities.
  await sql`
    INSERT INTO entity_types (type, schema, sensitive)
    VALUES
      ('email',        '{}', ARRAY['subject','body','headers']),
      ('corpus_chunk', '{}', ARRAY['content'])
    ON CONFLICT (type) DO NOTHING
  `;

  // Seed a tenant default retention policy for all tests that need one
  await sql`
    INSERT INTO tenant_retention_policies (tenant_id, retention_class, legal_hold_default)
    VALUES (${TEST_TENANT}, ${RETENTION_CLASS}, false)
    ON CONFLICT (tenant_id) DO UPDATE
      SET retention_class    = EXCLUDED.retention_class,
          legal_hold_default = EXCLUDED.legal_hold_default
  `;
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// lookupTenantDefaultPolicy
// ---------------------------------------------------------------------------

describe('lookupTenantDefaultPolicy', () => {
  test('returns the policy for an existing tenant', async () => {
    const policy = await lookupTenantDefaultPolicy(sql, TEST_TENANT);

    expect(policy.tenantId).toBe(TEST_TENANT);
    expect(policy.retentionClass).toBe(RETENTION_CLASS);
    expect(policy.legalHoldDefault).toBe(false);
  });

  test('throws MissingTenantRetentionPolicyError for an unknown tenant', async () => {
    await expect(lookupTenantDefaultPolicy(sql, 'tenant-does-not-exist')).rejects.toBeInstanceOf(
      MissingTenantRetentionPolicyError,
    );
  });

  test('MissingTenantRetentionPolicyError message includes the tenant id', async () => {
    const unknownTenant = 'tenant-xyz-missing';
    await expect(lookupTenantDefaultPolicy(sql, unknownTenant)).rejects.toThrow(unknownTenant);
  });
});

// ---------------------------------------------------------------------------
// writeEmailWithRetention — TP-1, AC-1, AC-3
// ---------------------------------------------------------------------------

describe('writeEmailWithRetention', () => {
  test('TP-1: inserts an email with retention_class and legal_hold from tenant default', async () => {
    const emailId = `email-retention-test-${Date.now()}`;

    const result = await writeEmailWithRetention(sql, {
      id: emailId,
      tenantId: TEST_TENANT,
      properties: {
        subject: 'Test retention email',
        body: 'body content',
        headers: '{}',
      },
    });

    expect(result.id).toBe(emailId);
    expect(result.retentionClass).toBe(RETENTION_CLASS);
    expect(result.legalHold).toBe(false);

    // AC-1: assert both columns are non-null in the DB row
    const [row] = await sql<{ retention_class: string; legal_hold: boolean; type: string }[]>`
      SELECT retention_class, legal_hold, type FROM entities WHERE id = ${emailId}
    `;

    expect(row.type).toBe('email');
    expect(row.retention_class).not.toBeNull();
    expect(row.legal_hold).not.toBeNull();

    // AC-3: assert the values match the tenant default
    expect(row.retention_class).toBe(RETENTION_CLASS);
    expect(row.legal_hold).toBe(false);

    // Cleanup
    await sql`DELETE FROM entities WHERE id = ${emailId}`;
  });

  test('inherits legal_hold_default=true when the tenant policy has it set', async () => {
    const heldTenant = 'tenant-on-hold';
    await sql`
      INSERT INTO tenant_retention_policies (tenant_id, retention_class, legal_hold_default)
      VALUES (${heldTenant}, 'finra-6yr', true)
      ON CONFLICT (tenant_id) DO UPDATE
        SET legal_hold_default = EXCLUDED.legal_hold_default
    `;

    const emailId = `email-hold-test-${Date.now()}`;
    const result = await writeEmailWithRetention(sql, {
      id: emailId,
      tenantId: heldTenant,
      properties: { subject: 'Held email', body: '', headers: '{}' },
    });

    expect(result.legalHold).toBe(true);

    const [row] = await sql<{ legal_hold: boolean }[]>`
      SELECT legal_hold FROM entities WHERE id = ${emailId}
    `;
    expect(row.legal_hold).toBe(true);

    // Cleanup
    await sql`DELETE FROM entities WHERE id = ${emailId}`;
    await sql`DELETE FROM tenant_retention_policies WHERE tenant_id = ${heldTenant}`;
  });

  // AC-4: missing tenant default blocks ingestion
  test('AC-4: throws MissingTenantRetentionPolicyError when no policy is configured', async () => {
    await expect(
      writeEmailWithRetention(sql, {
        id: `email-no-policy-${Date.now()}`,
        tenantId: 'tenant-without-policy',
        properties: { subject: 'Should not be written', body: '', headers: '{}' },
      }),
    ).rejects.toBeInstanceOf(MissingTenantRetentionPolicyError);
  });
});

// ---------------------------------------------------------------------------
// writeCorpusChunkWithRetention — TP-1 (corpus_chunk), AC-1, AC-3
// ---------------------------------------------------------------------------

describe('writeCorpusChunkWithRetention', () => {
  test('TP-1: inserts a corpus_chunk with retention_class and legal_hold from tenant default', async () => {
    const chunkId = `chunk-retention-test-${Date.now()}`;

    const result = await writeCorpusChunkWithRetention(sql, {
      id: chunkId,
      tenantId: TEST_TENANT,
      properties: { content: 'Anonymised text fragment.' },
    });

    expect(result.id).toBe(chunkId);
    expect(result.retentionClass).toBe(RETENTION_CLASS);
    expect(result.legalHold).toBe(false);

    const [row] = await sql<{ retention_class: string; legal_hold: boolean; type: string }[]>`
      SELECT retention_class, legal_hold, type FROM entities WHERE id = ${chunkId}
    `;

    expect(row.type).toBe('corpus_chunk');
    expect(row.retention_class).not.toBeNull();
    expect(row.legal_hold).not.toBeNull();
    expect(row.retention_class).toBe(RETENTION_CLASS);
    expect(row.legal_hold).toBe(false);

    // Cleanup
    await sql`DELETE FROM entities WHERE id = ${chunkId}`;
  });

  test('AC-4: throws MissingTenantRetentionPolicyError when no policy is configured', async () => {
    await expect(
      writeCorpusChunkWithRetention(sql, {
        id: `chunk-no-policy-${Date.now()}`,
        tenantId: 'tenant-without-policy',
        properties: { content: 'Should not be written.' },
      }),
    ).rejects.toBeInstanceOf(MissingTenantRetentionPolicyError);
  });
});

// ---------------------------------------------------------------------------
// Immutability — TP-2, AC-2
// ---------------------------------------------------------------------------

describe('retention field immutability', () => {
  test('TP-2: UPDATE of retention_class is rejected by the database trigger', async () => {
    const emailId = `email-immutable-test-${Date.now()}`;

    await writeEmailWithRetention(sql, {
      id: emailId,
      tenantId: TEST_TENANT,
      properties: { subject: 'Immutability test', body: '', headers: '{}' },
    });

    // Attempting to UPDATE retention_class must raise an exception from the trigger
    await expect(
      sql.unsafe(`UPDATE entities SET retention_class = 'changed' WHERE id = '${emailId}'`),
    ).rejects.toThrow(/retention_class is immutable/);

    // Cleanup
    await sql`DELETE FROM entities WHERE id = ${emailId}`;
  });

  test('TP-2: UPDATE of legal_hold is rejected by the database trigger', async () => {
    const chunkId = `chunk-immutable-test-${Date.now()}`;

    await writeCorpusChunkWithRetention(sql, {
      id: chunkId,
      tenantId: TEST_TENANT,
      properties: { content: 'Immutability test chunk.' },
    });

    await expect(
      sql.unsafe(`UPDATE entities SET legal_hold = true WHERE id = '${chunkId}'`),
    ).rejects.toThrow(/legal_hold is immutable/);

    // Cleanup
    await sql`DELETE FROM entities WHERE id = ${chunkId}`;
  });

  test('entities without retention fields set can still be updated normally', async () => {
    // A PRD entity (type=github_link) that never had retention fields set
    // should not be blocked by the trigger.
    const entityId = `github-link-no-retention-${Date.now()}`;

    await sql`
      INSERT INTO entities (id, type, properties)
      VALUES (${entityId}, 'github_link', '{"url":"https://github.com/example/repo"}')
    `;

    // Updating properties (a non-retention column) must succeed
    await expect(
      sql`UPDATE entities SET properties = '{"url":"https://github.com/example/updated"}' WHERE id = ${entityId}`,
    ).resolves.toBeDefined();

    // Cleanup
    await sql`DELETE FROM entities WHERE id = ${entityId}`;
  });
});
