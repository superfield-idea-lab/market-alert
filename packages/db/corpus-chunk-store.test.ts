/**
 * Integration tests for the CorpusChunk embedding query path.
 *
 * Spins up a real ephemeral pgvector/pgvector:pg16 Docker container
 * (required for the vector extension and HNSW index).
 *
 * Proves each PRD §7 compensating control:
 *
 *   CC-1  Audit: every similarity query emits an audit event before data flows.
 *   CC-2  Rate limit: per-tenant excess queries are rejected.
 *   CC-3  No public API / no embedding column: returned rows never contain
 *         the `embedding` field.
 *   CC-4  RLS: per-tenant scoping — cross-tenant similarity queries return
 *         zero results.
 *
 * Test plan items (from issue #31):
 *   TP-1  Integration: run a similarity query and assert the audit event,
 *         rate-limit counter, and RLS filter.
 *   TP-2  Integration: attempt to exceed the rate limit and assert rejection.
 *   TP-3  Integration: attempt a cross-tenant similarity query and assert
 *         RLS blocks it.
 *
 * No mocks — real Postgres, real Docker container.
 */

import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import postgres from 'postgres';
import { startPgvectorPostgres, type PgContainer } from './pg-container';
import { runInitRemote, dbUrl } from './init-remote';
import { migrate } from './index';
import {
  queryByEmbedding,
  EmbeddingRateLimitError,
  EmbeddingAuditError,
  EmbeddingRateLimiter,
  setEmbeddingLimiter,
  loadHnswIndexConfig,
  loadHnswQueryConfig,
} from './corpus-chunk-store';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let pg: PgContainer;
let appAdminSql: ReturnType<typeof postgres>;
let auditAdminSql: ReturnType<typeof postgres>;
let auditWSql: ReturnType<typeof postgres>;
let appRwSql: ReturnType<typeof postgres>;

const TEST_PASSWORDS = {
  app: 'app_test_pw',
  audit: 'audit_test_pw',
  analytics: 'analytics_test_pw',
  dictionary: 'dict_test_pw',
  email_ingest: 'email_ingest_test_pw',
};

const DB_NAMES = {
  app: 'superfield_app',
  audit: 'superfield_audit',
};

function makeRoleUrl(adminUrl: string, db: string, role: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
}

/**
 * Build a 768-float vector with every dimension set to `fill`.
 * Note: all fill vectors point in the same direction in R^768, so cosine
 * similarity between any two fill vectors is 1.0 regardless of fill magnitude.
 * Use makeDirectionalVector for tests that need distinguishable directions.
 */
function makeVector(fill: number): number[] {
  return Array.from({ length: 768 }, () => fill);
}

/**
 * Build a 768-float vector where dimension `hotDim` is 1.0 and all others
 * are `baseline`.  Two vectors with different `hotDim` values are orthogonal
 * (cosine similarity 0) and can be distinguished by HNSW ranking.
 */
function makeDirectionalVector(hotDim: number, baseline = 0.01): number[] {
  return Array.from({ length: 768 }, (_, i) => (i === hotDim ? 1.0 : baseline));
}

const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';
const ACTOR_A = 'actor-alpha';

beforeAll(async () => {
  pg = await startPgvectorPostgres();

  // Provision roles, databases, schema (including pgvector extension and HNSW index).
  await runInitRemote({
    ADMIN_DATABASE_URL: pg.url,
    APP_RW_PASSWORD: TEST_PASSWORDS.app,
    AUDIT_W_PASSWORD: TEST_PASSWORDS.audit,
    ANALYTICS_W_PASSWORD: TEST_PASSWORDS.analytics,
    DICT_RW_PASSWORD: TEST_PASSWORDS.dictionary,
    AGENT_EMAIL_INGEST_PASSWORD: TEST_PASSWORDS.email_ingest,
  } as NodeJS.ProcessEnv);

  // Run migrate() to apply the app schema (corpus_chunks + HNSW index).
  await migrate({ databaseUrl: dbUrl(pg.url, DB_NAMES.app) });

  appAdminSql = postgres(dbUrl(pg.url, DB_NAMES.app), { max: 3 });
  auditAdminSql = postgres(dbUrl(pg.url, DB_NAMES.audit), { max: 3 });
  auditWSql = postgres(makeRoleUrl(pg.url, DB_NAMES.audit, 'audit_w', TEST_PASSWORDS.audit), {
    max: 3,
  });
  appRwSql = postgres(makeRoleUrl(pg.url, DB_NAMES.app, 'app_rw', TEST_PASSWORDS.app), {
    max: 5,
  });

  // Insert test corpus chunks for TENANT_A and TENANT_B using the admin pool
  // (bypasses RLS for setup).
  // Each chunk uses a directional vector with a unique hot dimension so that
  // cosine similarity between chunks is well-defined and ordering is testable.
  // cc-a-1: hot dim 0, cc-a-2: hot dim 1, cc-b-1: hot dim 2
  await appAdminSql.unsafe(
    `INSERT INTO corpus_chunks (id, tenant_id, source_id, content, embedding, chunk_index)
     VALUES
       ('cc-a-1', $1, 'src-a', 'chunk content alpha 1', $2::vector, 0),
       ('cc-a-2', $1, 'src-a', 'chunk content alpha 2', $3::vector, 1),
       ('cc-b-1', $4, 'src-b', 'chunk content beta 1',  $5::vector, 0)`,
    [
      TENANT_A,
      `[${makeDirectionalVector(0).join(',')}]`,
      `[${makeDirectionalVector(1).join(',')}]`,
      TENANT_B,
      `[${makeDirectionalVector(2).join(',')}]`,
    ],
  );

  // Reset the module-level rate limiter to a generous limit for most tests.
  // Tests that verify rate-limit behaviour inject their own instance.
  setEmbeddingLimiter(new EmbeddingRateLimiter(60_000, 1000));
}, 120_000);

afterAll(async () => {
  await appRwSql?.end({ timeout: 5 });
  await appAdminSql?.end({ timeout: 5 });
  await auditWSql?.end({ timeout: 5 });
  await auditAdminSql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// HNSW configuration helpers
// ---------------------------------------------------------------------------

describe('HNSW configuration helpers', () => {
  test('loadHnswIndexConfig returns defaults when env vars are absent', () => {
    const cfg = loadHnswIndexConfig({});
    expect(cfg.m).toBe(16);
    expect(cfg.efConstruction).toBe(64);
  });

  test('loadHnswIndexConfig reads HNSW_M and HNSW_EF_CONSTRUCTION', () => {
    const cfg = loadHnswIndexConfig({ HNSW_M: '32', HNSW_EF_CONSTRUCTION: '128' });
    expect(cfg.m).toBe(32);
    expect(cfg.efConstruction).toBe(128);
  });

  test('loadHnswQueryConfig returns default ef_search 40 when env var is absent', () => {
    const cfg = loadHnswQueryConfig({});
    expect(cfg.efSearch).toBe(40);
  });

  test('loadHnswQueryConfig reads HNSW_EF_SEARCH', () => {
    const cfg = loadHnswQueryConfig({ HNSW_EF_SEARCH: '80' });
    expect(cfg.efSearch).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// CC-1 / TP-1: Audit event emitted before data flows
// ---------------------------------------------------------------------------

describe('CC-1: audit event before data flows (TP-1)', () => {
  test('a similarity query emits an audit event with action corpus_chunk.similarity_query', async () => {
    setEmbeddingLimiter(new EmbeddingRateLimiter(60_000, 1000));

    const beforeTs = new Date().toISOString();

    const results = await queryByEmbedding(appRwSql, auditWSql, {
      embedding: makeVector(0.15),
      tenantId: TENANT_A,
      actorId: ACTOR_A,
      topK: 2,
      correlationId: 'corr-audit-test',
    });

    // At least one result returned for TENANT_A
    expect(results.length).toBeGreaterThanOrEqual(1);

    // Verify audit event was written before data was returned
    const auditRows = await auditAdminSql<
      { actor_id: string; action: string; entity_id: string; correlation_id: string }[]
    >`
      SELECT actor_id, action, entity_id, correlation_id
      FROM audit_events
      WHERE action = 'corpus_chunk.similarity_query'
        AND entity_id = ${TENANT_A}
        AND ts >= ${beforeTs}::timestamptz
      ORDER BY ts DESC
      LIMIT 1
    `;

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].actor_id).toBe(ACTOR_A);
    expect(auditRows[0].action).toBe('corpus_chunk.similarity_query');
    expect(auditRows[0].correlation_id).toBe('corr-audit-test');
  });

  test('audit write failure blocks the query — EmbeddingAuditError is thrown', async () => {
    setEmbeddingLimiter(new EmbeddingRateLimiter(60_000, 1000));

    // Pass a broken pool (invalid URL) as auditSql to force an audit write failure.
    const brokenAuditSql = postgres('postgres://invalid:invalid@localhost:1/invalid', {
      max: 1,
      connect_timeout: 1,
    });

    try {
      await expect(
        queryByEmbedding(appRwSql, brokenAuditSql, {
          embedding: makeVector(0.1),
          tenantId: TENANT_A,
          actorId: ACTOR_A,
          topK: 1,
        }),
      ).rejects.toThrow(EmbeddingAuditError);
    } finally {
      await brokenAuditSql.end({ timeout: 1 }).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// CC-2 / TP-2: Rate limit per tenant
// ---------------------------------------------------------------------------

describe('CC-2: per-tenant rate limit (TP-2)', () => {
  test('queries below the limit are allowed', async () => {
    setEmbeddingLimiter(new EmbeddingRateLimiter(60_000, 5));

    for (let i = 0; i < 5; i++) {
      const results = await queryByEmbedding(appRwSql, auditWSql, {
        embedding: makeVector(0.1),
        tenantId: TENANT_A,
        actorId: ACTOR_A,
        topK: 1,
      });
      expect(results.length).toBeGreaterThanOrEqual(0);
    }
  });

  test('the (limit+1)th query from the same tenant in the same window throws EmbeddingRateLimitError', async () => {
    // Fresh limiter: 5 per minute
    setEmbeddingLimiter(new EmbeddingRateLimiter(60_000, 5));

    for (let i = 0; i < 5; i++) {
      await queryByEmbedding(appRwSql, auditWSql, {
        embedding: makeVector(0.1),
        tenantId: TENANT_A,
        actorId: ACTOR_A,
        topK: 1,
      });
    }

    await expect(
      queryByEmbedding(appRwSql, auditWSql, {
        embedding: makeVector(0.1),
        tenantId: TENANT_A,
        actorId: ACTOR_A,
        topK: 1,
      }),
    ).rejects.toThrow(EmbeddingRateLimitError);
  });

  test('rate limit is scoped per tenant — TENANT_B is not affected by TENANT_A exhaustion', async () => {
    // Fresh limiter: 2 per minute
    setEmbeddingLimiter(new EmbeddingRateLimiter(60_000, 2));

    // Exhaust TENANT_A
    for (let i = 0; i < 2; i++) {
      await queryByEmbedding(appRwSql, auditWSql, {
        embedding: makeVector(0.1),
        tenantId: TENANT_A,
        actorId: ACTOR_A,
        topK: 1,
      });
    }

    // TENANT_A is exhausted
    await expect(
      queryByEmbedding(appRwSql, auditWSql, {
        embedding: makeVector(0.1),
        tenantId: TENANT_A,
        actorId: ACTOR_A,
        topK: 1,
      }),
    ).rejects.toThrow(EmbeddingRateLimitError);

    // TENANT_B is on a different key — unaffected
    const results = await queryByEmbedding(appRwSql, auditWSql, {
      embedding: makeVector(0.9),
      tenantId: TENANT_B,
      actorId: 'actor-beta',
      topK: 1,
    });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// CC-3: Embedding column not returned (no public API exposure)
// ---------------------------------------------------------------------------

describe('CC-3: embedding column absent from results', () => {
  test('returned rows do not contain an embedding field', async () => {
    setEmbeddingLimiter(new EmbeddingRateLimiter(60_000, 1000));

    const results = await queryByEmbedding(appRwSql, auditWSql, {
      embedding: makeVector(0.1),
      tenantId: TENANT_A,
      actorId: ACTOR_A,
      topK: 2,
    });

    expect(results.length).toBeGreaterThan(0);
    for (const row of results) {
      expect(Object.keys(row)).not.toContain('embedding');
      // Required fields must be present
      expect(row.id).toBeTruthy();
      expect(row.content).toBeTruthy();
      expect(typeof row.similarity).toBe('number');
      expect(row.similarity).toBeGreaterThan(0);
      expect(row.similarity).toBeLessThanOrEqual(1);
    }
  });

  test('results are ordered by descending similarity', async () => {
    setEmbeddingLimiter(new EmbeddingRateLimiter(60_000, 1000));

    // Query pointing towards dim 1 — cc-a-2 has hot dim 1, so it should rank first.
    const results = await queryByEmbedding(appRwSql, auditWSql, {
      embedding: makeDirectionalVector(1),
      tenantId: TENANT_A,
      actorId: ACTOR_A,
      topK: 2,
    });

    expect(results.length).toBe(2);
    // Similarity should be non-increasing
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity);
    }
    // The nearest chunk to dim-1 query is cc-a-2 (hot dim 1 exact)
    expect(results[0].id).toBe('cc-a-2');
  });
});

// ---------------------------------------------------------------------------
// CC-4 / TP-3: RLS blocks cross-tenant similarity queries
// ---------------------------------------------------------------------------

describe('CC-4: RLS per-tenant scoping (TP-3)', () => {
  test('TENANT_A session returns only TENANT_A chunks', async () => {
    setEmbeddingLimiter(new EmbeddingRateLimiter(60_000, 1000));

    const results = await queryByEmbedding(appRwSql, auditWSql, {
      embedding: makeVector(0.5),
      tenantId: TENANT_A,
      actorId: ACTOR_A,
      topK: 10,
    });

    // Only TENANT_A chunks should appear
    for (const row of results) {
      expect(row.tenant_id).toBe(TENANT_A);
    }
    // TENANT_B chunk cc-b-1 must not appear
    expect(results.map((r) => r.id)).not.toContain('cc-b-1');
  });

  test('TENANT_B session returns only TENANT_B chunks', async () => {
    setEmbeddingLimiter(new EmbeddingRateLimiter(60_000, 1000));

    const results = await queryByEmbedding(appRwSql, auditWSql, {
      embedding: makeVector(0.5),
      tenantId: TENANT_B,
      actorId: 'actor-beta',
      topK: 10,
    });

    for (const row of results) {
      expect(row.tenant_id).toBe(TENANT_B);
    }
    // TENANT_A chunks must not appear
    expect(results.map((r) => r.id)).not.toContain('cc-a-1');
    expect(results.map((r) => r.id)).not.toContain('cc-a-2');
  });

  test('RLS is enabled on corpus_chunks table', async () => {
    const [row] = await appAdminSql<{ rowsecurity: boolean }[]>`
      SELECT relrowsecurity AS rowsecurity
      FROM pg_class
      WHERE relname = 'corpus_chunks'
        AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
    `;
    expect(row.rowsecurity).toBe(true);
  });

  test('corpus_chunks_tenant_isolation policy exists', async () => {
    const rows = await appAdminSql<{ policyname: string }[]>`
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'corpus_chunks'
        AND policyname = 'corpus_chunks_tenant_isolation'
    `;
    expect(rows).toHaveLength(1);
  });

  test('HNSW index exists on corpus_chunks.embedding', async () => {
    const rows = await appAdminSql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'corpus_chunks'
        AND indexname = 'idx_corpus_chunks_embedding_hnsw'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef.toLowerCase()).toContain('hnsw');
  });
});
