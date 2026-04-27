/**
 * Integration tests for the label-based clearance controls (issue #225).
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 *
 * Covers:
 *   - access_labels CRUD: create, get, list
 *   - per-label content key creation and KMS wrapping
 *   - labeled content encryption / decryption round-trip
 *   - user_labels grant and revoke
 *   - userHasLabel authorization check
 *   - writeLabeledGroundTruth: encrypts and stores
 *   - readLabeledGroundTruth: holder can read + decrypt
 *   - readLabeledGroundTruth: non-holder is denied (LabelClearanceDeniedError)
 *   - tenant/customer RLS boundary remains the outer boundary
 *     (a user in a different tenant cannot read even with the label name)
 *
 * Issue #225 — downstream label-based clearance controls and per-label
 * content-key encryption from template.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate } from './index';
import {
  createAccessLabel,
  getAccessLabel,
  listAccessLabels,
  createLabelContentKey,
  grantUserLabel,
  revokeUserLabel,
  listUserLabels,
  userHasLabel,
  writeLabeledGroundTruth,
  readLabeledGroundTruth,
  encryptLabeledContent,
  decryptLabeledContent,
  LabelNotFoundError,
  LabelContentKeyMissingError,
  LabelClearanceDeniedError,
  LabelGrantNotFoundError,
  LabeledGroundTruthNotFoundError,
} from './label-clearance';
import { _resetEncryptionCaches } from '../core/encryption';

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

const TEST_MASTER_KEY = 'a'.repeat(64); // 64-char hex master key for CI

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  pg = await startPostgres();
  await migrate({ databaseUrl: pg.url });

  sql = postgres(pg.url, { max: 5, idle_timeout: 20, connect_timeout: 10 });

  // Enable encryption
  process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
  delete process.env.ENCRYPTION_DISABLED;
  _resetEncryptionCaches();

  // Seed a user entity and two tenant entity stubs for FK references.
  await sql.unsafe(`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES
      ('user-alice', 'user', '{"username":"alice","role":"admin"}', 'tenant-a'),
      ('user-bob',   'user', '{"username":"bob",  "role":"reader"}', 'tenant-a'),
      ('user-carol', 'user', '{"username":"carol","role":"reader"}', 'tenant-b'),
      ('entity-e1',  'user', '{"username":"e1"}',                    'tenant-a'),
      ('entity-e2',  'user', '{"username":"e2"}',                    'tenant-b')
    ON CONFLICT DO NOTHING
  `);
}, 120_000);

afterAll(async () => {
  delete process.env.ENCRYPTION_MASTER_KEY;
  _resetEncryptionCaches();
  await sql?.end({ timeout: 5 });
  await pg?.stop();
}, 30_000);

// ---------------------------------------------------------------------------
// access_labels CRUD
// ---------------------------------------------------------------------------

describe('access_labels', () => {
  test('createAccessLabel — creates a global label', async () => {
    const label = await createAccessLabel(sql, {
      name: 'global-secret',
      description: 'Global secret classification',
      tenantId: null,
      createdBy: 'user-alice',
    });

    expect(label.name).toBe('global-secret');
    expect(label.tenant_id).toBeNull();
    expect(label.wrapped_content_key).toBeNull();
  });

  test('createAccessLabel — creates a tenant-scoped label', async () => {
    const label = await createAccessLabel(sql, {
      name: 'restricted',
      description: 'Restricted — tenant A only',
      tenantId: 'tenant-a',
      createdBy: 'user-alice',
    });

    expect(label.name).toBe('restricted');
    expect(label.tenant_id).toBe('tenant-a');
  });

  test('getAccessLabel — returns null for unknown label', async () => {
    const result = await getAccessLabel(sql, 'no-such-label', null);
    expect(result).toBeNull();
  });

  test('getAccessLabel — finds an existing global label', async () => {
    const result = await getAccessLabel(sql, 'global-secret', null);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('global-secret');
  });

  test('listAccessLabels — returns labels for a specific tenant', async () => {
    await createAccessLabel(sql, {
      name: 'tenant-a-only',
      tenantId: 'tenant-a',
      createdBy: 'user-alice',
    });

    const labels = await listAccessLabels(sql, { tenantId: 'tenant-a' });
    const names = labels.map((l) => l.name);
    expect(names).toContain('restricted');
    expect(names).toContain('tenant-a-only');
    // Should not include global or other-tenant labels
    expect(names).not.toContain('global-secret');
  });

  test('listAccessLabels — returns only global labels when tenantId is null', async () => {
    const labels = await listAccessLabels(sql, { tenantId: null });
    for (const l of labels) {
      expect(l.tenant_id).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Per-label content key
// ---------------------------------------------------------------------------

describe('createLabelContentKey', () => {
  test('sets wrapped_content_key on the label', async () => {
    await createAccessLabel(sql, {
      name: 'keyed-label',
      tenantId: null,
      createdBy: 'user-alice',
    }).catch(() => {
      /* already exists from a re-run — ignore */
    });

    const updated = await createLabelContentKey(sql, 'keyed-label', null);

    expect(updated.wrapped_content_key).not.toBeNull();
    expect(typeof updated.wrapped_content_key).toBe('string');
    // Should be a base64 string
    expect(() => atob(updated.wrapped_content_key!)).not.toThrow();
  });

  test('throws LabelNotFoundError for unknown label', async () => {
    await expect(createLabelContentKey(sql, 'no-such-label-key', null)).rejects.toThrow(
      LabelNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// Encrypt / decrypt round-trip
// ---------------------------------------------------------------------------

describe('encryptLabeledContent / decryptLabeledContent', () => {
  test('round-trip: encrypt then decrypt returns the original plaintext', async () => {
    // Ensure label with key exists
    await createAccessLabel(sql, {
      name: 'enc-label',
      tenantId: null,
      createdBy: 'user-alice',
    }).catch(() => {});
    await createLabelContentKey(sql, 'enc-label', null);

    const label = await getAccessLabel(sql, 'enc-label', null);
    expect(label).not.toBeNull();

    const plaintext = 'Top secret financial projection Q4 2025';
    const ciphertext = await encryptLabeledContent(label!, plaintext);

    expect(ciphertext).toMatch(/^enc:v1:/);
    expect(ciphertext).not.toContain(plaintext);

    const recovered = await decryptLabeledContent(label!, ciphertext);
    expect(recovered).toBe(plaintext);
  });

  test('throws LabelContentKeyMissingError when no key set', async () => {
    await createAccessLabel(sql, {
      name: 'no-key-label',
      tenantId: null,
      createdBy: 'user-alice',
    }).catch(() => {});

    const label = await getAccessLabel(sql, 'no-key-label', null);
    expect(label).not.toBeNull();
    expect(label!.wrapped_content_key).toBeNull();

    await expect(encryptLabeledContent(label!, 'secret')).rejects.toThrow(
      LabelContentKeyMissingError,
    );
  });
});

// ---------------------------------------------------------------------------
// User label grants
// ---------------------------------------------------------------------------

describe('grantUserLabel / revokeUserLabel / userHasLabel', () => {
  beforeAll(async () => {
    // Set up a label for grant tests
    await createAccessLabel(sql, {
      name: 'grant-test-label',
      tenantId: 'tenant-a',
      createdBy: 'user-alice',
    }).catch(() => {});
  });

  test('grantUserLabel — grants the label to a user', async () => {
    const grant = await grantUserLabel(sql, {
      userId: 'user-bob',
      labelName: 'grant-test-label',
      tenantId: 'tenant-a',
      grantedBy: 'user-alice',
    });

    expect(grant.user_id).toBe('user-bob');
    expect(grant.label_name).toBe('grant-test-label');
    expect(grant.granted_by).toBe('user-alice');
  });

  test('userHasLabel — returns true for granted user', async () => {
    const result = await userHasLabel(sql, 'user-bob', 'grant-test-label', 'tenant-a');
    expect(result).toBe(true);
  });

  test('userHasLabel — returns false for user without the label', async () => {
    const result = await userHasLabel(sql, 'user-alice', 'grant-test-label', 'tenant-a');
    expect(result).toBe(false);
  });

  test('listUserLabels — lists grants for a user', async () => {
    const grants = await listUserLabels(sql, 'user-bob', 'tenant-a');
    const names = grants.map((g) => g.label_name);
    expect(names).toContain('grant-test-label');
  });

  test('revokeUserLabel — removes the grant', async () => {
    await revokeUserLabel(sql, 'user-bob', 'grant-test-label', 'tenant-a');
    const result = await userHasLabel(sql, 'user-bob', 'grant-test-label', 'tenant-a');
    expect(result).toBe(false);
  });

  test('revokeUserLabel — throws LabelGrantNotFoundError when no grant exists', async () => {
    await expect(revokeUserLabel(sql, 'user-bob', 'grant-test-label', 'tenant-a')).rejects.toThrow(
      LabelGrantNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// writeLabeledGroundTruth / readLabeledGroundTruth — allowed path
// ---------------------------------------------------------------------------

describe('writeLabeledGroundTruth / readLabeledGroundTruth', () => {
  const LABEL_NAME = 'clearance-test';
  const TENANT_ID = 'tenant-a';
  const PLAINTEXT = 'Highly confidential advisory memo — internal only.';

  beforeAll(async () => {
    // Create the label and its content key
    await createAccessLabel(sql, {
      name: LABEL_NAME,
      tenantId: TENANT_ID,
      createdBy: 'user-alice',
    }).catch(() => {});
    await createLabelContentKey(sql, LABEL_NAME, TENANT_ID);

    // Grant label to alice only
    await grantUserLabel(sql, {
      userId: 'user-alice',
      labelName: LABEL_NAME,
      tenantId: TENANT_ID,
      grantedBy: 'user-alice',
    }).catch(() => {});

    // Ensure bob does NOT hold the label (revoke if it was somehow granted)
    await revokeUserLabel(sql, 'user-bob', LABEL_NAME, TENANT_ID).catch(() => {});
  });

  test('writeLabeledGroundTruth — stores encrypted content', async () => {
    const record = await writeLabeledGroundTruth(sql, {
      entityId: 'entity-e1',
      labelName: LABEL_NAME,
      tenantId: TENANT_ID,
      plaintext: PLAINTEXT,
      createdBy: 'user-alice',
    });

    expect(record.entity_id).toBe('entity-e1');
    expect(record.label_name).toBe(LABEL_NAME);
    // Content must be encrypted at rest
    expect(record.encrypted_content).toMatch(/^enc:v1:/);
    expect(record.encrypted_content).not.toContain(PLAINTEXT);
  });

  test('readLabeledGroundTruth — label holder can read and decrypt', async () => {
    const { record, plaintext } = await readLabeledGroundTruth(sql, {
      entityId: 'entity-e1',
      labelName: LABEL_NAME,
      tenantId: TENANT_ID,
      requestingUserId: 'user-alice',
    });

    expect(record.entity_id).toBe('entity-e1');
    expect(plaintext).toBe(PLAINTEXT);
  });

  test('readLabeledGroundTruth — non-holder is denied (LabelClearanceDeniedError)', async () => {
    // bob does not hold the label
    await expect(
      readLabeledGroundTruth(sql, {
        entityId: 'entity-e1',
        labelName: LABEL_NAME,
        tenantId: TENANT_ID,
        requestingUserId: 'user-bob',
      }),
    ).rejects.toThrow(LabelClearanceDeniedError);
  });

  test('readLabeledGroundTruth — cross-tenant user is denied even with same label name', async () => {
    // carol is in tenant-b. Even if carol somehow held a label named 'clearance-test'
    // in tenant-b, she cannot access tenant-a data because:
    //   1. The tenant_id on the record is tenant-a.
    //   2. userHasLabel checks tenant-a scope — carol has no grant there.
    await expect(
      readLabeledGroundTruth(sql, {
        entityId: 'entity-e1',
        labelName: LABEL_NAME,
        tenantId: TENANT_ID, // tenant-a scope, carol is tenant-b
        requestingUserId: 'user-carol',
      }),
    ).rejects.toThrow(LabelClearanceDeniedError);
  });

  test('readLabeledGroundTruth — throws LabeledGroundTruthNotFoundError when record absent but user has label', async () => {
    // alice holds the label but entity-e2 has no labeled_ground_truth record for this label/tenant
    // The clearance check passes (alice has the grant) but the record lookup fails.
    await expect(
      readLabeledGroundTruth(sql, {
        entityId: 'entity-e2',
        labelName: LABEL_NAME,
        tenantId: TENANT_ID,
        requestingUserId: 'user-alice',
      }),
    ).rejects.toThrow(LabeledGroundTruthNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Error surface: missing label on write
// ---------------------------------------------------------------------------

describe('writeLabeledGroundTruth error paths', () => {
  test('throws LabelNotFoundError when label does not exist', async () => {
    await expect(
      writeLabeledGroundTruth(sql, {
        entityId: 'entity-e1',
        labelName: 'no-such-label-xyz',
        tenantId: null,
        plaintext: 'secret',
        createdBy: 'user-alice',
      }),
    ).rejects.toThrow(LabelNotFoundError);
  });

  test('throws LabelContentKeyMissingError when label has no content key', async () => {
    await createAccessLabel(sql, {
      name: 'no-key-write-test',
      tenantId: null,
      createdBy: 'user-alice',
    }).catch(() => {});

    await expect(
      writeLabeledGroundTruth(sql, {
        entityId: 'entity-e1',
        labelName: 'no-key-write-test',
        tenantId: null,
        plaintext: 'secret',
        createdBy: 'user-alice',
      }),
    ).rejects.toThrow(LabelContentKeyMissingError);
  });
});
