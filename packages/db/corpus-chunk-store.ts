/**
 * @file corpus-chunk-store
 *
 * Server-side embedding query path for CorpusChunk similarity search.
 *
 * PRD §7 compensating controls enforced by every call to `queryByEmbedding`:
 *
 *   1. **Audit** — an audit event is written to `audit_events` before any
 *      CorpusChunk row is returned to the caller.  If the audit write fails,
 *      the query is blocked and no data is returned.
 *
 *   2. **Rate limit** — each tenant is limited to EMBEDDING_QUERY_RATE_LIMIT
 *      queries per EMBEDDING_QUERY_RATE_WINDOW_MS milliseconds (defaults:
 *      100 / 60 000 ms).  Excess calls throw `EmbeddingRateLimitError`.
 *
 *   3. **No public API** — this module is server-side only.  The embedding
 *      column is never serialised into any API response; callers receive only
 *      the `id`, `content`, `chunk_index`, `source_id`, and similarity score.
 *
 *   4. **Per-tenant RLS** — every query runs inside a transaction that sets
 *      `app.current_tenant_id` via SET LOCAL, so the
 *      `corpus_chunks_tenant_isolation` policy filters out all rows belonging
 *      to other tenants at the database layer.
 *
 * HNSW query parameters:
 *   - `m` and `ef_construction` are index-build parameters (set in schema.sql).
 *   - `ef_search` is a per-query parameter read from `HNSW_EF_SEARCH` (default 40).
 *
 * Blueprint: DATA blueprint, PRD §7, issue #31.
 */

import postgres from 'postgres';

// ---------------------------------------------------------------------------
// HNSW configuration
// ---------------------------------------------------------------------------

/**
 * HNSW index-build parameters.  Set once at schema-migration time via
 * schema.sql.  Exposed here for documentation and test introspection.
 */
export interface HnswIndexConfig {
  /** Number of bi-directional links per node (index m). Default 16. */
  m: number;
  /** Queue size during index construction (ef_construction). Default 64. */
  efConstruction: number;
}

/**
 * HNSW query parameters. Applied per-query via SET LOCAL.
 */
export interface HnswQueryConfig {
  /** Candidate list size for approximate search (ef_search). Default 40. */
  efSearch: number;
}

/**
 * Load HNSW index-build configuration from environment variables.
 *
 * HNSW_M             — index m (default 16)
 * HNSW_EF_CONSTRUCTION — ef_construction (default 64)
 */
export function loadHnswIndexConfig(env: NodeJS.ProcessEnv = process.env): HnswIndexConfig {
  return {
    m: Number(env.HNSW_M ?? 16),
    efConstruction: Number(env.HNSW_EF_CONSTRUCTION ?? 64),
  };
}

/**
 * Load HNSW query-time configuration from environment variables.
 *
 * HNSW_EF_SEARCH — ef_search (default 40)
 */
export function loadHnswQueryConfig(env: NodeJS.ProcessEnv = process.env): HnswQueryConfig {
  return {
    efSearch: Number(env.HNSW_EF_SEARCH ?? 40),
  };
}

// ---------------------------------------------------------------------------
// Per-tenant embedding query rate limiter
//
// Implemented inline here so that packages/db has no dependency on
// apps/server.  The algorithm is a sliding-window counter identical to the
// one in apps/server/src/security/rate-limiter.ts.
// ---------------------------------------------------------------------------

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix timestamp (seconds) when the oldest window entry expires. */
  resetAt: number;
}

/**
 * Sliding-window per-key rate limiter.
 *
 * Mirrors the implementation in apps/server/src/security/rate-limiter.ts but
 * is self-contained within packages/db to avoid a cross-package dependency.
 */
export class EmbeddingRateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly store = new Map<string, number[]>();

  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  /**
   * Check whether a request from `key` is within the rate limit.
   * Does NOT record the request — call `consume()` after a successful check.
   */
  check(key: string): RateLimitResult {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const timestamps = (this.store.get(key) ?? []).filter((ts) => ts > windowStart);

    const count = timestamps.length;
    const allowed = count < this.maxRequests;
    const remaining = Math.max(0, this.maxRequests - count - (allowed ? 1 : 0));
    const oldest = timestamps[0] ?? now;
    const resetAt = Math.ceil((oldest + this.windowMs) / 1000);

    return { allowed, limit: this.maxRequests, remaining, resetAt };
  }

  /** Record a request from `key`. */
  consume(key: string): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const timestamps = (this.store.get(key) ?? []).filter((ts) => ts > windowStart);
    timestamps.push(now);
    this.store.set(key, timestamps);
  }

  /** Reset all state. Useful for testing. */
  reset(): void {
    this.store.clear();
  }
}

/**
 * Load rate-limit parameters from environment variables.
 *
 * EMBEDDING_QUERY_RATE_LIMIT      — max queries per window (default 100)
 * EMBEDDING_QUERY_RATE_WINDOW_MS  — window length in ms (default 60 000)
 */
export function loadEmbeddingRateLimitConfig(env: NodeJS.ProcessEnv = process.env): {
  limit: number;
  windowMs: number;
} {
  return {
    limit: Number(env.EMBEDDING_QUERY_RATE_LIMIT ?? 100),
    windowMs: Number(env.EMBEDDING_QUERY_RATE_WINDOW_MS ?? 60_000),
  };
}

// Module-level singleton — one limiter for the lifetime of the process.
let _embeddingLimiter: EmbeddingRateLimiter | null = null;

/**
 * Returns the module-level per-tenant embedding query rate limiter.
 * Lazily constructed on first call so process.env values are respected
 * even when the module is imported before env vars are set.
 */
export function getEmbeddingLimiter(): EmbeddingRateLimiter {
  if (_embeddingLimiter === null) {
    const { limit, windowMs } = loadEmbeddingRateLimitConfig();
    _embeddingLimiter = new EmbeddingRateLimiter(windowMs, limit);
  }
  return _embeddingLimiter;
}

/**
 * Replace the module-level limiter.  Used in tests to inject a fresh instance.
 */
export function setEmbeddingLimiter(limiter: EmbeddingRateLimiter): void {
  _embeddingLimiter = limiter;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class EmbeddingRateLimitError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly result: RateLimitResult,
  ) {
    super(
      `Embedding query rate limit exceeded for tenant ${tenantId}. ` +
        `Resets at ${new Date(result.resetAt * 1000).toISOString()}.`,
    );
    this.name = 'EmbeddingRateLimitError';
  }
}

export class EmbeddingAuditError extends Error {
  constructor(cause: unknown) {
    super(`Embedding query blocked: audit event write failed. ${String(cause)}`);
    this.name = 'EmbeddingAuditError';
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CorpusChunkRow {
  id: string;
  tenant_id: string;
  source_id: string | null;
  content: string;
  chunk_index: number;
  /** Cosine similarity score: 1 − cosine_distance. Range [0, 1]. */
  similarity: number;
}

export interface QueryByEmbeddingOptions {
  /** The query vector — must be 768 dimensions. */
  embedding: number[];
  /** Tenant whose chunks are searched. */
  tenantId: string;
  /** User performing the search (recorded in the audit event). */
  actorId: string;
  /** Maximum number of results. Default 10. */
  topK?: number;
  /** Correlation ID for distributed tracing. */
  correlationId?: string;
}

// ---------------------------------------------------------------------------
// Audit event helper
// ---------------------------------------------------------------------------

/**
 * The genesis hash constant: 64 zero hex digits.
 * Matches the value used in audit-store.test.ts.
 */
const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const sorted = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k]))
    .join(',');
  return '{' + sorted + '}';
}

async function computeAuditHash(
  prevHash: string,
  payload: {
    actor_id: string;
    action: string;
    entity_type: string;
    entity_id: string;
    before: null;
    after: Record<string, unknown> | null;
    ts: string;
  },
): Promise<string> {
  const data =
    prevHash +
    `{"actor_id":${JSON.stringify(payload.actor_id)},"action":${JSON.stringify(payload.action)},"entity_type":${JSON.stringify(payload.entity_type)},"entity_id":${JSON.stringify(payload.entity_id)},"before":${canonicalJson(payload.before)},"after":${canonicalJson(payload.after)},"ts":${JSON.stringify(payload.ts)}}`;

  const encoder = new TextEncoder();
  const buf = encoder.encode(data);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Write one audit event to the `audit_events` table using the provided pool.
 * Runs inside a SERIALIZABLE transaction to maintain the hash chain.
 * Throws on any database error — callers must block the query on failure.
 */
async function writeAuditEvent(
  auditSql: postgres.Sql,
  opts: {
    actorId: string;
    tenantId: string;
    topK: number;
    correlationId?: string;
    ts: string;
  },
): Promise<void> {
  const reserved = await auditSql.reserve();
  try {
    await reserved.unsafe('BEGIN ISOLATION LEVEL SERIALIZABLE');

    const latestRows = (await reserved.unsafe(
      'SELECT hash FROM audit_events ORDER BY ts DESC, id DESC LIMIT 1',
    )) as unknown as { hash: string }[];

    const prevHash = latestRows[0]?.hash ?? GENESIS_HASH;

    const afterPayload: Record<string, unknown> = {
      top_k: opts.topK,
      tenant_id: opts.tenantId,
    };

    const hash = await computeAuditHash(prevHash, {
      actor_id: opts.actorId,
      action: 'corpus_chunk.similarity_query',
      entity_type: 'corpus_chunk',
      entity_id: opts.tenantId,
      before: null,
      after: afterPayload,
      ts: opts.ts,
    });

    await reserved.unsafe(
      `INSERT INTO audit_events
         (actor_id, action, entity_type, entity_id, before, after, ip, user_agent, correlation_id, ts, prev_hash, hash)
       VALUES ($1, $2, $3, $4, NULL, $5::jsonb, NULL, NULL, $6, $7::timestamptz, $8, $9)`,
      [
        opts.actorId,
        'corpus_chunk.similarity_query',
        'corpus_chunk',
        opts.tenantId,
        JSON.stringify(afterPayload),
        opts.correlationId ?? null,
        opts.ts,
        prevHash,
        hash,
      ],
    );

    await reserved.unsafe('COMMIT');
  } catch (err) {
    await reserved.unsafe('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    reserved.release();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find the `topK` corpus chunks most similar to `embedding` for `tenantId`.
 *
 * All four PRD §7 compensating controls are enforced:
 *   1. Rate limit checked first — throws `EmbeddingRateLimitError` if exceeded.
 *   2. Audit event written to `auditSql` before the similarity query executes.
 *      Throws `EmbeddingAuditError` if the write fails (query is blocked).
 *   3. Similarity query runs inside a transaction that sets
 *      `app.current_tenant_id` (RLS per-tenant scoping).
 *   4. The `embedding` column is never included in the returned rows.
 *
 * @param appSql    Postgres pool for the app database (app_rw role).
 * @param auditSql  Postgres pool for the audit database (audit_w role).
 * @param opts      Query options.
 * @param env       Process environment (for HNSW_EF_SEARCH override).
 */
export async function queryByEmbedding(
  appSql: postgres.Sql,
  auditSql: postgres.Sql,
  opts: QueryByEmbeddingOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CorpusChunkRow[]> {
  const topK = opts.topK ?? 10;

  // --- Compensating control 2: per-tenant rate limit ---
  const limiter = getEmbeddingLimiter();
  const rateResult = limiter.check(opts.tenantId);
  if (!rateResult.allowed) {
    throw new EmbeddingRateLimitError(opts.tenantId, rateResult);
  }

  const ts = new Date().toISOString();

  // --- Compensating control 1: audit-before-read ---
  try {
    await writeAuditEvent(auditSql, {
      actorId: opts.actorId,
      tenantId: opts.tenantId,
      topK,
      correlationId: opts.correlationId,
      ts,
    });
  } catch (err) {
    throw new EmbeddingAuditError(err);
  }

  // Audit write succeeded — record consumption in rate limiter.
  limiter.consume(opts.tenantId);

  // --- Compensating controls 3 & 4: no embedding column in result + RLS ---
  const { efSearch } = loadHnswQueryConfig(env);
  const vectorLiteral = `[${opts.embedding.join(',')}]`;

  return appSql.begin(async (tx) => {
    // Bind tenant context so the corpus_chunks_tenant_isolation RLS policy fires.
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${opts.tenantId.replace(/'/g, "''")}'`);
    // Set ef_search for this query's HNSW approximate search quality.
    await tx.unsafe(`SET LOCAL hnsw.ef_search = ${efSearch}`);

    // Return id, content, chunk_index, source_id, and similarity score only.
    // The embedding column is intentionally excluded (compensating control 3).
    const rows = await tx.unsafe<CorpusChunkRow[]>(
      `SELECT
         id,
         tenant_id,
         source_id,
         content,
         chunk_index,
         (1 - (embedding <=> $1::vector)) AS similarity
       FROM corpus_chunks
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vectorLiteral, topK],
    );

    return rows;
  }) as Promise<CorpusChunkRow[]>;
}
