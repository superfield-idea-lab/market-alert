/**
 * @file tests/integration/wiki-nav.spec.ts
 *
 * Integration tests for the wiki navigation API — issue #77.
 *
 * ## What this tests
 *
 * Test plan items from the issue:
 *
 *   TC-1 (wiki navigation renders citations):
 *     A published wiki_page_version with cites edges is returned by the
 *     drill-in API with its citation edges (confirmed_facts and corpus_chunks).
 *     Acceptance criterion AC-2: "Every claim links to its supporting source/fact."
 *
 *   TC-2 (prior versions remain navigable after rebuild):
 *     After two wiki rebuilds, both versions are listed in the version history.
 *     The prior version is accessible via the version-specific endpoint.
 *     Acceptance criterion: "Researcher can browse version history."
 *
 *   TC-3 (browse and search):
 *     The pages list endpoint returns wiki pages for a tenant.
 *     Subject-type filtering and search-by-prefix work correctly.
 *
 * ## Architecture
 *
 * Real ephemeral Postgres container. No mocks — real DB, real node:http server,
 * real handler functions. No vi.fn, vi.mock, vi.spyOn, vi.stubGlobal.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §9 — researcher navigates the wiki.
 * - packages/db/wiki-rebuild-store.ts — DB store.
 * - apps/server/src/api/wiki-nav-api.ts — API endpoints.
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/77
 */

import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../../packages/db/pg-container';
import { runInitRemote } from '../../packages/db/init-remote';
import { migrate, migrateMkt } from '../../packages/db/index';
import { WIKI_REBUILD_DDL } from '../../packages/db/wiki-rebuild-store';
import { WIKI_DEBATE_DDL } from '../../packages/db/wiki-debate-store';
import { handleWikiNavApiRequest } from '../../apps/server/src/api/wiki-nav-api';
import type { AppState } from '../../apps/server/src/index';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const TEST_TOKEN = 'wiki-nav-test-secret-77';
const TEST_PASSWORDS = {
  app: 'app_nav_test_pw',
  audit: 'audit_nav_test_pw',
  analytics: 'analytics_nav_test_pw',
  dictionary: 'dict_nav_test_pw',
  email_ingest: 'email_ingest_nav_test_pw',
};

const TENANT_ID = 'tenant-nav-77';

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;
let appState: AppState;
let httpServer: Server;
let apiBaseUrl: string;

// ---------------------------------------------------------------------------
// Local HTTP server
// ---------------------------------------------------------------------------

function startLocalServer(state: AppState): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost`);
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', async () => {
        const body = Buffer.concat(chunks).toString();
        const fetchReq = new Request(`http://localhost${req.url}`, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: ['POST', 'PATCH', 'PUT'].includes(req.method ?? '') ? body : undefined,
        });

        try {
          const response = await handleWikiNavApiRequest(fetchReq, url, state);

          if (response) {
            const resBody = await response.text();
            res.writeHead(response.status, { 'Content-Type': 'application/json' });
            res.end(resBody);
            return;
          }

          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        } catch (err) {
          console.error('[wiki-nav-test-server] Unhandled error:', err);
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

function makeRoleUrl(adminUrl: string, db: string, role: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pg = await startPostgres();

  await runInitRemote({
    ADMIN_DATABASE_URL: pg.url,
    APP_RW_PASSWORD: TEST_PASSWORDS.app,
    AUDIT_W_PASSWORD: TEST_PASSWORDS.audit,
    ANALYTICS_W_PASSWORD: TEST_PASSWORDS.analytics,
    DICT_RW_PASSWORD: TEST_PASSWORDS.dictionary,
    AGENT_EMAIL_INGEST_PASSWORD: TEST_PASSWORDS.email_ingest,
  } as NodeJS.ProcessEnv);

  const appRwUrl = makeRoleUrl(pg.url, 'superfield_app', 'app_rw', TEST_PASSWORDS.app);
  sql = postgres(appRwUrl, { max: 5 });

  await migrate({ databaseUrl: appRwUrl });
  await migrateMkt({ databaseUrl: appRwUrl });
  await sql.unsafe(WIKI_REBUILD_DDL);
  await sql.unsafe(WIKI_DEBATE_DDL);

  appState = {
    sql: sql as unknown as typeof import('../../packages/db/index').sql,
    auditSql: sql as unknown as typeof import('../../packages/db/index').sql,
    analyticsSql: sql as unknown as typeof import('../../packages/db/index').sql,
    dictionarySql: sql as unknown as typeof import('../../packages/db/index').sql,
  };

  process.env['TEST_MODE'] = 'true';
  process.env['WIKI_REBUILD_TEST_TOKEN'] = TEST_TOKEN;

  const server = await startLocalServer(appState);
  httpServer = server.server;
  apiBaseUrl = server.url;
}, 60_000);

afterAll(async () => {
  httpServer?.close();
  await sql?.end({ timeout: 5 });
  await pg?.stop();
  delete process.env['TEST_MODE'];
  delete process.env['WIKI_REBUILD_TEST_TOKEN'];
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const authHeaders = {
  Authorization: `Bearer ${TEST_TOKEN}`,
  'Content-Type': 'application/json',
};

/**
 * Seed a fully indexed wiki page version with citation edges.
 * Returns the page ID, version ID, and seeded citation IDs.
 */
async function seedIndexedWikiPage(
  subjectId: string,
  subjectType = 'company',
  bodyContent = '# Test company\n\n| Attribute | Value | Confidence |\n|---|---|---|\n| ceo | Jane Smith | 70% |',
): Promise<{
  wiki_page_id: string;
  wiki_page_version_id: string;
  fact_id: string;
}> {
  // Create wiki_pages row
  const pageRows = await sql<[{ id: string }]>`
    INSERT INTO wiki_pages (tenant_id, subject_type, subject_id)
    VALUES (${TENANT_ID}, ${subjectType}, ${subjectId})
    ON CONFLICT (tenant_id, subject_type, subject_id) DO UPDATE
      SET updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `;
  const wiki_page_id = pageRows[0]!.id;

  // Create wiki_page_versions_mkt row at status=indexed
  const versionRows = await sql<[{ id: string }]>`
    INSERT INTO wiki_page_versions_mkt
      (wiki_page_id, tenant_id, subject_type, subject_id, body_ciphertext, status)
    VALUES (
      ${wiki_page_id},
      ${TENANT_ID},
      ${subjectType},
      ${subjectId},
      ${bodyContent},
      'indexed'
    )
    RETURNING id
  `;
  const wiki_page_version_id = versionRows[0]!.id;

  // Advance the currently_published_version_id pointer
  await sql`
    UPDATE wiki_pages
    SET currently_published_version_id = ${wiki_page_version_id},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${wiki_page_id}
  `;

  // Seed a confirmed_fact
  const factRows = await sql<[{ id: string }]>`
    INSERT INTO confirmed_facts
      (tenant_id, corpus_chunk_id, subject_entity_id, subject_entity_type, attribute, value, confidence)
    VALUES (
      ${TENANT_ID},
      'chunk-nav-placeholder',
      ${subjectId},
      ${subjectType},
      'ceo',
      'Jane Smith',
      0.7
    )
    RETURNING id
  `;
  const fact_id = factRows[0]!.id;

  // Insert a cites edge from the version to the fact
  await sql`
    INSERT INTO wiki_page_cites
      (wiki_page_version_id, target_id, target_type)
    VALUES (
      ${wiki_page_version_id},
      ${fact_id},
      'confirmed_fact'
    )
    ON CONFLICT DO NOTHING
  `;

  return { wiki_page_id, wiki_page_version_id, fact_id };
}

// ---------------------------------------------------------------------------
// TC-1: wiki navigation renders citations
// ---------------------------------------------------------------------------

describe('TC-1: wiki page drill-in renders citations', () => {
  test('GET /api/wiki-nav/pages/:id returns current version with citation edges', async () => {
    const subjectId = `nav-tc1-${Date.now()}`;
    const { wiki_page_id, wiki_page_version_id, fact_id } = await seedIndexedWikiPage(subjectId);

    const res = await fetch(`${apiBaseUrl}/api/wiki-nav/pages/${wiki_page_id}`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      page: {
        id: string;
        subject_id: string;
        currently_published_version_id: string | null;
        open_debate_count: number;
      };
      current_version: {
        id: string;
        body_ciphertext: string | null;
        status: string;
      } | null;
      citations: Array<{ id: string; target_id: string; target_type: string }>;
    };

    expect(data.page.id).toBe(wiki_page_id);
    expect(data.page.subject_id).toBe(subjectId);
    expect(data.page.currently_published_version_id).toBe(wiki_page_version_id);
    expect(data.page.open_debate_count).toBe(0);

    expect(data.current_version).not.toBeNull();
    expect(data.current_version!.id).toBe(wiki_page_version_id);
    expect(data.current_version!.status).toBe('indexed');

    // AC-2: citations must be present for every claim
    expect(data.citations.length).toBeGreaterThan(0);
    const factCite = data.citations.find(
      (c) => c.target_id === fact_id && c.target_type === 'confirmed_fact',
    );
    expect(factCite).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TC-2: prior versions remain navigable after rebuild
// ---------------------------------------------------------------------------

describe('TC-2: prior versions remain navigable after rebuild', () => {
  test('version history lists all indexed versions and prior version is accessible', async () => {
    const subjectId = `nav-tc2-${Date.now()}`;
    const { wiki_page_id, wiki_page_version_id: v1Id } = await seedIndexedWikiPage(
      subjectId,
      'company',
      '# Version 1',
    );

    // Simulate a second rebuild: insert another indexed version and advance pointer
    const v2Rows = await sql<[{ id: string }]>`
      INSERT INTO wiki_page_versions_mkt
        (wiki_page_id, tenant_id, subject_type, subject_id, body_ciphertext, status)
      VALUES (
        ${wiki_page_id},
        ${TENANT_ID},
        'company',
        ${subjectId},
        '# Version 2',
        'indexed'
      )
      RETURNING id
    `;
    const v2Id = v2Rows[0]!.id;

    await sql`
      UPDATE wiki_pages
      SET currently_published_version_id = ${v2Id},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${wiki_page_id}
    `;

    // List versions — both should appear
    const listRes = await fetch(`${apiBaseUrl}/api/wiki-nav/pages/${wiki_page_id}/versions`, {
      headers: authHeaders,
    });
    expect(listRes.status).toBe(200);

    const listData = (await listRes.json()) as {
      versions: Array<{ id: string; status: string }>;
    };
    expect(listData.versions.length).toBeGreaterThanOrEqual(2);
    const ids = listData.versions.map((v) => v.id);
    expect(ids).toContain(v1Id);
    expect(ids).toContain(v2Id);

    // Prior version (v1) is accessible
    const v1Res = await fetch(`${apiBaseUrl}/api/wiki-nav/pages/${wiki_page_id}/versions/${v1Id}`, {
      headers: authHeaders,
    });
    expect(v1Res.status).toBe(200);

    const v1Data = (await v1Res.json()) as {
      version: { id: string; body_ciphertext: string | null };
    };
    expect(v1Data.version.id).toBe(v1Id);
    expect(v1Data.version.body_ciphertext).toBe('# Version 1');

    // Non-existent version returns 404
    const notFoundRes = await fetch(
      `${apiBaseUrl}/api/wiki-nav/pages/${wiki_page_id}/versions/nonexistent-version-id`,
      { headers: authHeaders },
    );
    expect(notFoundRes.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// TC-3: browse and search
// ---------------------------------------------------------------------------

describe('TC-3: browse and search wiki pages', () => {
  test('GET /api/wiki-nav/pages returns pages for tenant', async () => {
    // Seed two pages with distinct subject IDs
    const subjectA = `nav-browse-a-${Date.now()}`;
    const subjectB = `nav-browse-b-${Date.now()}`;
    await seedIndexedWikiPage(subjectA, 'company');
    await seedIndexedWikiPage(subjectB, 'company');

    const res = await fetch(
      `${apiBaseUrl}/api/wiki-nav/pages?tenant_id=${TENANT_ID}&subject_type=company`,
      { headers: authHeaders },
    );
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      pages: Array<{
        id: string;
        subject_id: string;
        subject_type: string;
        open_debate_count: number;
      }>;
    };
    expect(Array.isArray(data.pages)).toBe(true);
    expect(data.pages.length).toBeGreaterThanOrEqual(2);

    // All pages should be of type 'company'
    for (const page of data.pages) {
      expect(page.subject_type).toBe('company');
      expect(typeof page.open_debate_count).toBe('number');
    }

    // Both seeded subjects should appear
    const ids = data.pages.map((p) => p.subject_id);
    expect(ids).toContain(subjectA);
    expect(ids).toContain(subjectB);
  });

  test('prefix search with q param filters pages', async () => {
    const prefix = `nav-prefix-${Date.now()}`;
    const subjectA = `${prefix}-alpha`;
    const subjectB = `${prefix}-beta`;
    const subjectOther = `unrelated-${Date.now()}`;

    await seedIndexedWikiPage(subjectA, 'thesis');
    await seedIndexedWikiPage(subjectB, 'thesis');
    await seedIndexedWikiPage(subjectOther, 'thesis');

    const res = await fetch(
      `${apiBaseUrl}/api/wiki-nav/pages?tenant_id=${TENANT_ID}&subject_type=thesis&q=${encodeURIComponent(prefix)}`,
      { headers: authHeaders },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { pages: Array<{ subject_id: string }> };

    const subjectIds = data.pages.map((p) => p.subject_id);
    expect(subjectIds).toContain(subjectA);
    expect(subjectIds).toContain(subjectB);
    // The unrelated subject must not appear
    expect(subjectIds).not.toContain(subjectOther);
  });

  test('missing tenant_id returns 400', async () => {
    const res = await fetch(`${apiBaseUrl}/api/wiki-nav/pages`, { headers: authHeaders });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// TC-4: auth enforcement
// ---------------------------------------------------------------------------

describe('TC-4: auth enforcement', () => {
  test('returns 401 for missing token', async () => {
    const res = await fetch(`${apiBaseUrl}/api/wiki-nav/pages?tenant_id=${TENANT_ID}`);
    expect(res.status).toBe(401);
  });
});
