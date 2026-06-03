/**
 * @file tests/integration/wiki-debate.spec.ts
 *
 * Integration tests for the wiki debate lifecycle — issue #77.
 *
 * ## What this tests
 *
 * Test plan items from the issue:
 *
 *   TC-1 (debate open then resolve lifecycle):
 *     A wiki_debate is opened for a contested claim.
 *     It transitions from 'open' → 'resolved' with a resolution note.
 *     The row is no longer returned in the open-debate list after resolution.
 *
 *   TC-2 (debate open then archive lifecycle):
 *     A wiki_debate is opened and then archived (closed without resolution).
 *     The row is no longer returned in the open-debate list after archiving.
 *
 *   TC-3 (invalid status transitions):
 *     Attempting to resolve/archive an already-resolved debate returns 404
 *     (the DB UPDATE WHERE status='open' finds no matching row).
 *
 * ## Architecture
 *
 * Real ephemeral Postgres container. No mocks — real DB, real node:http server,
 * real handler functions. No vi.fn, vi.mock, vi.spyOn, vi.stubGlobal.
 *
 * ## Canonical docs
 *
 * - docs/architecture.md §"Knowledge subsystem" — wiki_debates entity type.
 * - packages/db/wiki-debate-store.ts — DB store.
 * - apps/server/src/api/wiki-debate-api.ts — API endpoints.
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
import { handleWikiDebateApiRequest } from '../../apps/server/src/api/wiki-debate-api';
import type { AppState } from '../../apps/server/src/index';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const TEST_TOKEN = 'wiki-debate-test-secret-77';
const TEST_PASSWORDS = {
  app: 'app_debate_test_pw',
  audit: 'audit_debate_test_pw',
  analytics: 'analytics_debate_test_pw',
  dictionary: 'dict_debate_test_pw',
  email_ingest: 'email_ingest_debate_test_pw',
};

const TENANT_ID = 'tenant-debate-77';

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
          const response = await handleWikiDebateApiRequest(fetchReq, url, state);

          if (response) {
            const resBody = await response.text();
            res.writeHead(response.status, { 'Content-Type': 'application/json' });
            res.end(resBody);
            return;
          }

          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        } catch (err) {
          console.error('[wiki-debate-test-server] Unhandled error:', err);
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

async function seedWikiPage(): Promise<{ wiki_page_id: string; wiki_page_version_id: string }> {
  const pageId = `wp-debate-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const versionId = `wpv-debate-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  await sql.unsafe(`
    INSERT INTO wiki_pages
      (id, tenant_id, subject_type, subject_id)
    VALUES
      ('${pageId}', '${TENANT_ID}', 'company', 'test-company-${Date.now()}')
    ON CONFLICT DO NOTHING
  `);

  await sql.unsafe(`
    INSERT INTO wiki_page_versions_mkt
      (id, wiki_page_id, tenant_id, subject_type, subject_id, status)
    VALUES
      ('${versionId}', '${pageId}', '${TENANT_ID}', 'company', 'test-company-${Date.now()}', 'indexed')
    ON CONFLICT DO NOTHING
  `);

  return { wiki_page_id: pageId, wiki_page_version_id: versionId };
}

// ---------------------------------------------------------------------------
// TC-1: debate open → resolve lifecycle
// ---------------------------------------------------------------------------

describe('TC-1: open then resolve lifecycle', () => {
  test('debate transitions from open → resolved with a resolution note', async () => {
    const { wiki_page_id, wiki_page_version_id } = await seedWikiPage();

    // Open the debate
    const openRes = await fetch(`${apiBaseUrl}/internal/wiki-debate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        tenant_id: TENANT_ID,
        wiki_page_id,
        wiki_page_version_id,
        claim: 'CEO name is disputed: Jane Smith vs. John Doe',
        evidence_a: ['fact-001', 'fact-002'],
        evidence_b: ['fact-003'],
      }),
    });
    expect(openRes.status).toBe(201);

    const openData = (await openRes.json()) as {
      debate: {
        id: string;
        status: string;
        claim: string;
        evidence_a: string;
        evidence_b: string;
      };
    };
    expect(openData.debate.status).toBe('open');
    expect(openData.debate.claim).toBe('CEO name is disputed: Jane Smith vs. John Doe');

    const debateId = openData.debate.id;

    // Confirm it appears in the open-debates list for the page
    const listRes = await fetch(`${apiBaseUrl}/internal/wiki-debate?wiki_page_id=${wiki_page_id}`, {
      headers: authHeaders,
    });
    expect(listRes.status).toBe(200);
    const listData = (await listRes.json()) as { debates: Array<{ id: string; status: string }> };
    expect(listData.debates.some((d) => d.id === debateId && d.status === 'open')).toBe(true);

    // Resolve the debate
    const resolveRes = await fetch(`${apiBaseUrl}/internal/wiki-debate/${debateId}/status`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({
        status: 'resolved',
        resolution_note: 'SEC filing confirms CEO is Jane Smith.',
      }),
    });
    expect(resolveRes.status).toBe(200);

    const resolveData = (await resolveRes.json()) as {
      debate: { id: string; status: string; resolution_note: string };
    };
    expect(resolveData.debate.status).toBe('resolved');
    expect(resolveData.debate.resolution_note).toBe('SEC filing confirms CEO is Jane Smith.');

    // Confirm it is no longer in the open-debates list
    const listAfterRes = await fetch(
      `${apiBaseUrl}/internal/wiki-debate?wiki_page_id=${wiki_page_id}`,
      { headers: authHeaders },
    );
    const listAfterData = (await listAfterRes.json()) as {
      debates: Array<{ id: string; status: string }>;
    };
    expect(listAfterData.debates.some((d) => d.id === debateId && d.status === 'open')).toBe(false);

    // Fetch by ID — should show resolved status
    const getRes = await fetch(`${apiBaseUrl}/internal/wiki-debate/${debateId}`, {
      headers: authHeaders,
    });
    expect(getRes.status).toBe(200);
    const getData = (await getRes.json()) as { debate: { status: string } };
    expect(getData.debate.status).toBe('resolved');
  });
});

// ---------------------------------------------------------------------------
// TC-2: debate open → archive lifecycle
// ---------------------------------------------------------------------------

describe('TC-2: open then archive lifecycle', () => {
  test('debate transitions from open → archived', async () => {
    const { wiki_page_id, wiki_page_version_id } = await seedWikiPage();

    const openRes = await fetch(`${apiBaseUrl}/internal/wiki-debate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        tenant_id: TENANT_ID,
        wiki_page_id,
        wiki_page_version_id,
        claim: 'Revenue figure contested: $450M vs. $480M',
        evidence_a: ['chunk-001'],
        evidence_b: ['chunk-002'],
      }),
    });
    expect(openRes.status).toBe(201);
    const openData = (await openRes.json()) as { debate: { id: string; status: string } };
    expect(openData.debate.status).toBe('open');
    const debateId = openData.debate.id;

    // Archive without a resolution note
    const archiveRes = await fetch(`${apiBaseUrl}/internal/wiki-debate/${debateId}/status`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'archived' }),
    });
    expect(archiveRes.status).toBe(200);
    const archiveData = (await archiveRes.json()) as { debate: { status: string } };
    expect(archiveData.debate.status).toBe('archived');

    // No longer in open list
    const listRes = await fetch(`${apiBaseUrl}/internal/wiki-debate?wiki_page_id=${wiki_page_id}`, {
      headers: authHeaders,
    });
    const listData = (await listRes.json()) as {
      debates: Array<{ id: string; status: string }>;
    };
    expect(listData.debates.some((d) => d.id === debateId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TC-3: invalid transition (already resolved)
// ---------------------------------------------------------------------------

describe('TC-3: invalid status transitions', () => {
  test('resolving an already-resolved debate returns 404', async () => {
    const { wiki_page_id, wiki_page_version_id } = await seedWikiPage();

    const openRes = await fetch(`${apiBaseUrl}/internal/wiki-debate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        tenant_id: TENANT_ID,
        wiki_page_id,
        wiki_page_version_id,
        claim: 'Already resolved debate',
        evidence_a: [],
        evidence_b: [],
      }),
    });
    const openData = (await openRes.json()) as { debate: { id: string } };
    const debateId = openData.debate.id;

    // First resolve — OK
    await fetch(`${apiBaseUrl}/internal/wiki-debate/${debateId}/status`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({
        status: 'resolved',
        resolution_note: 'First resolution.',
      }),
    });

    // Second resolve — no open row exists, must return 404
    const secondRes = await fetch(`${apiBaseUrl}/internal/wiki-debate/${debateId}/status`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({
        status: 'resolved',
        resolution_note: 'Second attempt.',
      }),
    });
    expect(secondRes.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// TC-4: auth enforcement
// ---------------------------------------------------------------------------

describe('TC-4: auth enforcement', () => {
  test('returns 401 for missing token', async () => {
    const res = await fetch(`${apiBaseUrl}/internal/wiki-debate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: TENANT_ID }),
    });
    expect(res.status).toBe(401);
  });

  test('returns 401 for wrong token', async () => {
    const res = await fetch(`${apiBaseUrl}/internal/wiki-debate`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer wrong-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenant_id: TENANT_ID }),
    });
    expect(res.status).toBe(401);
  });
});
