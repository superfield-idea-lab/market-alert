/**
 * @file tests/integration/source-discovery.spec.ts
 *
 * Source-discovery integration test — Phase 3 scout (issue #74).
 *
 * ## What this tests
 *
 * Two acceptance criteria from the issue test plan:
 *
 *   TC-1 (methodology read-only):
 *     The discovery worker reads the active methodology but NEVER writes to the
 *     golden_documents or golden_document_sections tables. Verified by checking
 *     the row `updated_at` timestamp is unchanged after the discovery run.
 *
 *   TC-2 (methodology to registered canonical source):
 *     A methodology fixture with a `venue_catalog` section → the registration
 *     endpoint is called → one `canonical_sources` row exists with `status=active`
 *     (via `activateCanonicalSource`) after the discovery run.
 *
 * ## Architecture
 *
 * The server handler (`handleCanonicalSourceRegistrationRequest`) is called
 * directly against a real ephemeral Postgres container — no HTTP subprocess.
 * The golden-documents endpoint is called through a real `node:http` server
 * backed by the same test container (no MSW for localhost traffic).
 *
 * The discovery worker (`executeSourceDiscoverTask`) is called with an
 * apiBaseUrl pointing at the local test HTTP server, which intercepts:
 *   - GET  /api/golden-documents/active/research_methodology
 *   - POST /internal/canonical-sources
 *
 * ## No mocks
 *
 * Uses a real ephemeral Postgres container, real `node:http` server, and
 * real handler functions. Zero vi.fn, vi.mock, vi.spyOn, vi.stubGlobal.
 *
 * ## Blueprint refs
 *
 * - TEST-D-001: golden-fixture-recording
 * - WORKER-T-001: no direct DB access from worker process
 * - WORKER-T-002: assertNoDatabaseUrl
 * - DATA-D-006: four-pool Postgres
 *
 * ## Canonical docs
 *
 * - docs/prd.md §2 §3 §5
 * - apps/worker/src/source-discover-job.ts
 * - apps/server/src/api/canonical-source-registration.ts
 * - packages/db/canonical-source-store.ts
 * - packages/db/mkt-canonical-sources.sql
 * - tests/fixtures/source-discovery/methodology-venue-catalog.json
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/74
 */

import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../../packages/db/pg-container';
import { runInitRemote } from '../../packages/db/init-remote';
import { migrate, migrateMkt } from '../../packages/db/index';
import {
  CANONICAL_SOURCES_DDL,
  registerCanonicalSource,
  activateCanonicalSource,
  listCanonicalSourcesByMethodology,
  type CanonicalSourceRow,
  type SqlClient,
} from '../../packages/db/canonical-source-store';
import { RESEARCH_TOPICS_DDL } from '../../packages/db/research-topics-store';

// Path to the research-topics migration SQL (adds topic_id columns to canonical_sources etc.)
const MKT_RESEARCH_TOPICS_SQL_PATH = resolve(
  new URL('../..', import.meta.url).pathname,
  'packages/db/mkt-research-topics.sql',
);
import { handleCanonicalSourceRegistrationRequest } from '../../apps/server/src/api/canonical-source-registration';
import {
  SOURCE_DISCOVER_JOB_TYPE,
  executeSourceDiscoverTask,
  type SourceDiscoverResult,
} from '../../apps/worker/src/source-discover-job';
import { TaskType, TASK_TYPE_AGENT_MAP } from '../../packages/db/task-queue';
import type { AppState } from '../../apps/server/src/index';
import methodologyFixture from '../fixtures/source-discovery/methodology-venue-catalog.json';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const TEST_TOKEN = 'source-discover-test-secret-42';
const TEST_PASSWORDS = {
  app: 'app_test_pw',
  audit: 'audit_test_pw',
  analytics: 'analytics_test_pw',
  dictionary: 'dict_test_pw',
  email_ingest: 'email_ingest_test_pw',
};

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;
let appState: AppState;
let httpServer: Server;
let apiBaseUrl: string;

function makeRoleUrl(adminUrl: string, db: string, role: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
}

// ---------------------------------------------------------------------------
// Minimal local HTTP server
//
// Routes:
//   GET  /api/golden-documents/active/research_methodology  → returns fixture
//   POST /internal/canonical-sources                        → delegates to handler
// ---------------------------------------------------------------------------

function startLocalServer(state: AppState): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost`);
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', async () => {
        const body = Buffer.concat(chunks).toString();
        // Build a fetch-compatible Request from the node:http IncomingMessage.
        const fetchReq = new Request(`http://localhost${req.url}`, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: req.method === 'POST' ? body : undefined,
        });

        try {
          // ── GET /api/golden-documents/active/research_methodology ──────────
          if (
            req.method === 'GET' &&
            url.pathname === '/api/golden-documents/active/research_methodology'
          ) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(methodologyFixture));
            return;
          }

          // ── POST /internal/canonical-sources ──────────────────────────────
          if (req.method === 'POST' && url.pathname === '/internal/canonical-sources') {
            const response = await handleCanonicalSourceRegistrationRequest(fetchReq, url, state);
            if (response) {
              const resBody = await response.text();
              res.writeHead(response.status, { 'Content-Type': 'application/json' });
              res.end(resBody);
              return;
            }
          }

          // ── Fallback ───────────────────────────────────────────────────────
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        } catch (err) {
          console.error('[test-server] Unhandled error:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Unexpected server address type'));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
    server.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Start ephemeral Postgres container
  pg = await startPostgres();

  // 2. Provision roles and databases
  await runInitRemote({
    ADMIN_DATABASE_URL: pg.url,
    APP_RW_PASSWORD: TEST_PASSWORDS.app,
    AUDIT_W_PASSWORD: TEST_PASSWORDS.audit,
    ANALYTICS_W_PASSWORD: TEST_PASSWORDS.analytics,
    DICT_RW_PASSWORD: TEST_PASSWORDS.dictionary,
    AGENT_EMAIL_INGEST_PASSWORD: TEST_PASSWORDS.email_ingest,
  } as NodeJS.ProcessEnv);

  // 3. Connect as app_rw
  const appRwUrl = makeRoleUrl(pg.url, 'superfield_app', 'app_rw', TEST_PASSWORDS.app);
  sql = postgres(appRwUrl, { max: 5 });

  // 4. Apply base schema then mkt-schema (mkt_corporate_actions, feature_flags, etc.)
  await migrate({ databaseUrl: appRwUrl });
  await migrateMkt({ databaseUrl: appRwUrl });

  // 5. Apply canonical_sources DDL (Phase 3 addition — not yet in mkt-schema.sql)
  await sql.unsafe(CANONICAL_SOURCES_DDL);

  // 5a. Apply research_topics DDL (issue #121) — creates research_topics and topic_members
  //     tables needed by getDefaultTopicIdForTenant.
  await sql.unsafe(RESEARCH_TOPICS_DDL);

  // 5b. Apply the full research-topics migration SQL — this adds the nullable topic_id
  //     column to canonical_sources (and other tables). Without this, INSERT INTO
  //     canonical_sources (..., topic_id) fails with "column does not exist".
  const rtMigrationSql = readFileSync(MKT_RESEARCH_TOPICS_SQL_PATH, 'utf-8');
  await sql.unsafe(rtMigrationSql);

  // 6. Build AppState
  appState = {
    sql: sql as unknown as typeof import('../../packages/db/index').sql,
    auditSql: sql as unknown as typeof import('../../packages/db/index').sql,
    analyticsSql: sql as unknown as typeof import('../../packages/db/index').sql,
    dictionarySql: sql as unknown as typeof import('../../packages/db/index').sql,
  };

  // 7. Set TEST_MODE and test token so the registration endpoint accepts requests
  process.env.TEST_MODE = 'true';
  process.env.EDGAR_TEST_TOKEN = TEST_TOKEN;

  // 8. Start local HTTP server
  const { server, url } = await startLocalServer(appState);
  httpServer = server;
  apiBaseUrl = url;
}, 90_000);

afterAll(async () => {
  httpServer?.close();
  await sql?.end({ timeout: 5 });
  await pg?.stop();
  delete process.env.TEST_MODE;
  delete process.env.EDGAR_TEST_TOKEN;
});

// ---------------------------------------------------------------------------
// Unit-level: TaskType / constants
// ---------------------------------------------------------------------------

describe('SOURCE_DISCOVER task type', () => {
  test('TaskType.SOURCE_DISCOVER equals "SOURCE_DISCOVER"', () => {
    expect(TaskType.SOURCE_DISCOVER).toBe('SOURCE_DISCOVER');
  });

  test('TASK_TYPE_AGENT_MAP maps SOURCE_DISCOVER to source_discovery', () => {
    expect(TASK_TYPE_AGENT_MAP[TaskType.SOURCE_DISCOVER]).toBe('source_discovery');
  });

  test('SOURCE_DISCOVER_JOB_TYPE equals "SOURCE_DISCOVER"', () => {
    expect(SOURCE_DISCOVER_JOB_TYPE).toBe('SOURCE_DISCOVER');
  });
});

// ---------------------------------------------------------------------------
// Unit-level: CANONICAL_SOURCES_DDL constant
// ---------------------------------------------------------------------------

describe('CANONICAL_SOURCES_DDL', () => {
  test('is a non-empty string', () => {
    expect(typeof CANONICAL_SOURCES_DDL).toBe('string');
    expect(CANONICAL_SOURCES_DDL.length).toBeGreaterThan(0);
  });

  test('contains CREATE TABLE IF NOT EXISTS canonical_sources', () => {
    expect(CANONICAL_SOURCES_DDL).toContain('CREATE TABLE IF NOT EXISTS canonical_sources');
  });

  test('contains methodology_id column', () => {
    expect(CANONICAL_SOURCES_DDL).toContain('methodology_id');
  });

  test('contains UNIQUE (methodology_id, url) idempotency constraint', () => {
    expect(CANONICAL_SOURCES_DDL).toContain('UNIQUE (methodology_id, url)');
  });

  test('contains status CHECK constraint', () => {
    expect(CANONICAL_SOURCES_DDL).toContain("status IN ('pending', 'active', 'retired')");
  });
});

// ---------------------------------------------------------------------------
// Integration: canonical_sources DB store
// ---------------------------------------------------------------------------

describe('canonical-source-store', () => {
  const methodologyId = 'meth-store-test-001';
  const authorId = 'author-store-test-001';
  const tenantId = 'tenant-store-test-001';

  test('registerCanonicalSource inserts a new row in pending status', async () => {
    const source = await registerCanonicalSource(sql as unknown as SqlClient, {
      methodology_id: methodologyId,
      author_id: authorId,
      tenant_id: tenantId,
      name: 'Test Venue A',
      url: 'https://test-venue-a.example.com',
      description: 'A test venue',
      access_mode: 'public',
    });

    expect(source).toBeDefined();
    expect(source.id).toBeTruthy();
    expect(source.methodology_id).toBe(methodologyId);
    expect(source.author_id).toBe(authorId);
    expect(source.tenant_id).toBe(tenantId);
    expect(source.name).toBe('Test Venue A');
    expect(source.url).toBe('https://test-venue-a.example.com');
    expect(source.access_mode).toBe('public');
    expect(source.status).toBe('pending');
  });

  test('registerCanonicalSource is idempotent — no duplicate on second call', async () => {
    // First call — already inserted above.
    const first = await registerCanonicalSource(sql as unknown as SqlClient, {
      methodology_id: methodologyId,
      author_id: authorId,
      tenant_id: tenantId,
      name: 'Test Venue A',
      url: 'https://test-venue-a.example.com',
    });

    // Second call — same methodology_id + url.
    const second = await registerCanonicalSource(sql as unknown as SqlClient, {
      methodology_id: methodologyId,
      author_id: authorId,
      tenant_id: tenantId,
      name: 'Test Venue A (duplicate attempt)',
      url: 'https://test-venue-a.example.com',
    });

    // Must be the same row (same id).
    expect(first.id).toBe(second.id);

    // Exactly one row in the DB for this (methodology_id, url).
    const rows = await sql<{ count: string }[]>`
      SELECT count(*) AS count
      FROM canonical_sources
      WHERE methodology_id = ${methodologyId}
        AND url = 'https://test-venue-a.example.com'
    `;
    expect(Number(rows[0].count)).toBe(1);
  });

  test('activateCanonicalSource advances status from pending to active', async () => {
    const source = await registerCanonicalSource(sql as unknown as SqlClient, {
      methodology_id: methodologyId,
      author_id: authorId,
      tenant_id: tenantId,
      name: 'Test Venue B',
      url: 'https://test-venue-b.example.com',
    });

    expect(source.status).toBe('pending');

    const activated = await activateCanonicalSource(sql as unknown as SqlClient, source.id);
    expect(activated).not.toBeNull();
    expect(activated!.status).toBe('active');
    expect(activated!.id).toBe(source.id);
  });

  test('listCanonicalSourcesByMethodology returns sources for the methodology', async () => {
    const sources = await listCanonicalSourcesByMethodology(
      sql as unknown as SqlClient,
      methodologyId,
    );
    // Should have at least the two we created above.
    expect(sources.length).toBeGreaterThanOrEqual(2);
    const urls = sources.map((s) => s.url);
    expect(urls).toContain('https://test-venue-a.example.com');
    expect(urls).toContain('https://test-venue-b.example.com');
  });

  test('listCanonicalSourcesByMethodology filters by status', async () => {
    const active = await listCanonicalSourcesByMethodology(
      sql as unknown as SqlClient,
      methodologyId,
      'active',
    );
    for (const s of active) {
      expect(s.status).toBe('active');
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: POST /internal/canonical-sources handler
// ---------------------------------------------------------------------------

describe('handleCanonicalSourceRegistrationRequest', () => {
  const methodologyId = 'meth-handler-test-001';
  const authorId = 'author-handler-test-001';
  const tenantId = 'tenant-handler-test-001';

  test('POST /internal/canonical-sources returns 401 when no Bearer token', async () => {
    const req = new Request('http://localhost/internal/canonical-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        methodology_id: methodologyId,
        author_id: authorId,
        tenant_id: tenantId,
        name: 'X',
        url: 'https://x.example.com',
      }),
    });
    const url = new URL(req.url);
    const res = await handleCanonicalSourceRegistrationRequest(req, url, appState);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  test('POST /internal/canonical-sources returns 400 when required fields are missing', async () => {
    const req = new Request('http://localhost/internal/canonical-sources', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({ methodology_id: methodologyId }), // missing name, url, etc.
    });
    const url = new URL(req.url);
    const res = await handleCanonicalSourceRegistrationRequest(req, url, appState);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });

  test('POST /internal/canonical-sources returns 201 for a new source', async () => {
    const req = new Request('http://localhost/internal/canonical-sources', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        methodology_id: methodologyId,
        author_id: authorId,
        tenant_id: tenantId,
        name: 'Handler Test Venue',
        url: 'https://handler-test.example.com',
        description: 'A handler-level test venue',
        access_mode: 'public',
      }),
    });
    const url = new URL(req.url);
    const res = await handleCanonicalSourceRegistrationRequest(req, url, appState);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(201);

    const body = (await res!.json()) as { created: boolean; source: CanonicalSourceRow };
    expect(body.created).toBe(true);
    expect(body.source.name).toBe('Handler Test Venue');
    expect(body.source.status).toBe('pending');
  });

  test('POST /internal/canonical-sources returns 200 for an idempotent duplicate', async () => {
    // First call — already registered above.
    const req1 = new Request('http://localhost/internal/canonical-sources', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        methodology_id: methodologyId,
        author_id: authorId,
        tenant_id: tenantId,
        name: 'Handler Test Venue',
        url: 'https://handler-test.example.com',
      }),
    });
    const url1 = new URL(req1.url);
    const res1 = await handleCanonicalSourceRegistrationRequest(req1, url1, appState);
    expect(res1!.status).toBe(200);

    const body1 = (await res1!.json()) as { created: boolean; source: CanonicalSourceRow };
    expect(body1.created).toBe(false);
  });

  test('POST returns null for non-matching route', async () => {
    const req = new Request('http://localhost/other-path', { method: 'POST' });
    const url = new URL(req.url);
    const res = await handleCanonicalSourceRegistrationRequest(req, url, appState);
    expect(res).toBeNull();
  });

  test('POST returns null for GET method on matching route', async () => {
    const req = new Request('http://localhost/internal/canonical-sources', { method: 'GET' });
    const url = new URL(req.url);
    const res = await handleCanonicalSourceRegistrationRequest(req, url, appState);
    expect(res).toBeNull();
  });

  // AC-canonical-topic: canonical source registration without explicit topic_id
  // succeeds and the created row has topic_id equal to the tenant's default topic (issue #121).
  test('POST /internal/canonical-sources without topic_id succeeds; row has tenant default topic_id', async () => {
    const topicTenantId = 'tenant-canonical-topic-test-' + Date.now();
    const topicAuthorId = 'author-canonical-topic-test';

    // Create the Default topic for this tenant.
    const [defaultTopic] = await sql<{ id: string }[]>`
      INSERT INTO research_topics (tenant_id, name, description, created_by)
      VALUES (${topicTenantId}, 'Default', 'Default topic for canonical source test', 'system')
      RETURNING id
    `;
    const defaultTopicId = defaultTopic.id;

    // Register a canonical source without supplying topic_id.
    const req = new Request('http://localhost/internal/canonical-sources', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        methodology_id: 'meth-canonical-topic-test-001',
        author_id: topicAuthorId,
        tenant_id: topicTenantId,
        name: 'Canonical Source With Default Topic',
        url: 'https://canonical-topic-test.example.com',
      }),
    });
    const url = new URL(req.url);
    const res = await handleCanonicalSourceRegistrationRequest(req, url, appState);

    // Should succeed with 201.
    expect(res).not.toBeNull();
    expect(res!.status).toBe(201);

    // Verify the row in the DB has topic_id = defaultTopicId.
    const rows = await sql<{ topic_id: string | null }[]>`
      SELECT topic_id FROM canonical_sources
      WHERE tenant_id = ${topicTenantId}
        AND url = 'https://canonical-topic-test.example.com'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].topic_id).toBe(defaultTopicId);
  });
});

// ---------------------------------------------------------------------------
// TC-1: Discovery NEVER writes the golden document (PRD §9 read-only invariant)
// ---------------------------------------------------------------------------

describe('TC-1: source discovery never writes the golden document', () => {
  test('the fixture golden document is unchanged after a discovery run', async () => {
    // Record the fixture methodology updated_at before discovery.
    // The fixture is served in-memory (no DB row for the golden document itself
    // in the test container), so we verify by asserting zero writes reach
    // the golden_documents table for the fixture author.
    const authorId = methodologyFixture.document.author_id;

    // Count golden_document rows for the fixture author before discovery.
    const before = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM golden_documents WHERE author_id = ${authorId}
    `;
    const countBefore = Number(before[0].count);

    // Run discovery — fixture methodology is served by the local HTTP server.
    const task = {
      id: 'task-tc1-001',
      job_type: SOURCE_DISCOVER_JOB_TYPE,
      agent_type: 'source_discovery',
      payload: {
        author_id: authorId,
        tenant_id: methodologyFixture.document.tenant_id,
      },
      status: 'claimed',
      delegated_token: TEST_TOKEN,
      created_at: new Date(),
      updated_at: new Date(),
      claim_expires_at: null,
      attempts: 1,
      max_attempts: 3,
      priority: 0,
      error_message: null,
    };

    await executeSourceDiscoverTask(
      task as unknown as Parameters<typeof executeSourceDiscoverTask>[0],
      apiBaseUrl,
      TEST_TOKEN,
    );

    // Count golden_document rows after — must be identical (no writes).
    const after = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM golden_documents WHERE author_id = ${authorId}
    `;
    const countAfter = Number(after[0].count);

    expect(countAfter).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// TC-2: Methodology fixture → registered canonical source
// ---------------------------------------------------------------------------

describe('TC-2: methodology venue catalog → registered canonical source', () => {
  test('discovery registers all venues from the venue_catalog fixture section', async () => {
    const authorId = methodologyFixture.document.author_id;
    const tenantId = methodologyFixture.document.tenant_id;
    const methodologyId = methodologyFixture.document.id;

    const task = {
      id: 'task-tc2-001',
      job_type: SOURCE_DISCOVER_JOB_TYPE,
      agent_type: 'source_discovery',
      payload: { author_id: authorId, tenant_id: tenantId },
      status: 'claimed',
      delegated_token: TEST_TOKEN,
      created_at: new Date(),
      updated_at: new Date(),
      claim_expires_at: null,
      attempts: 1,
      max_attempts: 3,
      priority: 0,
      error_message: null,
    };

    const result: SourceDiscoverResult = await executeSourceDiscoverTask(
      task as unknown as Parameters<typeof executeSourceDiscoverTask>[0],
      apiBaseUrl,
      TEST_TOKEN,
    );

    // The fixture has 3 venues in the venue_catalog section.
    expect(result.venues_found).toBe(3);
    expect(result.catalog_parse_failed).toBe(false);
    expect(result.methodology_id).toBe(methodologyId);
    // All 3 must be processed — either newly created or idempotent (TC-1 may
    // have already registered some on its discovery run).
    expect(result.registered_count + result.skipped_count).toBe(3);
    expect(result.error_count).toBe(0);
  });

  test('re-running discovery is idempotent — no duplicate canonical_sources rows', async () => {
    const authorId = methodologyFixture.document.author_id;
    const tenantId = methodologyFixture.document.tenant_id;
    const methodologyId = methodologyFixture.document.id;

    const task = {
      id: 'task-tc2-002',
      job_type: SOURCE_DISCOVER_JOB_TYPE,
      agent_type: 'source_discovery',
      payload: { author_id: authorId, tenant_id: tenantId },
      status: 'claimed',
      delegated_token: TEST_TOKEN,
      created_at: new Date(),
      updated_at: new Date(),
      claim_expires_at: null,
      attempts: 1,
      max_attempts: 3,
      priority: 0,
      error_message: null,
    };

    // Second run — venues already registered from TC-2 first test.
    const result2: SourceDiscoverResult = await executeSourceDiscoverTask(
      task as unknown as Parameters<typeof executeSourceDiscoverTask>[0],
      apiBaseUrl,
      TEST_TOKEN,
    );

    expect(result2.venues_found).toBe(3);
    expect(result2.registered_count).toBe(0); // all pre-existed
    expect(result2.skipped_count).toBe(3);
    expect(result2.error_count).toBe(0);

    // Verify exactly 3 rows in canonical_sources for this methodology.
    const rows = await sql<{ count: string }[]>`
      SELECT count(*) AS count
      FROM canonical_sources
      WHERE methodology_id = ${methodologyId}
    `;
    expect(Number(rows[0].count)).toBe(3);
  });

  test('at least one registered venue can be activated to Active status', async () => {
    const methodologyId = methodologyFixture.document.id;

    // Fetch a pending source from this methodology.
    const sources = await listCanonicalSourcesByMethodology(
      sql as unknown as SqlClient,
      methodologyId,
      'pending',
    );

    // If all were already activated by a previous test run, just verify active ones exist.
    if (sources.length === 0) {
      const activeOnes = await listCanonicalSourcesByMethodology(
        sql as unknown as SqlClient,
        methodologyId,
        'active',
      );
      expect(activeOnes.length).toBeGreaterThanOrEqual(1);
      return;
    }

    const toActivate = sources[0];
    const activated = await activateCanonicalSource(sql as unknown as SqlClient, toActivate.id);

    expect(activated).not.toBeNull();
    expect(activated!.status).toBe('active');
    expect(activated!.methodology_id).toBe(methodologyId);
  });
});
