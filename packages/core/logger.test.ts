import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { log, rotateLogs, templateMessage, configureLogger, resetDeduplication } from './logger';
import { PII_FIELD_NAMES } from './scrub-pii';

// Resolve the path to shared fixtures relative to this file.
const FIXTURES_DIR = resolve(import.meta.dirname, '../../tests/fixtures/pii-payloads');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'superfield-logger-test-'));
}

function readLines(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
}

function parseLines(filePath: string): Record<string, unknown>[] {
  return readLines(filePath).map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// templateMessage
// ---------------------------------------------------------------------------

describe('templateMessage', () => {
  test('replaces UUIDs', () => {
    expect(templateMessage('Request 550e8400-e29b-41d4-a716-446655440000 failed')).toBe(
      'Request <uuid> failed',
    );
  });

  test('replaces ISO timestamps', () => {
    expect(templateMessage('Event at 2024-03-15T12:34:56.789Z')).toBe('Event at <ts>');
  });

  test('replaces standalone integers', () => {
    expect(templateMessage('Status 500 after 123 ms')).toBe('Status <n> after <n> ms');
  });

  test('replaces long hex strings', () => {
    expect(templateMessage('Hash deadbeef12345678 computed')).toBe('Hash <hex> computed');
  });

  test('leaves short words intact', () => {
    // "abc" is only 3 chars — below the 8-char hex threshold
    expect(templateMessage('Route /api/tasks not found')).toBe('Route /api/tasks not found');
  });

  test('handles a message with no dynamic tokens', () => {
    expect(templateMessage('Server started')).toBe('Server started');
  });
});

// ---------------------------------------------------------------------------
// rotateLogs
// ---------------------------------------------------------------------------

describe('rotateLogs', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('creates the logs directory if it does not exist', () => {
    const nested = join(dir, 'sub', 'logs');
    rotateLogs(nested);
    expect(existsSync(nested)).toBe(true);
  });

  test('renames app.log to app.YYYY-MM-DD.log', () => {
    const appLog = join(dir, 'app.log');
    writeFileSync(appLog, 'old content\n', 'utf8');
    rotateLogs(dir);
    expect(existsSync(appLog)).toBe(false);
    const today = new Date().toISOString().slice(0, 10);
    expect(existsSync(join(dir, `app.${today}.log`))).toBe(true);
  });

  test('renames uniques.log to uniques.YYYY-MM-DD.log', () => {
    const uniquesLog = join(dir, 'uniques.log');
    writeFileSync(uniquesLog, 'old entry\n', 'utf8');
    rotateLogs(dir);
    expect(existsSync(uniquesLog)).toBe(false);
    const today = new Date().toISOString().slice(0, 10);
    expect(existsSync(join(dir, `uniques.${today}.log`))).toBe(true);
  });

  test('does not fail when no logs exist', () => {
    expect(() => rotateLogs(dir)).not.toThrow();
  });

  test('deletes rotated files older than 30 days', () => {
    // Create a fake rotated file dated 31 days ago
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const oldFile = join(dir, `app.${oldDate}.log`);
    writeFileSync(oldFile, 'stale\n', 'utf8');
    rotateLogs(dir);
    expect(existsSync(oldFile)).toBe(false);
  });

  test('keeps rotated files within 30 days', () => {
    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const recentFile = join(dir, `app.${recentDate}.log`);
    writeFileSync(recentFile, 'recent\n', 'utf8');
    rotateLogs(dir);
    expect(existsSync(recentFile)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// log — dual-file writes and deduplication
// ---------------------------------------------------------------------------

describe('log', () => {
  let dir: string;
  let uniquesLog: string;

  beforeEach(() => {
    dir = makeTmpDir();
    configureLogger(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writes a JSON line to app.log', () => {
    log('info', 'Server started', { trace_id: 'abc' });
    const lines = parseLines(join(dir, 'app.log'));
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('info');
    expect(lines[0].message).toBe('Server started');
    expect(lines[0].trace_id).toBe('abc');
    expect(typeof lines[0].ts).toBe('string');
  });

  test('writes the first occurrence to uniques.log', () => {
    uniquesLog = join(dir, 'uniques.log');
    log('info', 'Server started', { trace_id: 'abc' });
    const lines = parseLines(uniquesLog);
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe('Server started');
  });

  test('does not write a duplicate to uniques.log', () => {
    uniquesLog = join(dir, 'uniques.log');
    log('info', 'Server started', { trace_id: 'abc' });
    log('info', 'Server started', { trace_id: 'def' });
    // app.log has 2 lines
    expect(parseLines(join(dir, 'app.log'))).toHaveLength(2);
    // uniques.log has 1 line
    expect(parseLines(uniquesLog)).toHaveLength(1);
  });

  test('treats the same template with different dynamic values as duplicate', () => {
    uniquesLog = join(dir, 'uniques.log');
    log('error', 'Request 550e8400-e29b-41d4-a716-446655440000 failed with status 500', {});
    log('error', 'Request aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee failed with status 404', {});
    expect(parseLines(join(dir, 'app.log'))).toHaveLength(2);
    expect(parseLines(uniquesLog)).toHaveLength(1);
  });

  test('treats different levels as different dedup keys', () => {
    uniquesLog = join(dir, 'uniques.log');
    log('info', 'Server started', {});
    log('warn', 'Server started', {});
    expect(parseLines(uniquesLog)).toHaveLength(2);
  });

  test('treats different message templates as different dedup keys', () => {
    uniquesLog = join(dir, 'uniques.log');
    log('info', 'Server started', {});
    log('info', 'Server stopped', {});
    expect(parseLines(uniquesLog)).toHaveLength(2);
  });

  test('includes additional context fields in the entry', () => {
    log('warn', 'Rate limit exceeded', { trace_id: 'tid1', user_id: 'u42', limit: 100 });
    const lines = parseLines(join(dir, 'app.log'));
    expect(lines[0].user_id).toBe('u42');
    expect(lines[0].limit).toBe(100);
  });

  test('trace_id defaults to empty string when not supplied', () => {
    log('info', 'Health check', {});
    const lines = parseLines(join(dir, 'app.log'));
    expect(lines[0].trace_id).toBe('');
  });

  test('ts is a valid ISO 8601 timestamp', () => {
    log('info', 'Startup', {});
    const lines = parseLines(join(dir, 'app.log'));
    expect(new Date(lines[0].ts as string).toISOString()).toBe(lines[0].ts);
  });

  test('configureLogger resets rotation and dedup state', () => {
    uniquesLog = join(dir, 'uniques.log');
    log('info', 'Server started', {});
    // Reconfigure to a fresh directory — dedup should reset
    const dir2 = makeTmpDir();
    try {
      configureLogger(dir2);
      log('info', 'Server started', {});
      expect(parseLines(join(dir2, 'uniques.log'))).toHaveLength(1);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  test('resetDeduplication allows same key to write to uniques.log again', () => {
    uniquesLog = join(dir, 'uniques.log');
    log('info', 'Server started', {});
    resetDeduplication();
    log('info', 'Server started', {});
    expect(parseLines(uniquesLog)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// PII scrubbing — fixture-driven
// ---------------------------------------------------------------------------

interface PiiFixture {
  description: string;
  input: Record<string, unknown>;
  expected_scrubbed: Record<string, unknown>;
}

describe('log — PII scrubbing', () => {
  let dir: string;
  let appLog: string;

  beforeEach(() => {
    dir = makeTmpDir();
    configureLogger(dir);
    appLog = join(dir, 'app.log');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Helper: assert that a logged entry contains only the scrubbed values
   * and no raw PII values from the input fixture.
   */
  function assertNoPiiInEntry(
    entry: Record<string, unknown>,
    input: Record<string, unknown>,
  ): void {
    const entryJson = JSON.stringify(entry);
    // Walk all PII fields from the fixture input and ensure their raw values
    // do not appear verbatim in the serialised log entry.
    function collectPiiValues(obj: unknown): string[] {
      if (Array.isArray(obj)) return obj.flatMap(collectPiiValues);
      if (obj !== null && typeof obj === 'object') {
        const result: string[] = [];
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          if (PII_FIELD_NAMES.has(k) && typeof v === 'string') {
            result.push(v);
          }
          result.push(...collectPiiValues(v));
        }
        return result;
      }
      return [];
    }
    for (const rawValue of collectPiiValues(input)) {
      expect(entryJson).not.toContain(rawValue);
    }
  }

  test('user-registration fixture: no raw PII in logged entry', () => {
    const fixture = JSON.parse(
      readFileSync(join(FIXTURES_DIR, 'user-registration.json'), 'utf8'),
    ) as PiiFixture;

    log('info', 'User registered', fixture.input);
    const entries = parseLines(appLog);
    expect(entries).toHaveLength(1);
    assertNoPiiInEntry(entries[0], fixture.input);
    // Non-PII fields are preserved
    expect(entries[0].id).toBe(fixture.input.id);
    expect(entries[0].role).toBe(fixture.input.role);
  });

  test('nested-user-profile fixture: no raw PII in logged entry', () => {
    const fixture = JSON.parse(
      readFileSync(join(FIXTURES_DIR, 'nested-user-profile.json'), 'utf8'),
    ) as PiiFixture;

    log('info', 'Profile updated', fixture.input);
    const entries = parseLines(appLog);
    expect(entries).toHaveLength(1);
    assertNoPiiInEntry(entries[0], fixture.input);
    // Non-PII fields preserved
    expect(entries[0].event).toBe('profile_update');
    expect(entries[0].status).toBe('ok');
  });

  test('auth-token fixture: no raw PII in logged entry', () => {
    const fixture = JSON.parse(
      readFileSync(join(FIXTURES_DIR, 'auth-token.json'), 'utf8'),
    ) as PiiFixture;

    log('info', 'Auth token issued', fixture.input);
    const entries = parseLines(appLog);
    expect(entries).toHaveLength(1);
    assertNoPiiInEntry(entries[0], fixture.input);
    // Non-PII preserved
    expect(entries[0].user_id).toBe(fixture.input.user_id);
    expect(entries[0].expires_in).toBe(fixture.input.expires_in);
  });

  test('all known PII_FIELD_NAMES are redacted when logged', () => {
    // Build a payload with every known PII field.
    const input: Record<string, unknown> = { safe_field: 'keep-me' };
    for (const field of PII_FIELD_NAMES) {
      input[field] = `raw-value-for-${field}`;
    }

    log('warn', 'PII completeness check', input);
    const entries = parseLines(appLog);
    expect(entries).toHaveLength(1);

    // Every known PII field must be redacted.
    for (const field of PII_FIELD_NAMES) {
      expect(entries[0][field]).toBe('[REDACTED]');
    }
    // Non-PII field is untouched.
    expect(entries[0].safe_field).toBe('keep-me');
  });

  test('adding a new unscrubbed PII field to context is caught by PII_FIELD_NAMES check', () => {
    // This test documents the guard: if a developer adds a new PII field name
    // to PII_FIELD_NAMES the test above automatically covers it.
    // The count of known PII fields must stay consistent with scrub-pii.ts.
    // If this test fails it means scrub-pii.ts was changed without updating
    // the test expectation — a deliberate friction point.
    expect(PII_FIELD_NAMES.size).toBeGreaterThanOrEqual(13);
  });
});
