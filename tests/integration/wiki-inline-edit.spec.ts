/**
 * @file tests/integration/wiki-inline-edit.spec.ts
 *
 * Integration tests — Inline wiki edit, methodology meta-commentary entity,
 * and surfacing (issue #87).
 *
 * ## What this tests
 *
 * ### AC-1: An inline edit applies and propagates implications
 *
 * TC-1: POST /api/wiki/inline-edit inserts a wiki_inline_edits row.
 * TC-2: Response contains edit_id and correction_status='pending'.
 * TC-3: Unauthenticated POST is rejected with 401.
 * TC-4: POST with methodology_shift=true opens a meta-commentary entry.
 * TC-5: POST with methodology_shift=false does NOT open a meta-commentary entry.
 * TC-6: POST with methodology_shift=true but missing drift_observation returns 422.
 *
 * ### AC-2: Meta-commentary entries surface via badge and digest and escalate when urgent
 *
 * TC-7:  GET /api/wiki/meta-commentary/badge returns open_count.
 * TC-8:  GET /api/wiki/meta-commentary/digest returns weekly digest grouped by class.
 * TC-9:  GET /api/wiki/meta-commentary/urgent returns only high-urgency open entries.
 * TC-10: A high-urgency entry appears in the urgent list; a normal-urgency entry does not.
 *
 * ### AC-3: Fold-in is an explicit researcher action; nothing auto-applies to the golden doc
 *
 * TC-11: PATCH /api/wiki/meta-commentary/:id/acknowledge transitions open → acknowledged.
 * TC-12: PATCH /api/wiki/meta-commentary/:id/fold-in transitions acknowledged → folded_in.
 * TC-13: Response for fold-in contains a golden_doc_note confirming the doc is NOT written.
 * TC-14: Fold-in is rejected when the entry is still in 'open' status (must acknowledge first).
 * TC-15: PATCH /api/wiki/meta-commentary/:id/archive closes an entry without fold-in.
 * TC-16: Archive is rejected when the entry is already folded_in.
 *
 * ## No mocks
 *
 * No vi.fn, vi.mock, vi.spyOn, or vi.stubGlobal. Real ephemeral Postgres
 * container. Real node:http server. Real handler functions called directly.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5 — researcher feedback surface (inline edit, meta-commentary surfacing).
 * - docs/prd.md §9 — golden-document invariant.
 * - docs/architecture.md §"Knowledge subsystem" — methodology_meta_commentary.
 * - packages/db/wiki-inline-edit-store.ts — DB store.
 * - apps/server/src/api/wiki-inline-edit-api.ts — API handlers.
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/87
 */

import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../../packages/db/pg-container';
import { runInitRemote } from '../../packages/db/init-remote';
import { migrate, migrateMkt } from '../../packages/db/index';
import { CHAT_FEEDBACK_DDL } from '../../packages/db/chat-feedback-store';
import { WIKI_INLINE_EDIT_DDL } from '../../packages/db/wiki-inline-edit-store';
import { handleWikiInlineEditRequest } from '../../apps/server/src/api/wiki-inline-edit-api';
import type { AppState } from '../../apps/server/src/index';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const TEST_TOKEN = 'wiki-inline-edit-test-secret-87';
const TEST_PASSWORDS = {
  app: 'app_inline_edit_pw',
  audit: 'audit_inline_edit_pw',
  analytics: 'analytics_inline_edit_pw',
  dictionary: 'dict_inline_edit_pw',
  email_ingest: 'email_ingest_inline_edit_pw',
};

const TENANT_ID = 'tenant-inline-edit-87';
const RESEARCHER_ID = 'researcher-inline-edit-87';
const WIKI_PAGE_ID = 'wp-inline-edit-87-target';

// ---------------------------------------------------------------------------
// Shared state
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
          const response = await handleWikiInlineEditRequest(fetchReq, url, state);
          if (response) {
            const resBody = await response.text();
            res.writeHead(response.status, { 'Content-Type': 'application/json' });
            res.end(resBody);
            return;
          }
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        } catch (err) {
          console.error('[wiki-inline-edit-test-server] Unhandled error:', err);
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
  // Apply base chat-feedback DDL first (contains methodology_meta_commentary table).
  await sql.unsafe(CHAT_FEEDBACK_DDL);
  // Apply inline edit DDL (extends methodology_meta_commentary, adds wiki_inline_edits).
  await sql.unsafe(WIKI_INLINE_EDIT_DDL);

  appState = {
    sql: sql as unknown as typeof import('../../packages/db/index').sql,
    auditSql: sql as unknown as typeof import('../../packages/db/index').sql,
    analyticsSql: sql as unknown as typeof import('../../packages/db/index').sql,
    dictionarySql: sql as unknown as typeof import('../../packages/db/index').sql,
  };

  process.env['TEST_MODE'] = 'true';
  process.env['WIKI_INLINE_EDIT_TEST_TOKEN'] = TEST_TOKEN;

  const { server, url } = await startLocalServer(appState);
  httpServer = server;
  apiBaseUrl = url;
}, 60_000);

afterAll(async () => {
  httpServer?.close();
  await sql?.end({ timeout: 5 });
  await pg?.stop();
  delete process.env['TEST_MODE'];
  delete process.env['WIKI_INLINE_EDIT_TEST_TOKEN'];
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const authHeaders = {
  Authorization: `Bearer ${TEST_TOKEN}`,
  'Content-Type': 'application/json',
};

function postInlineEdit(
  body: Record<string, unknown>,
  headers: Record<string, string> = authHeaders,
): Promise<Response> {
  return fetch(`${apiBaseUrl}/api/wiki/inline-edit`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function getBadge(researcher_id: string): Promise<Response> {
  return fetch(
    `${apiBaseUrl}/api/wiki/meta-commentary/badge?researcher_id=${encodeURIComponent(researcher_id)}`,
    { headers: authHeaders },
  );
}

function getDigest(researcher_id: string): Promise<Response> {
  return fetch(
    `${apiBaseUrl}/api/wiki/meta-commentary/digest?researcher_id=${encodeURIComponent(researcher_id)}`,
    { headers: authHeaders },
  );
}

function getUrgent(researcher_id: string): Promise<Response> {
  return fetch(
    `${apiBaseUrl}/api/wiki/meta-commentary/urgent?researcher_id=${encodeURIComponent(researcher_id)}`,
    { headers: authHeaders },
  );
}

function patchEntry(entry_id: string, action: string, researcher_id: string): Promise<Response> {
  return fetch(`${apiBaseUrl}/api/wiki/meta-commentary/${entry_id}/${action}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ researcher_id }),
  });
}

// ---------------------------------------------------------------------------
// AC-1: Inline edit applies and propagates implications
// ---------------------------------------------------------------------------

describe('AC-1: inline edit → correction prompt + optional meta-commentary', () => {
  test('TC-1: POST /api/wiki/inline-edit inserts a wiki_inline_edits row', async () => {
    const res = await postInlineEdit({
      researcher_id: RESEARCHER_ID,
      tenant_id: TENANT_ID,
      wiki_page_id: WIKI_PAGE_ID,
      diff_text:
        '-Company X is in Phase 2.\n+Company X is in Phase 3 as of Q1 2026, per FDA filing.',
      methodology_shift: false,
    });
    expect(res.status).toBe(201);

    const rows = await sql`
      SELECT id, wiki_page_id, researcher_id, diff_text, correction_status
      FROM wiki_inline_edits
      WHERE researcher_id = ${RESEARCHER_ID}
        AND wiki_page_id  = ${WIKI_PAGE_ID}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.wiki_page_id).toBe(WIKI_PAGE_ID);
    expect(rows[0]!.correction_status).toBe('pending');
  });

  test('TC-2: response contains edit_id and correction_status=pending', async () => {
    const res = await postInlineEdit({
      researcher_id: RESEARCHER_ID,
      tenant_id: TENANT_ID,
      wiki_page_id: WIKI_PAGE_ID,
      diff_text: '-Outdated claim.\n+Corrected claim with source citation.',
      methodology_shift: false,
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      edit_id: string;
      meta_commentary_id: null;
      correction_status: string;
    };
    expect(typeof body.edit_id).toBe('string');
    expect(body.edit_id.length).toBeGreaterThan(0);
    expect(body.meta_commentary_id).toBeNull();
    expect(body.correction_status).toBe('pending');
  });

  test('TC-3: unauthenticated POST is rejected with 401', async () => {
    const res = await postInlineEdit(
      {
        researcher_id: RESEARCHER_ID,
        tenant_id: TENANT_ID,
        wiki_page_id: WIKI_PAGE_ID,
        diff_text: '-old\n+new',
        methodology_shift: false,
      },
      { 'Content-Type': 'application/json' }, // no Authorization header
    );
    expect(res.status).toBe(401);
  });

  test('TC-4: POST with methodology_shift=true opens a meta-commentary entry', async () => {
    const researcherId = `researcher-ms-${Date.now()}`;
    const res = await postInlineEdit({
      researcher_id: researcherId,
      tenant_id: TENANT_ID,
      wiki_page_id: WIKI_PAGE_ID,
      diff_text: '-Regulatory filings are secondary.\n+Regulatory filings are the primary source.',
      methodology_shift: true,
      drift_observation:
        'Researcher elevated regulatory filings above press releases globally, implying a methodology shift.',
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      edit_id: string;
      meta_commentary_id: string;
      correction_status: string;
    };
    expect(typeof body.meta_commentary_id).toBe('string');
    expect(body.meta_commentary_id.length).toBeGreaterThan(0);

    // Verify the meta-commentary row in DB.
    const metaRows = await sql`
      SELECT id, researcher_id, class, status, observation, source
      FROM methodology_meta_commentary
      WHERE id = ${body.meta_commentary_id}
    `;
    expect(metaRows.length).toBe(1);
    expect(metaRows[0]!.status).toBe('open');
    expect(metaRows[0]!.class).toBe('methodology_drift');
    expect(metaRows[0]!.source).toBe('wiki_inline_edit');
    expect(metaRows[0]!.researcher_id).toBe(researcherId);
  });

  test('TC-5: POST with methodology_shift=false does NOT open meta-commentary', async () => {
    const researcherId = `researcher-no-ms-${Date.now()}`;
    const res = await postInlineEdit({
      researcher_id: researcherId,
      tenant_id: TENANT_ID,
      wiki_page_id: WIKI_PAGE_ID,
      diff_text: '-Wrong clinical stage.\n+Correct clinical stage.',
      methodology_shift: false,
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { edit_id: string; meta_commentary_id: null };
    expect(body.meta_commentary_id).toBeNull();

    const metaRows = await sql`
      SELECT id FROM methodology_meta_commentary WHERE researcher_id = ${researcherId}
    `;
    expect(metaRows.length).toBe(0);
  });

  test('TC-6: methodology_shift=true without drift_observation returns 422', async () => {
    const res = await postInlineEdit({
      researcher_id: RESEARCHER_ID,
      tenant_id: TENANT_ID,
      wiki_page_id: WIKI_PAGE_ID,
      diff_text: '-old\n+new',
      methodology_shift: true,
      // drift_observation omitted
    });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// AC-2: Meta-commentary surfacing — badge, digest, urgent escalation
// ---------------------------------------------------------------------------

describe('AC-2: meta-commentary surfacing — badge, digest, urgent escalation', () => {
  // We use a unique researcher per describe block to get a clean count.
  const researcherSurface = `researcher-surface-${Date.now()}`;

  beforeAll(async () => {
    // Seed some entries for this researcher.
    // Two normal-urgency open entries (methodology_drift class).
    await postInlineEdit({
      researcher_id: researcherSurface,
      tenant_id: TENANT_ID,
      wiki_page_id: WIKI_PAGE_ID,
      diff_text: '-old drift 1\n+new drift 1',
      methodology_shift: true,
      drift_observation: 'Drift observation 1 for surface tests.',
    });
    await postInlineEdit({
      researcher_id: researcherSurface,
      tenant_id: TENANT_ID,
      wiki_page_id: WIKI_PAGE_ID,
      diff_text: '-old drift 2\n+new drift 2',
      methodology_shift: true,
      drift_observation: 'Drift observation 2 for surface tests.',
    });
    // One high-urgency open entry.
    await postInlineEdit({
      researcher_id: researcherSurface,
      tenant_id: TENANT_ID,
      wiki_page_id: WIKI_PAGE_ID,
      diff_text: '-Retracted source claim.\n+Source retracted by publisher; claim removed.',
      methodology_shift: true,
      drift_observation:
        'A Tier A source has been retracted by its publisher; demoted_source candidate.',
      urgency_tier: 'high',
    });
  });

  test('TC-7: GET /api/wiki/meta-commentary/badge returns open_count >= 3', async () => {
    const res = await getBadge(researcherSurface);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { open_count: number };
    expect(typeof body.open_count).toBe('number');
    expect(body.open_count).toBeGreaterThanOrEqual(3);
  });

  test('TC-8: GET /api/wiki/meta-commentary/digest groups entries by class', async () => {
    const res = await getDigest(researcherSurface);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      digest: Array<{ class: string; count: number; entry_ids: string[] }>;
    };
    expect(Array.isArray(body.digest)).toBe(true);
    // All three entries are methodology_drift class.
    const driftBucket = body.digest.find((d) => d.class === 'methodology_drift');
    expect(driftBucket).toBeDefined();
    expect(driftBucket!.count).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(driftBucket!.entry_ids)).toBe(true);
    expect(driftBucket!.entry_ids.length).toBeGreaterThanOrEqual(3);
  });

  test('TC-9: GET /api/wiki/meta-commentary/urgent returns only high-urgency open entries', async () => {
    const res = await getUrgent(researcherSurface);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      entries: Array<{ urgency_tier: string; status: string }>;
    };
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
    // All returned entries must be high-urgency and open.
    expect(body.entries.every((e) => e.urgency_tier === 'high')).toBe(true);
    expect(body.entries.every((e) => e.status === 'open')).toBe(true);
  });

  test('TC-10: normal-urgency entry does not appear in the urgent list', async () => {
    // The two normal-urgency drift entries seeded above must not appear in urgent.
    const res = await getUrgent(researcherSurface);
    const body = (await res.json()) as { entries: Array<{ urgency_tier: string }> };
    expect(body.entries.every((e) => e.urgency_tier === 'high')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-3: Fold-in is an explicit researcher action; nothing auto-applies to golden doc
// ---------------------------------------------------------------------------

describe('AC-3: fold-in is explicit; golden doc is never written', () => {
  let entryId: string;
  const researcherLifecycle = `researcher-lifecycle-${Date.now()}`;

  beforeAll(async () => {
    // Create one open entry to exercise the lifecycle.
    const res = await postInlineEdit({
      researcher_id: researcherLifecycle,
      tenant_id: TENANT_ID,
      wiki_page_id: WIKI_PAGE_ID,
      diff_text: '-Phase 1.\n+Phase 2 as of June 2026.',
      methodology_shift: true,
      drift_observation: 'Lifecycle test: methodology drift observation.',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { meta_commentary_id: string };
    entryId = body.meta_commentary_id;
  });

  test('TC-11: PATCH .../acknowledge transitions open → acknowledged', async () => {
    const res = await patchEntry(entryId, 'acknowledge', researcherLifecycle);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { entry: { status: string; acknowledged_at: string } };
    expect(body.entry.status).toBe('acknowledged');
    expect(body.entry.acknowledged_at).not.toBeNull();
  });

  test('TC-12: PATCH .../fold-in transitions acknowledged → folded_in', async () => {
    const res = await patchEntry(entryId, 'fold-in', researcherLifecycle);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      entry: { status: string; folded_in_at: string };
      golden_doc_note: string;
    };
    expect(body.entry.status).toBe('folded_in');
    expect(body.entry.folded_in_at).not.toBeNull();
  });

  test('TC-13: fold-in response contains golden_doc_note confirming doc is NOT written', async () => {
    // Create a fresh entry and fold it in.
    const postRes = await postInlineEdit({
      researcher_id: researcherLifecycle,
      tenant_id: TENANT_ID,
      wiki_page_id: WIKI_PAGE_ID,
      diff_text: '-Secondary claim.\n+Primary claim with higher trust.',
      methodology_shift: true,
      drift_observation: 'Lifecycle test: golden_doc_note verification.',
    });
    const postBody = (await postRes.json()) as { meta_commentary_id: string };
    const eid = postBody.meta_commentary_id;

    // Acknowledge first.
    await patchEntry(eid, 'acknowledge', researcherLifecycle);

    // Fold in.
    const res = await patchEntry(eid, 'fold-in', researcherLifecycle);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { golden_doc_note: string };
    expect(typeof body.golden_doc_note).toBe('string');
    expect(body.golden_doc_note.toLowerCase()).toContain('not automatically updated');
  });

  test('TC-14: fold-in is rejected when the entry is still open (must acknowledge first)', async () => {
    // Create a fresh open entry.
    const postRes = await postInlineEdit({
      researcher_id: researcherLifecycle,
      tenant_id: TENANT_ID,
      wiki_page_id: WIKI_PAGE_ID,
      diff_text: '-old open entry.\n+new value.',
      methodology_shift: true,
      drift_observation: 'Test: fold-in without acknowledge should fail.',
    });
    const postBody = (await postRes.json()) as { meta_commentary_id: string };
    const eid = postBody.meta_commentary_id;

    // Try to fold-in directly without acknowledging first.
    const res = await patchEntry(eid, 'fold-in', researcherLifecycle);
    expect(res.status).toBe(409);
  });

  test('TC-15: PATCH .../archive closes an entry without fold-in', async () => {
    // Create a fresh open entry.
    const postRes = await postInlineEdit({
      researcher_id: researcherLifecycle,
      tenant_id: TENANT_ID,
      wiki_page_id: WIKI_PAGE_ID,
      diff_text: '-will be archived.\n+not needed.',
      methodology_shift: true,
      drift_observation: 'Test: archive without fold-in.',
    });
    const postBody = (await postRes.json()) as { meta_commentary_id: string };
    const eid = postBody.meta_commentary_id;

    const res = await patchEntry(eid, 'archive', researcherLifecycle);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { entry: { status: string; archived_at: string } };
    expect(body.entry.status).toBe('archived');
    expect(body.entry.archived_at).not.toBeNull();
  });

  test('TC-16: archive is rejected when the entry is already folded_in', async () => {
    // entryId was folded_in in TC-12.
    const res = await patchEntry(entryId, 'archive', researcherLifecycle);
    expect(res.status).toBe(409);
  });
});
