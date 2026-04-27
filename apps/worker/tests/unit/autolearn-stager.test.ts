/**
 * Unit tests for the autolearn temporary-filesystem stager.
 *
 * Tests cover:
 * - URL construction helpers
 * - Error type construction
 * - stageAutolearnInput: successful staging (real node:http server)
 * - stageAutolearnInput: fetch failures abort cleanly
 * - stageAutolearnInput: parse errors abort cleanly
 * - cleanupStagingDir: removes the directory
 * - createStagingDir / writeStagingFile: isolated path and write checks
 *
 * All HTTP interactions use a real node:http server on a random port — no mocks.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildGroundTruthUrl,
  buildWikiUrl,
  stageAutolearnInput,
  cleanupStagingDir,
  createStagingDir,
  writeStagingFile,
  AutolearnFetchError,
  AutolearnParseError,
  StagingWriteError,
  GROUND_TRUTH_FILENAME,
  WIKI_FILENAME,
  STAGING_DIR_PREFIX,
  segmentToDialogueLine,
  segmentsToDialogue,
  formatGroundTruthForStaging,
  type GroundTruthContent,
} from '../../src/autolearn-stager.js';

// ---------------------------------------------------------------------------
// URL construction helpers
// ---------------------------------------------------------------------------

describe('buildGroundTruthUrl', () => {
  test('includes base path and scope query params', () => {
    const url = buildGroundTruthUrl('https://api.example.com', { dept: 'd1', customer: 'c1' });
    expect(url).toContain('/api/autolearn/ground-truth');
    expect(url).toContain('dept=d1');
    expect(url).toContain('customer=c1');
  });

  test('produces a valid URL', () => {
    const url = buildGroundTruthUrl('http://localhost:3000', { dept: 'eng', customer: 'acme' });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('dept')).toBe('eng');
    expect(parsed.searchParams.get('customer')).toBe('acme');
  });

  test('encodes special characters in scope tokens', () => {
    const url = buildGroundTruthUrl('http://localhost', { dept: 'a b', customer: 'c&d' });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('dept')).toBe('a b');
    expect(parsed.searchParams.get('customer')).toBe('c&d');
  });

  test('omits full=true when fullGroundTruth is false (default)', () => {
    const url = buildGroundTruthUrl('http://localhost', { dept: 'd1', customer: 'c1' });
    const parsed = new URL(url);
    expect(parsed.searchParams.has('full')).toBe(false);
  });

  test('includes full=true when fullGroundTruth is true (deepclean mode)', () => {
    const url = buildGroundTruthUrl('http://localhost', { dept: 'd1', customer: 'c1' }, true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('full')).toBe('true');
  });
});

describe('buildWikiUrl', () => {
  test('includes base path and scope query params', () => {
    const url = buildWikiUrl('https://api.example.com', { dept: 'sales', customer: 'widget-co' });
    expect(url).toContain('/api/autolearn/wiki');
    expect(url).toContain('dept=sales');
    expect(url).toContain('customer=widget-co');
  });

  test('produces a valid URL', () => {
    const url = buildWikiUrl('http://localhost:8080', { dept: 'ops', customer: 'beta' });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/autolearn/wiki');
    expect(parsed.searchParams.get('dept')).toBe('ops');
    expect(parsed.searchParams.get('customer')).toBe('beta');
  });
});

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

describe('AutolearnFetchError', () => {
  test('is named AutolearnFetchError', () => {
    const err = new AutolearnFetchError('/api/autolearn/wiki', 404);
    expect(err.name).toBe('AutolearnFetchError');
  });

  test('includes HTTP status in message when provided', () => {
    const err = new AutolearnFetchError('/api/autolearn/ground-truth', 503);
    expect(err.message).toContain('503');
  });

  test('includes endpoint in message', () => {
    const err = new AutolearnFetchError('/api/autolearn/wiki', 401);
    expect(err.message).toContain('/api/autolearn/wiki');
  });

  test('handles null status (network error)', () => {
    const cause = new Error('ECONNREFUSED');
    const err = new AutolearnFetchError('/api/autolearn/wiki', null, cause);
    expect(err.statusCode).toBeNull();
    expect(err.message).toContain('ECONNREFUSED');
  });
});

describe('AutolearnParseError', () => {
  test('is named AutolearnParseError', () => {
    const err = new AutolearnParseError('/api/autolearn/ground-truth', 'not json');
    expect(err.name).toBe('AutolearnParseError');
  });

  test('includes endpoint in message', () => {
    const err = new AutolearnParseError('/api/autolearn/ground-truth', 'bad');
    expect(err.message).toContain('/api/autolearn/ground-truth');
  });

  test('truncates very long raw bodies in message', () => {
    const longBody = 'x'.repeat(1000);
    const err = new AutolearnParseError('/endpoint', longBody);
    expect(err.message.length).toBeLessThan(500);
  });
});

describe('StagingWriteError', () => {
  test('is named StagingWriteError', () => {
    const err = new StagingWriteError('/tmp/some-dir/file.json');
    expect(err.name).toBe('StagingWriteError');
  });

  test('includes path in message', () => {
    const err = new StagingWriteError('/tmp/superfield-autolearn-xyz/ground-truth.json');
    expect(err.message).toContain('/tmp/superfield-autolearn-xyz/ground-truth.json');
  });
});

// ---------------------------------------------------------------------------
// createStagingDir
// ---------------------------------------------------------------------------

describe('createStagingDir', () => {
  test('creates a directory under /tmp/ with the expected prefix', async () => {
    const dir = await createStagingDir();
    try {
      const s = await stat(dir);
      expect(s.isDirectory()).toBe(true);
      expect(dir).toContain(STAGING_DIR_PREFIX);
    } finally {
      await cleanupStagingDir(dir);
    }
  });

  test('each call creates a distinct directory (no collisions)', async () => {
    const [dir1, dir2] = await Promise.all([createStagingDir(), createStagingDir()]);
    try {
      expect(dir1).not.toBe(dir2);
    } finally {
      await cleanupStagingDir(dir1);
      await cleanupStagingDir(dir2);
    }
  });
});

// ---------------------------------------------------------------------------
// writeStagingFile
// ---------------------------------------------------------------------------

describe('writeStagingFile', () => {
  test('writes content that can be read back', async () => {
    const dir = await createStagingDir();
    try {
      const filePath = join(dir, 'test.txt');
      await writeStagingFile(filePath, 'hello staging');
      const content = await readFile(filePath, 'utf-8');
      expect(content).toBe('hello staging');
    } finally {
      await cleanupStagingDir(dir);
    }
  });

  test('throws StagingWriteError when directory does not exist', async () => {
    const filePath = '/tmp/superfield-nonexistent-dir/file.txt';
    await expect(writeStagingFile(filePath, 'data')).rejects.toBeInstanceOf(StagingWriteError);
  });
});

// ---------------------------------------------------------------------------
// cleanupStagingDir
// ---------------------------------------------------------------------------

describe('cleanupStagingDir', () => {
  test('removes the staging directory', async () => {
    const dir = await createStagingDir();
    await cleanupStagingDir(dir);
    await expect(stat(dir)).rejects.toThrow();
  });

  test('is idempotent — does not throw if directory does not exist', async () => {
    await expect(
      cleanupStagingDir('/tmp/superfield-autolearn-does-not-exist'),
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Shared test server helpers
// ---------------------------------------------------------------------------

/**
 * Create and start a one-shot HTTP server on a random OS-assigned port.
 *
 * The server calls `handler` for every incoming request.  The caller is
 * responsible for calling `server.close()` in an afterAll hook.
 */
function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Unexpected server address type'));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
    server.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// stageAutolearnInput — successful staging
// ---------------------------------------------------------------------------

describe('stageAutolearnInput — success', () => {
  let server: Server;
  let baseUrl: string;

  const GROUND_TRUTH_BODY = JSON.stringify({
    scope_ref: 'dept=eng&customer=acme',
    records: [
      { id: 'rec-001', token_a: 'tok_123', token_b: 'tok_456' },
      { id: 'rec-002', token_a: 'tok_789' },
    ],
    fetched_at: '2026-04-11T00:00:00.000Z',
  });

  const WIKI_BODY = '# Acme Engineering Wiki\n\nAnonymised content here.\n';

  beforeAll(async () => {
    const result = await startTestServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`);

      if (url.pathname === '/api/autolearn/ground-truth') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(GROUND_TRUTH_BODY);
        return;
      }

      if (url.pathname === '/api/autolearn/wiki') {
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        res.end(WIKI_BODY);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });
    server = result.server;
    baseUrl = result.baseUrl;
  });

  afterAll(() => {
    server.close();
  });

  test('returns a staging result with valid paths', async () => {
    const result = await stageAutolearnInput({
      apiBaseUrl: baseUrl,
      scope: { dept: 'eng', customer: 'acme' },
      delegatedToken: 'test-token',
    });

    try {
      expect(result.stagingDir).toContain(STAGING_DIR_PREFIX);
      expect(result.groundTruthPath).toBe(join(result.stagingDir, GROUND_TRUTH_FILENAME));
      expect(result.wikiPath).toBe(join(result.stagingDir, WIKI_FILENAME));
    } finally {
      await cleanupStagingDir(result.stagingDir);
    }
  });

  test('writes ground-truth.json containing tokenised records', async () => {
    const result = await stageAutolearnInput({
      apiBaseUrl: baseUrl,
      scope: { dept: 'eng', customer: 'acme' },
      delegatedToken: 'test-token',
    });

    try {
      const content = await readFile(result.groundTruthPath, 'utf-8');
      const parsed = JSON.parse(content) as { records: { id: string }[] };
      expect(Array.isArray(parsed.records)).toBe(true);
      expect(parsed.records[0]?.id).toBe('rec-001');
    } finally {
      await cleanupStagingDir(result.stagingDir);
    }
  });

  test('writes wiki.md containing the markdown content', async () => {
    const result = await stageAutolearnInput({
      apiBaseUrl: baseUrl,
      scope: { dept: 'eng', customer: 'acme' },
      delegatedToken: 'test-token',
    });

    try {
      const content = await readFile(result.wikiPath, 'utf-8');
      expect(content).toBe(WIKI_BODY);
    } finally {
      await cleanupStagingDir(result.stagingDir);
    }
  });

  test('staged directory exists on disk after staging', async () => {
    const result = await stageAutolearnInput({
      apiBaseUrl: baseUrl,
      scope: { dept: 'eng', customer: 'acme' },
      delegatedToken: 'test-token',
    });

    try {
      const s = await stat(result.stagingDir);
      expect(s.isDirectory()).toBe(true);
    } finally {
      await cleanupStagingDir(result.stagingDir);
    }
  });

  test('staged directory is removed after cleanup', async () => {
    const result = await stageAutolearnInput({
      apiBaseUrl: baseUrl,
      scope: { dept: 'eng', customer: 'acme' },
      delegatedToken: 'test-token',
    });

    await cleanupStagingDir(result.stagingDir);
    await expect(stat(result.stagingDir)).rejects.toThrow();
  });

  test('forwards the Authorization header to the API', async () => {
    let capturedAuth: string | null = null;

    const { server: authCapServer, baseUrl: authCapBaseUrl } = await startTestServer((req, res) => {
      capturedAuth = req.headers['authorization'] ?? null;
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/autolearn/ground-truth') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(GROUND_TRUTH_BODY);
        return;
      }
      if (url.pathname === '/api/autolearn/wiki') {
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        res.end(WIKI_BODY);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      const result = await stageAutolearnInput({
        apiBaseUrl: authCapBaseUrl,
        scope: { dept: 'eng', customer: 'acme' },
        delegatedToken: 'bearer-token-xyz',
      });
      await cleanupStagingDir(result.stagingDir);
      expect(capturedAuth).toBe('Bearer bearer-token-xyz');
    } finally {
      authCapServer.close();
    }
  });

  test('passes scope query params to the ground-truth endpoint', async () => {
    const receivedUrls: string[] = [];

    const { server: captureServer, baseUrl: captureBaseUrl } = await startTestServer((req, res) => {
      receivedUrls.push(req.url ?? '');
      if ((req.url ?? '').includes('/api/autolearn/ground-truth')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(GROUND_TRUTH_BODY);
        return;
      }
      if ((req.url ?? '').includes('/api/autolearn/wiki')) {
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        res.end(WIKI_BODY);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      const result = await stageAutolearnInput({
        apiBaseUrl: captureBaseUrl,
        scope: { dept: 'finance', customer: 'beta-corp' },
        delegatedToken: 'tok',
      });
      await cleanupStagingDir(result.stagingDir);
      const gtUrl = receivedUrls.find((u) => u.includes('/api/autolearn/ground-truth')) ?? '';
      expect(gtUrl).toContain('dept=finance');
      expect(gtUrl).toContain('customer=beta-corp');
    } finally {
      captureServer.close();
    }
  });

  test('passes full=true to the ground-truth endpoint when fullGroundTruth is set (deepclean mode)', async () => {
    const receivedUrls: string[] = [];

    const { server: captureServer, baseUrl: captureBaseUrl } = await startTestServer((req, res) => {
      receivedUrls.push(req.url ?? '');
      if ((req.url ?? '').includes('/api/autolearn/ground-truth')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(GROUND_TRUTH_BODY);
        return;
      }
      if ((req.url ?? '').includes('/api/autolearn/wiki')) {
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        res.end(WIKI_BODY);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      const result = await stageAutolearnInput({
        apiBaseUrl: captureBaseUrl,
        scope: { dept: 'deepclean-dept', customer: 'deepclean-cust' },
        delegatedToken: 'tok',
        fullGroundTruth: true,
      });
      await cleanupStagingDir(result.stagingDir);
      const gtUrl = receivedUrls.find((u) => u.includes('/api/autolearn/ground-truth')) ?? '';
      expect(gtUrl).toContain('full=true');
    } finally {
      captureServer.close();
    }
  });

  test('does NOT pass full=true to the ground-truth endpoint when fullGroundTruth is false (gardening mode)', async () => {
    const receivedUrls: string[] = [];

    const { server: captureServer, baseUrl: captureBaseUrl } = await startTestServer((req, res) => {
      receivedUrls.push(req.url ?? '');
      if ((req.url ?? '').includes('/api/autolearn/ground-truth')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(GROUND_TRUTH_BODY);
        return;
      }
      if ((req.url ?? '').includes('/api/autolearn/wiki')) {
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        res.end(WIKI_BODY);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      const result = await stageAutolearnInput({
        apiBaseUrl: captureBaseUrl,
        scope: { dept: 'garden-dept', customer: 'garden-cust' },
        delegatedToken: 'tok',
        fullGroundTruth: false,
      });
      await cleanupStagingDir(result.stagingDir);
      const gtUrl = receivedUrls.find((u) => u.includes('/api/autolearn/ground-truth')) ?? '';
      expect(gtUrl).not.toContain('full=true');
    } finally {
      captureServer.close();
    }
  });
});

// ---------------------------------------------------------------------------
// stageAutolearnInput — speaker diarisation in staged content (issue #59)
// ---------------------------------------------------------------------------

describe('stageAutolearnInput — speaker labels appear in staged ground-truth', () => {
  let server: Server;
  let baseUrl: string;

  const WIKI_BODY = '# Test Wiki\n\nContent.\n';

  const GROUND_TRUTH_WITH_SEGMENTS = JSON.stringify({
    scope_ref: 'dept=sales&customer=acme',
    records: [
      {
        id: 'rec-t1',
        type: 'transcript',
        segments: [
          { speaker: 'SPEAKER_A', text: 'Hello, how can I help?', start_s: 0, end_s: 2 },
          { speaker: 'SPEAKER_B', text: 'I need to renew my policy.', start_s: 2, end_s: 4 },
          { speaker: 'SPEAKER_A', text: 'Sure, let me look that up.', start_s: 4, end_s: 6 },
        ],
      },
      {
        id: 'rec-e1',
        type: 'email',
        body: 'No segments here',
      },
    ],
    fetched_at: '2026-04-11T00:00:00.000Z',
  });

  beforeAll(async () => {
    const result = await startTestServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (url.pathname === '/api/autolearn/ground-truth') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(GROUND_TRUTH_WITH_SEGMENTS);
        return;
      }

      if (url.pathname === '/api/autolearn/wiki') {
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        res.end(WIKI_BODY);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });
    server = result.server;
    baseUrl = result.baseUrl;
  });

  afterAll(() => {
    server.close();
  });

  test('staged ground-truth.json contains a dialogue field for records with segments', async () => {
    const result = await stageAutolearnInput({
      apiBaseUrl: baseUrl,
      scope: { dept: 'sales', customer: 'acme' },
      delegatedToken: 'test-token',
    });

    try {
      const raw = await readFile(result.groundTruthPath, 'utf-8');
      const parsed = JSON.parse(raw) as {
        records: Array<{ id: string; dialogue?: string; segments?: unknown[] }>;
      };

      const transcriptRecord = parsed.records.find((r) => r.id === 'rec-t1');
      expect(transcriptRecord).toBeDefined();
      // The dialogue field should be present and contain speaker labels.
      expect(typeof transcriptRecord!.dialogue).toBe('string');
      expect(transcriptRecord!.dialogue).toContain('[SPEAKER_A]');
      expect(transcriptRecord!.dialogue).toContain('[SPEAKER_B]');
      expect(transcriptRecord!.dialogue).toContain('Hello, how can I help?');
      expect(transcriptRecord!.dialogue).toContain('I need to renew my policy.');

      // The raw segments are preserved alongside the dialogue field.
      expect(Array.isArray(transcriptRecord!.segments)).toBe(true);
    } finally {
      await cleanupStagingDir(result.stagingDir);
    }
  });

  test('email records without segments have no dialogue field in staged content', async () => {
    const result = await stageAutolearnInput({
      apiBaseUrl: baseUrl,
      scope: { dept: 'sales', customer: 'acme' },
      delegatedToken: 'test-token',
    });

    try {
      const raw = await readFile(result.groundTruthPath, 'utf-8');
      const parsed = JSON.parse(raw) as {
        records: Array<{ id: string; dialogue?: string }>;
      };

      const emailRecord = parsed.records.find((r) => r.id === 'rec-e1');
      expect(emailRecord).toBeDefined();
      expect(emailRecord!.dialogue).toBeUndefined();
    } finally {
      await cleanupStagingDir(result.stagingDir);
    }
  });

  test('dialogue lines preserve speaker attribution order (issue #59 — stable labels)', async () => {
    const result = await stageAutolearnInput({
      apiBaseUrl: baseUrl,
      scope: { dept: 'sales', customer: 'acme' },
      delegatedToken: 'test-token',
    });

    try {
      const raw = await readFile(result.groundTruthPath, 'utf-8');
      const parsed = JSON.parse(raw) as {
        records: Array<{ id: string; dialogue?: string }>;
      };

      const transcriptRecord = parsed.records.find((r) => r.id === 'rec-t1');
      const lines = transcriptRecord!.dialogue!.split('\n');
      // Three segments → three dialogue lines.
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe('[SPEAKER_A] Hello, how can I help?');
      expect(lines[1]).toBe('[SPEAKER_B] I need to renew my policy.');
      expect(lines[2]).toBe('[SPEAKER_A] Sure, let me look that up.');
    } finally {
      await cleanupStagingDir(result.stagingDir);
    }
  });
});

// ---------------------------------------------------------------------------
// stageAutolearnInput — fetch failures
// ---------------------------------------------------------------------------

describe('stageAutolearnInput — ground-truth fetch failure', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const result = await startTestServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`);

      if (url.pathname === '/api/autolearn/ground-truth') {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Service unavailable');
        return;
      }

      if (url.pathname === '/api/autolearn/wiki') {
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        res.end('# Wiki\n');
        return;
      }

      res.writeHead(404);
      res.end();
    });
    server = result.server;
    baseUrl = result.baseUrl;
  });

  afterAll(() => {
    server.close();
  });

  test('throws AutolearnFetchError when ground-truth API returns 503', async () => {
    await expect(
      stageAutolearnInput({
        apiBaseUrl: baseUrl,
        scope: { dept: 'eng', customer: 'acme' },
        delegatedToken: 'tok',
      }),
    ).rejects.toBeInstanceOf(AutolearnFetchError);
  });

  test('includes the HTTP status code in the error', async () => {
    await stageAutolearnInput({
      apiBaseUrl: baseUrl,
      scope: { dept: 'eng', customer: 'acme' },
      delegatedToken: 'tok',
    }).catch((err: unknown) => {
      expect(err).toBeInstanceOf(AutolearnFetchError);
      expect((err as AutolearnFetchError).statusCode).toBe(503);
    });
  });
});

describe('stageAutolearnInput — wiki fetch failure', () => {
  let server: Server;
  let baseUrl: string;

  const GROUND_TRUTH_BODY = JSON.stringify({
    scope_ref: 'test',
    records: [],
    fetched_at: '2026-04-11T00:00:00.000Z',
  });

  beforeAll(async () => {
    const result = await startTestServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`);

      if (url.pathname === '/api/autolearn/ground-truth') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(GROUND_TRUTH_BODY);
        return;
      }

      if (url.pathname === '/api/autolearn/wiki') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      res.writeHead(404);
      res.end();
    });
    server = result.server;
    baseUrl = result.baseUrl;
  });

  afterAll(() => {
    server.close();
  });

  test('throws AutolearnFetchError when wiki API returns 404', async () => {
    await expect(
      stageAutolearnInput({
        apiBaseUrl: baseUrl,
        scope: { dept: 'eng', customer: 'acme' },
        delegatedToken: 'tok',
      }),
    ).rejects.toBeInstanceOf(AutolearnFetchError);
  });

  test('includes the HTTP status code in the error', async () => {
    await stageAutolearnInput({
      apiBaseUrl: baseUrl,
      scope: { dept: 'eng', customer: 'acme' },
      delegatedToken: 'tok',
    }).catch((err: unknown) => {
      expect(err).toBeInstanceOf(AutolearnFetchError);
      expect((err as AutolearnFetchError).statusCode).toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------
// stageAutolearnInput — invalid JSON from ground-truth API
// ---------------------------------------------------------------------------

describe('stageAutolearnInput — ground-truth parse failure', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const result = await startTestServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`);

      if (url.pathname === '/api/autolearn/ground-truth') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('this is not valid json {{{');
        return;
      }

      if (url.pathname === '/api/autolearn/wiki') {
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        res.end('# Wiki\n');
        return;
      }

      res.writeHead(404);
      res.end();
    });
    server = result.server;
    baseUrl = result.baseUrl;
  });

  afterAll(() => {
    server.close();
  });

  test('throws AutolearnParseError when ground-truth response is not JSON', async () => {
    await expect(
      stageAutolearnInput({
        apiBaseUrl: baseUrl,
        scope: { dept: 'eng', customer: 'acme' },
        delegatedToken: 'tok',
      }),
    ).rejects.toBeInstanceOf(AutolearnParseError);
  });
});

// ---------------------------------------------------------------------------
// stageAutolearnInput — network error (server unreachable)
// ---------------------------------------------------------------------------

describe('stageAutolearnInput — network error', () => {
  test('throws AutolearnFetchError when the server is unreachable', async () => {
    // Port 1 is reserved and will always refuse connections.
    await expect(
      stageAutolearnInput({
        apiBaseUrl: 'http://127.0.0.1:1',
        scope: { dept: 'eng', customer: 'acme' },
        delegatedToken: 'tok',
      }),
    ).rejects.toBeInstanceOf(AutolearnFetchError);
  });

  test('AutolearnFetchError has null statusCode for network errors', async () => {
    await stageAutolearnInput({
      apiBaseUrl: 'http://127.0.0.1:1',
      scope: { dept: 'eng', customer: 'acme' },
      delegatedToken: 'tok',
    }).catch((err: unknown) => {
      expect(err).toBeInstanceOf(AutolearnFetchError);
      expect((err as AutolearnFetchError).statusCode).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Module export smoke-test
// ---------------------------------------------------------------------------

describe('autolearn-stager module exports', () => {
  test('stageAutolearnInput is exported as a function', async () => {
    const mod = await import('../../src/autolearn-stager.js');
    expect(typeof mod.stageAutolearnInput).toBe('function');
  });

  test('cleanupStagingDir is exported as a function', async () => {
    const mod = await import('../../src/autolearn-stager.js');
    expect(typeof mod.cleanupStagingDir).toBe('function');
  });

  test('GROUND_TRUTH_FILENAME and WIKI_FILENAME are exported strings', async () => {
    const mod = await import('../../src/autolearn-stager.js');
    expect(typeof mod.GROUND_TRUTH_FILENAME).toBe('string');
    expect(typeof mod.WIKI_FILENAME).toBe('string');
  });

  test('segmentToDialogueLine is exported as a function', async () => {
    const mod = await import('../../src/autolearn-stager.js');
    expect(typeof mod.segmentToDialogueLine).toBe('function');
  });

  test('segmentsToDialogue is exported as a function', async () => {
    const mod = await import('../../src/autolearn-stager.js');
    expect(typeof mod.segmentsToDialogue).toBe('function');
  });

  test('formatGroundTruthForStaging is exported as a function', async () => {
    const mod = await import('../../src/autolearn-stager.js');
    expect(typeof mod.formatGroundTruthForStaging).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Speaker-label serialisation helpers (issue #59)
// ---------------------------------------------------------------------------

describe('segmentToDialogueLine', () => {
  test('formats a segment as [SPEAKER_X] text', () => {
    const line = segmentToDialogueLine({
      speaker: 'SPEAKER_A',
      text: 'Hello',
      start_s: 0,
      end_s: 1,
    });
    expect(line).toBe('[SPEAKER_A] Hello');
  });

  test('uses the opaque label from the segment', () => {
    const line = segmentToDialogueLine({
      speaker: 'SPEAKER_B',
      text: 'Goodbye',
      start_s: 2,
      end_s: 3,
    });
    expect(line).toBe('[SPEAKER_B] Goodbye');
  });
});

describe('segmentsToDialogue', () => {
  test('joins multiple segments as newline-separated dialogue lines', () => {
    const segments = [
      { speaker: 'SPEAKER_A' as const, text: 'Good morning', start_s: 0, end_s: 2 },
      { speaker: 'SPEAKER_B' as const, text: 'How can I help?', start_s: 2, end_s: 4 },
    ];
    const dialogue = segmentsToDialogue(segments);
    expect(dialogue).toBe('[SPEAKER_A] Good morning\n[SPEAKER_B] How can I help?');
  });

  test('returns empty string for empty array', () => {
    expect(segmentsToDialogue([])).toBe('');
  });

  test('returns empty string for undefined', () => {
    expect(segmentsToDialogue(undefined)).toBe('');
  });

  test('single segment produces a single line without trailing newline', () => {
    const dialogue = segmentsToDialogue([
      { speaker: 'SPEAKER_A' as const, text: 'Only me', start_s: 0, end_s: 5 },
    ]);
    expect(dialogue).toBe('[SPEAKER_A] Only me');
    expect(dialogue).not.toContain('\n');
  });
});

describe('formatGroundTruthForStaging', () => {
  test('passes through records that have no segments', () => {
    const content: GroundTruthContent = {
      scope_ref: 'scope-1',
      fetched_at: '2026-01-01T00:00:00Z',
      records: [{ id: 'r1', type: 'email', body: 'plain text' }],
    };
    const result = formatGroundTruthForStaging(content);
    expect(result.records[0]).not.toHaveProperty('dialogue');
    expect(result.records[0].body).toBe('plain text');
  });

  test('adds a dialogue field to records that have segments', () => {
    const content: GroundTruthContent = {
      scope_ref: 'scope-2',
      fetched_at: '2026-01-01T00:00:00Z',
      records: [
        {
          id: 'r2',
          type: 'transcript',
          segments: [
            { speaker: 'SPEAKER_A' as const, text: 'Hi', start_s: 0, end_s: 1 },
            { speaker: 'SPEAKER_B' as const, text: 'Hello', start_s: 1, end_s: 2 },
          ],
        },
      ],
    };
    const result = formatGroundTruthForStaging(content);
    expect(result.records[0].dialogue).toBe('[SPEAKER_A] Hi\n[SPEAKER_B] Hello');
  });

  test('preserves the original segments array alongside the dialogue field', () => {
    const segments = [{ speaker: 'SPEAKER_A' as const, text: 'Segment one', start_s: 0, end_s: 1 }];
    const content: GroundTruthContent = {
      scope_ref: 's',
      fetched_at: '2026-01-01T00:00:00Z',
      records: [{ id: 'r3', segments }],
    };
    const result = formatGroundTruthForStaging(content);
    expect(result.records[0].segments).toEqual(segments);
    expect(result.records[0].dialogue).toBe('[SPEAKER_A] Segment one');
  });

  test('does not add dialogue for records with empty segments array', () => {
    const content: GroundTruthContent = {
      scope_ref: 's',
      fetched_at: '2026-01-01T00:00:00Z',
      records: [{ id: 'r4', segments: [] }],
    };
    const result = formatGroundTruthForStaging(content);
    expect(result.records[0]).not.toHaveProperty('dialogue');
  });

  test('preserves top-level scope_ref and fetched_at', () => {
    const content: GroundTruthContent = {
      scope_ref: 'my-scope',
      fetched_at: '2026-06-01T12:00:00Z',
      records: [],
    };
    const result = formatGroundTruthForStaging(content);
    expect(result.scope_ref).toBe('my-scope');
    expect(result.fetched_at).toBe('2026-06-01T12:00:00Z');
  });
});
