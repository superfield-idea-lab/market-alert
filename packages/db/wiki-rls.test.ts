/**
 * Integration tests — RLS-enforced my-customers-only wiki visibility (issue #50).
 *
 * Spins up a real ephemeral Postgres container, provisions the full schema and
 * role setup via runInitRemote, then asserts:
 *
 *   1. wiki_page_versions has RLS enabled.
 *   2. The wiki_page_versions_rm_isolation policy exists.
 *   3. An RM can read wiki versions for their assigned customers.
 *   4. An RM CANNOT read wiki versions for a customer assigned to another RM.
 *      The block is enforced at the database layer via the RLS policy.
 *   5. With no rmCustomerIds set (empty list), zero wiki versions are returned.
 *   6. Superuser (admin pool) bypasses RLS and sees all wiki versions.
 *
 * No mocks. Real Postgres container, real runInitRemote, real withRlsContext.
 *
 * Blueprint: PRD §7 — restrictive RLS enforced at the database layer.
 * Issue #50 — RLS-enforced my-customers-only wiki visibility.
 */

import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { runInitRemote, dbUrl } from './init-remote';
import { withRlsContext } from './rls-context';

let pg: PgContainer;

/** app_rw pool — used by the application for normal queries (subject to RLS). */
let appRwSql: ReturnType<typeof postgres>;

/** Admin pool on the app database — bypasses RLS (superuser). */
let adminAppSql: ReturnType<typeof postgres>;

const TEST_PASSWORDS = {
  app: 'app_test_pw',
  audit: 'audit_test_pw',
  analytics: 'analytics_test_pw',
  dictionary: 'dict_test_pw',
  email_ingest: 'email_ingest_test_pw',
};

const DB_NAMES = {
  app: 'superfield_app',
};

function makeRoleUrl(adminUrl: string, db: string, role: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TENANT_A = 'tenant-wiki-rls';

// Two distinct relationship managers
const RM_A_ID = 'rm-a-wiki-rls-test';
const RM_B_ID = 'rm-b-wiki-rls-test';

// Two distinct customers, each assigned to one RM
const CUSTOMER_A_ID = 'customer-a-wiki-rls-test';
const CUSTOMER_B_ID = 'customer-b-wiki-rls-test';

let versionAId: string;
let versionBId: string;

beforeAll(async () => {
  pg = await startPostgres();

  await runInitRemote({
    ADMIN_DATABASE_URL: pg.url,
    APP_RW_PASSWORD: TEST_PASSWORDS.app,
    AUDIT_W_PASSWORD: TEST_PASSWORDS.audit,
    ANALYTICS_W_PASSWORD: TEST_PASSWORDS.analytics,
    DICT_RW_PASSWORD: TEST_PASSWORDS.dictionary,
    AGENT_EMAIL_INGEST_PASSWORD: TEST_PASSWORDS.email_ingest,
  } as NodeJS.ProcessEnv);

  appRwSql = postgres(makeRoleUrl(pg.url, DB_NAMES.app, 'app_rw', TEST_PASSWORDS.app), { max: 5 });
  adminAppSql = postgres(dbUrl(pg.url, DB_NAMES.app), { max: 3 });

  // Seed required entity types
  await adminAppSql`
    INSERT INTO entity_types (type, schema)
    VALUES ('user', '{}'), ('customer', '{}')
    ON CONFLICT (type) DO NOTHING
  `;

  // Create two RM user entities and two customer entities in the same tenant.
  await adminAppSql`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES
      (${RM_A_ID},       'user',     '{}', ${TENANT_A}),
      (${RM_B_ID},       'user',     '{}', ${TENANT_A}),
      (${CUSTOMER_A_ID}, 'customer', '{}', ${TENANT_A}),
      (${CUSTOMER_B_ID}, 'customer', '{}', ${TENANT_A})
    ON CONFLICT (id) DO NOTHING
  `;

  // Assign RM_A → CUSTOMER_A and RM_B → CUSTOMER_B via 'manages' relations.
  await adminAppSql`
    INSERT INTO relations (id, source_id, target_id, type, properties)
    VALUES
      (${'rel-rm-a-cust-a-wiki-rls'}, ${RM_A_ID}, ${CUSTOMER_A_ID}, 'manages', '{}'),
      (${'rel-rm-b-cust-b-wiki-rls'}, ${RM_B_ID}, ${CUSTOMER_B_ID}, 'manages', '{}')
    ON CONFLICT (id) DO NOTHING
  `;

  // Insert one wiki_page_version for each customer (using admin pool to bypass RLS).
  const [rowA] = await adminAppSql<{ id: string }[]>`
    INSERT INTO wiki_page_versions (page_id, dept, customer, content, state, created_by)
    VALUES (
      ${'page-a'},
      'dept-wiki-rls',
      ${CUSTOMER_A_ID},
      'Wiki content for customer A — confidential',
      'draft',
      ${RM_A_ID}
    )
    RETURNING id
  `;
  versionAId = rowA.id;

  const [rowB] = await adminAppSql<{ id: string }[]>`
    INSERT INTO wiki_page_versions (page_id, dept, customer, content, state, created_by)
    VALUES (
      ${'page-b'},
      'dept-wiki-rls',
      ${CUSTOMER_B_ID},
      'Wiki content for customer B — confidential',
      'draft',
      ${RM_B_ID}
    )
    RETURNING id
  `;
  versionBId = rowB.id;
}, 120_000);

afterAll(async () => {
  await appRwSql?.end({ timeout: 5 });
  await adminAppSql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// 1. RLS infrastructure
// ---------------------------------------------------------------------------

describe('wiki_page_versions — RLS infrastructure', () => {
  test('RLS is enabled on wiki_page_versions', async () => {
    const [row] = await adminAppSql<{ rowsecurity: boolean }[]>`
      SELECT relrowsecurity AS rowsecurity
      FROM pg_class
      WHERE relname = 'wiki_page_versions'
        AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
    `;
    expect(row.rowsecurity).toBe(true);
  });

  test('wiki_page_versions_rm_isolation policy exists as PERMISSIVE FOR SELECT', async () => {
    const rows = await adminAppSql<{ policyname: string; cmd: string; permissive: string }[]>`
      SELECT policyname, cmd, permissive
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename  = 'wiki_page_versions'
        AND policyname = 'wiki_page_versions_rm_isolation'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].permissive).toBe('PERMISSIVE');
    expect(rows[0].cmd).toBe('SELECT');
  });
});

// ---------------------------------------------------------------------------
// 2. Own-customer read succeeds
// ---------------------------------------------------------------------------

describe('wiki_page_versions — own-customer read', () => {
  test('RM_A can read the wiki version for their assigned customer (CUSTOMER_A)', async () => {
    const rows = await withRlsContext(
      appRwSql,
      { userId: RM_A_ID, tenantId: TENANT_A, rmCustomerIds: [CUSTOMER_A_ID] },
      (tx) =>
        tx<{ id: string }[]>`
          SELECT id FROM wiki_page_versions WHERE id = ${versionAId}
        `,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(versionAId);
  });

  test('RM_B can read the wiki version for their assigned customer (CUSTOMER_B)', async () => {
    const rows = await withRlsContext(
      appRwSql,
      { userId: RM_B_ID, tenantId: TENANT_A, rmCustomerIds: [CUSTOMER_B_ID] },
      (tx) =>
        tx<{ id: string }[]>`
          SELECT id FROM wiki_page_versions WHERE id = ${versionBId}
        `,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(versionBId);
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-RM access is blocked at the database layer
// ---------------------------------------------------------------------------

describe('wiki_page_versions — cross-RM access block (database layer)', () => {
  test(
    'RM_A cannot read the wiki version for CUSTOMER_B — ' +
      'RLS filters the row silently, returning zero results',
    async () => {
      // RM_A is only assigned to CUSTOMER_A; CUSTOMER_B is assigned to RM_B.
      // The DB-layer policy must block this — no application-layer filtering.
      const rows = await withRlsContext(
        appRwSql,
        { userId: RM_A_ID, tenantId: TENANT_A, rmCustomerIds: [CUSTOMER_A_ID] },
        (tx) =>
          tx<{ id: string }[]>`
            SELECT id FROM wiki_page_versions WHERE id = ${versionBId}
          `,
      );
      expect(rows).toHaveLength(0);
    },
  );

  test(
    'RM_B cannot read the wiki version for CUSTOMER_A — ' +
      'RLS filters the row silently, returning zero results',
    async () => {
      // RM_B is only assigned to CUSTOMER_B; CUSTOMER_A is assigned to RM_A.
      const rows = await withRlsContext(
        appRwSql,
        { userId: RM_B_ID, tenantId: TENANT_A, rmCustomerIds: [CUSTOMER_B_ID] },
        (tx) =>
          tx<{ id: string }[]>`
            SELECT id FROM wiki_page_versions WHERE id = ${versionAId}
          `,
      );
      expect(rows).toHaveLength(0);
    },
  );

  test('session with empty rmCustomerIds cannot read any wiki version', async () => {
    const rows = await withRlsContext(
      appRwSql,
      { userId: RM_A_ID, tenantId: TENANT_A, rmCustomerIds: [] },
      (tx) =>
        tx<{ id: string }[]>`
          SELECT id FROM wiki_page_versions
          WHERE id IN (${versionAId}, ${versionBId})
        `,
    );
    expect(rows).toHaveLength(0);
  });

  test('session with no rmCustomerIds (omitted) cannot read any wiki version', async () => {
    // omitting rmCustomerIds defaults to '' → empty array_to_string output → no match
    const rows = await withRlsContext(
      appRwSql,
      { userId: RM_A_ID, tenantId: TENANT_A },
      (tx) =>
        tx<{ id: string }[]>`
          SELECT id FROM wiki_page_versions
          WHERE id IN (${versionAId}, ${versionBId})
        `,
    );
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Superuser bypasses RLS
// ---------------------------------------------------------------------------

describe('wiki_page_versions — superuser bypass', () => {
  test('admin pool bypasses RLS and can read all wiki versions', async () => {
    const rows = await adminAppSql<{ id: string }[]>`
      SELECT id FROM wiki_page_versions
      WHERE id IN (${versionAId}, ${versionBId})
      ORDER BY id
    `;
    expect(rows).toHaveLength(2);
  });
});
