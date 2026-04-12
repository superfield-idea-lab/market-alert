/**
 * @file packages/embedding/embedding.ts
 *
 * Embedding service abstraction — Phase 2: Email ingestion & corpus store.
 *
 * All code that needs to embed text goes through this module. The backend is
 * chosen at boot time: Ollama in development, the in-house candle Rust server
 * in production. Both backends serve `nomic-embed-text-v1.5` and expose the
 * same HTTP contract, so worker pods require no changes at cutover.
 *
 * ## Contract
 *
 * POST /api/embed   (candle production server)
 * POST /api/embed   (Ollama dev wrapper — same shape)
 *
 * Request:  { input: string[] }
 * Response: { embeddings: number[][] }
 *
 * Both backends return 768-dimensional float vectors by default (the full
 * Matryoshka resolution for nomic-embed-text-v1.5).
 *
 * ## Backend implementations
 *
 * | Backend              | Use case                              |
 * | -------------------- | ------------------------------------- |
 * | OllamaEmbeddingBackend  | Development (local Ollama service) |
 * | CandleEmbeddingBackend  | Production (in-house Rust server)  |
 *
 * ## Usage
 *
 * ```ts
 * import { getEmbeddingService } from 'embedding';
 *
 * const svc = getEmbeddingService();
 * const vectors = await svc.embed(['hello world', 'second chunk']);
 * // vectors: number[][]  — one 768-dim vector per input string
 * ```
 *
 * ## Boot-time selection
 *
 * Call `configureEmbeddingBackend` once at startup to override the default:
 *
 * ```ts
 * import { configureEmbeddingBackend, CandleEmbeddingBackend } from 'embedding';
 * configureEmbeddingBackend(new CandleEmbeddingBackend({ baseUrl: process.env.CANDLE_URL! }));
 * ```
 *
 * If `EMBEDDING_BACKEND` env var is set to `'candle'`, the candle backend is
 * selected automatically from `resolveDefaultBackend()`. Otherwise Ollama is
 * used (development default).
 *
 * Canonical doc: docs/technical/embedding.md
 * Blueprint ref: docs/implementation-plan-v1.md Phase 2
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single embedding result: a 768-dimensional float vector.
 */
export type EmbeddingVector = number[];

/**
 * The public embedding service contract.
 *
 * All backends — Ollama, candle, or any future provider — must implement this
 * interface. The caller only ever sees this interface; the backend is injected
 * at startup.
 */
export interface EmbeddingService {
  /**
   * Embeds one or more text inputs and returns one vector per input, in the
   * same order.
   *
   * @param inputs - Non-empty array of strings to embed.
   * @returns Array of 768-dimensional float vectors, one per input.
   * @throws {EmbeddingError} if the backend returns an error or is unreachable.
   */
  embed(inputs: string[]): Promise<EmbeddingVector[]>;

  /**
   * Name of the model being served by this backend.
   * Both backends must report `nomic-embed-text-v1.5`.
   */
  readonly model: string;
}

/**
 * Thrown when an embedding request fails.
 */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

// ---------------------------------------------------------------------------
// Shared model constant
// ---------------------------------------------------------------------------

export const EMBEDDING_MODEL = 'nomic-embed-text-v1.5' as const;

// ---------------------------------------------------------------------------
// Ollama backend
// ---------------------------------------------------------------------------

/**
 * Options for the Ollama embedding backend.
 */
export interface OllamaEmbeddingOptions {
  /**
   * Base URL of the Ollama HTTP server.
   * Defaults to `OLLAMA_URL` env var, then `http://localhost:11434`.
   */
  baseUrl?: string;

  /**
   * Model name to use.
   * Defaults to `nomic-embed-text-v1.5`.
   */
  model?: string;
}

/**
 * Ollama embedding backend.
 *
 * Uses the Ollama `/api/embed` endpoint:
 *   POST { model, input: string[] }
 *   → { embeddings: number[][] }
 *
 * This backend is the development default. It connects to the Ollama service
 * running inside the k3d dev cluster (or locally).
 *
 * Ollama API reference: https://github.com/ollama/ollama/blob/main/docs/api.md
 */
export class OllamaEmbeddingBackend implements EmbeddingService {
  readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: OllamaEmbeddingOptions = {}) {
    this.baseUrl = opts.baseUrl ?? process.env['OLLAMA_URL'] ?? 'http://localhost:11434';
    this.model = opts.model ?? EMBEDDING_MODEL;
  }

  async embed(inputs: string[]): Promise<EmbeddingVector[]> {
    if (inputs.length === 0) {
      return [];
    }

    const url = `${this.baseUrl}/api/embed`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: inputs }),
      });
    } catch (err) {
      throw new EmbeddingError(`OllamaEmbeddingBackend: network error reaching ${url}`, err);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '(unreadable)');
      throw new EmbeddingError(
        `OllamaEmbeddingBackend: HTTP ${response.status} from ${url}: ${body}`,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw new EmbeddingError('OllamaEmbeddingBackend: failed to parse response JSON', err);
    }

    const typed = json as { embeddings?: number[][] };
    if (!Array.isArray(typed.embeddings)) {
      throw new EmbeddingError('OllamaEmbeddingBackend: response missing "embeddings" array');
    }

    return typed.embeddings;
  }
}

// ---------------------------------------------------------------------------
// Candle backend (in-house Rust server)
// ---------------------------------------------------------------------------

/**
 * Options for the candle embedding backend.
 */
export interface CandleEmbeddingOptions {
  /**
   * Base URL of the candle Rust HTTP server.
   * Defaults to `CANDLE_URL` env var, then `http://embedding-service:8080`.
   */
  baseUrl?: string;

  /**
   * Model name to report. Both backends serve the same model.
   * Defaults to `nomic-embed-text-v1.5`.
   */
  model?: string;
}

/**
 * Candle embedding backend — in-house Rust server (production).
 *
 * The candle server exposes the same API contract as the Ollama backend:
 *   POST /api/embed  { input: string[] }
 *   → { embeddings: number[][] }
 *
 * The server is a thin Axum HTTP wrapper around the HuggingFace `candle`
 * inference framework loading `nomic-embed-text-v1.5` weights directly from
 * HuggingFace format. It is deployed as a shared Kubernetes Deployment (not
 * per-worker) and is stateless.
 *
 * Architecture: docs/technical/embedding.md § Production (in-house Rust embedding server)
 */
export class CandleEmbeddingBackend implements EmbeddingService {
  readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: CandleEmbeddingOptions = {}) {
    this.baseUrl = opts.baseUrl ?? process.env['CANDLE_URL'] ?? 'http://embedding-service:8080';
    this.model = opts.model ?? EMBEDDING_MODEL;
  }

  async embed(inputs: string[]): Promise<EmbeddingVector[]> {
    if (inputs.length === 0) {
      return [];
    }

    const url = `${this.baseUrl}/api/embed`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: inputs }),
      });
    } catch (err) {
      throw new EmbeddingError(`CandleEmbeddingBackend: network error reaching ${url}`, err);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '(unreadable)');
      throw new EmbeddingError(
        `CandleEmbeddingBackend: HTTP ${response.status} from ${url}: ${body}`,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw new EmbeddingError('CandleEmbeddingBackend: failed to parse response JSON', err);
    }

    const typed = json as { embeddings?: number[][] };
    if (!Array.isArray(typed.embeddings)) {
      throw new EmbeddingError('CandleEmbeddingBackend: response missing "embeddings" array');
    }

    return typed.embeddings;
  }
}

// ---------------------------------------------------------------------------
// Module-level backend registry
// ---------------------------------------------------------------------------

/**
 * Returns the default backend selected from the environment.
 *
 * `EMBEDDING_BACKEND=candle` → CandleEmbeddingBackend
 * (anything else)           → OllamaEmbeddingBackend  (development default)
 */
function resolveDefaultBackend(): EmbeddingService {
  if (process.env['EMBEDDING_BACKEND'] === 'candle') {
    return new CandleEmbeddingBackend();
  }
  return new OllamaEmbeddingBackend();
}

/** Active backend. Resolved lazily on first call to `getEmbeddingService`. */
let _backend: EmbeddingService | null = null;

/**
 * Returns the active embedding service.
 *
 * If no backend has been configured via `configureEmbeddingBackend`, the
 * default backend is resolved from the environment on first call.
 */
export function getEmbeddingService(): EmbeddingService {
  if (_backend === null) {
    _backend = resolveDefaultBackend();
  }
  return _backend;
}

/**
 * Replaces the active embedding backend.
 *
 * Call once at server startup to override the default:
 *
 * ```ts
 * configureEmbeddingBackend(new CandleEmbeddingBackend({ baseUrl: '...' }));
 * ```
 *
 * Primarily useful in tests and for explicit production wiring.
 */
export function configureEmbeddingBackend(backend: EmbeddingService): void {
  _backend = backend;
}

/**
 * Resets the backend to `null` so the next call to `getEmbeddingService`
 * re-resolves from the environment.
 *
 * Intended for test isolation only — do not call in production code.
 */
export function _resetEmbeddingBackend(): void {
  _backend = null;
}
