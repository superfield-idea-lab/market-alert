import postgres from 'postgres';
import { buildSslOptions } from './ssl';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const DEFAULT_DATABASE_NAMES = {
  app: 'calypso_app',
  audit: 'calypso_audit',
  analytics: 'calypso_analytics',
  dictionary: 'calypso_dictionary',
} as const;

const ROLE_NAMES = {
  app: 'app_rw',
  audit: 'audit_w',
  analytics: 'analytics_w',
  /** IdentityDictionary service role — read/write on kb_dictionary only. */
  dictionary: 'dict_rw',
} as const;

/**
 * Base read-only worker role. All per-type agent roles are created IN ROLE
 * agent_worker so they inherit any future shared grants applied to the base
 * role (e.g. SELECT on public reference tables). agent_worker itself has no
 * LOGIN — it is a privilege group, not a connection credential.
 *
 * Blueprint: WORKER-D-007 (per-agent-type-database-role), WORKER-P-001 (read-only-database-access)
 */
const AGENT_BASE_ROLE = 'agent_worker';

/**
 * Known agent types and their corresponding per-type DB roles and view names.
 * Adding a new agent type here is the only change required to provision it.
 *
 * Blueprint: WORKER-P-008 (agent-type-isolation), TQ-D-004 (per-type-filtered-views)
 *
 * email_ingest: Phase 2 email ingestion worker. The role has no INSERT on the
 * entities table — writes are forced through POST /internal/ingestion/email.
 * Blueprint: WORKER-P-001 (read-only-database-access), issue #28.
 */
export const AGENT_TYPES = ['coding', 'analysis', 'code_cleanup', 'email_ingest'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

/**
 * Customer-scoped tables: every table whose rows belong to a specific tenant.
 * Each table listed here has RLS enabled and a tenant-isolation policy applied
 * by configureCustomerScopedRls().
 *
 * Blueprint: DATA blueprint, PRD §7 — restrictive RLS replaces application-layer
 * tenant filtering (issue #19).
 */
export const CUSTOMER_SCOPED_TABLES = ['entities', 'relations'] as const;
export type CustomerScopedTable = (typeof CUSTOMER_SCOPED_TABLES)[number];

export function agentRoleName(agentType: AgentType): string {
  return `agent_${agentType}`;
}

export function agentViewName(agentType: AgentType): string {
  return `task_queue_view_${agentType}`;
}

export interface InitRemoteConfig {
  adminDatabaseUrl: string;
  passwords: {
    app: string;
    audit: string;
    analytics: string;
    /** IdentityDictionary service role password. */
    dictionary: string;
    /** Per-type agent role passwords keyed by agent type (e.g. coding, analysis) */
    agents: Record<AgentType, string>;
  };
  databases: {
    app: string;
    audit: string;
    analytics: string;
    /** kb_dictionary: IdentityDictionary isolation domain. */
    dictionary: string;
  };
}

export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function dbUrl(base: string, dbName: string): string {
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  return url.toString();
}

export function sslOptions(): ReturnType<typeof buildSslOptions> {
  return buildSslOptions();
}

export function makePool(url: string) {
  return postgres(url, {
    max: 1,
    idle_timeout: 30,
    connect_timeout: 30,
    ssl: sslOptions(),
    connection: { client_min_messages: 'warning' },
  });
}

export function loadInitRemoteConfig(env: NodeJS.ProcessEnv = process.env): InitRemoteConfig {
  const required = [
    'ADMIN_DATABASE_URL',
    'APP_RW_PASSWORD',
    'AUDIT_W_PASSWORD',
    'ANALYTICS_W_PASSWORD',
    'DICT_RW_PASSWORD',
  ] as const;

  // Agent type passwords: AGENT_<TYPE>_PASSWORD (e.g. AGENT_CODING_PASSWORD)
  const agentPasswordKeys = AGENT_TYPES.map((t) => `AGENT_${t.toUpperCase()}_PASSWORD` as string);

  const missing = [
    ...required.filter((key) => !env[key]),
    ...agentPasswordKeys.filter((key) => !env[key]),
  ];
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const agents = Object.fromEntries(
    AGENT_TYPES.map((t) => [t, env[`AGENT_${t.toUpperCase()}_PASSWORD`]!]),
  ) as Record<AgentType, string>;

  return {
    adminDatabaseUrl: env.ADMIN_DATABASE_URL!,
    passwords: {
      app: env.APP_RW_PASSWORD!,
      audit: env.AUDIT_W_PASSWORD!,
      analytics: env.ANALYTICS_W_PASSWORD!,
      dictionary: env.DICT_RW_PASSWORD!,
      agents,
    },
    databases: {
      app: env.APP_DB || DEFAULT_DATABASE_NAMES.app,
      audit: env.AUDIT_DB || DEFAULT_DATABASE_NAMES.audit,
      analytics: env.ANALYTICS_DB || DEFAULT_DATABASE_NAMES.analytics,
      dictionary: env.DICTIONARY_DB || DEFAULT_DATABASE_NAMES.dictionary,
    },
  };
}

async function ensureRole(
  admin: ReturnType<typeof makePool>,
  roleName: string,
  password: string,
): Promise<void> {
  const escapedPassword = escapeSqlLiteral(password);
  await admin.unsafe(`
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${roleName}') THEN
    CREATE ROLE ${quoteIdentifier(roleName)} WITH LOGIN PASSWORD '${escapedPassword}';
  ELSE
    ALTER ROLE ${quoteIdentifier(roleName)} WITH LOGIN PASSWORD '${escapedPassword}';
  END IF;
END
$$;
`);
}

async function ensureDatabase(
  admin: ReturnType<typeof makePool>,
  databaseName: string,
): Promise<void> {
  const [{ exists }] = await admin<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT FROM pg_database WHERE datname = ${databaseName}) AS exists
  `;
  if (!exists) {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  }
  // Revoke the default PUBLIC CONNECT privilege so only explicitly granted roles
  // can connect. This enforces structural cross-pool isolation at the database layer.
  // DATA-D-006: a role must not be able to connect to a database it does not own.
  await admin.unsafe(`REVOKE CONNECT ON DATABASE ${quoteIdentifier(databaseName)} FROM PUBLIC`);
}

async function grantConnect(
  admin: ReturnType<typeof makePool>,
  databaseName: string,
  roleName: string,
): Promise<void> {
  await admin.unsafe(
    `GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${quoteIdentifier(roleName)}`,
  );
}

async function configureAppDatabase(appAdmin: ReturnType<typeof makePool>): Promise<void> {
  await appAdmin.unsafe(`
GRANT ALL ON SCHEMA public TO ${quoteIdentifier(ROLE_NAMES.app)};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quoteIdentifier(ROLE_NAMES.app)};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdentifier(ROLE_NAMES.app)};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quoteIdentifier(ROLE_NAMES.app)};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ${quoteIdentifier(ROLE_NAMES.app)};
`);

  const [{ server_version_num }] = await appAdmin<{ server_version_num: number }[]>`
    SELECT current_setting('server_version_num')::int AS server_version_num
  `;

  if (server_version_num >= 170000) {
    await appAdmin.unsafe(`
GRANT MAINTAIN ON ALL TABLES IN SCHEMA public TO ${quoteIdentifier(ROLE_NAMES.app)};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT MAINTAIN ON TABLES TO ${quoteIdentifier(ROLE_NAMES.app)};
`);
  }
}

async function configureAuditDatabase(auditAdmin: ReturnType<typeof makePool>): Promise<void> {
  await auditAdmin.unsafe(`
GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(ROLE_NAMES.audit)};

-- Append-only hash-chained audit event log.
-- audit_w may INSERT and SELECT only. No UPDATE, DELETE, or TRUNCATE.
-- This is the primary audit store used by emitAuditEvent.
CREATE TABLE IF NOT EXISTS audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    before JSONB,
    after JSONB,
    ip TEXT,
    user_agent TEXT,
    correlation_id TEXT,
    ts TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
);

ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS correlation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_events_ts ON audit_events(ts);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events(entity_type, entity_id);

-- audit_w: INSERT and SELECT only — no UPDATE, DELETE, or TRUNCATE.
GRANT INSERT, SELECT ON TABLE audit_events TO ${quoteIdentifier(ROLE_NAMES.audit)};
`);
}

/**
 * Configure the kb_dictionary database for dict_rw.
 *
 * dict_rw receives SELECT, INSERT, UPDATE, DELETE on identity_tokens only.
 * No cross-pool access: app_rw has no CONNECT privilege on kb_dictionary, and
 * dict_rw has no CONNECT privilege on kb_app, kb_audit, or kb_analytics.
 *
 * DATA-D-006: structural isolation enforced at the database layer.
 */
async function configureDictionaryDatabase(dictAdmin: ReturnType<typeof makePool>): Promise<void> {
  await dictAdmin.unsafe(`
CREATE TABLE IF NOT EXISTS identity_tokens (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    token       TEXT NOT NULL UNIQUE,
    real_name   TEXT NOT NULL,
    real_email  TEXT NOT NULL,
    real_org    TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_identity_tokens_token ON identity_tokens(token);
CREATE INDEX IF NOT EXISTS idx_identity_tokens_created_at ON identity_tokens(created_at);
GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(ROLE_NAMES.dictionary)};
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE identity_tokens TO ${quoteIdentifier(ROLE_NAMES.dictionary)};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quoteIdentifier(ROLE_NAMES.dictionary)};
`);
}

async function configureAnalyticsDatabase(
  analyticsAdmin: ReturnType<typeof makePool>,
): Promise<void> {
  await analyticsAdmin.unsafe(`
CREATE TABLE IF NOT EXISTS analytics_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor_id TEXT,
  target_type TEXT,
  target_id TEXT,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_analytics_events_occurred_at ON analytics_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_event_type ON analytics_events (event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_events_target ON analytics_events (target_type, target_id);

CREATE TABLE IF NOT EXISTS audit_replica (
  id BIGSERIAL PRIMARY KEY,
  audit_log_id BIGINT NOT NULL UNIQUE,
  action TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  mirrored_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_replica_mirrored_at ON audit_replica (mirrored_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_replica_action ON audit_replica (action);

GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(ROLE_NAMES.analytics)};
GRANT INSERT, SELECT ON TABLE analytics_events TO ${quoteIdentifier(ROLE_NAMES.analytics)};
GRANT INSERT, SELECT ON TABLE audit_replica TO ${quoteIdentifier(ROLE_NAMES.analytics)};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdentifier(ROLE_NAMES.analytics)};
`);
}

/**
 * Ensure the shared agent_worker base role exists (no LOGIN, no direct grants).
 * All per-type agent roles are members of this group role.
 *
 * Blueprint: WORKER-D-007 (per-agent-type-database-role)
 */
async function ensureAgentBaseRole(admin: ReturnType<typeof makePool>): Promise<void> {
  await admin.unsafe(`
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${AGENT_BASE_ROLE}') THEN
    CREATE ROLE ${quoteIdentifier(AGENT_BASE_ROLE)} NOLOGIN;
  END IF;
END
$$;
`);
}

/**
 * Ensure a per-type agent role exists as a member of agent_worker.
 * The role gets LOGIN with the supplied password so worker pods can authenticate.
 *
 * Blueprint: WORKER-D-007 (per-agent-type-database-role), WORKER-P-008 (agent-type-isolation)
 */
async function ensureAgentTypeRole(
  admin: ReturnType<typeof makePool>,
  agentType: AgentType,
  password: string,
): Promise<void> {
  const roleName = agentRoleName(agentType);
  const escapedPassword = escapeSqlLiteral(password);
  await admin.unsafe(`
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${roleName}') THEN
    CREATE ROLE ${quoteIdentifier(roleName)} WITH LOGIN PASSWORD '${escapedPassword}' IN ROLE ${quoteIdentifier(AGENT_BASE_ROLE)};
  ELSE
    ALTER ROLE ${quoteIdentifier(roleName)} WITH LOGIN PASSWORD '${escapedPassword}';
  END IF;
END
$$;
`);
}

/**
 * Grant each per-type agent role CONNECT on the app database and SELECT on its
 * filtered view. No other grants are issued — write access is structurally absent.
 *
 * Blueprint: WORKER-P-001 (read-only-database-access), TQ-D-004 (per-type-filtered-views)
 */
async function configureAgentWorkerRoles(
  admin: ReturnType<typeof makePool>,
  appAdmin: ReturnType<typeof makePool>,
  config: InitRemoteConfig,
): Promise<void> {
  // Enable RLS on task_queue. app_rw owns the table (migrateAppSchema ran as
  // app_rw); admin is a superuser so it can still enable RLS without being the
  // owner. The statement is idempotent.
  await appAdmin.unsafe(`ALTER TABLE task_queue ENABLE ROW LEVEL SECURITY`);

  for (const agentType of AGENT_TYPES) {
    const roleName = agentRoleName(agentType);
    const viewName = agentViewName(agentType);
    const policyName = `task_queue_${agentType}_read`;

    // CONNECT on the app database
    await admin.unsafe(
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(config.databases.app)} TO ${quoteIdentifier(roleName)}`,
    );

    // USAGE on public schema
    await appAdmin.unsafe(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(roleName)}`);

    // USAGE on public schema + SELECT on the per-type view only.
    // migrate() has already been called above, so the view is guaranteed to exist.
    await appAdmin.unsafe(
      `GRANT SELECT ON ${quoteIdentifier(viewName)} TO ${quoteIdentifier(roleName)}`,
    );

    // RLS policy: role may only SELECT rows where agent_type matches its own type.
    // DROP + CREATE is idempotent.
    // Blueprint: WORKER-D-007 (per-agent-type-database-role), TQ-D-004 (per-type-filtered-views)
    await appAdmin.unsafe(`DROP POLICY IF EXISTS ${quoteIdentifier(policyName)} ON task_queue`);
    await appAdmin.unsafe(`
CREATE POLICY ${quoteIdentifier(policyName)}
  ON task_queue
  FOR SELECT
  TO ${quoteIdentifier(roleName)}
  USING (agent_type = '${escapeSqlLiteral(agentType)}')
`);
  }
}

/**
 * Enable RLS on customer-scoped tables and create (or replace) tenant-isolation
 * policies for each table.
 *
 * entities: uses the `tenant_id` column directly.
 * relations: joins to `entities` on `source_id` to derive the tenant.
 *
 * Both policies are PERMISSIVE FOR ALL. Because each table has FORCE ROW LEVEL
 * SECURITY set (the table owner, app_rw, is forced to obey RLS too), a single
 * PERMISSIVE policy is functionally equivalent to RESTRICTIVE: any row that does
 * not satisfy the USING clause is invisible to all non-superuser roles.
 *
 * Blueprint: DATA blueprint, PRD §7, issue #19.
 */
async function configureCustomerScopedRls(appAdmin: ReturnType<typeof makePool>): Promise<void> {
  // Enable RLS and FORCE RLS on entities
  await appAdmin.unsafe(`ALTER TABLE entities ENABLE ROW LEVEL SECURITY`);
  await appAdmin.unsafe(`ALTER TABLE entities FORCE ROW LEVEL SECURITY`);

  // Tenant-isolation policy on entities
  await appAdmin.unsafe(`DROP POLICY IF EXISTS entities_tenant_isolation ON entities`);
  await appAdmin.unsafe(`
CREATE POLICY entities_tenant_isolation
  ON entities
  FOR ALL
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)
  )
`);

  // Enable RLS and FORCE RLS on relations
  await appAdmin.unsafe(`ALTER TABLE relations ENABLE ROW LEVEL SECURITY`);
  await appAdmin.unsafe(`ALTER TABLE relations FORCE ROW LEVEL SECURITY`);

  // Tenant-isolation policy on relations (derives tenant via source entity)
  await appAdmin.unsafe(`DROP POLICY IF EXISTS relations_tenant_isolation ON relations`);
  await appAdmin.unsafe(`
CREATE POLICY relations_tenant_isolation
  ON relations
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM entities
      WHERE entities.id = source_id
        AND entities.tenant_id = current_setting('app.current_tenant_id', true)
    )
  )
`);
}

async function verifyRole(
  admin: ReturnType<typeof makePool>,
  roleName: string,
): Promise<string | null> {
  const [{ count }] = await admin<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM pg_roles WHERE rolname = ${roleName}
  `;
  return count === 1 ? null : `missing role ${roleName}`;
}

async function verifyDatabase(
  admin: ReturnType<typeof makePool>,
  databaseName: string,
): Promise<string | null> {
  const [{ count }] = await admin<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM pg_database WHERE datname = ${databaseName}
  `;
  return count === 1 ? null : `missing database ${databaseName}`;
}

async function verifyDatabaseConnect(
  admin: ReturnType<typeof makePool>,
  databaseName: string,
  roleName: string,
): Promise<string | null> {
  const [{ allowed }] = await admin<{ allowed: boolean }[]>`
    SELECT has_database_privilege(${roleName}, ${databaseName}, 'CONNECT') AS allowed
  `;
  return allowed ? null : `${roleName} missing CONNECT on ${databaseName}`;
}

async function verifyTable(
  db: ReturnType<typeof makePool>,
  tableName: string,
): Promise<string | null> {
  const [{ count }] = await db<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${tableName}
  `;
  return count === 1 ? null : `missing table ${tableName}`;
}

async function verifyTableGrant(
  db: ReturnType<typeof makePool>,
  tableName: string,
  roleName: string,
  privilegeType: string,
): Promise<string | null> {
  const [{ count }] = await db<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = ${tableName}
      AND grantee = ${roleName}
      AND privilege_type = ${privilegeType}
  `;
  return count >= 1 ? null : `${roleName} missing ${privilegeType} on ${tableName}`;
}

async function _verifyColumnGrant(
  db: ReturnType<typeof makePool>,
  tableName: string,
  columnName: string,
  roleName: string,
  privilegeType: string,
): Promise<string | null> {
  const [{ count }] = await db<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND table_name = ${tableName}
      AND column_name = ${columnName}
      AND grantee = ${roleName}
      AND privilege_type = ${privilegeType}
  `;
  return count >= 1 ? null : `${roleName} missing ${privilegeType} on ${tableName}.${columnName}`;
}

/**
 * Verifies that a privilege is NOT present on a table for a role.
 * Returns an error string if the privilege IS granted (unexpected).
 *
 * Used to assert INSERT-only semantics on business_journal.
 */
async function verifyNoTableGrant(
  db: ReturnType<typeof makePool>,
  tableName: string,
  roleName: string,
  privilegeType: string,
): Promise<string | null> {
  const [{ count }] = await db<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = ${tableName}
      AND grantee = ${roleName}
      AND privilege_type = ${privilegeType}
  `;
  return count === 0 ? null : `${roleName} unexpectedly holds ${privilegeType} on ${tableName}`;
}

async function verifyView(
  db: ReturnType<typeof makePool>,
  viewName: string,
): Promise<string | null> {
  const [{ count }] = await db<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM information_schema.views
    WHERE table_schema = 'public' AND table_name = ${viewName}
  `;
  return count === 1 ? null : `missing view ${viewName}`;
}

async function verifyRlsPolicy(
  db: ReturnType<typeof makePool>,
  tableName: string,
  policyName: string,
): Promise<string | null> {
  const [{ count }] = await db<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = ${tableName}
      AND policyname = ${policyName}
  `;
  return count === 1 ? null : `missing RLS policy ${policyName} on ${tableName}`;
}

async function verifyRlsEnabled(
  db: ReturnType<typeof makePool>,
  tableName: string,
): Promise<string | null> {
  const [{ rowsecurity }] = await db<{ rowsecurity: boolean }[]>`
    SELECT relrowsecurity AS rowsecurity
    FROM pg_class
    WHERE relname = ${tableName}
      AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  `;
  return rowsecurity ? null : `RLS not enabled on ${tableName}`;
}

async function verifyAgentRoles(
  admin: ReturnType<typeof makePool>,
  appAdmin: ReturnType<typeof makePool>,
  config: InitRemoteConfig,
): Promise<string[]> {
  const checks: Array<Promise<string | null>> = [
    verifyRole(admin, AGENT_BASE_ROLE),
    verifyRlsEnabled(appAdmin, 'task_queue'),
  ];

  for (const agentType of AGENT_TYPES) {
    const roleName = agentRoleName(agentType);
    const viewName = agentViewName(agentType);
    checks.push(
      verifyRole(admin, roleName),
      verifyDatabaseConnect(admin, config.databases.app, roleName),
      verifyView(appAdmin, viewName),
      verifyTableGrant(appAdmin, viewName, roleName, 'SELECT'),
      verifyRlsPolicy(appAdmin, 'task_queue', `task_queue_${agentType}_read`),
    );
  }

  const results = await Promise.all(checks);
  return results.filter((v): v is string => v !== null);
}

async function verifyAppSchemaPrivileges(appAdmin: ReturnType<typeof makePool>): Promise<string[]> {
  const [privileges] = await appAdmin<{ usage: boolean; create: boolean }[]>`
    SELECT
      has_schema_privilege(${ROLE_NAMES.app}, 'public', 'USAGE') AS usage,
      has_schema_privilege(${ROLE_NAMES.app}, 'public', 'CREATE') AS create
  `;
  const failures: string[] = [];
  if (!privileges.usage) failures.push(`${ROLE_NAMES.app} missing USAGE on public schema`);
  if (!privileges.create) failures.push(`${ROLE_NAMES.app} missing CREATE on public schema`);
  return failures;
}

async function verifyInitRemote(
  admin: ReturnType<typeof makePool>,
  appAdmin: ReturnType<typeof makePool>,
  auditAdmin: ReturnType<typeof makePool>,
  analyticsAdmin: ReturnType<typeof makePool>,
  dictAdmin: ReturnType<typeof makePool>,
  config: InitRemoteConfig,
): Promise<void> {
  const checks = await Promise.all([
    verifyRole(admin, ROLE_NAMES.app),
    verifyRole(admin, ROLE_NAMES.audit),
    verifyRole(admin, ROLE_NAMES.analytics),
    verifyRole(admin, ROLE_NAMES.dictionary),
    verifyDatabase(admin, config.databases.app),
    verifyDatabase(admin, config.databases.audit),
    verifyDatabase(admin, config.databases.analytics),
    verifyDatabase(admin, config.databases.dictionary),
    verifyDatabaseConnect(admin, config.databases.app, ROLE_NAMES.app),
    verifyDatabaseConnect(admin, config.databases.audit, ROLE_NAMES.audit),
    verifyDatabaseConnect(admin, config.databases.analytics, ROLE_NAMES.analytics),
    verifyDatabaseConnect(admin, config.databases.dictionary, ROLE_NAMES.dictionary),
    verifyTable(auditAdmin, 'audit_events'),
    verifyTable(analyticsAdmin, 'analytics_events'),
    verifyTable(analyticsAdmin, 'audit_replica'),
    verifyTable(dictAdmin, 'identity_tokens'),
    verifyTableGrant(auditAdmin, 'audit_events', ROLE_NAMES.audit, 'INSERT'),
    verifyTableGrant(auditAdmin, 'audit_events', ROLE_NAMES.audit, 'SELECT'),
    verifyTable(appAdmin, 'business_journal'),
    verifyTableGrant(appAdmin, 'business_journal', ROLE_NAMES.app, 'INSERT'),
    verifyTableGrant(appAdmin, 'business_journal', ROLE_NAMES.app, 'SELECT'),
    verifyNoTableGrant(appAdmin, 'business_journal', ROLE_NAMES.app, 'UPDATE'),
    verifyNoTableGrant(appAdmin, 'business_journal', ROLE_NAMES.app, 'DELETE'),
    verifyTableGrant(analyticsAdmin, 'analytics_events', ROLE_NAMES.analytics, 'INSERT'),
    verifyTableGrant(analyticsAdmin, 'analytics_events', ROLE_NAMES.analytics, 'SELECT'),
    verifyTableGrant(analyticsAdmin, 'audit_replica', ROLE_NAMES.analytics, 'INSERT'),
    verifyTableGrant(analyticsAdmin, 'audit_replica', ROLE_NAMES.analytics, 'SELECT'),
    verifyTableGrant(dictAdmin, 'identity_tokens', ROLE_NAMES.dictionary, 'INSERT'),
    verifyTableGrant(dictAdmin, 'identity_tokens', ROLE_NAMES.dictionary, 'SELECT'),
    verifyTableGrant(dictAdmin, 'identity_tokens', ROLE_NAMES.dictionary, 'UPDATE'),
    verifyTableGrant(dictAdmin, 'identity_tokens', ROLE_NAMES.dictionary, 'DELETE'),
  ]);

  const failures = checks.filter((value): value is string => value !== null);
  failures.push(...(await verifyAppSchemaPrivileges(appAdmin)));
  failures.push(...(await verifyAgentRoles(admin, appAdmin, config)));

  // Verify customer-scoped RLS (issue #19)
  for (const table of CUSTOMER_SCOPED_TABLES) {
    const rlsCheck = await verifyRlsEnabled(appAdmin, table);
    if (rlsCheck !== null) failures.push(rlsCheck);
    const policyCheck = await verifyRlsPolicy(appAdmin, table, `${table}_tenant_isolation`);
    if (policyCheck !== null) failures.push(policyCheck);
  }

  if (failures.length > 0) {
    throw new Error(`Genesis verification failed:\n- ${failures.join('\n- ')}`);
  }
}

/**
 * Apply the app database schema (schema.sql) using the provided pool.
 * Mirrors the migrate() function in packages/db/index.ts but avoids importing
 * that module (which creates postgres pools at module-load time with env-var URLs
 * that are not available in the db-init container).
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inDollarQuote = false;
  let i = 0;

  while (i < sql.length) {
    if (sql[i] === '$' && sql[i + 1] === '$') {
      inDollarQuote = !inDollarQuote;
      current += '$$';
      i += 2;
      continue;
    }
    if (!inDollarQuote && sql[i] === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = '';
      i += 1;
      continue;
    }
    current += sql[i];
    i += 1;
  }
  const trailing = current.trim();
  if (trailing.length > 0) {
    statements.push(trailing);
  }
  return statements;
}

async function migrateAppSchema(pool: ReturnType<typeof makePool>): Promise<void> {
  console.log('[init-remote] Applying app database schema...');
  const schemaSql = readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf-8');
  const cleanSql = schemaSql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const statements = splitSqlStatements(cleanSql).filter((s) => s.length > 0);
  for (const statement of statements) {
    await pool.unsafe(statement);
  }
  console.log('[init-remote] App schema applied.');
}

export async function runInitRemote(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadInitRemoteConfig(env);
  const admin = makePool(config.adminDatabaseUrl);
  let appAdmin: ReturnType<typeof makePool> | undefined;
  let auditAdmin: ReturnType<typeof makePool> | undefined;
  let analyticsAdmin: ReturnType<typeof makePool> | undefined;
  let dictAdmin: ReturnType<typeof makePool> | undefined;

  try {
    await ensureRole(admin, ROLE_NAMES.app, config.passwords.app);
    await ensureRole(admin, ROLE_NAMES.audit, config.passwords.audit);
    await ensureRole(admin, ROLE_NAMES.analytics, config.passwords.analytics);
    await ensureRole(admin, ROLE_NAMES.dictionary, config.passwords.dictionary);

    await ensureDatabase(admin, config.databases.app);
    await ensureDatabase(admin, config.databases.audit);
    await ensureDatabase(admin, config.databases.analytics);
    await ensureDatabase(admin, config.databases.dictionary);

    await grantConnect(admin, config.databases.app, ROLE_NAMES.app);
    await grantConnect(admin, config.databases.audit, ROLE_NAMES.audit);
    await grantConnect(admin, config.databases.analytics, ROLE_NAMES.analytics);
    await grantConnect(admin, config.databases.dictionary, ROLE_NAMES.dictionary);

    appAdmin = makePool(dbUrl(config.adminDatabaseUrl, config.databases.app));
    auditAdmin = makePool(dbUrl(config.adminDatabaseUrl, config.databases.audit));
    analyticsAdmin = makePool(dbUrl(config.adminDatabaseUrl, config.databases.analytics));
    dictAdmin = makePool(dbUrl(config.adminDatabaseUrl, config.databases.dictionary));

    await configureAppDatabase(appAdmin);
    await configureAuditDatabase(auditAdmin);
    await configureAnalyticsDatabase(analyticsAdmin);
    await configureDictionaryDatabase(dictAdmin);

    // Apply the app database schema using the app_rw role so that app_rw owns
    // the resulting tables. This is idempotent (CREATE TABLE IF NOT EXISTS) and
    // ensures that the later migrate() call run by the server process (also as
    // app_rw) can create indexes and triggers on its own tables without an
    // ownership error.
    const appRwUrl = (() => {
      const u = new URL(config.adminDatabaseUrl);
      u.username = ROLE_NAMES.app;
      u.password = config.passwords.app;
      u.pathname = `/${config.databases.app}`;
      return u.toString();
    })();
    const appRw = makePool(appRwUrl);
    try {
      await migrateAppSchema(appRw);
    } finally {
      await appRw.end({ timeout: 5 });
    }

    // Enforce INSERT-only on business_journal for app_rw.
    // configureAppDatabase grants SELECT/INSERT/UPDATE/DELETE on all tables.
    // We revoke UPDATE and DELETE here so that business_journal is append-only.
    // DATA-D-004, DATA-C-026/027: the business journal must be immutable after insert.
    await appAdmin!.unsafe(`
REVOKE UPDATE, DELETE ON TABLE business_journal FROM ${quoteIdentifier(ROLE_NAMES.app)};
`);

    // Provision agent_worker base role and per-type agent roles
    await ensureAgentBaseRole(admin);
    for (const agentType of AGENT_TYPES) {
      await ensureAgentTypeRole(admin, agentType, config.passwords.agents[agentType]);
    }
    await configureAgentWorkerRoles(admin, appAdmin, config);
    await configureCustomerScopedRls(appAdmin);

    await verifyInitRemote(admin, appAdmin, auditAdmin, analyticsAdmin, dictAdmin, config);

    console.log('Genesis database initialisation completed successfully.');
  } finally {
    await Promise.all([
      dictAdmin?.end({ timeout: 5 }),
      analyticsAdmin?.end({ timeout: 5 }),
      auditAdmin?.end({ timeout: 5 }),
      appAdmin?.end({ timeout: 5 }),
      admin.end({ timeout: 5 }),
    ]);
  }
}

if (import.meta.main) {
  runInitRemote().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
