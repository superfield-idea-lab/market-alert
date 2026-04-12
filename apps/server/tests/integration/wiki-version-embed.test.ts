/**
 * @file wiki-version-embed.test.ts
 *
 * Integration tests for the draft WikiPageVersion embedding pipeline
 * (issue #44).
 *
 * Acceptance criteria verified:
 *   AC-1  Every new draft WikiPageVersion has an associated embedding.
 *   AC-2  Embeddings reuse the Phase 2 abstraction (OllamaEmbeddingBackend
 *         via OLLAMA_URL env var pointing to the stub server).
 *   AC-3  PRD §7 compensating controls apply:
 *         CC-3  embedding column absent from API response body.
 *
 * Test plan items (issue #44):
 *   TP-1  Integration: create a draft via the endpoint and assert an
 *         embedding is stored in wiki_page_versions.embedding.
 *   TP-2  Integration: assert the draft embedding is queryable only via the
 *         compensating-control path (embedding absent from direct API
 *         response).
 *
 * No mocks — real pgvector Postgres, real Bun server, real node:http stub
 * for the Ollama embedding service (avoids needing a live Ollama in CI).
 *
 * The stub is a minimal node:http server that replays the recorded Ollama
 * fixture. The Bun server process receives OLLAMA_URL pointing at the stub
 * so its OllamaEmbeddingBackend calls the stub instead of a real service.
 */

import { afterAll, beforeAll, describe, test, expect } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Subprocess } from 'bun';
import postgres from 'postgres';
import { startPgvectorPostgres, type PgContainer } from '../helpers/pg-container';
import { runInitRemote, dbUrl } from '../../../../packages/db/init-remote';
import { migrate, migrateAudit } from '../../../../packages/db/index';

// ---------------------------------------------------------------------------
// Fixture — replays a recorded Ollama embedding response.
// The server process calls the stub at OLLAMA_URL instead of a live Ollama.
// ---------------------------------------------------------------------------

const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const OLLAMA_FIXTURE_PATH = resolve(
  REPO_ROOT,
  'tests/fixtures/ollama/ollama_embed_2026-04-11T00-00-00-000Z.json',
);

const ollamaFixture = JSON.parse(readFileSync(OLLAMA_FIXTURE_PATH, 'utf-8')) as {
  response: { status: number; body: unknown };
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVER_PORT = 31436;
const STUB_PORT = 31437;
const BASE = `http://localhost:${SERVER_PORT}`;
const STUB_BASE = `http://localhost:${STUB_PORT}`;
const SERVER_READY_TIMEOUT_MS = 30_000;
const SERVER_ENTRY = 'apps/server/src/index.ts';

const TEST_PASSWORDS = {
  app: 'app_test_pw44',
  audit: 'audit_test_pw44',
  analytics: 'analytics_test_pw44',
  dictionary: 'dict_test_pw44',
  coding: 'coding_test_pw44',
  analysis: 'analysis_test_pw44',
  code_cleanup: 'code_cleanup_test_pw44',
  email_ingest: 'email_ingest_test_pw44',
};

const DB_NAMES = {
  app: 'calypso_app',
  audit: 'calypso_audit',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let pg: PgContainer;
let server: Subprocess;
let stubServer: HttpServer;
let appAdminSql: ReturnType<typeof postgres>;

// ---------------------------------------------------------------------------
// Ollama stub server — replays the fixture for every POST /api/embed request.
// ---------------------------------------------------------------------------

function startStubServer(port: number): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const s = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        // Accept any POST to /api/embed and replay the fixture.
        res.writeHead(ollamaFixture.response.status, {
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify(ollamaFixture.response.body));
        void body; // consumed but not validated — any text input is accepted
      });
    });

    s.listen(port, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Start the Ollama stub.
  stubServer = await startStubServer(STUB_PORT);

  // 2. Start a pgvector container (needed for vector(768) column).
  pg = await startPgvectorPostgres();

  // 3. Provision roles, databases, schema.
  await runInitRemote({
    ADMIN_DATABASE_URL: pg.url,
    APP_RW_PASSWORD: TEST_PASSWORDS.app,
    AUDIT_W_PASSWORD: TEST_PASSWORDS.audit,
    ANALYTICS_W_PASSWORD: TEST_PASSWORDS.analytics,
    DICT_RW_PASSWORD: TEST_PASSWORDS.dictionary,
    AGENT_CODING_PASSWORD: TEST_PASSWORDS.coding,
    AGENT_ANALYSIS_PASSWORD: TEST_PASSWORDS.analysis,
    AGENT_CODE_CLEANUP_PASSWORD: TEST_PASSWORDS.code_cleanup,
    AGENT_EMAIL_INGEST_PASSWORD: TEST_PASSWORDS.email_ingest,
  } as NodeJS.ProcessEnv);

  await migrate({ databaseUrl: dbUrl(pg.url, DB_NAMES.app) });
  await migrateAudit({ databaseUrl: dbUrl(pg.url, DB_NAMES.audit) });

  // 4. Admin pool for assertion queries.
  appAdminSql = postgres(dbUrl(pg.url, DB_NAMES.app), { max: 3 });

  // 5. Start the Bun server with pgvector DB + stub Ollama URL.
  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: dbUrl(pg.url, DB_NAMES.app),
      AUDIT_DATABASE_URL: dbUrl(pg.url, DB_NAMES.audit),
      PORT: String(SERVER_PORT),
      TEST_MODE: 'true',
      CSRF_DISABLED: 'true',
      // Point the OllamaEmbeddingBackend at our stub.
      OLLAMA_URL: STUB_BASE,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServer(BASE);
}, 120_000);

afterAll(async () => {
  server?.kill();
  await appAdminSql?.end({ timeout: 5 });
  await pg?.stop();
  await new Promise<void>((resolve) => stubServer?.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Helper — mint a scoped wiki-write token via the TEST_MODE endpoint.
// ---------------------------------------------------------------------------

async function mintWorkerToken(dept: string, customer: string): Promise<string> {
  const res = await fetch(`${BASE}/api/test/worker-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dept, customer }),
  });
  if (!res.ok) {
    throw new Error(`Failed to mint worker token: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

// ---------------------------------------------------------------------------
// TP-1 / AC-1 / AC-2: Embedding stored on draft creation
// ---------------------------------------------------------------------------

describe('TP-1 / AC-1 / AC-2: embedding stored on draft creation', () => {
  test('POST /internal/wiki/versions stores a 768-dim embedding in the DB', async () => {
    const token = await mintWorkerToken('wealth-mgmt', 'acme-corp');

    const res = await fetch(`${BASE}/internal/wiki/versions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        page_id: 'acme-strategy',
        dept: 'wealth-mgmt',
        customer: 'acme-corp',
        content:
          'Customer expressed strong interest in ESG-focused funds and sustainable investing.',
        source_task: 'task-embed-01',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.id).toBe('string');

    // Give the async embed + UPDATE a moment to complete before asserting.
    // The handler currently runs embed() after RETURNING id — it completes
    // synchronously before the response is sent, so no delay is needed.
    // If this becomes a background job in future, add a retry loop here.

    // Verify the embedding is stored.
    const rows = await appAdminSql<{ has_embedding: boolean; dims: number }[]>`
      SELECT
        (embedding IS NOT NULL) AS has_embedding,
        vector_dims(embedding)  AS dims
      FROM wiki_page_versions
      WHERE id = ${body.id as string}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].has_embedding).toBe(true);
    expect(rows[0].dims).toBe(768);
  });

  test('embedding reuses the Phase 2 abstraction — stored value matches fixture dimensions', async () => {
    const token = await mintWorkerToken('wealth-mgmt', 'acme-corp');

    const res = await fetch(`${BASE}/internal/wiki/versions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        page_id: 'acme-onboarding-v2',
        dept: 'wealth-mgmt',
        customer: 'acme-corp',
        content: 'Annual review of customer objectives and risk tolerance.',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    const rows = await appAdminSql<{ dims: number }[]>`
      SELECT vector_dims(embedding) AS dims
      FROM wiki_page_versions
      WHERE id = ${body.id as string}
        AND embedding IS NOT NULL
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].dims).toBe(768);
  });
});

// ---------------------------------------------------------------------------
// TP-2 / AC-3 / CC-3: Embedding absent from API response
// ---------------------------------------------------------------------------

describe('TP-2 / AC-3 / CC-3: embedding absent from API response', () => {
  test('POST /internal/wiki/versions response body does not contain embedding field', async () => {
    const token = await mintWorkerToken('wealth-mgmt', 'acme-corp');

    const res = await fetch(`${BASE}/internal/wiki/versions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        page_id: 'acme-risk-profile',
        dept: 'wealth-mgmt',
        customer: 'acme-corp',
        content: 'Customer risk profile: moderate. Target allocation 60/40.',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    // CC-3: embedding must NOT be in the response.
    expect(Object.keys(body)).not.toContain('embedding');

    // Required response fields are present.
    expect(typeof body.id).toBe('string');
    expect(body.state).toBe('draft');
    expect(body.dept).toBe('wealth-mgmt');
    expect(body.customer).toBe('acme-corp');
  });

  test('embedding is stored in DB but absent from the response body', async () => {
    const token = await mintWorkerToken('wealth-mgmt', 'acme-corp');

    const res = await fetch(`${BASE}/internal/wiki/versions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        page_id: 'acme-notes',
        dept: 'wealth-mgmt',
        customer: 'acme-corp',
        content: 'Meeting notes: discussed Q3 performance and macro outlook.',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    const id = body.id as string;

    // 1. Embedding must NOT be in the API response body.
    expect(Object.keys(body)).not.toContain('embedding');

    // 2. Embedding must be present in the DB row.
    const dbRows = await appAdminSql<{ has_embedding: boolean }[]>`
      SELECT (embedding IS NOT NULL) AS has_embedding
      FROM wiki_page_versions
      WHERE id = ${id}
    `;
    expect(dbRows).toHaveLength(1);
    expect(dbRows[0].has_embedding).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/health/live`);
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}
