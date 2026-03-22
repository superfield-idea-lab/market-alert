import postgres from 'postgres';
import { buildSslOptions } from './ssl';

const DEFAULT_DATABASE_NAMES = {
  app: 'calypso_app',
  audit: 'calypso_audit',
  analytics: 'calypso_analytics',
} as const;

const ROLE_NAMES = {
  app: 'app_rw',
  audit: 'audit_w',
  analytics: 'analytics_w',
} as const;

export interface InitRemoteConfig {
  adminDatabaseUrl: string;
  passwords: {
    app: string;
    audit: string;
    analytics: string;
  };
  databases: {
    app: string;
    audit: string;
    analytics: string;
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
  ] as const;

  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    adminDatabaseUrl: env.ADMIN_DATABASE_URL!,
    passwords: {
      app: env.APP_RW_PASSWORD!,
      audit: env.AUDIT_W_PASSWORD!,
      analytics: env.ANALYTICS_W_PASSWORD!,
    },
    databases: {
      app: env.APP_DB || DEFAULT_DATABASE_NAMES.app,
      audit: env.AUDIT_DB || DEFAULT_DATABASE_NAMES.audit,
      analytics: env.ANALYTICS_DB || DEFAULT_DATABASE_NAMES.analytics,
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
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  changes JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_status ON audit_log (status);
GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(ROLE_NAMES.audit)};
GRANT INSERT, SELECT ON TABLE audit_log TO ${quoteIdentifier(ROLE_NAMES.audit)};
GRANT UPDATE(status) ON TABLE audit_log TO ${quoteIdentifier(ROLE_NAMES.audit)};
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

async function verifyColumnGrant(
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
  config: InitRemoteConfig,
): Promise<void> {
  const checks = await Promise.all([
    verifyRole(admin, ROLE_NAMES.app),
    verifyRole(admin, ROLE_NAMES.audit),
    verifyRole(admin, ROLE_NAMES.analytics),
    verifyDatabase(admin, config.databases.app),
    verifyDatabase(admin, config.databases.audit),
    verifyDatabase(admin, config.databases.analytics),
    verifyDatabaseConnect(admin, config.databases.app, ROLE_NAMES.app),
    verifyDatabaseConnect(admin, config.databases.audit, ROLE_NAMES.audit),
    verifyDatabaseConnect(admin, config.databases.analytics, ROLE_NAMES.analytics),
    verifyTable(auditAdmin, 'audit_log'),
    verifyTable(analyticsAdmin, 'analytics_events'),
    verifyTable(analyticsAdmin, 'audit_replica'),
    verifyTableGrant(auditAdmin, 'audit_log', ROLE_NAMES.audit, 'INSERT'),
    verifyTableGrant(auditAdmin, 'audit_log', ROLE_NAMES.audit, 'SELECT'),
    verifyColumnGrant(auditAdmin, 'audit_log', 'status', ROLE_NAMES.audit, 'UPDATE'),
    verifyTableGrant(analyticsAdmin, 'analytics_events', ROLE_NAMES.analytics, 'INSERT'),
    verifyTableGrant(analyticsAdmin, 'analytics_events', ROLE_NAMES.analytics, 'SELECT'),
    verifyTableGrant(analyticsAdmin, 'audit_replica', ROLE_NAMES.analytics, 'INSERT'),
    verifyTableGrant(analyticsAdmin, 'audit_replica', ROLE_NAMES.analytics, 'SELECT'),
  ]);

  const failures = checks.filter((value): value is string => value !== null);
  failures.push(...(await verifyAppSchemaPrivileges(appAdmin)));

  if (failures.length > 0) {
    throw new Error(`Genesis verification failed:\n- ${failures.join('\n- ')}`);
  }
}

export async function runInitRemote(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadInitRemoteConfig(env);
  const admin = makePool(config.adminDatabaseUrl);
  let appAdmin: ReturnType<typeof makePool> | undefined;
  let auditAdmin: ReturnType<typeof makePool> | undefined;
  let analyticsAdmin: ReturnType<typeof makePool> | undefined;

  try {
    await ensureRole(admin, ROLE_NAMES.app, config.passwords.app);
    await ensureRole(admin, ROLE_NAMES.audit, config.passwords.audit);
    await ensureRole(admin, ROLE_NAMES.analytics, config.passwords.analytics);

    await ensureDatabase(admin, config.databases.app);
    await ensureDatabase(admin, config.databases.audit);
    await ensureDatabase(admin, config.databases.analytics);

    await grantConnect(admin, config.databases.app, ROLE_NAMES.app);
    await grantConnect(admin, config.databases.audit, ROLE_NAMES.audit);
    await grantConnect(admin, config.databases.analytics, ROLE_NAMES.analytics);

    appAdmin = makePool(dbUrl(config.adminDatabaseUrl, config.databases.app));
    auditAdmin = makePool(dbUrl(config.adminDatabaseUrl, config.databases.audit));
    analyticsAdmin = makePool(dbUrl(config.adminDatabaseUrl, config.databases.analytics));

    await configureAppDatabase(appAdmin);
    await configureAuditDatabase(auditAdmin);
    await configureAnalyticsDatabase(analyticsAdmin);
    await verifyInitRemote(admin, appAdmin, auditAdmin, analyticsAdmin, config);

    console.log('Genesis database initialisation completed successfully.');
  } finally {
    await Promise.all([
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
