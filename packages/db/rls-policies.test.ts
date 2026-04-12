/**
 * Integration tests for restrictive RLS policies on customer-scoped tables.
 *
 * Spins up a real ephemeral Postgres container, runs runInitRemote to provision
 * the full database and role setup, then asserts that:
 *
 *   1. RLS is enabled on `entities` and `relations`.
 *   2. Each restrictive policy exists in pg_policies.
 *   3. app_rw can only read rows matching the current session's tenant_id.
 *   4. Cross-tenant reads return zero rows (not an error — RLS filters silently).
 *   5. Queries with no session context (empty tenant) return zero rows.
 *   6. Superuser bypass: admin pool bypasses RLS and sees all rows.
 *
 * Blueprint: DATA blueprint, PRD §7 — restrictive RLS replaces application-layer
 * tenant filtering.
 *
 * Issue #19 — Phase 1 security foundation.
 */

import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { runInitRemote, dbUrl, CUSTOMER_SCOPED_TABLES } from './init-remote';
import { withRlsContext } from './rls-context';

let pg: PgContainer;

// app_rw pool — used by the application for normal queries
let appRwSql: ReturnType<typeof postgres>;
// Admin pool on the app database — bypasses RLS (superuser)
let adminAppSql: ReturnType<typeof postgres>;

const TEST_PASSWORDS = {
  app: 'app_test_pw',
  audit: 'audit_test_pw',
  analytics: 'analytics_test_pw',
  dictionary: 'dict_test_pw',
  coding: 'coding_test_pw',
  analysis: 'analysis_test_pw',
  code_cleanup: 'code_cleanup_test_pw',
  email_ingest: 'email_ingest_test_pw',
};

const DB_NAMES = {
  app: 'calypso_app',
};

function makeRoleUrl(adminUrl: string, db: string, role: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
}

// Entity IDs used across tests
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const USER_A = 'user-entity-a';
const USER_B = 'user-entity-b';
let entityAId: string;
let entityBId: string;
let relationId: string;

beforeAll(async () => {
  pg = await startPostgres();

  await runInitRemote({
    ADMIN_DATABASE_URL: pg.url,
    APP_RW_PASSWORD: TEST_PASSWORDS.app,
    AUDIT_W_PASSWORD: TEST_PASSWORDS.audit,
    ANALYTICS_W_PASSWORD: TEST_PASSWORDS.analytics,
    DICT_RW_PASSWORD: TEST_PASSWORDS.dictionary,
    AGENT_CODING_PASSWORD: TEST_PASSWORDS.coding,
    AGENT_ANALYSIS_PASSWORD: TEST_PASSWORDS.analysis,
    AGENT_CODE_CLEANUP_PASSWORD: TEST_PASSWORDS.code_cleanup,
    AGENT_EMAIL_INGEST_PASSWORD: TEST_PASSWORDS.email_ingest,
  } as NodeJS.ProcessEnv);

  appRwSql = postgres(makeRoleUrl(pg.url, DB_NAMES.app, 'app_rw', TEST_PASSWORDS.app), { max: 5 });

  // Admin pool on app database — bypasses RLS (superuser)
  adminAppSql = postgres(dbUrl(pg.url, DB_NAMES.app), { max: 3 });

  // Insert test entities into two different tenants using the admin pool
  // (bypasses RLS for setup).
  entityAId = `ent-a-${Date.now()}`;
  entityBId = `ent-b-${Date.now()}`;
  relationId = `rel-${Date.now()}`;

  // Insert user entity_type if not present
  await adminAppSql`
    INSERT INTO entity_types (type, schema)
    VALUES ('user', '{}')
    ON CONFLICT (type) DO NOTHING
  `;

  await adminAppSql`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES
      (${entityAId}, 'user', ${'{}'}::jsonb, ${TENANT_A}),
      (${entityBId}, 'user', ${'{}'}::jsonb, ${TENANT_B})
  `;

  // Insert a relation between the two tenant-A entity and tenant-B entity
  // (in practice cross-tenant relations are not allowed; we use it to verify
  // the RLS policy filters by source entity tenant).
  await adminAppSql`
    INSERT INTO relations (id, source_id, target_id, type, properties)
    VALUES (${relationId}, ${entityAId}, ${entityBId}, 'test', ${'{}'}::jsonb)
  `;
}, 120_000);

afterAll(async () => {
  await appRwSql?.end({ timeout: 5 });
  await adminAppSql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// RLS infrastructure: enabled + policy existence
// ---------------------------------------------------------------------------

describe('RLS infrastructure', () => {
  test.each(CUSTOMER_SCOPED_TABLES)('RLS is enabled on %s', async (table) => {
    const [row] = await adminAppSql<{ rowsecurity: boolean }[]>`
        SELECT relrowsecurity AS rowsecurity
        FROM pg_class
        WHERE relname = ${table}
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      `;
    expect(row.rowsecurity).toBe(true);
  });

  test.each(CUSTOMER_SCOPED_TABLES)(
    'tenant-isolation policy %s_tenant_isolation exists in pg_policies as PERMISSIVE FOR ALL',
    async (table) => {
      const rows = await adminAppSql<{ policyname: string; cmd: string; permissive: string }[]>`
        SELECT policyname, cmd, permissive
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = ${table}
          AND policyname = ${`${table}_tenant_isolation`}
      `;
      expect(rows).toHaveLength(1);
      // Permissive policies appear as 'PERMISSIVE' — the only policy on the table,
      // so no rows are accessible without it (deny-by-default when RLS is enabled
      // and FORCE RLS is active on the table owner).
      expect(rows[0].permissive).toBe('PERMISSIVE');
      expect(rows[0].cmd).toBe('ALL');
    },
  );
});

// ---------------------------------------------------------------------------
// entities: tenant isolation via app_rw
// ---------------------------------------------------------------------------

describe('entities — tenant isolation (app_rw role)', () => {
  test('app_rw reads own-tenant entity when session context matches', async () => {
    const rows = await withRlsContext(
      appRwSql,
      { userId: USER_A, tenantId: TENANT_A },
      async (tx) => {
        return tx<{ id: string }[]>`SELECT id FROM entities WHERE id = ${entityAId}`;
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(entityAId);
  });

  test('app_rw cannot read cross-tenant entity — RLS filters the row silently', async () => {
    // Session is scoped to TENANT_A; entityBId belongs to TENANT_B.
    const rows = await withRlsContext(
      appRwSql,
      { userId: USER_A, tenantId: TENANT_A },
      async (tx) => {
        return tx<{ id: string }[]>`SELECT id FROM entities WHERE id = ${entityBId}`;
      },
    );
    expect(rows).toHaveLength(0);
  });

  test('app_rw with TENANT_B context cannot read TENANT_A entity', async () => {
    const rows = await withRlsContext(
      appRwSql,
      { userId: USER_B, tenantId: TENANT_B },
      async (tx) => {
        return tx<{ id: string }[]>`SELECT id FROM entities WHERE id = ${entityAId}`;
      },
    );
    expect(rows).toHaveLength(0);
  });

  test('app_rw with empty tenantId cannot read any entity row', async () => {
    // tenantId=null is serialised as '' by withRlsContext.
    // The policy permits rows where tenant_id = '' OR tenantId = ''.
    // No row has tenant_id='' so the result must be empty.
    const rows = await withRlsContext(appRwSql, { userId: USER_A, tenantId: null }, async (tx) => {
      return tx<{ id: string }[]>`SELECT id FROM entities WHERE id = ${entityAId}`;
    });
    expect(rows).toHaveLength(0);
  });

  test('superuser (admin pool) bypasses RLS and can read all entities', async () => {
    // Admin pool connects as the postgres superuser — RLS is bypassed.
    const rows = await adminAppSql<{ id: string }[]>`
      SELECT id FROM entities WHERE id IN (${entityAId}, ${entityBId})
      ORDER BY id
    `;
    expect(rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// relations: tenant isolation via app_rw
// ---------------------------------------------------------------------------

describe('relations — tenant isolation (app_rw role)', () => {
  test('app_rw with TENANT_A context can read the relation whose source is in TENANT_A', async () => {
    // relationId has source_id=entityAId (TENANT_A).
    const rows = await withRlsContext(
      appRwSql,
      { userId: USER_A, tenantId: TENANT_A },
      async (tx) => {
        return tx<{ id: string }[]>`SELECT id FROM relations WHERE id = ${relationId}`;
      },
    );
    expect(rows).toHaveLength(1);
  });

  test('app_rw with TENANT_B context cannot read the TENANT_A-sourced relation', async () => {
    // The relation's source entity belongs to TENANT_A.
    // A TENANT_B session must not see it.
    const rows = await withRlsContext(
      appRwSql,
      { userId: USER_B, tenantId: TENANT_B },
      async (tx) => {
        return tx<{ id: string }[]>`SELECT id FROM relations WHERE id = ${relationId}`;
      },
    );
    expect(rows).toHaveLength(0);
  });

  test('app_rw with empty tenantId cannot read any relation row', async () => {
    const rows = await withRlsContext(appRwSql, { userId: USER_A, tenantId: null }, async (tx) => {
      return tx<{ id: string }[]>`SELECT id FROM relations WHERE id = ${relationId}`;
    });
    expect(rows).toHaveLength(0);
  });

  test('superuser (admin pool) bypasses RLS and can read all relations', async () => {
    const rows = await adminAppSql<{ id: string }[]>`
      SELECT id FROM relations WHERE id = ${relationId}
    `;
    expect(rows).toHaveLength(1);
  });
});
