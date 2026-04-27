/**
 * @file logger-integration.test.ts
 *
 * Integration tests for the structured logger + PII scrubbing pipeline.
 *
 * These tests simulate the server request-logging path: a request arrives,
 * the handler extracts a trace ID, builds a context object that may contain
 * PII fields, and calls `log()`.  The assertions verify that the written log
 * line contains no raw PII values even when PII fields appear in the context.
 *
 * Test plan ref: Issue #8 — "Integration: drive a server request through
 * apps/server and assert the request log line contains no raw PII".
 *
 * No mocks. Real filesystem writes to a temp directory.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { log, configureLogger } from './logger';
import { extractTraceId, traceLog } from './trace';
import { PII_FIELD_NAMES } from './scrub-pii';

const FIXTURES_DIR = resolve(import.meta.dirname, '../../tests/fixtures/pii-payloads');

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'superfield-logger-int-test-'));
}

function parseLines(filePath: string): Record<string, unknown>[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

interface PiiFixture {
  description: string;
  input: Record<string, unknown>;
  expected_scrubbed: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Integration: request lifecycle simulation
// ---------------------------------------------------------------------------

describe('request log pipeline — no raw PII', () => {
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
   * Simulate the server `withTrace()` helper: extract a trace ID from a
   * request, then call `log()` with the request context.
   */
  function simulateRequestLog(
    method: string,
    path: string,
    status: number,
    extraContext: Record<string, unknown> = {},
  ): void {
    const req = new Request(`http://localhost${path}`, { method });
    const traceId = extractTraceId(req);

    // Mirror the withTrace() call in apps/server/src/index.ts
    log('info', `${method} ${path} ${status}`, {
      trace_id: traceId,
      method,
      path,
      status,
      duration_ms: 12,
      ...extraContext,
    });
  }

  test('basic request log line is valid JSON with typed fields', () => {
    simulateRequestLog('GET', '/api/tasks', 200);
    const entries = parseLines(appLog);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    // Required typed fields
    expect(typeof entry.ts).toBe('string');
    expect(new Date(entry.ts as string).toISOString()).toBe(entry.ts);
    expect(entry.level).toBe('info');
    expect(typeof entry.trace_id).toBe('string');
    expect(entry.method).toBe('GET');
    expect(entry.path).toBe('/api/tasks');
    expect(entry.status).toBe(200);
    expect(typeof entry.duration_ms).toBe('number');
  });

  test('request context containing email is scrubbed before logging', () => {
    simulateRequestLog('POST', '/api/auth', 200, {
      email: 'user@example.com',
      user_id: 'u-001',
    });
    const entries = parseLines(appLog);
    expect(entries).toHaveLength(1);
    const entryJson = JSON.stringify(entries[0]);
    expect(entryJson).not.toContain('user@example.com');
    expect(entries[0].email).toBe('[REDACTED]');
    // Non-PII is preserved
    expect(entries[0].user_id).toBe('u-001');
  });

  test('request context containing auth token is scrubbed before logging', () => {
    simulateRequestLog('POST', '/api/auth', 200, {
      token: 'eyJhbGciOiJFUzI1NiJ9.secret.signature',
      authorization: 'Bearer secret-jwt',
    });
    const entries = parseLines(appLog);
    const entryJson = JSON.stringify(entries[0]);
    expect(entryJson).not.toContain('eyJhbGciOiJFUzI1NiJ9.secret.signature');
    expect(entryJson).not.toContain('Bearer secret-jwt');
    expect(entries[0].token).toBe('[REDACTED]');
    expect(entries[0].authorization).toBe('[REDACTED]');
  });

  test('user-registration fixture: no raw PII in request log entry', () => {
    const fixture = JSON.parse(
      readFileSync(join(FIXTURES_DIR, 'user-registration.json'), 'utf8'),
    ) as PiiFixture;

    // Simulate logging a user registration payload as part of a request
    simulateRequestLog('POST', '/api/auth', 201, fixture.input);
    const entries = parseLines(appLog);
    expect(entries).toHaveLength(1);

    // Collect raw PII values from the fixture input
    const entryJson = JSON.stringify(entries[0]);
    for (const field of PII_FIELD_NAMES) {
      const rawValue = fixture.input[field];
      if (typeof rawValue === 'string') {
        expect(entryJson).not.toContain(rawValue);
      }
    }
  });

  test('nested PII in request context is recursively scrubbed', () => {
    const fixture = JSON.parse(
      readFileSync(join(FIXTURES_DIR, 'nested-user-profile.json'), 'utf8'),
    ) as PiiFixture;

    simulateRequestLog('PATCH', '/api/users/u-789', 200, fixture.input);
    const entries = parseLines(appLog);
    expect(entries).toHaveLength(1);

    const entryJson = JSON.stringify(entries[0]);
    // Assert no raw email or phone values from the fixture appear in the log
    expect(entryJson).not.toContain('bob@example.com');
    expect(entryJson).not.toContain('contact1@example.com');
    expect(entryJson).not.toContain('contact2@example.com');
    expect(entryJson).not.toContain('+1-555-111-2222');
    expect(entryJson).not.toContain('+1-555-333-4444');
    expect(entryJson).not.toContain('s3cr3t-api-k3y');
    // Non-PII preserved
    expect(entries[0].event).toBe('profile_update');
    expect(entries[0].status).toBe('ok');
  });

  test('traceLog helper fields are preserved and trace_id is set', () => {
    const req = new Request('http://localhost/api/tasks', { method: 'GET' });
    const traceId = extractTraceId(req);
    const entry = traceLog('info', traceId, { method: 'GET', path: '/api/tasks', status: 200 });

    // traceLog returns a plain object — JSON-serialise it to verify structure
    const line = JSON.stringify(entry);
    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed.trace_id).toBe(traceId);
    expect(parsed.level).toBe('info');
    expect(parsed.method).toBe('GET');
    expect(parsed.status).toBe(200);
    expect(typeof parsed.ts).toBe('string');
  });

  test('multiple requests produce separate log lines each scrubbed', () => {
    simulateRequestLog('POST', '/api/auth', 200, { email: 'a@example.com', token: 'tok-a' });
    simulateRequestLog('GET', '/api/tasks', 200, { email: 'b@example.com', token: 'tok-b' });

    const entries = parseLines(appLog);
    expect(entries).toHaveLength(2);

    const entryJson = JSON.stringify(entries);
    expect(entryJson).not.toContain('a@example.com');
    expect(entryJson).not.toContain('b@example.com');
    expect(entryJson).not.toContain('tok-a');
    expect(entryJson).not.toContain('tok-b');
  });
});
