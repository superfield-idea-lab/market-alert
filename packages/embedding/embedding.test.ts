/**
 * @file packages/embedding/embedding.test.ts
 *
 * Contract tests for the embedding service abstraction.
 *
 * Rules:
 * - No mocks. No vi.fn / vi.mock / vi.spyOn / vi.stubGlobal.
 * - Ollama backend is tested against recorded fixtures via MSW v2.
 * - Candle backend is tested against a real node:http stub server
 *   (acceptable for CI portability; MSW v2 also used for fixture replay).
 *
 * Test plan:
 * - Backend contract: both OllamaEmbeddingBackend and CandleEmbeddingBackend
 *   must satisfy the EmbeddingService interface.
 * - Dimension check: returned vectors must have 768 dimensions.
 * - Empty input: both backends must return [] for empty input arrays.
 * - Error propagation: EmbeddingError is thrown on non-2xx HTTP response.
 * - Boot selection: getEmbeddingService returns Ollama by default; candle
 *   when EMBEDDING_BACKEND=candle.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { resolve } from 'node:path';

import {
  CandleEmbeddingBackend,
  EMBEDDING_MODEL,
  EmbeddingError,
  OllamaEmbeddingBackend,
  _resetEmbeddingBackend,
  configureEmbeddingBackend,
  getEmbeddingService,
} from './embedding';
import { loadFixtureFile } from '../../tests/fixtures/msw-handler';

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const REPO_ROOT = new URL('../../', import.meta.url).pathname;

const OLLAMA_FIXTURE_PATH = resolve(
  REPO_ROOT,
  'tests/fixtures/ollama/ollama_embed_2026-04-11T00-00-00-000Z.json',
);
const CANDLE_FIXTURE_PATH = resolve(
  REPO_ROOT,
  'tests/fixtures/candle/candle_embed_2026-04-11T00-00-00-000Z.json',
);

// ---------------------------------------------------------------------------
// Shared contract test suite
// ---------------------------------------------------------------------------

/**
 * Runs the full EmbeddingService contract against `backend`.
 * Used by both Ollama and Candle test blocks.
 */
async function runEmbeddingContractSuite(
  backend: import('./embedding').EmbeddingService,
  label: string,
  fixtureInput: string,
): Promise<void> {
  // model name
  if (backend.model !== EMBEDDING_MODEL) {
    throw new Error(`${label}: expected model "${EMBEDDING_MODEL}", got "${backend.model}"`);
  }

  // single input
  const vectors = await backend.embed([fixtureInput]);
  if (!Array.isArray(vectors) || vectors.length !== 1) {
    throw new Error(`${label}: expected 1 vector, got ${vectors?.length}`);
  }
  const v = vectors[0];
  if (!Array.isArray(v) || v.length !== 768) {
    throw new Error(`${label}: expected 768-dim vector, got ${v?.length}`);
  }
  for (const dim of v) {
    if (typeof dim !== 'number') {
      throw new Error(`${label}: vector contains non-number element`);
    }
  }

  // empty input → empty result
  const empty = await backend.embed([]);
  if (!Array.isArray(empty) || empty.length !== 0) {
    throw new Error(`${label}: embed([]) must return []`);
  }
}

// ---------------------------------------------------------------------------
// Ollama backend tests
// ---------------------------------------------------------------------------

describe('OllamaEmbeddingBackend', () => {
  const ollamaFixture = loadFixtureFile(OLLAMA_FIXTURE_PATH);
  const fixtureInput = (ollamaFixture.request.body as { input: string[] }).input[0];
  const ollamaBaseUrl = 'http://localhost:11434';

  const server = setupServer(
    http.post(`${ollamaBaseUrl}/api/embed`, () =>
      HttpResponse.json(ollamaFixture.response.body as Record<string, unknown>, {
        status: ollamaFixture.response.status,
      }),
    ),
  );

  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterAll(() => server.close());
  afterEach(() => server.resetHandlers());

  test('satisfies EmbeddingService contract against fixture', async () => {
    const backend = new OllamaEmbeddingBackend({ baseUrl: ollamaBaseUrl });
    await runEmbeddingContractSuite(backend, 'OllamaEmbeddingBackend', fixtureInput);
  });

  test('throws EmbeddingError on non-2xx response', async () => {
    server.use(
      http.post(`${ollamaBaseUrl}/api/embed`, () =>
        HttpResponse.json({ error: 'model not found' }, { status: 404 }),
      ),
    );
    const backend = new OllamaEmbeddingBackend({ baseUrl: ollamaBaseUrl });
    await expect(backend.embed(['test'])).rejects.toThrow(EmbeddingError);
  });

  test('throws EmbeddingError when response is missing embeddings field', async () => {
    server.use(
      http.post(`${ollamaBaseUrl}/api/embed`, () =>
        HttpResponse.json({ model: EMBEDDING_MODEL }, { status: 200 }),
      ),
    );
    const backend = new OllamaEmbeddingBackend({ baseUrl: ollamaBaseUrl });
    await expect(backend.embed(['test'])).rejects.toThrow(EmbeddingError);
  });
});

// ---------------------------------------------------------------------------
// Candle backend tests
// ---------------------------------------------------------------------------

describe('CandleEmbeddingBackend', () => {
  const candleFixture = loadFixtureFile(CANDLE_FIXTURE_PATH);
  const fixtureInput = (candleFixture.request.body as { input: string[] }).input[0];
  const candleBaseUrl = 'http://embedding-service:8080';

  const server = setupServer(
    http.post(`${candleBaseUrl}/api/embed`, () =>
      HttpResponse.json(candleFixture.response.body as Record<string, unknown>, {
        status: candleFixture.response.status,
      }),
    ),
  );

  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterAll(() => server.close());
  afterEach(() => server.resetHandlers());

  test('satisfies EmbeddingService contract against fixture', async () => {
    const backend = new CandleEmbeddingBackend({ baseUrl: candleBaseUrl });
    await runEmbeddingContractSuite(backend, 'CandleEmbeddingBackend', fixtureInput);
  });

  test('throws EmbeddingError on non-2xx response', async () => {
    server.use(
      http.post(`${candleBaseUrl}/api/embed`, () =>
        HttpResponse.json({ error: 'internal server error' }, { status: 500 }),
      ),
    );
    const backend = new CandleEmbeddingBackend({ baseUrl: candleBaseUrl });
    await expect(backend.embed(['test'])).rejects.toThrow(EmbeddingError);
  });

  test('throws EmbeddingError when response is missing embeddings field', async () => {
    server.use(
      http.post(`${candleBaseUrl}/api/embed`, () => HttpResponse.json({}, { status: 200 })),
    );
    const backend = new CandleEmbeddingBackend({ baseUrl: candleBaseUrl });
    await expect(backend.embed(['test'])).rejects.toThrow(EmbeddingError);
  });
});

// ---------------------------------------------------------------------------
// Boot-time backend selection
// ---------------------------------------------------------------------------

describe('getEmbeddingService / boot-time selection', () => {
  afterEach(() => {
    _resetEmbeddingBackend();
    delete process.env['EMBEDDING_BACKEND'];
  });

  test('returns OllamaEmbeddingBackend by default', () => {
    const svc = getEmbeddingService();
    expect(svc).toBeInstanceOf(OllamaEmbeddingBackend);
    expect(svc.model).toBe(EMBEDDING_MODEL);
  });

  test('returns CandleEmbeddingBackend when EMBEDDING_BACKEND=candle', () => {
    process.env['EMBEDDING_BACKEND'] = 'candle';
    const svc = getEmbeddingService();
    expect(svc).toBeInstanceOf(CandleEmbeddingBackend);
    expect(svc.model).toBe(EMBEDDING_MODEL);
  });

  test('configureEmbeddingBackend replaces the active backend', () => {
    const custom = new CandleEmbeddingBackend({ baseUrl: 'http://custom:9999' });
    configureEmbeddingBackend(custom);
    const svc = getEmbeddingService();
    expect(svc).toBe(custom);
  });

  test('_resetEmbeddingBackend clears the configured backend', () => {
    configureEmbeddingBackend(new CandleEmbeddingBackend());
    _resetEmbeddingBackend();
    // After reset, a new default (Ollama) is resolved
    const svc = getEmbeddingService();
    expect(svc).toBeInstanceOf(OllamaEmbeddingBackend);
  });
});
