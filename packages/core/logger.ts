/**
 * Dual-file JSON-lines logger.
 *
 * Two parallel outputs are maintained:
 *   logs/app.log     — complete chronological record, every event in order
 *   logs/uniques.log — each distinct message template written only on first occurrence
 *
 * Every log entry is a JSON line: { ts, level, trace_id, message, ...context }.
 *
 * Deduplication key: `level + message_template` where dynamic values (UUIDs,
 * integers, hex strings, ISO timestamps) are normalised away from the message
 * so that logically identical messages collapse to a single entry.
 *
 * Both files are rotated daily on startup: the existing file is renamed to
 * `<name>.YYYY-MM-DD.log`. Rotated files older than 30 days are deleted.
 *
 * Server-only: uses Bun/Node file-system APIs and is never imported by the
 * browser bundle.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogContext {
  trace_id?: string;
  [key: string]: unknown;
}

export interface LogEntry {
  ts: string;
  level: LogLevel;
  message: string;
  trace_id: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Set of deduplication keys seen in this process lifetime. */
const _seen = new Set<string>();

/** Absolute path to the logs directory. Resolved once at module load. */
let _logsDir: string = resolveLogsDir();

/** Cached absolute paths to the two log files. */
let _appLog: string = join(_logsDir, 'app.log');
let _uniquesLog: string = join(_logsDir, 'uniques.log');

/** Whether startup rotation has been performed in this process. */
let _rotated = false;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Returns the path to the `logs/` directory.
 *
 * Resolution order:
 *   1. `LOG_DIR` environment variable (absolute or relative to cwd)
 *   2. `<process.cwd()>/logs`
 *
 * In test environments set `LOG_DIR` to a tmp path so tests do not write to
 * the project root.
 */
function resolveLogsDir(): string {
  const env = process.env.LOG_DIR;
  if (env) {
    return env.startsWith('/') ? env : join(process.cwd(), env);
  }
  return join(process.cwd(), 'logs');
}

// ---------------------------------------------------------------------------
// Startup rotation
// ---------------------------------------------------------------------------

/**
 * Rotates `app.log` and `uniques.log` if they exist:
 *   - Renames each to `<base>.YYYY-MM-DD.log` (today's date in UTC)
 *   - Deletes rotated files older than 30 days
 *
 * Called once on first log write in the process lifetime.
 */
export function rotateLogs(logsDir: string = _logsDir): void {
  ensureLogsDir(logsDir);

  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

  for (const base of ['app', 'uniques']) {
    const current = join(logsDir, `${base}.log`);
    if (existsSync(current)) {
      const rotated = join(logsDir, `${base}.${today}.log`);
      renameSync(current, rotated);
    }
  }

  pruneOldLogs(logsDir, 30);
}

/**
 * Deletes rotated log files older than `maxDays` days.
 * Matches files named `<base>.YYYY-MM-DD.log`.
 */
function pruneOldLogs(logsDir: string, maxDays: number): void {
  const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
  const rotatedRe = /^(?:app|uniques)\.\d{4}-\d{2}-\d{2}\.log$/;

  let entries: string[];
  try {
    entries = readdirSync(logsDir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (!rotatedRe.test(name)) continue;
    // Extract date from filename: app.YYYY-MM-DD.log → YYYY-MM-DD
    const datePart = name.slice(name.indexOf('.') + 1, name.lastIndexOf('.'));
    const fileDate = new Date(datePart).getTime();
    if (!isNaN(fileDate) && fileDate < cutoff) {
      try {
        unlinkSync(join(logsDir, name));
      } catch {
        // best-effort
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Normalises dynamic tokens out of a log message to produce a stable template.
 *
 * Replaced patterns (in order):
 *   - ISO 8601 timestamps
 *   - UUID v4 strings
 *   - Hexadecimal strings of 8+ characters
 *   - Integers (standalone numbers)
 */
export function templateMessage(message: string): string {
  return message
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<ts>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\b\d+\b/g, '<n>');
}

/**
 * Returns the deduplication key for a log entry: `level:template`.
 */
function dedupKey(level: LogLevel, message: string): string {
  return `${level}:${templateMessage(message)}`;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function ensureLogsDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function writeLine(filePath: string, line: string): void {
  try {
    appendFileSync(filePath, line + '\n', 'utf8');
  } catch {
    // Silently ignore file I/O errors so logging never crashes the server.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reconfigures the logger to write to a different directory.
 * Intended for test isolation — call before the first `log()` in a test suite.
 */
export function configureLogger(logsDir: string): void {
  _logsDir = logsDir;
  _appLog = join(logsDir, 'app.log');
  _uniquesLog = join(logsDir, 'uniques.log');
  _rotated = false;
  _seen.clear();
}

/**
 * Resets the deduplication state only (keeps the log directory config).
 * Useful for test suites that want to start each test with a clean slate.
 */
export function resetDeduplication(): void {
  _seen.clear();
}

/**
 * Writes a structured JSON-lines log entry.
 *
 * Always appends to `logs/app.log`.
 * Appends to `logs/uniques.log` only if the `level + message_template` key
 * has not been seen in this process lifetime.
 *
 * On the first call in a process, log rotation is performed automatically.
 *
 * @param level   - Severity level
 * @param message - Human-readable message (dynamic values are normalised for dedup)
 * @param context - Additional structured fields; `trace_id` is extracted if present
 */
export function log(level: LogLevel, message: string, context: LogContext = {}): void {
  // Perform startup rotation once per process.
  if (!_rotated) {
    _rotated = true;
    rotateLogs(_logsDir);
  }

  ensureLogsDir(_logsDir);

  const { trace_id = '', ...rest } = context;

  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    message,
    trace_id,
    ...rest,
  };

  const line = JSON.stringify(entry);

  // Always write to app.log
  writeLine(_appLog, line);

  // Write to uniques.log only on first occurrence of this dedup key
  const key = dedupKey(level, message);
  if (!_seen.has(key)) {
    _seen.add(key);
    writeLine(_uniquesLog, line);
  }
}
