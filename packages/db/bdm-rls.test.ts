/**
 * @file bdm-rls.test.ts
 *
 * Integration tests — Phase 7 BDM restrictive RLS policies (issue #73).
 *
 * Spins up a real ephemeral Postgres container, provisions the full schema and
 * role setup via runInitRemote, then asserts that a BDM session:
 *
 *   1. Cannot read customer entity rows at the database layer.
 *   2. Cannot read wiki_page entity rows at the database layer.
 *   3. Cannot read ground-truth email entity rows at the database layer.
 *   4. Cannot read customer_interest entity rows at the database layer.
 *   5. Cannot read identity_token entity rows at the database layer.
 *   6. Cannot traverse a has_ground_truth relation at the database layer.
 *   7. CAN read corpus_chunk entities (anonymised path — unblocked).
 *   8. CAN read transcript entities (anonymised path — unblocked).
 *   9. wiki_page_versions are fully blocked for BDM sessions.
 *  10. Policy existence and type checks for the three BDM block policies.
 *
 * Non-BDM sessions (no bdmDepartmentId set) are exercised in a reference run
 * to confirm the policies are no-ops outside BDM sessions.
 *
 * No mocks. Real Postgres container, real runInitRemote, real withRlsContext.
 *
 * Canonical docs:
 * - docs/PRD.md §4.7 (BDM workflow RLS boundary)
 * - docs/PRD.md §7 (structural DB blocks replace application-layer filtering)
 *
 * Issue #73 — feat: restrictive RLS policies blocking BDM access to customer data.
 */

import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import {
  runInitRemote,
  dbUrl,
  BDM_BLOCKED_ENTITY_TYPES,
  BDM_BLOCKED_RELATION_TYPES,
} from './init-remote';
import { withRlsContext } from './rls-context';

let pg: PgContainer;

/** app_rw pool — subject to RLS (used by all BDM session probes). */
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

const DB_NAMES = { app: 'superfield_app' };

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

const TENANT_A = 'tenant-bdm-rls';
const BDM_USER_ID = 'bdm-user-bdm-rls-test';
const RM_USER_ID = 'rm-user-bdm-rls-test';
const DEPT_ID = 'dept-bdm-rls-test';

// Customer-identifying entities (must be blocked for BDM)
const CUSTOMER_ID = 'customer-bdm-rls-test';
const CRM_UPDATE_ID = 'crm-update-bdm-rls-test';
const CUSTOMER_INTEREST_ID = 'cust-interest-bdm-rls-test';
const EMAIL_ID = 'email-bdm-rls-test';
const WIKI_PAGE_ID = 'wiki-page-bdm-rls-test';
const WIKI_PAGE_VERSION_ENTITY_ID = 'wiki-page-version-entity-bdm-rls-test';
const WIKI_ANNOTATION_ID = 'wiki-annotation-bdm-rls-test';
const IDENTITY_TOKEN_ID = 'identity-token-bdm-rls-test';

// Anonymised entities (must be accessible for BDM)
const TRANSCRIPT_ID = 'transcript-bdm-rls-test';
const CORPUS_CHUNK_ID = 'corpus-chunk-bdm-rls-test';
const ASSET_MANAGER_ID = 'asset-manager-bdm-rls-test';

// Relations
const HAS_GROUND_TRUTH_REL_ID = 'rel-has-gt-bdm-rls-test';
const DISCUSSED_IN_REL_ID = 'rel-discussed-in-bdm-rls-test';

// wiki_page_versions row
let wikiVersionId: string;

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

  // Seed required entity types (idempotent — init-remote seeds user, task, tag,
  // github_link, channel, message; we add the Phase 1 types used in this test).
  await adminAppSql`
    INSERT INTO entity_types (type, schema)
    VALUES
      ('customer',          '{}'),
      ('crm_update',        '{}'),
      ('customer_interest', '{}'),
      ('email',             '{}'),
      ('wiki_page',         '{}'),
      ('wiki_page_version', '{}'),
      ('wiki_annotation',   '{}'),
      ('identity_token',    '{}'),
      ('transcript',        '{}'),
      ('corpus_chunk',      '{}'),
      ('asset_manager',     '{}'),
      ('department',        '{}')
    ON CONFLICT (type) DO NOTHING
  `;

  // Insert all test entities via admin pool (bypasses RLS).
  await adminAppSql`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES
      (${BDM_USER_ID},                    'user',             '{}', ${TENANT_A}),
      (${RM_USER_ID},                     'user',             '{}', ${TENANT_A}),
      (${DEPT_ID},                        'department',       '{}', ${TENANT_A}),
      (${CUSTOMER_ID},                    'customer',         '{}', ${TENANT_A}),
      (${CRM_UPDATE_ID},                  'crm_update',       '{}', ${TENANT_A}),
      (${CUSTOMER_INTEREST_ID},           'customer_interest','{}', ${TENANT_A}),
      (${EMAIL_ID},                       'email',            '{}', ${TENANT_A}),
      (${WIKI_PAGE_ID},                   'wiki_page',        '{}', ${TENANT_A}),
      (${WIKI_PAGE_VERSION_ENTITY_ID},    'wiki_page_version','{}', ${TENANT_A}),
      (${WIKI_ANNOTATION_ID},             'wiki_annotation',  '{}', ${TENANT_A}),
      (${IDENTITY_TOKEN_ID},              'identity_token',   '{}', ${TENANT_A}),
      (${TRANSCRIPT_ID},                  'transcript',       '{}', ${TENANT_A}),
      (${CORPUS_CHUNK_ID},                'corpus_chunk',     '{}', ${TENANT_A}),
      (${ASSET_MANAGER_ID},               'asset_manager',    '{}', ${TENANT_A})
    ON CONFLICT (id) DO NOTHING
  `;

  // Insert test relations via admin pool.
  // has_ground_truth: transcript → customer (traversal attack shape)
  // discussed_in: asset_manager → transcript (BDM-accessible)
  await adminAppSql`
    INSERT INTO relations (id, source_id, target_id, type, properties)
    VALUES
      (${HAS_GROUND_TRUTH_REL_ID}, ${TRANSCRIPT_ID}, ${CUSTOMER_ID},    'has_ground_truth', '{}'),
      (${DISCUSSED_IN_REL_ID},     ${ASSET_MANAGER_ID}, ${TRANSCRIPT_ID}, 'discussed_in',    '{}')
    ON CONFLICT (id) DO NOTHING
  `;

  // Insert a wiki_page_versions row (for the wiki_page_versions_bdm_block test).
  const [wikiRow] = await adminAppSql<{ id: string }[]>`
    INSERT INTO wiki_page_versions (page_id, dept, customer, content, state, created_by)
    VALUES (
      ${'page-bdm-rls'},
      ${DEPT_ID},
      ${CUSTOMER_ID},
      'Confidential wiki content',
      'draft',
      ${RM_USER_ID}
    )
    RETURNING id
  `;
  wikiVersionId = wikiRow.id;
}, 120_000);

afterAll(async () => {
  await appRwSql?.end({ timeout: 5 });
  await adminAppSql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// 1. BDM block policy existence
// ---------------------------------------------------------------------------

describe('BDM RLS — policy existence', () => {
  test('entities_bdm_block is a RESTRICTIVE SELECT policy on entities', async () => {
    const rows = await adminAppSql<{ policyname: string; cmd: string; permissive: string }[]>`
      SELECT policyname, cmd, permissive
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename  = 'entities'
        AND policyname = 'entities_bdm_block'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].permissive).toBe('RESTRICTIVE');
    expect(rows[0].cmd).toBe('SELECT');
  });

  test('relations_bdm_block is a RESTRICTIVE SELECT policy on relations', async () => {
    const rows = await adminAppSql<{ policyname: string; cmd: string; permissive: string }[]>`
      SELECT policyname, cmd, permissive
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename  = 'relations'
        AND policyname = 'relations_bdm_block'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].permissive).toBe('RESTRICTIVE');
    expect(rows[0].cmd).toBe('SELECT');
  });

  test('wiki_page_versions_bdm_block is a RESTRICTIVE SELECT policy on wiki_page_versions', async () => {
    const rows = await adminAppSql<{ policyname: string; cmd: string; permissive: string }[]>`
      SELECT policyname, cmd, permissive
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename  = 'wiki_page_versions'
        AND policyname = 'wiki_page_versions_bdm_block'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].permissive).toBe('RESTRICTIVE');
    expect(rows[0].cmd).toBe('SELECT');
  });
});

// ---------------------------------------------------------------------------
// 2. BDM session — blocked entity types
// ---------------------------------------------------------------------------

describe('BDM RLS — blocked entity types (BDM session)', () => {
  test.each(BDM_BLOCKED_ENTITY_TYPES)(
    'BDM session cannot read entity of type "%s" at the database layer',
    async (entityType) => {
      const idMap: Record<string, string> = {
        customer: CUSTOMER_ID,
        crm_update: CRM_UPDATE_ID,
        customer_interest: CUSTOMER_INTEREST_ID,
        email: EMAIL_ID,
        wiki_page: WIKI_PAGE_ID,
        wiki_page_version: WIKI_PAGE_VERSION_ENTITY_ID,
        wiki_annotation: WIKI_ANNOTATION_ID,
        identity_token: IDENTITY_TOKEN_ID,
      };
      const entityId = idMap[entityType];

      const rows = await withRlsContext(
        appRwSql,
        { userId: BDM_USER_ID, tenantId: TENANT_A, bdmDepartmentId: DEPT_ID },
        (tx) => tx<{ id: string }[]>`SELECT id FROM entities WHERE id = ${entityId}`,
      );
      expect(rows).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// 3. BDM session — anonymised path still accessible
// ---------------------------------------------------------------------------

describe('BDM RLS — anonymised path accessible (BDM session)', () => {
  test('BDM session CAN read a transcript entity', async () => {
    const rows = await withRlsContext(
      appRwSql,
      { userId: BDM_USER_ID, tenantId: TENANT_A, bdmDepartmentId: DEPT_ID },
      (tx) => tx<{ id: string }[]>`SELECT id FROM entities WHERE id = ${TRANSCRIPT_ID}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(TRANSCRIPT_ID);
  });

  test('BDM session CAN read a corpus_chunk entity', async () => {
    const rows = await withRlsContext(
      appRwSql,
      { userId: BDM_USER_ID, tenantId: TENANT_A, bdmDepartmentId: DEPT_ID },
      (tx) => tx<{ id: string }[]>`SELECT id FROM entities WHERE id = ${CORPUS_CHUNK_ID}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(CORPUS_CHUNK_ID);
  });

  test('BDM session CAN read an asset_manager entity', async () => {
    const rows = await withRlsContext(
      appRwSql,
      { userId: BDM_USER_ID, tenantId: TENANT_A, bdmDepartmentId: DEPT_ID },
      (tx) => tx<{ id: string }[]>`SELECT id FROM entities WHERE id = ${ASSET_MANAGER_ID}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(ASSET_MANAGER_ID);
  });

  test('BDM session CAN read a discussed_in relation (asset_manager → transcript)', async () => {
    const rows = await withRlsContext(
      appRwSql,
      { userId: BDM_USER_ID, tenantId: TENANT_A, bdmDepartmentId: DEPT_ID },
      (tx) => tx<{ id: string }[]>`SELECT id FROM relations WHERE id = ${DISCUSSED_IN_REL_ID}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(DISCUSSED_IN_REL_ID);
  });
});

// ---------------------------------------------------------------------------
// 4. BDM session — has_ground_truth traversal blocked
// ---------------------------------------------------------------------------

describe('BDM RLS — has_ground_truth traversal blocked (BDM session)', () => {
  test(
    'BDM session cannot traverse has_ground_truth (transcript → customer) — ' +
      'database layer blocks re-identification via relation traversal',
    async () => {
      const rows = await withRlsContext(
        appRwSql,
        { userId: BDM_USER_ID, tenantId: TENANT_A, bdmDepartmentId: DEPT_ID },
        (tx) =>
          tx<{ id: string }[]>`SELECT id FROM relations WHERE id = ${HAS_GROUND_TRUTH_REL_ID}`,
      );
      expect(rows).toHaveLength(0);
    },
  );

  test.each(BDM_BLOCKED_RELATION_TYPES)(
    'BDM session cannot read any relation of type "%s"',
    async (relType) => {
      const rows = await withRlsContext(
        appRwSql,
        { userId: BDM_USER_ID, tenantId: TENANT_A, bdmDepartmentId: DEPT_ID },
        (tx) => tx<{ id: string }[]>`SELECT id FROM relations WHERE type = ${relType}`,
      );
      expect(rows).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// 5. BDM session — wiki_page_versions fully blocked
// ---------------------------------------------------------------------------

describe('BDM RLS — wiki_page_versions fully blocked (BDM session)', () => {
  test('BDM session cannot read wiki_page_versions at the database layer', async () => {
    const rows = await withRlsContext(
      appRwSql,
      { userId: BDM_USER_ID, tenantId: TENANT_A, bdmDepartmentId: DEPT_ID },
      (tx) => tx<{ id: string }[]>`SELECT id FROM wiki_page_versions WHERE id = ${wikiVersionId}`,
    );
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Non-BDM sessions are unaffected by the BDM block policies
// ---------------------------------------------------------------------------

describe('BDM RLS — non-BDM sessions unaffected', () => {
  test('RM session (no bdmDepartmentId) can read a customer entity', async () => {
    const rows = await withRlsContext(
      appRwSql,
      { userId: RM_USER_ID, tenantId: TENANT_A },
      (tx) => tx<{ id: string }[]>`SELECT id FROM entities WHERE id = ${CUSTOMER_ID}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(CUSTOMER_ID);
  });

  test('RM session can read a has_ground_truth relation', async () => {
    const rows = await withRlsContext(
      appRwSql,
      { userId: RM_USER_ID, tenantId: TENANT_A },
      (tx) => tx<{ id: string }[]>`SELECT id FROM relations WHERE id = ${HAS_GROUND_TRUTH_REL_ID}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(HAS_GROUND_TRUTH_REL_ID);
  });

  test('RM session with assigned customer can read wiki_page_versions', async () => {
    const rows = await withRlsContext(
      appRwSql,
      { userId: RM_USER_ID, tenantId: TENANT_A, rmCustomerIds: [CUSTOMER_ID] },
      (tx) => tx<{ id: string }[]>`SELECT id FROM wiki_page_versions WHERE id = ${wikiVersionId}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(wikiVersionId);
  });
});

// ---------------------------------------------------------------------------
// 7. Superuser bypasses all RLS (including BDM blocks)
// ---------------------------------------------------------------------------

describe('BDM RLS — superuser bypasses BDM block policies', () => {
  test('admin pool reads customer entity despite BDM block policies existing', async () => {
    const rows = await adminAppSql<{ id: string }[]>`
      SELECT id FROM entities WHERE id = ${CUSTOMER_ID}
    `;
    expect(rows).toHaveLength(1);
  });

  test('admin pool reads has_ground_truth relation despite BDM block policies existing', async () => {
    const rows = await adminAppSql<{ id: string }[]>`
      SELECT id FROM relations WHERE id = ${HAS_GROUND_TRUTH_REL_ID}
    `;
    expect(rows).toHaveLength(1);
  });

  test('admin pool reads wiki_page_versions despite BDM block policies existing', async () => {
    const rows = await adminAppSql<{ id: string }[]>`
      SELECT id FROM wiki_page_versions WHERE id = ${wikiVersionId}
    `;
    expect(rows).toHaveLength(1);
  });
});
