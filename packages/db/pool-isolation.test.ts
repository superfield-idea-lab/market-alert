/**
 * Integration tests for four-pool cross-pool isolation.
 *
 * Spins up a real ephemeral Postgres container, runs runInitRemote to provision
 * all four databases and roles, then asserts database-layer access controls:
 *
 * - app_rw cannot SELECT from kb_audit tables
 * - app_rw cannot SELECT from kb_dictionary tables
 * - audit_w cannot UPDATE or DELETE rows in kb_audit
 * - dict_rw cannot SELECT from kb_app tables
 * - kb_analytics exists and is empty after init
 * - Each pool's key domain is disjoint (config assertion)
 *
 * DATA-D-006: structural separation — cross-pool access denied at the database layer.
 */

import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { runInitRemote, dbUrl } from './init-remote';
import { KEY_DOMAINS } from './index';

let pg: PgContainer;

// Pools bound as specific roles after init
let appRwSql: ReturnType<typeof postgres>;
let auditWSql: ReturnType<typeof postgres>;
let analyticsWSql: ReturnType<typeof postgres>;
let dictRwSql: ReturnType<typeof postgres>;
let adminAppSql: ReturnType<typeof postgres>;

const TEST_PASSWORDS = {
  app: 'app_test_pw',
  audit: 'audit_test_pw',
  analytics: 'analytics_test_pw',
  dictionary: 'dict_test_pw',
  email_ingest: 'email_ingest_test_pw',
};

// Database names provisioned by runInitRemote
const DB_NAMES = {
  app: 'superfield_app',
  audit: 'superfield_audit',
  analytics: 'superfield_analytics',
  dictionary: 'superfield_dictionary',
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

  // runInitRemote uses the admin URL to provision roles and databases
  await runInitRemote({
    ADMIN_DATABASE_URL: pg.url,
    APP_RW_PASSWORD: TEST_PASSWORDS.app,
    AUDIT_W_PASSWORD: TEST_PASSWORDS.audit,
    ANALYTICS_W_PASSWORD: TEST_PASSWORDS.analytics,
    DICT_RW_PASSWORD: TEST_PASSWORDS.dictionary,
    AGENT_EMAIL_INGEST_PASSWORD: TEST_PASSWORDS.email_ingest,
  } as NodeJS.ProcessEnv);

  // Bind role-specific pools to each database
  appRwSql = postgres(makeRoleUrl(pg.url, DB_NAMES.app, 'app_rw', TEST_PASSWORDS.app), { max: 3 });
  auditWSql = postgres(makeRoleUrl(pg.url, DB_NAMES.audit, 'audit_w', TEST_PASSWORDS.audit), {
    max: 3,
  });
  analyticsWSql = postgres(
    makeRoleUrl(pg.url, DB_NAMES.analytics, 'analytics_w', TEST_PASSWORDS.analytics),
    { max: 3 },
  );
  dictRwSql = postgres(
    makeRoleUrl(pg.url, DB_NAMES.dictionary, 'dict_rw', TEST_PASSWORDS.dictionary),
    { max: 3 },
  );

  // Admin pool on the app database for reference inserts
  adminAppSql = postgres(dbUrl(pg.url, DB_NAMES.app), { max: 3 });
}, 120_000);

afterAll(async () => {
  await appRwSql?.end({ timeout: 5 });
  await auditWSql?.end({ timeout: 5 });
  await analyticsWSql?.end({ timeout: 5 });
  await dictRwSql?.end({ timeout: 5 });
  await adminAppSql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// app_rw cross-pool isolation
// ---------------------------------------------------------------------------

describe('app_rw cross-pool isolation', () => {
  test('app_rw cannot SELECT from kb_audit tables — blocked at the database layer', async () => {
    // app_rw holds no CONNECT privilege on the audit database.
    // Attempting to connect as app_rw to superfield_audit must fail.
    const appRwAuditSql = postgres(
      makeRoleUrl(pg.url, DB_NAMES.audit, 'app_rw', TEST_PASSWORDS.app),
      { max: 1, connect_timeout: 5 },
    );
    await expect(appRwAuditSql`SELECT 1`).rejects.toThrow();
    await appRwAuditSql.end({ timeout: 3 }).catch(() => {});
  });

  test('app_rw cannot SELECT from kb_dictionary tables — blocked at the database layer', async () => {
    // app_rw holds no CONNECT privilege on the dictionary database.
    const appRwDictSql = postgres(
      makeRoleUrl(pg.url, DB_NAMES.dictionary, 'app_rw', TEST_PASSWORDS.app),
      { max: 1, connect_timeout: 5 },
    );
    await expect(appRwDictSql`SELECT 1`).rejects.toThrow();
    await appRwDictSql.end({ timeout: 3 }).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// audit_w privilege restrictions
// ---------------------------------------------------------------------------

describe('audit_w privilege restrictions', () => {
  test('audit_w can INSERT into audit_log', async () => {
    const id = `test-audit-${Date.now()}`;
    await expect(
      auditWSql`
        INSERT INTO audit_log (id, action, changes, status)
        VALUES (${id}, 'test.action', '{}', 'pending')
      `,
    ).resolves.not.toThrow();
  });

  test('audit_w cannot UPDATE rows in audit_log — blocked at the database layer', async () => {
    // audit_w holds only INSERT, SELECT, and UPDATE(status). Full-row UPDATE must fail.
    // We test UPDATE on a non-status column (entity_type) which is not granted.
    const id = `test-audit-update-${Date.now()}`;
    await auditWSql`
      INSERT INTO audit_log (id, action, changes, status)
      VALUES (${id}, 'test.update', '{}', 'pending')
    `;

    await expect(
      auditWSql.unsafe(`UPDATE audit_log SET action = 'tampered' WHERE id = '${id}'`),
    ).rejects.toThrow();
  });

  test('audit_w cannot DELETE rows in audit_log — blocked at the database layer', async () => {
    const id = `test-audit-delete-${Date.now()}`;
    await auditWSql`
      INSERT INTO audit_log (id, action, changes, status)
      VALUES (${id}, 'test.delete', '{}', 'pending')
    `;

    await expect(auditWSql`DELETE FROM audit_log WHERE id = ${id}`).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// dict_rw cross-pool isolation
// ---------------------------------------------------------------------------

describe('dict_rw cross-pool isolation', () => {
  test('dict_rw cannot SELECT from kb_app tables — blocked at the database layer', async () => {
    // dict_rw holds no CONNECT privilege on the app database.
    const dictRwAppSql = postgres(
      makeRoleUrl(pg.url, DB_NAMES.app, 'dict_rw', TEST_PASSWORDS.dictionary),
      { max: 1, connect_timeout: 5 },
    );
    await expect(dictRwAppSql`SELECT 1`).rejects.toThrow();
    await dictRwAppSql.end({ timeout: 3 }).catch(() => {});
  });

  test('dict_rw can read/write identity_tokens in kb_dictionary', async () => {
    const token = `tok-${Date.now()}`;
    await expect(
      dictRwSql`
        INSERT INTO identity_tokens (token, real_name, real_email, real_org)
        VALUES (${token}, 'Test User', 'test@example.com', 'TestOrg')
      `,
    ).resolves.not.toThrow();

    const rows = await dictRwSql<{ token: string }[]>`
      SELECT token FROM identity_tokens WHERE token = ${token}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].token).toBe(token);

    // Clean up
    await dictRwSql`DELETE FROM identity_tokens WHERE token = ${token}`;
  });
});

// ---------------------------------------------------------------------------
// kb_analytics post-init state
// ---------------------------------------------------------------------------

describe('kb_analytics post-init state', () => {
  test('kb_analytics exists and analytics_events table is empty after init', async () => {
    const rows = await analyticsWSql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM analytics_events
    `;
    expect(parseInt(rows[0].count, 10)).toBe(0);
  });

  test('kb_analytics audit_replica table is empty after init', async () => {
    const rows = await analyticsWSql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM audit_replica
    `;
    expect(parseInt(rows[0].count, 10)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Disjoint key domain configuration
// ---------------------------------------------------------------------------

describe('disjoint key domain identifiers', () => {
  test('app and audit key domains are disjoint', () => {
    const appKeys = new Set<string>(KEY_DOMAINS.app);
    const auditKeys = new Set<string>(KEY_DOMAINS.audit);
    const intersection = [...appKeys].filter((k) => auditKeys.has(k));
    expect(intersection).toHaveLength(0);
  });

  test('app and dictionary key domains are disjoint', () => {
    const appKeys = new Set<string>(KEY_DOMAINS.app);
    const dictKeys = new Set<string>(KEY_DOMAINS.dictionary);
    const intersection = [...appKeys].filter((k) => dictKeys.has(k));
    expect(intersection).toHaveLength(0);
  });

  test('audit and dictionary key domains are disjoint', () => {
    const auditKeys = new Set<string>(KEY_DOMAINS.audit);
    const dictKeys = new Set<string>(KEY_DOMAINS.dictionary);
    const intersection = [...auditKeys].filter((k) => dictKeys.has(k));
    expect(intersection).toHaveLength(0);
  });

  test('dictionary pool uses identity-key domain only', () => {
    expect(KEY_DOMAINS.dictionary).toContain('identity-key');
    expect(KEY_DOMAINS.dictionary).toHaveLength(1);
  });

  test('analytics pool has no encryption key domains (populated Phase 7)', () => {
    expect(KEY_DOMAINS.analytics).toHaveLength(0);
  });
});
