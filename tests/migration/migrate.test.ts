import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrate } from '../../packages/db';
import { startPostgres, type PgContainer } from '../../packages/db/pg-container';

/**
 * Expected public tables and views after applying the baseline migration.
 * _schema_version is included because the baseline migration creates it and
 * inserts the 'baseline-001' row (ENV-C-016).
 */
const EXPECTED_TABLES = [
  '_schema_version',
  'api_keys',
  'entities',
  'entity_types',
  'passkey_challenges',
  'passkey_credentials',
  'relations',
  'revoked_tokens',
  'task_queue',
  'task_queue_view_analysis',
  // Phase 0 scout: worker-phase views (issue #5, TQ-D-001)
  'task_queue_view_annotation',
  'task_queue_view_autolearn',
  'task_queue_view_bdm_summary',
  'task_queue_view_code_cleanup',
  'task_queue_view_coding',
  'task_queue_view_deepclean',
  'task_queue_view_email_ingest',
  'task_queue_view_transcription',
  'worker_credentials',
] as const;

let pg: PgContainer;

beforeAll(async () => {
  pg = await startPostgres();
}, 60_000);

afterAll(async () => {
  await pg?.stop();
});

test('migrate() creates the expected tables and records baseline-001 in _schema_version', async () => {
  await migrate({ databaseUrl: pg.url });

  const tables = new Set(listPublicTables(pg.containerId));
  expect(tables).toEqual(new Set(EXPECTED_TABLES));

  const rows = querySchemaVersion(pg.containerId);
  expect(rows).toEqual(['baseline-001']);
});

test('migrate() is idempotent — running twice produces one _schema_version row', async () => {
  // pg is still running from the previous test; schema already applied
  await expect(migrate({ databaseUrl: pg.url })).resolves.toBeUndefined();

  const rows = querySchemaVersion(pg.containerId);
  expect(rows).toEqual(['baseline-001']);
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function listPublicTables(containerId: string): string[] {
  const query = [
    'SELECT table_name',
    'FROM information_schema.tables',
    "WHERE table_schema = 'public'",
    'ORDER BY table_name',
  ].join(' ');
  const proc = Bun.spawnSync([
    'docker',
    'exec',
    containerId,
    'psql',
    '-U',
    'calypso',
    '-d',
    'calypso',
    '-At',
    '-c',
    query,
  ]);

  expect(proc.exitCode).toBe(0);

  return new TextDecoder()
    .decode(proc.stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Returns the list of migration names recorded in _schema_version,
 * ordered alphabetically so assertions are deterministic.
 */
function querySchemaVersion(containerId: string): string[] {
  const query = 'SELECT migration FROM _schema_version ORDER BY migration';
  const proc = Bun.spawnSync([
    'docker',
    'exec',
    containerId,
    'psql',
    '-U',
    'calypso',
    '-d',
    'calypso',
    '-At',
    '-c',
    query,
  ]);

  expect(proc.exitCode).toBe(0);

  return new TextDecoder()
    .decode(proc.stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
