/**
 * @file client-errors.test.ts
 *
 * Tests for the POST /api/v1/client-errors handler.
 *
 * Test plan ref: Issue #9 — "Integration test: POST /api/v1/client-errors with
 * a sample payload, assert it is logged with trace_id".
 *
 * No mocks. The handler is called directly with real Request objects.
 * Log output is captured by pointing the logger at a tmp directory.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { configureLogger } from 'core';
import { handleClientErrorsRequest } from '../../src/api/client-errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'client-errors-test-'));
}

function parseAppLog(dir: string): Record<string, unknown>[] {
  const path = join(dir, 'app.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleClientErrorsRequest', () => {
  let logDir: string;

  beforeEach(() => {
    logDir = makeTmpDir();
    configureLogger(logDir);
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  test('returns 202 for a valid payload', async () => {
    const req = new Request('http://localhost/api/v1/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Unhandled promise rejection', url: '/dashboard' }),
    });

    const res = await handleClientErrorsRequest(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(202);
  });

  test('logs the error with the browser trace_id from the payload', async () => {
    const browserTraceId = 'browser-trace-0000-0000-0000-001';
    const req = new Request('http://localhost/api/v1/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'TypeError: Cannot read properties of undefined',
        trace_id: browserTraceId,
        component: 'TaskList',
      }),
    });

    await handleClientErrorsRequest(req);

    const entries = parseAppLog(logDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].trace_id).toBe(browserTraceId);
    expect(entries[0].level).toBe('error');
    expect(String(entries[0].message)).toContain('TypeError');
  });

  test('logs the error with the request X-Trace-Id when payload has no trace_id', async () => {
    const requestTraceId = 'server-trace-0000-0000-0000-002';
    const req = new Request('http://localhost/api/v1/client-errors', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Trace-Id': requestTraceId,
      },
      body: JSON.stringify({ message: 'Script error', url: '/' }),
    });

    await handleClientErrorsRequest(req);

    const entries = parseAppLog(logDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].trace_id).toBe(requestTraceId);
  });

  test('logs the error using traceparent header when present', async () => {
    const traceParentId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const req = new Request('http://localhost/api/v1/client-errors', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        traceparent: `00-${traceParentId}-00f067aa0ba902b7-01`,
      },
      body: JSON.stringify({ message: 'Network error' }),
    });

    await handleClientErrorsRequest(req);

    const entries = parseAppLog(logDir);
    expect(entries).toHaveLength(1);
    // trace_id should use traceparent trace-id segment (no browser trace_id in payload)
    expect(entries[0].trace_id).toBe(traceParentId);
  });

  test('returns 400 for payload missing message field', async () => {
    const req = new Request('http://localhost/api/v1/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'some stack', url: '/' }),
    });

    const res = await handleClientErrorsRequest(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });

  test('returns 400 for invalid JSON body', async () => {
    const req = new Request('http://localhost/api/v1/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });

    const res = await handleClientErrorsRequest(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });

  test('returns null for non-POST methods', async () => {
    const req = new Request('http://localhost/api/v1/client-errors', {
      method: 'GET',
    });

    const res = await handleClientErrorsRequest(req);
    expect(res).toBeNull();
  });

  test('preserves component and url fields in the log entry', async () => {
    const req = new Request('http://localhost/api/v1/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Render error',
        component: 'AlertPanel',
        url: '/alerts',
        trace_id: 'trace-xyz',
      }),
    });

    await handleClientErrorsRequest(req);

    const entries = parseAppLog(logDir);
    expect(entries[0].component).toBe('AlertPanel');
    expect(entries[0].url).toBe('/alerts');
  });
});
