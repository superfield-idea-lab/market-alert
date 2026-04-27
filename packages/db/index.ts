import postgres from 'postgres';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { buildSslOptions } from './ssl';

export { buildSslOptions } from './ssl';

const DEFAULT_DATABASE_URLS = {
  app: 'postgres://app_rw:app_rw_password@localhost:5432/superfield_app',
  audit: 'postgres://audit_w:audit_w_password@localhost:5432/superfield_audit',
  analytics: 'postgres://analytics_w:analytics_w_password@localhost:5432/superfield_analytics',
  dictionary: 'postgres://dict_rw:dict_rw_password@localhost:5432/superfield_dictionary',
} as const;

export interface DatabaseUrls {
  app: string;
  audit: string;
  analytics: string;
  /** IdentityDictionary service pool — read/write on kb_dictionary only. */
  dictionary: string;
}

/**
 * Disjoint key domain identifiers for each connection pool.
 * Each pool's encrypted columns reference a distinct KMS key domain.
 * Backing KMS key material is provisioned separately (Phase 2 KMS abstraction).
 *
 * DATA-D-006: structural separation of encryption key domains across tiers.
 */
export const KEY_DOMAINS = {
  app: ['auth-key', 'crm-key', 'corpus-key'],
  audit: ['audit-key'],
  analytics: [],
  dictionary: ['identity-key'],
} as const;

function maskDbUrl(dbUrl: string): string {
  return dbUrl.replace(/:[^:@]+@/, ':***@');
}

export function resolveDatabaseUrls(env: NodeJS.ProcessEnv = process.env): DatabaseUrls {
  return {
    app: env.DATABASE_URL || DEFAULT_DATABASE_URLS.app,
    audit: env.AUDIT_DATABASE_URL || DEFAULT_DATABASE_URLS.audit,
    analytics: env.ANALYTICS_DATABASE_URL || DEFAULT_DATABASE_URLS.analytics,
    dictionary: env.DICTIONARY_DATABASE_URL || DEFAULT_DATABASE_URLS.dictionary,
  };
}

function createPool(databaseUrl: string, max: number) {
  console.log(`[db] Binding to PostgreSQL at: ${maskDbUrl(databaseUrl)}`);
  return postgres(databaseUrl, {
    max,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: buildSslOptions(),
    connection: { client_min_messages: 'warning' },
  });
}

const databaseUrls = resolveDatabaseUrls();

export const sql = createPool(databaseUrls.app, 20);
export const auditSql = createPool(databaseUrls.audit, 5);
export const analyticsSql = createPool(databaseUrls.analytics, 5);
/**
 * Dictionary pool — bound to the IdentityDictionary service database.
 * Only the IdentityDictionary module should import this pool directly.
 * All other modules must not hold a reference to dictionarySql.
 *
 * Role: dict_rw — read/write on kb_dictionary only.
 * Cross-pool access from app_rw is structurally denied at the database layer.
 */
export const dictionarySql = createPool(databaseUrls.dictionary, 5);

export interface MigrateOptions {
  databaseUrl?: string;
}

export interface MigrateAuditOptions {
  databaseUrl?: string;
}

export interface MigrateDictionaryOptions {
  databaseUrl?: string;
}

export function resolveSchemaSqlPath(
  moduleUrl: string = import.meta.url,
  cwd: string = process.cwd(),
): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    resolve(moduleDir, 'schema.sql'),
    resolve(moduleDir, '../packages/db/schema.sql'),
    resolve(cwd, 'packages/db/schema.sql'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

/**
 * Split a SQL string into individual statements on top-level semicolons,
 * respecting dollar-quoted blocks ($$...$$) so PL/pgSQL function bodies
 * that contain semicolons are never split mid-body.
 *
 * This is intentionally minimal: it handles the common `$$` tag only.
 * Named dollar tags (e.g. $body$) are not needed for our schema.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inDollarQuote = false;
  let i = 0;

  while (i < sql.length) {
    // Check for $$ delimiter
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

/**
 * Initializes the database tables by executing the native raw SQL schema.
 * This function should be called at server startup to ensure tables exist.
 *
 * Policy note:
 * This is a starter bootstrap migration path, not the final enterprise data
 * posture. Future work should separate graph schema setup from ledger / journal
 * migrations, audit-store setup, and digital-twin checkpoint infrastructure.
 */
export async function migrate(options: MigrateOptions = {}) {
  console.log('[db] Initializing PostgreSQL database schema...');
  const schemaSql = readFileSync(resolveSchemaSqlPath(), 'utf-8');
  const databaseUrl = options.databaseUrl ?? databaseUrls.app;
  const migrationSql =
    options.databaseUrl === undefined
      ? sql
      : postgres(databaseUrl, {
          max: 1,
          idle_timeout: 10,
          connect_timeout: 10,
          connection: { client_min_messages: 'warning' },
        });

  try {
    // Remove single-line and block comments, then split by top-level semicolons.
    // Dollar-quoted blocks ($$...$$) are preserved intact so PL/pgSQL function
    // bodies are not split mid-body.
    const cleanSql = schemaSql
      .replace(/--.*$/gm, '') // Remove single-line comments
      .replace(/\/\*[\s\S]*?\*\//g, ''); // Remove multi-line comments

    const statements = splitSqlStatements(cleanSql).filter((s) => s.length > 0);

    // Execute sequentially
    for (const statement of statements) {
      await migrationSql.unsafe(statement);
    }
    console.log('[db] Schema migration complete.');
  } catch (err) {
    console.error('[db] Schema migration failed:', err);
    throw err;
  } finally {
    if (migrationSql !== sql) {
      await migrationSql.end({ timeout: 5 });
    }
  }
}

export function resolveDictionarySchemaSqlPath(
  moduleUrl: string = import.meta.url,
  cwd: string = process.cwd(),
): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    resolve(moduleDir, 'dictionary-schema.sql'),
    resolve(moduleDir, '../packages/db/dictionary-schema.sql'),
    resolve(cwd, 'packages/db/dictionary-schema.sql'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

/**
 * Verifies connectivity to the audit database at server startup.
 *
 * The audit schema (audit_log table, indexes, grants) is created by
 * init-remote.ts running as a database admin at deploy time. Attempting to
 * re-run that DDL here as audit_w fails on PG 15+ because audit_w only holds
 * USAGE on the public schema, not CREATE. This function replaces the old
 * DDL-executing migration with a lightweight SELECT 1 connectivity probe so
 * that server startup succeeds and emitAuditEvent works on the first request.
 */
export async function migrateAudit(options: MigrateAuditOptions = {}) {
  console.log('[db] Verifying audit database connectivity...');
  const databaseUrl = options.databaseUrl ?? databaseUrls.audit;
  const connectSql =
    options.databaseUrl === undefined
      ? auditSql
      : postgres(databaseUrl, {
          max: 1,
          idle_timeout: 10,
          connect_timeout: 10,
          connection: { client_min_messages: 'warning' },
        });

  try {
    await connectSql`SELECT 1`;
    console.log('[db] Audit database connectivity verified.');
  } catch (err) {
    console.error('[db] Audit database connectivity check failed:', err);
    throw err;
  } finally {
    if (connectSql !== auditSql) {
      await connectSql.end({ timeout: 5 });
    }
  }
}

/**
 * Verifies connectivity to the dictionary database at server startup.
 *
 * The dictionary schema is created by init-remote.ts at deploy time.
 * This function performs a lightweight connectivity probe only — the dict_rw
 * role holds no DDL privileges.
 *
 * DATA-D-006: dict_rw is structurally isolated to kb_dictionary; no cross-pool
 * access from app_rw is possible.
 */
export async function migrateDictionary(options: MigrateDictionaryOptions = {}) {
  console.log('[db] Verifying dictionary database connectivity...');
  const databaseUrl = options.databaseUrl ?? databaseUrls.dictionary;
  const connectSql =
    options.databaseUrl === undefined
      ? dictionarySql
      : postgres(databaseUrl, {
          max: 1,
          idle_timeout: 10,
          connect_timeout: 10,
          connection: { client_min_messages: 'warning' },
        });

  try {
    await connectSql`SELECT 1`;
    console.log('[db] Dictionary database connectivity verified.');
  } catch (err) {
    console.error('[db] Dictionary database connectivity check failed:', err);
    throw err;
  } finally {
    if (connectSql !== dictionarySql) {
      await connectSql.end({ timeout: 5 });
    }
  }
}
