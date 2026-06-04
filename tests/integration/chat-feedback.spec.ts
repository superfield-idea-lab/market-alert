/**
 * @file tests/integration/chat-feedback.spec.ts
 *
 * Scout integration tests — chat feedback → wiki superseding fact + methodology
 * meta-commentary (issue #86).
 *
 * ## What this tests
 *
 * Validates the seams for the researcher chat-feedback correction vertical slice:
 *
 *   researcher chat message (correction)
 *     → POST /api/wiki/feedback
 *       → applyFeedback() [stub: inserts chat_feedback row]
 *         → if methodology_shift: openMetaCommentaryEntry() [stub: inserts row]
 *           → goldenDocIsUnmutated() === true [invariant guard]
 *
 * In scout mode the superseding confirmed_fact INSERT and WIKI_REBUILD enqueue
 * are no-op stubs. These tests confirm:
 *
 *   AC-1  A chat correction updates the relevant wiki page.
 *         TC-1: POST /api/wiki/feedback inserts a chat_feedback row with
 *               the correct wiki_page_id, researcher_id, and message.
 *         TC-2: The response includes a feedback_id.
 *         TC-3: Unauthorised POST is rejected with 401.
 *
 *   AC-2  An implied methodology shift opens a meta-commentary entry.
 *         TC-4: POST with methodology_shift=true inserts a
 *               methodology_meta_commentary row at status 'open'.
 *         TC-5: GET /api/wiki/feedback/meta-commentary returns the open entry.
 *         TC-6: POST with methodology_shift=false does NOT open a meta entry.
 *         TC-7: drift_observation is required when methodology_shift=true (422).
 *
 *   AC-3  The golden Methodology document is never written.
 *         TC-8: GET /api/wiki/feedback/golden-doc-check returns
 *               { golden_doc_unmutated: true } after a correction is applied.
 *
 * ## No mocks
 *
 * No vi.fn, vi.mock, vi.spyOn, or vi.stubGlobal. Real ephemeral Postgres
 * container. Real node:http server. Real handler functions called directly.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5 — researcher feedback surface.
 * - docs/prd.md §9 — golden-document invariant.
 * - docs/architecture.md §"Knowledge subsystem" — methodology_meta_commentary.
 * - packages/db/chat-feedback-store.ts — DB store stub.
 * - apps/server/src/api/chat-feedback-api.ts — API stub.
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/86
 */

import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../../packages/db/pg-container';
import { runInitRemote } from '../../packages/db/init-remote';
import { migrate, migrateMkt } from '../../packages/db/index';
import { CHAT_FEEDBACK_DDL } from '../../packages/db/chat-feedback-store';
import { handleChatFeedbackRequest } from '../../apps/server/src/api/chat-feedback-api';
import type { AppState } from '../../apps/server/src/index';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const TEST_TOKEN = 'chat-feedback-test-secret-86';
const TEST_PASSWORDS = {
  app: 'app_feedback_test_pw',
  audit: 'audit_feedback_test_pw',
  analytics: 'analytics_feedback_test_pw',
  dictionary: 'dict_feedback_test_pw',
  email_ingest: 'email_ingest_feedback_test_pw',
};

const TENANT_ID = 'tenant-feedback-86';
const RESEARCHER_ID = 'researcher-feedback-86';
const WIKI_PAGE_ID = 'wp-feedback-86-target';
const SUPERSEDED_FACT_ID = 'fact-old-86';

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
      const url = new URL(req.url ?? '/', 'http://localhost');
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
          const response = await handleChatFeedbackRequest(fetchReq, url, state);
          if (response) {
            const resBody = await response.text();
            res.writeHead(response.status, { 'Content-Type': 'application/json' });
            res.end(resBody);
            return;
          }
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        } catch (err) {
          console.error('[chat-feedback-test-server] Unhandled error:', err);
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
  await sql.unsafe(CHAT_FEEDBACK_DDL);

  appState = {
    sql: sql as unknown as typeof import('../../packages/db/index').sql,
    auditSql: sql as unknown as typeof import('../../packages/db/index').sql,
    analyticsSql: sql as unknown as typeof import('../../packages/db/index').sql,
    dictionarySql: sql as unknown as typeof import('../../packages/db/index').sql,
  };

  process.env['TEST_MODE'] = 'true';
  process.env['CHAT_FEEDBACK_TEST_TOKEN'] = TEST_TOKEN;

  const { server, url } = await startLocalServer(appState);
  httpServer = server;
  apiBaseUrl = url;
}, 60_000);

afterAll(async () => {
  httpServer?.close();
  await sql?.end({ timeout: 5 });
  await pg?.stop();
  delete process.env['TEST_MODE'];
  delete process.env['CHAT_FEEDBACK_TEST_TOKEN'];
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const authHeaders = {
  Authorization: `Bearer ${TEST_TOKEN}`,
  'Content-Type': 'application/json',
};

function postFeedback(
  body: Record<string, unknown>,
  headers: Record<string, string> = authHeaders,
): Promise<Response> {
  return fetch(`${apiBaseUrl}/api/wiki/feedback`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function getMetaCommentary(
  researcher_id: string,
  headers: Record<string, string> = authHeaders,
): Promise<Response> {
  return fetch(
    `${apiBaseUrl}/api/wiki/feedback/meta-commentary?researcher_id=${encodeURIComponent(researcher_id)}`,
    { headers },
  );
}

function getGoldenDocCheck(headers: Record<string, string> = authHeaders): Promise<Response> {
  return fetch(`${apiBaseUrl}/api/wiki/feedback/golden-doc-check`, { headers });
}

// ---------------------------------------------------------------------------
// AC-1: Chat correction applies to the wiki page
// ---------------------------------------------------------------------------

describe('AC-1: chat correction → wiki page update (stub)', () => {
  test('TC-1: POST /api/wiki/feedback inserts a chat_feedback row', async () => {
    const res = await postFeedback({
      researcher_id: RESEARCHER_ID,
      tenant_id: TENANT_ID,
      message: 'The pipeline page overweights press releases; treat regulatory filings as primary.',
      wiki_page_id: WIKI_PAGE_ID,
      superseded_fact_id: SUPERSEDED_FACT_ID,
      new_fact_value: 'Regulatory filings are the primary source for pipeline status.',
      methodology_shift: false,
    });
    expect(res.status).toBe(201);

    const rows = await sql`
      SELECT id, wiki_page_id, researcher_id, message, methodology_shift
      FROM chat_feedback
      WHERE researcher_id = ${RESEARCHER_ID}
        AND wiki_page_id  = ${WIKI_PAGE_ID}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.wiki_page_id).toBe(WIKI_PAGE_ID);
    expect(rows[0]!.researcher_id).toBe(RESEARCHER_ID);
    expect(rows[0]!.methodology_shift).toBe(false);
  });

  test('TC-2: response body contains a feedback_id', async () => {
    const res = await postFeedback({
      researcher_id: RESEARCHER_ID,
      tenant_id: TENANT_ID,
      message: 'Correct company X stage to Phase 2.',
      wiki_page_id: WIKI_PAGE_ID,
      superseded_fact_id: SUPERSEDED_FACT_ID,
      new_fact_value: 'Company X pipeline is in Phase 2.',
      methodology_shift: false,
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { feedback_id: string; meta_commentary_id: null };
    expect(typeof body.feedback_id).toBe('string');
    expect(body.feedback_id.length).toBeGreaterThan(0);
    expect(body.meta_commentary_id).toBeNull();
  });

  test('TC-3: unauthenticated POST is rejected with 401', async () => {
    const res = await postFeedback(
      {
        researcher_id: RESEARCHER_ID,
        tenant_id: TENANT_ID,
        message: 'Correct something.',
        wiki_page_id: WIKI_PAGE_ID,
        superseded_fact_id: SUPERSEDED_FACT_ID,
        new_fact_value: 'New value.',
        methodology_shift: false,
      },
      { 'Content-Type': 'application/json' }, // no Authorization header
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// AC-2: Implied methodology shift opens a meta-commentary entry
// ---------------------------------------------------------------------------

describe('AC-2: methodology shift → meta-commentary entry (stub)', () => {
  test('TC-4: POST with methodology_shift=true inserts a methodology_meta_commentary row', async () => {
    const researcherId = `researcher-meta-${Date.now()}`;
    const res = await postFeedback({
      researcher_id: researcherId,
      tenant_id: TENANT_ID,
      message:
        'Going forward, regulatory filings should rank above press releases across all companies, not just Company X.',
      wiki_page_id: WIKI_PAGE_ID,
      superseded_fact_id: SUPERSEDED_FACT_ID,
      new_fact_value: 'Regulatory filings rank above press releases globally.',
      methodology_shift: true,
      drift_observation:
        'Researcher generalised a per-company rule to a global methodology rule, implying filing primacy should be encoded in the Research Methodology.',
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { feedback_id: string; meta_commentary_id: string };
    expect(typeof body.meta_commentary_id).toBe('string');
    expect(body.meta_commentary_id.length).toBeGreaterThan(0);

    // Verify the meta-commentary row exists in the DB.
    const metaRows = await sql`
      SELECT id, researcher_id, class, status, observation
      FROM methodology_meta_commentary
      WHERE id = ${body.meta_commentary_id}
    `;
    expect(metaRows.length).toBe(1);
    expect(metaRows[0]!.status).toBe('open');
    expect(metaRows[0]!.class).toBe('methodology_drift');
    expect(metaRows[0]!.researcher_id).toBe(researcherId);
  });

  test('TC-5: GET /api/wiki/feedback/meta-commentary returns the open entry', async () => {
    const researcherId = `researcher-meta-list-${Date.now()}`;

    // Submit a correction that implies a methodology shift.
    await postFeedback({
      researcher_id: researcherId,
      tenant_id: TENANT_ID,
      message: 'Treat Phase 3 filings as the gold standard across all therapeutic areas.',
      wiki_page_id: WIKI_PAGE_ID,
      superseded_fact_id: SUPERSEDED_FACT_ID,
      new_fact_value: 'Phase 3 filings are the gold standard.',
      methodology_shift: true,
      drift_observation: 'Researcher extended Phase 3 primacy to all therapeutic areas.',
    });

    // Retrieve meta-commentary entries.
    const res = await getMetaCommentary(researcherId);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { entries: Array<{ status: string; class: string }> };
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
    expect(body.entries.every((e) => e.status === 'open')).toBe(true);
    expect(body.entries.every((e) => e.class === 'methodology_drift')).toBe(true);
  });

  test('TC-6: POST with methodology_shift=false does NOT open a meta-commentary entry', async () => {
    const researcherId = `researcher-no-meta-${Date.now()}`;
    const res = await postFeedback({
      researcher_id: researcherId,
      tenant_id: TENANT_ID,
      message: 'Company Y is in Phase 1, not Phase 2.',
      wiki_page_id: WIKI_PAGE_ID,
      superseded_fact_id: SUPERSEDED_FACT_ID,
      new_fact_value: 'Company Y is in Phase 1.',
      methodology_shift: false,
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { feedback_id: string; meta_commentary_id: null };
    expect(body.meta_commentary_id).toBeNull();

    // Confirm no meta-commentary row was inserted for this researcher.
    const metaRows = await sql`
      SELECT id FROM methodology_meta_commentary
      WHERE researcher_id = ${researcherId}
    `;
    expect(metaRows.length).toBe(0);
  });

  test('TC-7: missing drift_observation when methodology_shift=true returns 422', async () => {
    const res = await postFeedback({
      researcher_id: RESEARCHER_ID,
      tenant_id: TENANT_ID,
      message: 'Regulatory filings should rank higher.',
      wiki_page_id: WIKI_PAGE_ID,
      superseded_fact_id: SUPERSEDED_FACT_ID,
      new_fact_value: 'Regulatory filings rank higher.',
      methodology_shift: true,
      // drift_observation omitted
    });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// AC-3: Golden Methodology document is never written
// ---------------------------------------------------------------------------

describe('AC-3: golden-document invariant', () => {
  test('TC-8: golden-doc-check returns { golden_doc_unmutated: true } after a correction', async () => {
    // Apply a correction (with methodology shift).
    await postFeedback({
      researcher_id: RESEARCHER_ID,
      tenant_id: TENANT_ID,
      message: 'Correct the primary source ranking for all companies.',
      wiki_page_id: WIKI_PAGE_ID,
      superseded_fact_id: SUPERSEDED_FACT_ID,
      new_fact_value: 'Regulatory filings rank above press releases.',
      methodology_shift: true,
      drift_observation: 'Global source ranking drift implied.',
    });

    // Confirm the golden document is untouched.
    const res = await getGoldenDocCheck();
    expect(res.status).toBe(200);

    const body = (await res.json()) as { golden_doc_unmutated: boolean };
    expect(body.golden_doc_unmutated).toBe(true);
  });
});
