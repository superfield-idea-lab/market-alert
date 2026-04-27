/**
 * @file backup
 * Encrypted Postgres backup and restore helpers.
 *
 * ## Design
 *
 * A backup artifact is a pg_dump custom-format file encrypted with AES-256-GCM
 * using a one-time data key. The data key is itself encrypted under the active
 * KMS backend (envelope encryption) and stored in a JSON sidecar file alongside
 * the ciphertext dump.
 *
 * Artifact layout on disk (or in the configured store):
 *   <backup-id>.dump.enc   — AES-256-GCM encrypted pg_dump output
 *   <backup-id>.meta.json  — JSON sidecar: timestamp, databases, encrypted DEK
 *
 * ## Encryption model
 *
 * 1. A fresh 32-byte data key is generated via `kmsGenerateDataKey`.
 * 2. pg_dump output is encrypted with AES-256-GCM before writing to disk.
 * 3. The KMS-encrypted form of the DEK (encryptedKey) is embedded in the sidecar.
 * 4. On restore, the sidecar is read, the DEK is recovered via `kmsDecryptDataKey`,
 *    and the .enc file is decrypted into a temporary cleartext dump for pg_restore.
 *
 * ## pg_dump version compatibility
 *
 * pg_dump must match the server major version. This module resolves the correct
 * pg_dump binary by:
 *   1. Querying the target server's major version via a postgres connection.
 *   2. Checking whether the local pg_dump major version matches.
 *   3. If not, running pg_dump inside a matching postgres:<major> Docker image
 *      with `--network=host` so it can reach the test/staging container port.
 *
 * ## Environment variables
 *
 *   BACKUP_STORE_DIR   — Local directory for backup artifacts (default: /var/backups/superfield)
 *   ENCRYPTION_MASTER_KEY — Required for local-dev KMS backend; omit to disable encryption
 *   DATABASE_URL       — App database (default: pg-container URL when running in tests)
 *   AUDIT_DATABASE_URL — Audit database (default: same as DATABASE_URL)
 *
 * Blueprint: DATA blueprint, PRD §7 — backup cadence and encrypt-at-rest requirement.
 * Issue #91 — encrypted Postgres backup and tested restore runbook.
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import postgres from 'postgres';
import { kmsGenerateDataKey, kmsDecryptDataKey } from '../core/kms';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackupConfig {
  /** Directory where backup artifacts are written. */
  storeDir: string;
  /**
   * Admin (superuser) connection URL for the application database.
   * Must bypass RLS — do not use the application role (`app_rw`) here.
   */
  appDatabaseUrl: string;
  /**
   * Admin (superuser) connection URL for the audit database.
   * Must bypass RLS — do not use the application role here.
   */
  auditDatabaseUrl: string;
}

export interface BackupMeta {
  /** Unique backup identifier (ISO-8601 timestamp slug). */
  backupId: string;
  /** UTC timestamp when the backup was created. */
  createdAt: string;
  /** List of database names included in this backup artifact. */
  databases: string[];
  /** Base64-encoded KMS-encrypted data key for the .dump.enc file. */
  encryptedDek: string | null;
  /** Base64-encoded IV used for AES-256-GCM encryption. Null when unencrypted. */
  iv: string | null;
}

export interface BackupResult {
  backupId: string;
  encFilePath: string;
  metaFilePath: string;
  meta: BackupMeta;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bufferToBase64(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64');
}

function base64ToBuffer(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** Parse a Postgres URL into its components. */
function parseDbUrl(url: string): {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
} {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port || '5432',
    user: u.username,
    password: u.password,
    database: u.pathname.replace(/^\//, ''),
  };
}

/** Return the local pg_dump major version, or 0 if not found. */
function localPgDumpMajorVersion(): number {
  const result = spawnSync('pg_dump', ['--version']);
  if (result.status !== 0) return 0;
  const output = result.stdout?.toString() ?? '';
  // "pg_dump (PostgreSQL) 14.22 ..."
  const m = output.match(/PostgreSQL\)\s+(\d+)\./);
  return m ? parseInt(m[1], 10) : 0;
}

/** Query the server major version via the postgres driver. */
async function serverMajorVersion(url: string): Promise<number> {
  const sql = postgres(url, { max: 1, connect_timeout: 10 });
  try {
    const rows = await sql<{ server_version: string }[]>`SHOW server_version`;
    const ver = rows[0]?.server_version ?? '0';
    // "16.13 (Debian 16.13-1.pgdg13+1)" → 16
    return parseInt(ver.split('.')[0], 10);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Run pg_dump against the given URL, returning raw dump bytes.
 *
 * Uses the local pg_dump binary when its major version matches the server.
 * Otherwise falls back to `docker run postgres:<major>` with --network=host
 * so that ephemeral test containers on random host ports are reachable.
 */
async function runPgDump(url: string): Promise<Buffer> {
  const { host, port, user, password, database } = parseDbUrl(url);
  const serverVer = await serverMajorVersion(url);
  const localVer = localPgDumpMajorVersion();

  const pgDumpArgs = [
    '--format=custom',
    '--no-password',
    '-h',
    host,
    '-p',
    port,
    '-U',
    user,
    database,
  ];

  let result: ReturnType<typeof spawnSync>;

  if (localVer === serverVer) {
    result = spawnSync('pg_dump', pgDumpArgs, {
      env: { ...process.env, PGPASSWORD: password },
      maxBuffer: 512 * 1024 * 1024,
    });
  } else {
    // Use matching pg_dump from Docker image with host networking so ephemeral
    // test containers on random ports are reachable.
    result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--network=host',
        '-e',
        `PGPASSWORD=${password}`,
        `postgres:${serverVer}`,
        'pg_dump',
        ...pgDumpArgs,
      ],
      { maxBuffer: 512 * 1024 * 1024 },
    );
  }

  if (result.status !== 0) {
    const errMsg = result.stderr?.toString() ?? 'unknown error';
    throw new Error(`pg_dump failed: ${errMsg}`);
  }

  return result.stdout as Buffer;
}

/**
 * Run pg_restore from a local dump file against the given target URL.
 *
 * Respects the same version-matching logic as runPgDump.
 */
async function runPgRestore(dumpFile: string, targetUrl: string): Promise<void> {
  const { host, port, user, password, database } = parseDbUrl(targetUrl);
  const serverVer = await serverMajorVersion(targetUrl);
  const localVer = localPgDumpMajorVersion();

  const pgRestoreArgs = [
    '--no-password',
    '--clean',
    '--if-exists',
    '-h',
    host,
    '-p',
    port,
    '-U',
    user,
    '-d',
    database,
  ];

  let result: ReturnType<typeof spawnSync>;

  if (localVer === serverVer) {
    result = spawnSync('pg_restore', [...pgRestoreArgs, dumpFile], {
      env: { ...process.env, PGPASSWORD: password },
    });
  } else {
    // Mount the dump file into the container at /dump.bin.
    result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--network=host',
        '-v',
        `${dumpFile}:/dump.bin:ro`,
        '-e',
        `PGPASSWORD=${password}`,
        `postgres:${serverVer}`,
        'pg_restore',
        ...pgRestoreArgs,
        '/dump.bin',
      ],
      {},
    );
  }

  if (result.status !== 0) {
    const errMsg = result.stderr?.toString() ?? 'unknown error';
    // pg_restore exits non-zero for warnings (e.g. role not found).
    // Only treat as error when stderr contains explicit "error:" lines.
    const hasErrors = errMsg.split('\n').some((l) => l.startsWith('pg_restore: error:'));
    if (hasErrors) {
      throw new Error(`pg_restore failed: ${errMsg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/**
 * Create an encrypted backup of one database and write artifacts to storeDir.
 *
 * `databaseUrl` must be a superuser (or `pg_dump`-privileged) connection URL
 * so that pg_dump can read all rows regardless of RLS policies.
 * The application role (`app_rw`) is subject to RLS and cannot produce a
 * complete backup of customer-scoped tables.
 *
 * Returns BackupResult containing the artifact paths and metadata.
 *
 * When ENCRYPTION_MASTER_KEY is not set the dump is written unencrypted and
 * `meta.encryptedDek` is null (safe for CI without KMS config).
 */
export async function backupDatabase(
  databaseUrl: string,
  storeDir: string,
  label: string,
): Promise<BackupResult> {
  if (!existsSync(storeDir)) {
    mkdirSync(storeDir, { recursive: true });
  }

  const createdAt = new Date().toISOString();
  const slug = createdAt.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const backupId = `${label}_${slug}`;
  const encFilePath = join(storeDir, `${backupId}.dump.enc`);
  const metaFilePath = join(storeDir, `${backupId}.meta.json`);

  const plainBytes = await runPgDump(databaseUrl);
  const { database } = parseDbUrl(databaseUrl);

  let encryptedDek: string | null = null;
  let iv: string | null = null;
  let artifactBytes: Buffer;

  if (process.env.ENCRYPTION_MASTER_KEY) {
    // Envelope encryption: generate a one-time DEK, encrypt the dump bytes.
    const dataKey = await kmsGenerateDataKey({ domain: 'backup', purpose: 'backup-enc' });

    const ivBuf = new ArrayBuffer(12);
    const ivArr = new Uint8Array(ivBuf);
    crypto.getRandomValues(ivArr);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      dataKey.plaintextKey.buffer as ArrayBuffer,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );

    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: ivArr },
      cryptoKey,
      // Ensure we pass a plain ArrayBuffer (not SharedArrayBuffer-backed Buffer).
      plainBytes.buffer.slice(
        plainBytes.byteOffset,
        plainBytes.byteOffset + plainBytes.byteLength,
      ) as ArrayBuffer,
    );

    artifactBytes = Buffer.from(cipherBuf);
    encryptedDek = bufferToBase64(dataKey.encryptedKey);
    iv = bufferToBase64(ivArr);
  } else {
    // No encryption key — write plaintext dump (dev / CI without KMS).
    artifactBytes = plainBytes;
  }

  writeFileSync(encFilePath, artifactBytes);

  const meta: BackupMeta = {
    backupId,
    createdAt,
    databases: [database],
    encryptedDek,
    iv,
  };

  writeFileSync(metaFilePath, JSON.stringify(meta, null, 2));

  return { backupId, encFilePath, metaFilePath, meta };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Restore a database from a backup artifact written by `backupDatabase`.
 *
 * The function:
 *   1. Reads the sidecar metadata.
 *   2. Decrypts the .dump.enc file to a temporary cleartext dump (when encrypted).
 *   3. Runs pg_restore against the target URL.
 *   4. Cleans up the temporary file.
 *
 * The restore is idempotent: pg_restore is invoked with `--clean --if-exists`
 * so re-running against the same target drops and recreates objects without error.
 */
export async function restoreDatabase(
  encFilePath: string,
  metaFilePath: string,
  targetDatabaseUrl: string,
): Promise<void> {
  const meta: BackupMeta = JSON.parse(readFileSync(metaFilePath, 'utf-8'));
  const encBytes = readFileSync(encFilePath);

  let clearDumpPath: string;
  let tempFile = false;

  if (meta.encryptedDek && meta.iv) {
    // Decrypt the dump using the KMS-recovered DEK.
    const encryptedKey = base64ToBuffer(meta.encryptedDek);
    const plaintextKey = await kmsDecryptDataKey(encryptedKey, {
      domain: 'backup',
      purpose: 'backup-enc',
    });

    const ivArr = base64ToBuffer(meta.iv);

    // Ensure we pass plain ArrayBuffers (not SharedArrayBuffer-backed Uint8Arrays).
    const plaintextKeyBuf = plaintextKey.buffer.slice(
      plaintextKey.byteOffset,
      plaintextKey.byteOffset + plaintextKey.byteLength,
    ) as ArrayBuffer;

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      plaintextKeyBuf,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );

    const ivBuf = ivArr.buffer.slice(
      ivArr.byteOffset,
      ivArr.byteOffset + ivArr.byteLength,
    ) as ArrayBuffer;

    const encBytesBuf = encBytes.buffer.slice(
      encBytes.byteOffset,
      encBytes.byteOffset + encBytes.byteLength,
    ) as ArrayBuffer;

    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBuf },
      cryptoKey,
      encBytesBuf,
    );

    clearDumpPath = join(tmpdir(), `${meta.backupId}.dump`);
    writeFileSync(clearDumpPath, Buffer.from(plainBuf));
    tempFile = true;
  } else {
    // Unencrypted backup (dev / CI without KMS).
    clearDumpPath = encFilePath;
  }

  try {
    await runPgRestore(clearDumpPath, targetDatabaseUrl);
  } finally {
    if (tempFile && existsSync(clearDumpPath)) {
      unlinkSync(clearDumpPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Scheduled backup entry point
// ---------------------------------------------------------------------------

/**
 * Run backups for all configured databases.
 *
 * Reads configuration from environment variables:
 *   BACKUP_STORE_DIR      — artifact directory (required)
 *   DATABASE_URL          — app database
 *   AUDIT_DATABASE_URL    — audit database
 *
 * Intended to be invoked by a cron job or a k8s CronJob resource.
 */
export async function runScheduledBackup(config: BackupConfig): Promise<BackupResult[]> {
  const results: BackupResult[] = [];

  const appResult = await backupDatabase(config.appDatabaseUrl, config.storeDir, 'app');
  results.push(appResult);
  console.log(`[backup] app database backup written: ${appResult.encFilePath}`);

  if (config.auditDatabaseUrl !== config.appDatabaseUrl) {
    const auditResult = await backupDatabase(config.auditDatabaseUrl, config.storeDir, 'audit');
    results.push(auditResult);
    console.log(`[backup] audit database backup written: ${auditResult.encFilePath}`);
  }

  return results;
}

/**
 * Load backup config from process.env.
 *
 * Uses ADMIN_DATABASE_URL / ADMIN_AUDIT_DATABASE_URL for the superuser
 * connections required by pg_dump to read all rows regardless of RLS.
 *
 * Falls back to DATABASE_URL / AUDIT_DATABASE_URL when admin URLs are absent
 * (safe for local dev where the single user is already a superuser).
 */
export function loadBackupConfig(env: NodeJS.ProcessEnv = process.env): BackupConfig {
  return {
    storeDir: env.BACKUP_STORE_DIR ?? '/var/backups/superfield',
    appDatabaseUrl:
      env.ADMIN_DATABASE_URL ??
      env.DATABASE_URL ??
      'postgres://app_rw:app_rw_password@localhost:5432/superfield_app',
    auditDatabaseUrl:
      env.ADMIN_AUDIT_DATABASE_URL ??
      env.AUDIT_DATABASE_URL ??
      env.ADMIN_DATABASE_URL ??
      env.DATABASE_URL ??
      'postgres://audit_w:audit_w_password@localhost:5432/superfield_audit',
  };
}
