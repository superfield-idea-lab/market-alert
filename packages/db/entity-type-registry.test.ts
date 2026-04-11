/**
 * Unit tests for the EntityTypeRegistry.
 *
 * These tests cover:
 *   1. In-memory register / get / list / has / size — no database required.
 *   2. registerWithDb — persists a new entity type to a real Postgres instance
 *      via the pg-container test helper. No DDL is issued; only a single
 *      INSERT … ON CONFLICT DO NOTHING is executed.
 *
 * No mocks. Database tests use a real postgres container via pg-container.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { EntityTypeRegistry, entityTypeRegistry } from './entity-type-registry';
import { migrate } from './index';
import { startPostgres, type PgContainer } from './pg-container';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// In-memory tests (no database)
// ---------------------------------------------------------------------------

describe('EntityTypeRegistry — in-memory', () => {
  test('register returns a normalised entry', () => {
    const registry = new EntityTypeRegistry();
    const entry = registry.register({ type: 'widget', schema: { type: 'object' } });

    expect(entry.type).toBe('widget');
    expect(entry.schema).toEqual({ type: 'object' });
    expect(entry.sensitive).toEqual([]);
    expect(entry.kmsKeyId).toBeNull();
  });

  test('register with sensitive fields and kmsKeyId', () => {
    const registry = new EntityTypeRegistry();
    const entry = registry.register({
      type: 'secret_doc',
      schema: {},
      sensitive: ['content', 'author'],
      kmsKeyId: 'arn:aws:kms:us-east-1:123:key/abc',
    });

    expect(entry.sensitive).toEqual(['content', 'author']);
    expect(entry.kmsKeyId).toBe('arn:aws:kms:us-east-1:123:key/abc');
  });

  test('register is idempotent — second call returns same entry', () => {
    const registry = new EntityTypeRegistry();
    const first = registry.register({ type: 'thing', schema: {} });
    const second = registry.register({ type: 'thing', schema: { extra: true } });

    expect(second).toBe(first); // same object reference
    expect(registry.size).toBe(1);
  });

  test('get returns undefined for unregistered type', () => {
    const registry = new EntityTypeRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  test('has returns false for unregistered, true after registration', () => {
    const registry = new EntityTypeRegistry();
    expect(registry.has('thing')).toBe(false);
    registry.register({ type: 'thing', schema: {} });
    expect(registry.has('thing')).toBe(true);
  });

  test('list returns all entries sorted by type', () => {
    const registry = new EntityTypeRegistry();
    registry.register({ type: 'zebra', schema: {} });
    registry.register({ type: 'alpha', schema: {} });
    registry.register({ type: 'middle', schema: {} });

    const types = registry.list().map((e) => e.type);
    expect(types).toEqual(['alpha', 'middle', 'zebra']);
  });

  test('size reflects the number of registered types', () => {
    const registry = new EntityTypeRegistry();
    expect(registry.size).toBe(0);
    registry.register({ type: 'a', schema: {} });
    expect(registry.size).toBe(1);
    registry.register({ type: 'b', schema: {} });
    expect(registry.size).toBe(2);
    // duplicate — size must not change
    registry.register({ type: 'a', schema: {} });
    expect(registry.size).toBe(2);
  });

  test('register throws for empty type string', () => {
    const registry = new EntityTypeRegistry();
    expect(() => registry.register({ type: '', schema: {} })).toThrow(TypeError);
  });

  test('register throws for invalid type characters (uppercase)', () => {
    const registry = new EntityTypeRegistry();
    expect(() => registry.register({ type: 'MyType', schema: {} })).toThrow(TypeError);
  });

  test('register throws for type starting with digit', () => {
    const registry = new EntityTypeRegistry();
    expect(() => registry.register({ type: '1thing', schema: {} })).toThrow(TypeError);
  });

  test('register accepts underscores and digits after first char', () => {
    const registry = new EntityTypeRegistry();
    const entry = registry.register({ type: 'corpus_chunk_v2', schema: {} });
    expect(entry.type).toBe('corpus_chunk_v2');
  });
});

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

describe('entityTypeRegistry singleton', () => {
  test('is an instance of EntityTypeRegistry', () => {
    expect(entityTypeRegistry).toBeInstanceOf(EntityTypeRegistry);
  });
});

// ---------------------------------------------------------------------------
// Database integration — registerWithDb
// ---------------------------------------------------------------------------

describe('EntityTypeRegistry — registerWithDb', () => {
  let pg: PgContainer;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    pg = await startPostgres();
    await migrate({ databaseUrl: pg.url });

    sql = postgres(pg.url, { max: 1, idle_timeout: 10, connect_timeout: 10 });
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await pg?.stop();
  });

  test('registerWithDb inserts a new entity type without DDL', async () => {
    const registry = new EntityTypeRegistry();

    const entry = await registry.registerWithDb(sql, {
      type: 'synthetic_test_type',
      schema: { description: 'a test entity type' },
      sensitive: ['secret_field'],
      kmsKeyId: 'test-key-id',
    });

    expect(entry.type).toBe('synthetic_test_type');

    // Verify it landed in the database
    const rows = await sql<{ type: string; sensitive: string[]; kms_key_id: string | null }[]>`
      SELECT type, sensitive, kms_key_id
      FROM entity_types
      WHERE type = 'synthetic_test_type'
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('synthetic_test_type');
    expect(rows[0].sensitive).toEqual(['secret_field']);
    expect(rows[0].kms_key_id).toBe('test-key-id');
  });

  test('registerWithDb is idempotent — second call does not throw', async () => {
    const registry = new EntityTypeRegistry();

    await registry.registerWithDb(sql, { type: 'idempotent_type', schema: {} });
    // Second call — DB uses ON CONFLICT DO NOTHING
    await expect(
      registry.registerWithDb(sql, { type: 'idempotent_type', schema: {} }),
    ).resolves.toBeDefined();
  });

  test('registerWithDb: the new entity type can immediately store entities', async () => {
    const registry = new EntityTypeRegistry();

    await registry.registerWithDb(sql, {
      type: 'live_test_entity',
      schema: {},
    });

    // Insert an entity of the new type — no DDL needed
    const id = `test-entity-${Date.now()}`;
    await sql`
      INSERT INTO entities (id, type, properties)
      VALUES (${id}, 'live_test_entity', ${sql.json({ label: 'hello' }) as never})
    `;

    const [row] = await sql<{ id: string; type: string }[]>`
      SELECT id, type FROM entities WHERE id = ${id}
    `;

    expect(row.id).toBe(id);
    expect(row.type).toBe('live_test_entity');
  });

  test('registerWithDb: the in-memory registry reflects the persisted type', async () => {
    const registry = new EntityTypeRegistry();

    await registry.registerWithDb(sql, { type: 'memory_db_sync', schema: {} });

    expect(registry.has('memory_db_sync')).toBe(true);
    expect(registry.get('memory_db_sync')?.type).toBe('memory_db_sync');
  });
});
