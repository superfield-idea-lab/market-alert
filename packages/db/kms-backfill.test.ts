/**
 * Integration tests for the idempotent KMS backfill utility.
 *
 * Spins up a real ephemeral Postgres container, seeds plaintext entity rows,
 * runs the backfill, and asserts:
 *   - Plaintext sensitive fields are encrypted after the first run.
 *   - Re-running the backfill is safe: no row is double-encrypted.
 *   - Rows without sensitive fields are not touched.
 *   - The result counters (scanned / updated / skipped / errors) are correct.
 *
 * No mocks.  Real docker container, real encryption, real postgres writes.
 *
 * Issue #226 — downstream idempotent KMS backfill utility.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate } from './index';
import {
  backfillEntities,
  isEncrypted,
  needsBackfill,
  encryptPlaintextFields,
  BACKFILL_ELIGIBLE_ENTITY_TYPES,
} from './kms-backfill';
import { _resetEncryptionCaches } from '../core/encryption';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_MASTER_KEY = 'b'.repeat(64); // 64-char hex master key for CI

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  pg = await startPostgres();

  // Migrate schema so the `entities` table exists.
  await migrate({ databaseUrl: pg.url });

  // Open a direct admin connection that bypasses RLS.
  sql = postgres(pg.url, { max: 5, idle_timeout: 20, connect_timeout: 10 });

  // Enable encryption with a test master key.
  process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
  delete process.env.ENCRYPTION_DISABLED;
  _resetEncryptionCaches();
}, 120_000);

afterAll(async () => {
  delete process.env.ENCRYPTION_MASTER_KEY;
  _resetEncryptionCaches();
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Unit-level helpers (no DB required)
// ---------------------------------------------------------------------------

describe('isEncrypted', () => {
  test('returns true for enc:v1: prefixed strings', () => {
    expect(isEncrypted('enc:v1:abc:def')).toBe(true);
  });

  test('returns false for plaintext strings', () => {
    expect(isEncrypted('hello world')).toBe(false);
  });

  test('returns false for non-string values', () => {
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
    expect(isEncrypted(42)).toBe(false);
  });
});

describe('needsBackfill', () => {
  test('returns true when sensitive field is plaintext', () => {
    expect(needsBackfill('user', { display_name: 'Alice', email: 'alice@example.com' })).toBe(true);
  });

  test('returns false when all sensitive fields are already encrypted', () => {
    expect(
      needsBackfill('user', {
        display_name: 'enc:v1:iv1:ciphertext1',
        email: 'enc:v1:iv2:ciphertext2',
      }),
    ).toBe(false);
  });

  test('returns false when sensitive fields are absent from properties', () => {
    // Row exists but has no sensitive columns — treat as already-encrypted (skip)
    expect(needsBackfill('user', { some_other_field: 'value' })).toBe(false);
  });

  test('returns false for entity types with no sensitive fields', () => {
    // 'github_link' has no sensitive fields in the registry
    expect(needsBackfill('github_link', { url: 'https://example.com' })).toBe(false);
  });

  test('returns true when at least one field is plaintext even if others are encrypted', () => {
    expect(
      needsBackfill('user', {
        display_name: 'enc:v1:iv1:ciphertext1',
        email: 'plaintext@example.com', // not encrypted
      }),
    ).toBe(true);
  });
});

describe('encryptPlaintextFields', () => {
  test('encrypts plaintext sensitive fields', async () => {
    const props = { display_name: 'Alice', email: 'alice@example.com' };
    const encrypted = await encryptPlaintextFields('user', props);
    expect(isEncrypted(encrypted.display_name)).toBe(true);
    expect(isEncrypted(encrypted.email)).toBe(true);
  });

  test('leaves already-encrypted fields unchanged', async () => {
    const alreadyEncryptedName = 'enc:v1:iv:ciphertext';
    const props = { display_name: alreadyEncryptedName, email: 'alice@example.com' };
    const encrypted = await encryptPlaintextFields('user', props);
    // Already-encrypted value must be exactly preserved.
    expect(encrypted.display_name).toBe(alreadyEncryptedName);
    expect(isEncrypted(encrypted.email)).toBe(true);
  });

  test('does not mutate the original properties object', async () => {
    const props = { display_name: 'Alice', email: 'alice@example.com' };
    await encryptPlaintextFields('user', props);
    // Original object must be unchanged.
    expect(props.display_name).toBe('Alice');
    expect(props.email).toBe('alice@example.com');
  });
});

describe('BACKFILL_ELIGIBLE_ENTITY_TYPES', () => {
  test('includes user, email, and corpus_chunk at minimum', () => {
    expect(BACKFILL_ELIGIBLE_ENTITY_TYPES).toContain('user');
    expect(BACKFILL_ELIGIBLE_ENTITY_TYPES).toContain('email');
    expect(BACKFILL_ELIGIBLE_ENTITY_TYPES).toContain('corpus_chunk');
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real Postgres
// ---------------------------------------------------------------------------

describe('backfillEntities — integration', () => {
  /**
   * Helper: insert an entity row with plaintext properties.
   * Returns the inserted id.
   */
  async function seedPlaintextEntity(
    type: string,
    properties: Record<string, unknown>,
    id?: string,
  ): Promise<string> {
    // Ensure the entity type exists in entity_types (seeded from schema.sql).
    // For types not seeded, insert them first.
    await sql`
      INSERT INTO entity_types (type, schema)
      VALUES (${type}, ${sql.json({}) as never})
      ON CONFLICT (type) DO NOTHING
    `;

    const rowId = id ?? crypto.randomUUID();
    await sql`
      INSERT INTO entities (id, type, properties)
      VALUES (${rowId}, ${type}, ${sql.json(properties as never)})
    `;
    return rowId;
  }

  /**
   * Helper: fetch properties for a given entity id.
   */
  async function fetchProperties(id: string): Promise<Record<string, unknown>> {
    const rows = await sql<{ properties: Record<string, unknown> }[]>`
      SELECT properties FROM entities WHERE id = ${id}
    `;
    return rows[0]?.properties ?? {};
  }

  test('TP-1: plaintext rows get encrypted after backfill', async () => {
    const id = await seedPlaintextEntity('user', {
      display_name: 'Test User',
      email: 'testuser@example.com',
    });

    const result = await backfillEntities(sql, {
      entityTypes: ['user'],
      logger: { info: () => {}, error: () => {} },
    });

    expect(result.updated).toBeGreaterThanOrEqual(1);
    expect(result.errors).toBe(0);

    const props = await fetchProperties(id);
    expect(isEncrypted(props.display_name)).toBe(true);
    expect(isEncrypted(props.email)).toBe(true);
  });

  test('TP-2: re-running backfill does not double-encrypt already-encrypted rows', async () => {
    const id = await seedPlaintextEntity('user', {
      display_name: 'Idem User',
      email: 'idem@example.com',
    });

    // First run: encrypts the row.
    const run1 = await backfillEntities(sql, {
      entityTypes: ['user'],
      logger: { info: () => {}, error: () => {} },
    });
    expect(run1.updated).toBeGreaterThanOrEqual(1);

    const propsAfterRun1 = await fetchProperties(id);
    expect(isEncrypted(propsAfterRun1.display_name)).toBe(true);
    expect(isEncrypted(propsAfterRun1.email)).toBe(true);

    const cipherDisplayName = propsAfterRun1.display_name;
    const cipherEmail = propsAfterRun1.email;

    // Second run: all sensitive fields are already encrypted — row is skipped.
    const run2 = await backfillEntities(sql, {
      entityTypes: ['user'],
      logger: { info: () => {}, error: () => {} },
    });
    // No new updates for the already-encrypted row.
    expect(run2.updated).toBe(0);

    const propsAfterRun2 = await fetchProperties(id);
    // Ciphertext must be byte-for-byte identical (not re-encrypted).
    expect(propsAfterRun2.display_name).toBe(cipherDisplayName);
    expect(propsAfterRun2.email).toBe(cipherEmail);
  });

  test('TP-3: rows without sensitive fields are skipped', async () => {
    // Seed a 'github_link' entity — this type has no sensitive fields.
    const id = await seedPlaintextEntity('github_link', {
      url: 'https://github.com/example/repo',
      stars: 42,
    });

    const result = await backfillEntities(sql, {
      entityTypes: ['github_link'],
      logger: { info: () => {}, error: () => {} },
    });

    // github_link has no sensitive fields → the backfill treats it as ineligible.
    // Since BACKFILL_ELIGIBLE_ENTITY_TYPES only includes types with sensitive fields,
    // if we explicitly pass 'github_link' none of its rows need backfill.
    expect(result.updated).toBe(0);

    const props = await fetchProperties(id);
    // URL must be unchanged.
    expect(props.url).toBe('https://github.com/example/repo');
  });

  test('TP-4: dry-run mode logs without writing to the database', async () => {
    const id = await seedPlaintextEntity('user', {
      display_name: 'Dry Run User',
      email: 'dryrun@example.com',
    });

    const result = await backfillEntities(sql, {
      entityTypes: ['user'],
      dryRun: true,
      logger: { info: () => {}, error: () => {} },
    });

    expect(result.dryRun).toBe(true);
    // The result reports a would-be update.
    expect(result.updated).toBeGreaterThanOrEqual(1);

    // But the actual database row must remain plaintext.
    const props = await fetchProperties(id);
    expect(props.display_name).toBe('Dry Run User');
    expect(props.email).toBe('dryrun@example.com');

    // Clean up the dry-run row so subsequent test runs are not affected.
    await sql`DELETE FROM entities WHERE id = ${id}`;
  });

  test('TP-5: result counters are accurate (scanned = updated + skipped + errors)', async () => {
    // Seed one plaintext row and one already-encrypted row.
    await seedPlaintextEntity('user', {
      display_name: 'Counter Test Plaintext',
      email: 'counter-plain@example.com',
    });

    await seedPlaintextEntity('user', {
      display_name: 'enc:v1:iv:ciphertext1',
      email: 'enc:v1:iv:ciphertext2',
    });

    const result = await backfillEntities(sql, {
      entityTypes: ['user'],
      logger: { info: () => {}, error: () => {} },
    });

    // scanned must account for all rows.
    expect(result.scanned).toBeGreaterThanOrEqual(2);
    // The identity must hold: scanned = updated + skipped + errors.
    expect(result.scanned).toBe(result.updated + result.skipped + result.errors);
  });
});
