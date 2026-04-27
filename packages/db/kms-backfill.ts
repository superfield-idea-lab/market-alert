/**
 * @file kms-backfill.ts
 *
 * Idempotent KMS backfill utility for legacy plaintext records.
 *
 * ## Purpose
 *
 * Finance-kb stores entity properties in a JSONB column (`entities.properties`).
 * Sensitive fields are encrypted in place using AES-256-GCM via
 * `packages/core/encryption.ts`.  Rows ingested before encryption was enabled
 * may carry plaintext values.  This utility backfills those rows.
 *
 * ## Idempotency
 *
 * A row is considered already-encrypted when every sensitive field it carries
 * starts with `enc:v1:`.  Such rows are skipped unconditionally.  Rerunning
 * the backfill against a fully-migrated database is safe and produces no
 * UPDATEs.
 *
 * ## Scope (v1)
 *
 * Eligible entity types are determined by `SENSITIVE_FIELDS` from
 * `packages/core/encryption.ts`.  Only entity types that declare at least one
 * sensitive field are candidates for backfill.
 *
 * ## Usage
 *
 * ### Library
 * ```ts
 * import { backfillEntities } from 'db/kms-backfill';
 * const result = await backfillEntities(sql, { batchSize: 200 });
 * console.log(result);
 * ```
 *
 * ### CLI (run from repo root)
 * ```bash
 * ENCRYPTION_MASTER_KEY=<hex64> DATABASE_URL=<pg-url> \
 *   bun run packages/db/kms-backfill.ts
 * ```
 *
 * ## Environment variables
 *
 * | Variable              | Required | Description                                      |
 * | --------------------- | -------- | ------------------------------------------------- |
 * | `ENCRYPTION_MASTER_KEY` | Yes    | 64-char hex (or base64) AES-256 master key        |
 * | `DATABASE_URL`        | Yes      | PostgreSQL connection URL for the app database    |
 * | `KMS_BACKFILL_BATCH`  | No       | Rows per batch (default: 100)                     |
 * | `KMS_BACKFILL_DRY_RUN` | No      | Set to `true` to log without writing              |
 *
 * ## Security notes
 *
 * - Connect as an admin/superuser role, not `app_rw`, to bypass RLS.
 * - The utility writes back only the `properties` column of matched rows.
 * - No row is touched unless at least one of its sensitive fields is plaintext.
 *
 * Blueprint: DATA blueprint, PRD §7 — encrypt-at-rest requirement.
 * Issue #226 — downstream idempotent KMS backfill utility.
 */

import postgres from 'postgres';
import { encryptField, SENSITIVE_FIELDS } from '../core/encryption';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENC_PREFIX = 'enc:v1:';

/** Entity types that have at least one declared sensitive field. */
export const BACKFILL_ELIGIBLE_ENTITY_TYPES: string[] = Object.entries(SENSITIVE_FIELDS)
  .filter(([, fields]) => fields && fields.length > 0)
  .map(([type]) => type);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackfillOptions {
  /**
   * Number of rows to process per SELECT batch.
   * Default: 100.
   */
  batchSize?: number;
  /**
   * When true, sensitive-field encryption is computed and logged but the
   * UPDATE is not written to the database.
   * Default: false.
   */
  dryRun?: boolean;
  /**
   * Restrict backfill to specific entity types (must be a subset of
   * `BACKFILL_ELIGIBLE_ENTITY_TYPES`).  When absent, all eligible types are
   * processed.
   */
  entityTypes?: string[];
  /**
   * Optional logger.  Defaults to `console.log` / `console.error`.
   */
  logger?: BackfillLogger;
}

export interface BackfillLogger {
  info(msg: string): void;
  error(msg: string): void;
}

export interface BackfillResult {
  /** Total rows examined across all batches. */
  scanned: number;
  /** Rows that had at least one plaintext sensitive field and were updated. */
  updated: number;
  /** Rows skipped because all sensitive fields were already encrypted. */
  skipped: number;
  /** Rows that failed during encryption or update (non-fatal, logged). */
  errors: number;
  /** Whether the run was in dry-run mode (no writes). */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when a field value is already encrypted (carries the enc:v1: prefix).
 */
export function isEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/**
 * Returns true when a row's properties contain at least one plaintext
 * sensitive field for the given entity type.
 */
export function needsBackfill(entityType: string, properties: Record<string, unknown>): boolean {
  const sensitiveKeys = SENSITIVE_FIELDS[entityType as keyof typeof SENSITIVE_FIELDS] ?? [];
  for (const key of sensitiveKeys) {
    const value = properties[key];
    if (typeof value === 'string' && !isEncrypted(value)) {
      return true;
    }
  }
  return false;
}

/**
 * Encrypts all plaintext sensitive fields in `properties` for the given
 * entity type.  Fields that are already encrypted or absent are left
 * unchanged.
 *
 * Returns the updated properties map.  The original map is not mutated.
 */
export async function encryptPlaintextFields(
  entityType: string,
  properties: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sensitiveKeys = SENSITIVE_FIELDS[entityType as keyof typeof SENSITIVE_FIELDS] ?? [];
  const result: Record<string, unknown> = { ...properties };
  for (const key of sensitiveKeys) {
    const value = result[key];
    if (typeof value === 'string' && !isEncrypted(value)) {
      result[key] = await encryptField(entityType, value);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main backfill function
// ---------------------------------------------------------------------------

/**
 * Scan `entities` rows for each eligible entity type and encrypt any
 * plaintext sensitive fields.
 *
 * Pagination is cursor-based (ordered by `id ASC`) to avoid OFFSET
 * performance degradation on large tables.
 *
 * @param sql   - An active postgres.Sql client.  Must have write access to
 *                `entities` (admin/superuser, not `app_rw`).
 * @param opts  - Optional tuning parameters.
 * @returns     A summary of rows scanned, updated, skipped, and errored.
 */
export async function backfillEntities(
  sql: postgres.Sql,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const batchSize = opts.batchSize ?? 100;
  const dryRun = opts.dryRun ?? false;
  const eligibleTypes = opts.entityTypes ?? BACKFILL_ELIGIBLE_ENTITY_TYPES;
  const logger: BackfillLogger = opts.logger ?? {
    info: (m) => console.log(`[kms-backfill] ${m}`),
    error: (m) => console.error(`[kms-backfill] ERROR ${m}`),
  };

  const result: BackfillResult = { scanned: 0, updated: 0, skipped: 0, errors: 0, dryRun };

  logger.info(
    `Starting backfill. eligible_types=${eligibleTypes.join(',')} batch=${batchSize} dry_run=${dryRun}`,
  );

  for (const entityType of eligibleTypes) {
    logger.info(`Processing entity type: ${entityType}`);

    let cursor = '';
    let batchCount = 0;

    while (true) {
      // Cursor-based pagination: fetch rows with id > cursor, ordered by id.
      const rows = await sql<{ id: string; properties: Record<string, unknown> }[]>`
        SELECT id, properties
          FROM entities
         WHERE type = ${entityType}
           AND id > ${cursor}
         ORDER BY id ASC
         LIMIT ${batchSize}
      `;

      if (rows.length === 0) break;

      batchCount++;
      cursor = rows[rows.length - 1].id;
      result.scanned += rows.length;

      for (const row of rows) {
        if (!needsBackfill(entityType, row.properties)) {
          result.skipped++;
          continue;
        }

        try {
          const encrypted = await encryptPlaintextFields(entityType, row.properties);

          if (!dryRun) {
            await sql`
              UPDATE entities
                 SET properties = ${sql.json(encrypted as never)},
                     updated_at = NOW()
               WHERE id = ${row.id}
                 AND type = ${entityType}
            `;
          }

          result.updated++;
          logger.info(
            `${dryRun ? '[DRY-RUN] would update' : 'Updated'} entity id=${row.id} type=${entityType}`,
          );
        } catch (err) {
          result.errors++;
          logger.error(
            `Failed to process entity id=${row.id} type=${entityType}: ${(err as Error).message}`,
          );
        }
      }

      logger.info(
        `Batch ${batchCount} done for type=${entityType}: rows=${rows.length} cursor=${cursor}`,
      );
    }

    logger.info(
      `Finished entity type: ${entityType} (scanned so far: ${result.scanned}, updated: ${result.updated})`,
    );
  }

  logger.info(
    `Backfill complete. scanned=${result.scanned} updated=${result.updated} skipped=${result.skipped} errors=${result.errors}`,
  );

  return result;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * CLI invocation: run when this module is the main script.
 *
 * ```bash
 * ENCRYPTION_MASTER_KEY=<hex64> DATABASE_URL=<url> bun run packages/db/kms-backfill.ts
 * ```
 */
async function main(): Promise<void> {
  const databaseUrl =
    process.env.DATABASE_URL ?? 'postgres://superfield:superfield@localhost:5432/superfield';

  const batchSize = process.env.KMS_BACKFILL_BATCH
    ? parseInt(process.env.KMS_BACKFILL_BATCH, 10)
    : 100;

  const dryRun = process.env.KMS_BACKFILL_DRY_RUN === 'true';

  if (!process.env.ENCRYPTION_MASTER_KEY) {
    console.error('[kms-backfill] ENCRYPTION_MASTER_KEY is required. Aborting.');
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 5, idle_timeout: 20, connect_timeout: 10 });

  try {
    const result = await backfillEntities(sql, { batchSize, dryRun });
    console.log('[kms-backfill] Result:', JSON.stringify(result, null, 2));
    process.exit(result.errors > 0 ? 1 : 0);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Run when invoked directly (Bun or ts-node).
if (
  typeof require !== 'undefined'
    ? require.main === module
    : import.meta.url === `file://${process.argv[1]}`
) {
  main().catch((err) => {
    console.error('[kms-backfill] Fatal:', err);
    process.exit(1);
  });
}
