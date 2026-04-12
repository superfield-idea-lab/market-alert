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
    const err = new StagingWriteError('/tmp/calypso-autolearn-xyz/ground-truth.json');
    expect(err.message).toContain('/tmp/calypso-autolearn-xyz/ground-truth.json');
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
    const filePath = '/tmp/calypso-nonexistent-dir/file.txt';
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
    await expect(cleanupStagingDir('/tmp/calypso-autolearn-does-not-exist')).resolves.not.toThrow();
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
});
