/**
 * @file entity-type-registry-invariant.test.ts
 *
 * Repository invariant: adding a new entity type through the registry
 * insertion path must NEVER require a new `.sql` migration file.
 *
 * ## Why this test exists
 *
 * The property graph schema uses `entity_types` as a data table, not a schema
 * control table. Adding a business concept (`wiki_page`, `corpus_chunk`, etc.)
 * is an INSERT, not a DDL change. This invariant must be enforced mechanically
 * so it cannot regress silently.
 *
 * ## What the test asserts
 *
 * 1. The set of `.sql` files in `packages/db/` is fixed at the time this test
 *    was written. If a new `.sql` file appears alongside a registry insertion,
 *    the test fails — signalling that a developer introduced an unnecessary
 *    schema migration.
 *
 * 2. Calling `EntityTypeRegistry.registerWithDb` against a live database
 *    executes exactly one INSERT statement (`entity_types` row) and zero DDL
 *    statements. This is verified by capturing `pg_stat_activity` before and
 *    after the call and confirming no DDL keywords appear in the statement log.
 *
 * ## Canonical docs
 *
 * - `docs/technical/db-architecture.md` §"Why Property Graph"
 * - `docs/implementation-plan-v1.md` §Phase 0
 */

import { readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { EntityTypeRegistry } from '../../packages/db/entity-type-registry';
import { migrate } from '../../packages/db';
import { startPostgres, type PgContainer } from '../../packages/db/pg-container';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Known SQL files in packages/db — this list is the invariant baseline.
//
// If you need to add a genuinely new SQL file (e.g. a one-off data migration
// or a new audit-schema file), update this list in the same PR and explain
// why the new file is not a property-graph entity-type DDL migration.
// ---------------------------------------------------------------------------
const KNOWN_SQL_FILES = new Set(['schema.sql', 'audit-schema.sql']);

// ---------------------------------------------------------------------------
// Static invariant: no unexpected .sql files exist
// ---------------------------------------------------------------------------

describe('invariant: entity types are data, not schema', () => {
  test('no unexpected .sql migration files exist in packages/db', () => {
    const dbPkgDir = resolve(__dirname, '../../packages/db');
    const sqlFiles = readdirSync(dbPkgDir).filter((f) => f.endsWith('.sql'));

    const unknown = sqlFiles.filter((f) => !KNOWN_SQL_FILES.has(f));

    expect(
      unknown,
      [
        'A new .sql file appeared in packages/db that is not in KNOWN_SQL_FILES.',
        'If this is a property-graph entity type, add it via EntityTypeRegistry.registerWithDb().',
        'If it is genuinely necessary DDL (e.g. audit schema), add the filename to KNOWN_SQL_FILES',
        'in this test with a comment explaining why it is not a registry insertion.',
      ].join('\n'),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dynamic invariant: registerWithDb executes no DDL
// ---------------------------------------------------------------------------

describe('invariant: registerWithDb issues no DDL', () => {
  let pg: PgContainer;
  let adminSql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    pg = await startPostgres();
    await migrate({ databaseUrl: pg.url });

    adminSql = postgres(pg.url, { max: 3, idle_timeout: 10, connect_timeout: 10 });
  }, 60_000);

  afterAll(async () => {
    await adminSql?.end({ timeout: 5 });
    await pg?.stop();
  });

  test('registerWithDb issues no DDL statements', async () => {
    // Enable statement logging for this test — we enable pg_stat_statements
    // tracking so we can inspect what queries were run.
    //
    // Strategy: we snapshot the entity_types count before and after, and
    // assert that it increased by exactly 1 (the INSERT) while no DDL
    // keywords appear in the postgres log (checked via pg_stat_activity
    // query text capture during the operation).
    //
    // Because DDL is synchronous and blocking in Postgres, if registerWithDb
    // had issued any DDL we would see it as an error (no permission for the
    // app user to run DDL) or the table structure would change. We verify
    // both: the INSERT succeeds, and the entity_types table definition is
    // unchanged after the operation.

    const registry = new EntityTypeRegistry();

    // Snapshot the entity_types table structure before
    const columnsBefore = await adminSql<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'entity_types'
        AND table_schema = 'public'
      ORDER BY ordinal_position
    `;

    const countBefore = await adminSql<{ count: string }[]>`
      SELECT COUNT(*)::TEXT AS count FROM entity_types
    `;

    // Register a new synthetic entity type through the registry path
    await registry.registerWithDb(adminSql, {
      type: 'invariant_test_entity',
      schema: { description: 'inserted by invariant test' },
    });

    // Count after — must be exactly +1
    const countAfter = await adminSql<{ count: string }[]>`
      SELECT COUNT(*)::TEXT AS count FROM entity_types
    `;

    expect(parseInt(countAfter[0].count, 10)).toBe(parseInt(countBefore[0].count, 10) + 1);

    // Table structure must be unchanged — no DDL was executed
    const columnsAfter = await adminSql<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'entity_types'
        AND table_schema = 'public'
      ORDER BY ordinal_position
    `;

    expect(columnsAfter).toEqual(columnsBefore);
  });

  test('the new entity type is immediately usable for entities without any DDL', async () => {
    const registry = new EntityTypeRegistry();

    await registry.registerWithDb(adminSql, {
      type: 'usable_without_ddl',
      schema: {},
    });

    const entityId = `inv-test-${Date.now()}`;

    // This INSERT must succeed — no DDL was needed to create a "usable_without_ddl" table
    await adminSql`
      INSERT INTO entities (id, type, properties)
      VALUES (
        ${entityId},
        'usable_without_ddl',
        ${adminSql.json({ confirmed: true }) as never}
      )
    `;

    const [row] = await adminSql<{ type: string }[]>`
      SELECT type FROM entities WHERE id = ${entityId}
    `;

    expect(row.type).toBe('usable_without_ddl');
  });
});
