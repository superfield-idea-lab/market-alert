/**
 * @file fixture-recorder.test.ts
 *
 * Integration tests for the golden fixture recorder and MSW handler factory.
 *
 * ## What is tested
 *
 * 1. Fixture recorder makes a real HTTP call to a local node:http server and
 *    serializes the full request/response pair with a `recorded_at` timestamp.
 * 2. `writeFixture` persists a GoldenFixture to disk in the correct filename
 *    format and the file contains valid JSON.
 * 3. MSW v2 handler loads the committed Anthropic fixture and replays it
 *    correctly — an integration test passes without making a live API call.
 * 4. `isFixtureStale` detects fixtures older than 30 days (TEST-C-025).
 * 5. `assertFixturesFresh` throws on stale fixtures and passes on fresh ones.
 * 6. `checkSchemaDrift` detects added/removed top-level response fields.
 *
 * ## No mocks
 *
 * The recorder tests use a real `node:http` server bound to a random port.
 * The MSW tests load real fixture files from disk.
 * No vi.fn, vi.mock, vi.spyOn, or vi.stubGlobal anywhere.
 *
 * ## Blueprint refs
 *
 * - TEST-D-001: golden-fixture-recording
 * - TEST-A-003: fixture-refresh-pipeline
 * - TEST-C-003: golden-fixture-recorded
 * - TEST-C-019: fixture-refresh-pipeline
 * - TEST-C-025: fixtures-refreshed
 *
 * Canonical doc: docs/implementation-plan-v1.md § Phase 0
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { setupServer } from 'msw/node';

import {
  recordRequest,
  writeFixture,
  checkSchemaDrift,
  type GoldenFixture,
} from '../../scripts/record-fixture';

import {
  isFixtureStale,
  assertFixturesFresh,
  loadFixturesFromDir,
  createFixtureHandlerFromDir,
  createFixtureHandlerFromFile,
} from '../fixtures/msw-handler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const ANTHROPIC_FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'anthropic');

// Start a real local HTTP server that echoes back a JSON response.
// Used to test the recorder without hitting external APIs.
function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Could not bind server'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        stop: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
    server.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Recorder tests (real node:http server — no mocks)
// ---------------------------------------------------------------------------

describe('fixture recorder — real HTTP round-trip', () => {
  let stop: (() => Promise<void>) | null = null;
  let baseUrl = '';
  let tempDir = '';

  beforeAll(async () => {
    const srv = await startTestServer((_req, res) => {
      const body = JSON.stringify({
        content: [{ text: 'hello from fixture server', type: 'text' }],
        id: 'msg_test001',
        model: 'claude-3-haiku-20240307',
        role: 'assistant',
        stop_reason: 'end_turn',
        stop_sequence: null,
        type: 'message',
        usage: { input_tokens: 10, output_tokens: 6 },
      });
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      });
      res.end(body);
    });
    baseUrl = srv.baseUrl;
    stop = srv.stop;
    tempDir = mkdtempSync(join(tmpdir(), 'superfield-fixture-recorder-'));
  });

  afterAll(async () => {
    await stop?.();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('recordRequest captures method, url, status and recorded_at', async () => {
    const fixture = await recordRequest({
      body: { prompt: 'hello' },
      method: 'POST',
      service: 'test-service',
      url: `${baseUrl}/v1/messages`,
    });

    expect(fixture.service).toBe('test-service');
    expect(fixture.request.method).toBe('POST');
    expect(fixture.request.url).toBe(`${baseUrl}/v1/messages`);
    expect(fixture.request.body).toEqual({ prompt: 'hello' });
    expect(fixture.response.status).toBe(200);
    expect(typeof fixture.recorded_at).toBe('string');
    // recorded_at must be a valid ISO-8601 date
    expect(new Date(fixture.recorded_at).toISOString()).toBe(fixture.recorded_at);
  });

  test('recordRequest captures the full response body', async () => {
    const fixture = await recordRequest({
      method: 'POST',
      service: 'test-service',
      url: `${baseUrl}/v1/messages`,
    });

    const body = fixture.response.body as Record<string, unknown>;
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(Array.isArray(body.content)).toBe(true);
  });

  test('writeFixture persists to disk and filename contains service and timestamp', () => {
    const fixture: GoldenFixture = {
      recorded_at: '2026-01-15T10:30:00.000Z',
      request: {
        body: null,
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: 'https://example.com/v1/messages',
      },
      response: {
        body: { id: 'msg_1', type: 'message' },
        headers: { 'content-type': 'application/json' },
        status: 200,
        statusText: 'OK',
      },
      service: 'anthropic',
    };

    const filePath = writeFixture(fixture, tempDir);

    expect(filePath).toMatch(/anthropic_2026-01-15T10-30-00-000Z\.json$/);
    const written = JSON.parse(readFileSync(filePath, 'utf-8')) as GoldenFixture;
    expect(written.recorded_at).toBe('2026-01-15T10:30:00.000Z');
    expect(written.service).toBe('anthropic');
    expect(written.response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// MSW handler tests (committed fixtures — no live API)
// ---------------------------------------------------------------------------

describe('MSW handler — replays committed Anthropic fixture', () => {
  const { handler, reset } = createFixtureHandlerFromDir(ANTHROPIC_FIXTURE_DIR);
  const mswServer = setupServer(handler);

  beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
  afterAll(() => mswServer.close());
  afterEach(() => {
    mswServer.resetHandlers();
    reset();
  });

  test('fetch to Anthropic URL returns the recorded fixture body', async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      body: JSON.stringify({ model: 'claude-3-haiku-20240307', messages: [], max_tokens: 10 }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(Array.isArray(body.content)).toBe(true);
    const content = body.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe('text');
    expect(typeof content[0]?.text).toBe('string');
    expect((content[0]?.text ?? '').length).toBeGreaterThan(0);
  });

  test('replayed fixture has correct HTTP status', async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      body: JSON.stringify({ model: 'claude-3-haiku-20240307', messages: [], max_tokens: 10 }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(res.statusText).toBe('OK');
  });
});

// ---------------------------------------------------------------------------
// Single-file handler test
// ---------------------------------------------------------------------------

describe('MSW handler — single file', () => {
  // Pick the first fixture file to test single-file handler
  const fixtureFiles = readdirSync(ANTHROPIC_FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(ANTHROPIC_FIXTURE_DIR, f));

  test('createFixtureHandlerFromFile loads fixture with required fields', () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
    const { fixture } = createFixtureHandlerFromFile(fixtureFiles[0]!);
    expect(fixture.recorded_at).toBeTruthy();
    expect(fixture.service).toBe('anthropic');
    expect(fixture.request.method).toBe('POST');
    expect(fixture.response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Fixture loading / validation tests
// ---------------------------------------------------------------------------

describe('fixture loader — validation', () => {
  test('loadFixturesFromDir returns all JSON files sorted', () => {
    const fixtures = loadFixturesFromDir(ANTHROPIC_FIXTURE_DIR);
    expect(fixtures.length).toBeGreaterThan(0);
    for (const f of fixtures) {
      expect(f.recorded_at).toBeTruthy();
      expect(f.service).toBe('anthropic');
    }
  });

  test('every loaded fixture has required fields', () => {
    const fixtures = loadFixturesFromDir(ANTHROPIC_FIXTURE_DIR);
    for (const f of fixtures) {
      expect(typeof f.recorded_at).toBe('string');
      expect(typeof f.service).toBe('string');
      expect(typeof f.request.method).toBe('string');
      expect(typeof f.request.url).toBe('string');
      expect(typeof f.response.status).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// Staleness checks (TEST-C-025)
// ---------------------------------------------------------------------------

describe('isFixtureStale — 30-day threshold (TEST-C-025)', () => {
  function makeFixture(recorded_at: string): GoldenFixture {
    return {
      recorded_at,
      request: { body: null, headers: {}, method: 'POST', url: 'https://example.com' },
      response: { body: {}, headers: {}, status: 200, statusText: 'OK' },
      service: 'test',
    };
  }

  test('fresh fixture (1 day old) is not stale', () => {
    const now = new Date('2026-04-11T00:00:00.000Z');
    const fixture = makeFixture('2026-04-10T00:00:00.000Z');
    expect(isFixtureStale(fixture, now)).toBe(false);
  });

  test('fixture exactly 30 days old is not stale', () => {
    const now = new Date('2026-04-11T00:00:00.000Z');
    const fixture = makeFixture('2026-03-12T00:00:00.000Z');
    expect(isFixtureStale(fixture, now)).toBe(false);
  });

  test('fixture 31 days old is stale', () => {
    const now = new Date('2026-04-11T00:00:00.000Z');
    const fixture = makeFixture('2026-03-11T00:00:00.000Z');
    expect(isFixtureStale(fixture, now)).toBe(true);
  });

  test('assertFixturesFresh throws on stale fixture', () => {
    const now = new Date('2026-04-11T00:00:00.000Z');
    const stale = makeFixture('2026-01-01T00:00:00.000Z');
    expect(() => assertFixturesFresh([stale], now)).toThrowError(/Stale fixture detected/);
  });

  test('assertFixturesFresh passes with fresh fixtures', () => {
    const now = new Date('2026-04-11T00:00:00.000Z');
    const fresh = makeFixture('2026-04-10T00:00:00.000Z');
    expect(() => assertFixturesFresh([fresh], now)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Schema drift detection
// ---------------------------------------------------------------------------

describe('checkSchemaDrift', () => {
  function makeFixture(responseKeys: Record<string, unknown>): GoldenFixture {
    return {
      recorded_at: '2026-04-11T00:00:00.000Z',
      request: { body: null, headers: {}, method: 'POST', url: 'https://example.com' },
      response: { body: responseKeys, headers: {}, status: 200, statusText: 'OK' },
      service: 'test',
    };
  }

  test('identical fixtures have no drift', () => {
    const a = makeFixture({ id: 'x', type: 'message' });
    const b = makeFixture({ id: 'y', type: 'message' });
    const result = checkSchemaDrift(a, b);
    expect(result.drifted).toBe(false);
  });

  test('added field is detected', () => {
    const baseline = makeFixture({ id: 'x', type: 'message' });
    const updated = makeFixture({ id: 'x', type: 'message', new_field: 'value' });
    const result = checkSchemaDrift(baseline, updated);
    expect(result.drifted).toBe(true);
    if (result.drifted) {
      expect(result.added).toContain('new_field');
      expect(result.removed).toHaveLength(0);
    }
  });

  test('removed field is detected', () => {
    const baseline = makeFixture({ id: 'x', type: 'message', old_field: 'value' });
    const updated = makeFixture({ id: 'x', type: 'message' });
    const result = checkSchemaDrift(baseline, updated);
    expect(result.drifted).toBe(true);
    if (result.drifted) {
      expect(result.removed).toContain('old_field');
      expect(result.added).toHaveLength(0);
    }
  });

  test('both added and removed fields are detected simultaneously', () => {
    const baseline = makeFixture({ id: 'x', old: 'gone' });
    const updated = makeFixture({ id: 'x', new: 'arrived' });
    const result = checkSchemaDrift(baseline, updated);
    expect(result.drifted).toBe(true);
    if (result.drifted) {
      expect(result.added).toContain('new');
      expect(result.removed).toContain('old');
    }
  });
});
