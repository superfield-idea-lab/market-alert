/**
 * Integration tests for the Compliance Officer database role (issue #85).
 *
 * Proves the database-layer boundary:
 *  - compliance_officer can read the compliance tables it needs
 *  - compliance_officer is blocked from customer-content tables by RLS
 *
 * No mocks — real Postgres container, real init-remote provisioning.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { runInitRemote, dbUrl } from './init-remote';
import { migrate } from './index';

let pg: PgContainer;
let appAdminSql: ReturnType<typeof postgres>;
let appRwSql: ReturnType<typeof postgres>;
type Sql = ReturnType<typeof postgres>;

const TEST_PASSWORDS = {
  app: 'app_test_pw',
  audit: 'audit_test_pw',
  analytics: 'analytics_test_pw',
  dictionary: 'dict_test_pw',
  emailIngest: 'email_ingest_test_pw',
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

beforeAll(async () => {
  pg = await startPostgres();

  await runInitRemote({
    ADMIN_DATABASE_URL: pg.url,
    APP_RW_PASSWORD: TEST_PASSWORDS.app,
    AUDIT_W_PASSWORD: TEST_PASSWORDS.audit,
    ANALYTICS_W_PASSWORD: TEST_PASSWORDS.analytics,
    DICT_RW_PASSWORD: TEST_PASSWORDS.dictionary,
    AGENT_EMAIL_INGEST_PASSWORD: TEST_PASSWORDS.emailIngest,
  } as NodeJS.ProcessEnv);

  await migrate({ databaseUrl: dbUrl(pg.url, DB_NAMES.app) });

  appAdminSql = postgres(dbUrl(pg.url, DB_NAMES.app), { max: 3 });
  appRwSql = postgres(makeRoleUrl(pg.url, DB_NAMES.app, 'app_rw', TEST_PASSWORDS.app), {
    max: 3,
  });

  await appAdminSql`
    INSERT INTO entity_types (type, schema)
    VALUES ('customer', '{}'), ('wiki_page_version', '{}')
    ON CONFLICT (type) DO NOTHING
  `;

  await appAdminSql`
    INSERT INTO tenant_retention_policies (tenant_id, retention_class, legal_hold_default)
    VALUES ('tenant-compliance-test', 'mifid2-5yr', false)
    ON CONFLICT (tenant_id) DO NOTHING
  `;

  await appAdminSql`
    INSERT INTO legal_holds (tenant_id, placed_by, reason, status)
    VALUES ('tenant-compliance-test', 'co-placer', 'Compliance test hold', 'active')
  `;

  await appAdminSql`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES
      ('customer-compliance-test', 'customer', '{"name":"Sensitive Customer"}', 'tenant-compliance-test'),
      ('wiki-compliance-test', 'wiki_page_version', '{"title":"Sensitive wiki"}', 'tenant-compliance-test')
    ON CONFLICT (id) DO NOTHING
  `;
}, 120_000);

afterAll(async () => {
  await appRwSql?.end({ timeout: 5 });
  await appAdminSql?.end({ timeout: 5 });
  await pg?.stop();
});

async function withComplianceRole<T>(callback: (tx: Sql) => Promise<T>): Promise<T> {
  return appRwSql.begin(async (tx) => {
    await tx.unsafe('SET LOCAL ROLE compliance_officer');
    return callback(tx as unknown as Sql);
  }) as unknown as Promise<T>;
}

describe('compliance_officer database privileges', () => {
  test('can read compliance tables', async () => {
    const legalHolds = await withComplianceRole(
      (tx) =>
        tx<{ tenant_id: string; reason: string }[]>`
        SELECT tenant_id, reason
        FROM legal_holds
        WHERE tenant_id = 'tenant-compliance-test'
      `,
    );
    expect(legalHolds).toHaveLength(1);
    expect(legalHolds[0].reason).toBe('Compliance test hold');

    const retentionPolicies = await withComplianceRole(
      (tx) =>
        tx<{ tenant_id: string; retention_class: string }[]>`
        SELECT tenant_id, retention_class
        FROM tenant_retention_policies
        WHERE tenant_id = 'tenant-compliance-test'
      `,
    );
    expect(retentionPolicies).toHaveLength(1);
    expect(retentionPolicies[0].retention_class).toBe('mifid2-5yr');
  });

  test('customer-content rows are blocked by restrictive RLS', async () => {
    const rows = await withComplianceRole(
      (tx) =>
        tx<{ id: string }[]>`
        SELECT id
        FROM entities
        WHERE id IN ('customer-compliance-test', 'wiki-compliance-test')
      `,
    );

    expect(rows).toHaveLength(0);
  });

  test('compliance RLS policies are installed on customer-content tables', async () => {
    const policies = await appAdminSql<
      { tablename: string; policyname: string; permissive: string }[]
    >`
      SELECT tablename, policyname, permissive
      FROM pg_policies
      WHERE schemaname = 'public'
        AND policyname IN (
          'entities_compliance_block',
          'relations_compliance_block',
          'wiki_page_versions_compliance_block'
        )
      ORDER BY tablename
    `;

    expect(policies.map((p) => p.policyname)).toEqual([
      'entities_compliance_block',
      'relations_compliance_block',
      'wiki_page_versions_compliance_block',
    ]);
    expect(policies.every((p) => p.permissive === 'RESTRICTIVE')).toBe(true);
  });
});
