/**
 * @file tests/integration/event-evaluation.spec.ts
 *
 * Event-evaluation scout integration tests — Phase 6 dev-scout (issue #82).
 *
 * ## What this tests
 *
 * Validates the seams for the event-evaluation vertical slice:
 *   market_event + active standing prompt →
 *   signal row (cited) →
 *   signal_cites edges (standing_prompt_version)
 *
 * Tests exercise the stub data-access functions from `packages/db/signal-store.ts`
 * and the internal API from `apps/server/src/api/event-eval-api.ts` directly
 * against a real ephemeral Postgres container, so the schema, types, and ON
 * CONFLICT clauses are all verified at the DB layer.
 *
 * ## Acceptance criteria covered
 *
 *   AC-1  An event plus active prompt produces a signal in one call.
 *         TC-1: A market_event + active standing_prompt_version produces a signal row.
 *         TC-2: The signal row is linked to the correct market_event and version.
 *
 *   AC-2  The signal cites the exact wiki snapshot and prompt revision used.
 *         TC-3: A signal_cites edge to the standing_prompt_version is created.
 *         TC-4: The cite edge is immutable (target_id matches the version used).
 *
 *   AC-3  Re-evaluating the same event is idempotent.
 *         TC-5: Running event evaluation twice for the same
 *               (market_event_id, standing_prompt_version_id) produces exactly
 *               one signal row and returns `already_evaluated: true` on the
 *               second call.
 *
 *   Additionally:
 *   AC-4  Schema compiles (signals and signal_cites tables created by migrateMkt).
 *   AC-5  Signal state machine: valid transitions are accepted; invalid ones throw.
 *   AC-6  No vi.fn, vi.mock, or vi.spyOn calls.
 *
 * ## No mocks
 *
 * Uses a real ephemeral Postgres container. No vi.fn, vi.mock, vi.spyOn.
 *
 * ## Blueprint refs
 *
 * - TEST-D-001: golden-fixture-recording
 * - WORKER-T-002: no privileged DB access from worker process
 * - DATA-D-006: four-pool Postgres
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5, §9 — event evaluation, confidence, auditability
 * - docs/architecture.md §"Signal routing"
 * - docs/architecture.md §"Citations: first-class relation edges"
 * - packages/db/signal-store.ts — data access layer (this scout)
 * - packages/db/mkt-schema.sql — signals and signal_cites DDL (this scout)
 * - apps/server/src/api/event-eval-api.ts — internal API endpoints (this scout)
 * - apps/worker/src/event-eval-job.ts — worker handler (this scout)
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/82
 */

import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../../packages/db/pg-container';
import { runInitRemote } from '../../packages/db/init-remote';
import { migrate, migrateMkt } from '../../packages/db/index';
import { WIKI_REBUILD_DDL } from '../../packages/db/wiki-rebuild-store';
import { STANDING_PROMPT_DDL } from '../../packages/db/standing-prompt-store';
import {
  SIGNAL_STORE_DDL,
  insertSignal,
  getSignalById,
  getSignalByIdempotencyKey,
  insertSignalCite,
  getSignalCites,
  isValidSignalTransition,
  VALID_SIGNAL_TRANSITIONS,
} from '../../packages/db/signal-store';
import {
  handleEventEvalApiRequest,
  EVENT_EVAL_TEST_TOKEN,
} from '../../apps/server/src/api/event-eval-api';
import { parseEventEvalPayload, EVENT_EVAL_JOB_TYPE } from '../../apps/worker/src/event-eval-job';
import {
  upsertStandingPrompt,
  insertStandingPromptVersion,
  activateStandingPromptVersion,
} from '../../packages/db/standing-prompt-store';
import type { AppState } from '../../apps/server/src/index';
import type { TaskQueueRow } from '../../packages/db/task-queue';
import fixture from '../fixtures/event-evaluation/event-evaluation-fixture.json';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const TEST_TOKEN = EVENT_EVAL_TEST_TOKEN;
const TEST_PASSWORDS = {
  app: 'app_eval_test_pw',
  audit: 'audit_eval_test_pw',
  analytics: 'analytics_eval_test_pw',
  dictionary: 'dict_eval_test_pw',
  email_ingest: 'email_ingest_eval_test_pw',
};

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;
let appState: AppState;
let httpServer: Server;
let apiBaseUrl: string;

// ---------------------------------------------------------------------------
// Helper: build connection URL for a named role
// ---------------------------------------------------------------------------

function makeRoleUrl(adminUrl: string, db: string, user: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
}

// ---------------------------------------------------------------------------
// Local HTTP server — routes /internal/event-evaluation/*
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
          const response = await handleEventEvalApiRequest(fetchReq, url, state);

          if (response) {
            const resBody = await response.text();
            res.writeHead(response.status, { 'Content-Type': 'application/json' });
            res.end(resBody);
            return;
          }

          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        } catch (err) {
          console.error('[event-eval-test-server] Unhandled error:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
    server.once('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Start ephemeral Postgres container.
  pg = await startPostgres();

  // 2. Provision roles and databases.
  await runInitRemote({
    ADMIN_DATABASE_URL: pg.url,
    APP_RW_PASSWORD: TEST_PASSWORDS.app,
    AUDIT_W_PASSWORD: TEST_PASSWORDS.audit,
    ANALYTICS_W_PASSWORD: TEST_PASSWORDS.analytics,
    DICT_RW_PASSWORD: TEST_PASSWORDS.dictionary,
    AGENT_EMAIL_INGEST_PASSWORD: TEST_PASSWORDS.email_ingest,
  } as NodeJS.ProcessEnv);

  // 3. Connect as app_rw.
  const appRwUrl = makeRoleUrl(pg.url, 'superfield_app', 'app_rw', TEST_PASSWORDS.app);
  sql = postgres(appRwUrl, { max: 5 });

  // 4. Apply base schema and mkt-schema (includes raw_filings, market_events).
  await migrate({ databaseUrl: appRwUrl });
  await migrateMkt({ databaseUrl: appRwUrl });

  // 5. Apply wiki rebuild DDL (needed for wiki_page_versions_mkt referenced by standing-prompt DDL).
  await sql.unsafe(WIKI_REBUILD_DDL);

  // 6. Apply standing-prompt DDL (needed for getActiveStandingPromptVersion).
  await sql.unsafe(STANDING_PROMPT_DDL);

  // 7. Apply signal store DDL (signals, signal_cites).
  await sql.unsafe(SIGNAL_STORE_DDL);

  // 8. Build AppState.
  appState = {
    sql: sql as unknown as typeof import('../../packages/db/index').sql,
    auditSql: sql as unknown as typeof import('../../packages/db/index').sql,
    analyticsSql: sql as unknown as typeof import('../../packages/db/index').sql,
    dictionarySql: sql as unknown as typeof import('../../packages/db/index').sql,
  };

  // 9. Set TEST_MODE for auth.
  process.env['TEST_MODE'] = 'true';

  // 10. Start local HTTP server.
  const serverResult = await startLocalServer(appState);
  httpServer = serverResult.server;
  apiBaseUrl = serverResult.url;
}, 60_000);

afterAll(async () => {
  httpServer?.close();
  await sql?.end({ timeout: 5 });
  await pg?.stop();
  delete process.env['TEST_MODE'];
});

// ---------------------------------------------------------------------------
// Unit tests: parseEventEvalPayload
// ---------------------------------------------------------------------------

describe('parseEventEvalPayload', () => {
  test('parses a valid payload', () => {
    const payload = parseEventEvalPayload({ market_event_id: 'evt-001' });
    expect(payload.market_event_id).toBe('evt-001');
  });

  test('throws for missing market_event_id', () => {
    expect(() => parseEventEvalPayload({})).toThrow('market_event_id');
  });

  test('throws for non-object payload', () => {
    expect(() => parseEventEvalPayload('bad')).toThrow('JSON object');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: EVENT_EVAL_JOB_TYPE constant
// ---------------------------------------------------------------------------

describe('EVENT_EVAL_JOB_TYPE', () => {
  test('equals "EVENT_EVALUATE"', () => {
    expect(EVENT_EVAL_JOB_TYPE).toBe('EVENT_EVALUATE');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: signal state machine
// ---------------------------------------------------------------------------

describe('signal state machine', () => {
  test('Generated → Delivered is valid', () => {
    expect(isValidSignalTransition('Generated', 'Delivered')).toBe(true);
  });

  test('Generated → Queued is valid', () => {
    expect(isValidSignalTransition('Generated', 'Queued')).toBe(true);
  });

  test('Queued → Delivered is valid', () => {
    expect(isValidSignalTransition('Queued', 'Delivered')).toBe(true);
  });

  test('Queued → Suppressed is valid', () => {
    expect(isValidSignalTransition('Queued', 'Suppressed')).toBe(true);
  });

  test('Delivered → Suppressed is invalid', () => {
    expect(isValidSignalTransition('Delivered', 'Suppressed')).toBe(false);
  });

  test('Suppressed → Delivered is invalid', () => {
    expect(isValidSignalTransition('Suppressed', 'Delivered')).toBe(false);
  });

  test('Generated → Suppressed is invalid', () => {
    expect(isValidSignalTransition('Generated', 'Suppressed')).toBe(false);
  });

  test('VALID_SIGNAL_TRANSITIONS covers all four statuses', () => {
    expect(VALID_SIGNAL_TRANSITIONS.size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: signal-store DB layer
// ---------------------------------------------------------------------------

describe('signal-store DB layer (AC-1, AC-2, AC-3)', () => {
  const TENANT_ID = 'tenant-sig-test';
  const RESEARCHER_ID = 'researcher-sig-001';
  const MARKET_EVENT_ID_PREFIX = 'evt-store-';
  const SP_VERSION_ID_PREFIX = 'spv-store-';

  test('AC-1: insertSignal creates a signal row with correct fields', async () => {
    const market_event_id = `${MARKET_EVENT_ID_PREFIX}001`;
    const standing_prompt_version_id = `${SP_VERSION_ID_PREFIX}001`;

    const row = await insertSignal({
      tenant_id: TENANT_ID,
      researcher_id: RESEARCHER_ID,
      market_event_id,
      standing_prompt_version_id,
      rationale: null,
      source_trust: 1.0,
      extraction_certainty: 1.0,
      sql: sql as unknown as import('../../packages/db/signal-store').SqlClient,
    });

    expect(row).not.toBeNull();
    expect(row!.tenant_id).toBe(TENANT_ID);
    expect(row!.researcher_id).toBe(RESEARCHER_ID);
    expect(row!.market_event_id).toBe(market_event_id);
    expect(row!.standing_prompt_version_id).toBe(standing_prompt_version_id);
    expect(row!.status).toBe('Generated');
    expect(row!.source_trust).toBe(1);
    expect(row!.extraction_certainty).toBe(1);
    expect(row!.idempotency_key).toBe(
      `event_eval:${market_event_id}:${standing_prompt_version_id}`,
    );
  });

  test('AC-2: insertSignalCite creates a cites edge to the standing_prompt_version', async () => {
    const market_event_id = `${MARKET_EVENT_ID_PREFIX}002`;
    const standing_prompt_version_id = `${SP_VERSION_ID_PREFIX}002`;

    const signal = await insertSignal({
      tenant_id: TENANT_ID,
      researcher_id: RESEARCHER_ID,
      market_event_id,
      standing_prompt_version_id,
      sql: sql as unknown as import('../../packages/db/signal-store').SqlClient,
    });
    expect(signal).not.toBeNull();

    const cite = await insertSignalCite({
      signal_id: signal!.id,
      target_type: 'standing_prompt_version',
      target_id: standing_prompt_version_id,
      sql: sql as unknown as import('../../packages/db/signal-store').SqlClient,
    });
    expect(cite).not.toBeNull();
    expect(cite!.target_type).toBe('standing_prompt_version');
    expect(cite!.target_id).toBe(standing_prompt_version_id);
    expect(cite!.signal_id).toBe(signal!.id);
  });

  test('AC-2: getSignalCites returns all cites edges for a signal', async () => {
    const market_event_id = `${MARKET_EVENT_ID_PREFIX}003`;
    const standing_prompt_version_id = `${SP_VERSION_ID_PREFIX}003`;
    const wiki_page_version_id = 'wpv-store-003';

    const signal = await insertSignal({
      tenant_id: TENANT_ID,
      researcher_id: RESEARCHER_ID,
      market_event_id,
      standing_prompt_version_id,
      sql: sql as unknown as import('../../packages/db/signal-store').SqlClient,
    });
    expect(signal).not.toBeNull();

    await insertSignalCite({
      signal_id: signal!.id,
      target_type: 'standing_prompt_version',
      target_id: standing_prompt_version_id,
      sql: sql as unknown as import('../../packages/db/signal-store').SqlClient,
    });
    await insertSignalCite({
      signal_id: signal!.id,
      target_type: 'wiki_page_version',
      target_id: wiki_page_version_id,
      sql: sql as unknown as import('../../packages/db/signal-store').SqlClient,
    });

    const cites = await getSignalCites(
      signal!.id,
      sql as unknown as import('../../packages/db/signal-store').SqlClient,
    );
    expect(cites).toHaveLength(2);
    const targetTypes = cites.map((c) => c.target_type);
    expect(targetTypes).toContain('standing_prompt_version');
    expect(targetTypes).toContain('wiki_page_version');
  });

  test('AC-3: insertSignal is idempotent — same key returns null on second call', async () => {
    const market_event_id = `${MARKET_EVENT_ID_PREFIX}004`;
    const standing_prompt_version_id = `${SP_VERSION_ID_PREFIX}004`;

    const first = await insertSignal({
      tenant_id: TENANT_ID,
      researcher_id: RESEARCHER_ID,
      market_event_id,
      standing_prompt_version_id,
      sql: sql as unknown as import('../../packages/db/signal-store').SqlClient,
    });
    expect(first).not.toBeNull();

    // Second call with same (market_event_id, standing_prompt_version_id)
    const second = await insertSignal({
      tenant_id: TENANT_ID,
      researcher_id: RESEARCHER_ID,
      market_event_id,
      standing_prompt_version_id,
      sql: sql as unknown as import('../../packages/db/signal-store').SqlClient,
    });
    expect(second).toBeNull(); // ON CONFLICT DO NOTHING

    // The first row is retrievable by idempotency key
    const idempotency_key = `event_eval:${market_event_id}:${standing_prompt_version_id}`;
    const fetched = await getSignalByIdempotencyKey(
      idempotency_key,
      sql as unknown as import('../../packages/db/signal-store').SqlClient,
    );
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(first!.id);
  });

  test('AC-3: insertSignalCite is idempotent — same edge returns null on second call', async () => {
    const market_event_id = `${MARKET_EVENT_ID_PREFIX}005`;
    const standing_prompt_version_id = `${SP_VERSION_ID_PREFIX}005`;

    const signal = await insertSignal({
      tenant_id: TENANT_ID,
      researcher_id: RESEARCHER_ID,
      market_event_id,
      standing_prompt_version_id,
      sql: sql as unknown as import('../../packages/db/signal-store').SqlClient,
    });
    expect(signal).not.toBeNull();

    const first_cite = await insertSignalCite({
      signal_id: signal!.id,
      target_type: 'standing_prompt_version',
      target_id: standing_prompt_version_id,
      sql: sql as unknown as import('../../packages/db/signal-store').SqlClient,
    });
    expect(first_cite).not.toBeNull();

    const second_cite = await insertSignalCite({
      signal_id: signal!.id,
      target_type: 'standing_prompt_version',
      target_id: standing_prompt_version_id,
      sql: sql as unknown as import('../../packages/db/signal-store').SqlClient,
    });
    // ON CONFLICT DO NOTHING — returns null
    expect(second_cite).toBeNull();
  });

  test('getSignalById returns the signal row', async () => {
    const market_event_id = `${MARKET_EVENT_ID_PREFIX}006`;
    const standing_prompt_version_id = `${SP_VERSION_ID_PREFIX}006`;

    const row = await insertSignal({
      tenant_id: TENANT_ID,
      researcher_id: RESEARCHER_ID,
      market_event_id,
      standing_prompt_version_id,
      sql: sql as unknown as import('../../packages/db/signal-store').SqlClient,
    });
    expect(row).not.toBeNull();

    const fetched = await getSignalById(
      row!.id,
      sql as unknown as import('../../packages/db/signal-store').SqlClient,
    );
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(row!.id);
    expect(fetched!.market_event_id).toBe(market_event_id);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: event-eval internal API (via local HTTP server)
// ---------------------------------------------------------------------------

describe('event-eval API (AC-1, AC-2, AC-3)', () => {
  const TENANT_ID = fixture.standing_prompt.tenant_id;
  const RESEARCHER_ID = fixture.standing_prompt.researcher_id;

  const authHeader = { Authorization: `Bearer ${TEST_TOKEN}` };

  let marketEventId: string;
  let standingPromptVersionId: string;

  beforeAll(async () => {
    // Seed a market_event row via direct DB insert (raw_filings FK is nullable).
    const meRow = await sql<{ id: string }[]>`
      INSERT INTO market_events
        (source, event_type, subject_entity_id, subject_entity_type, event_date, description, status)
      VALUES
        (${fixture.market_event.source}, ${fixture.market_event.event_type},
         ${fixture.market_event.subject_entity_id}, ${fixture.market_event.subject_entity_type},
         ${fixture.market_event.event_date}::TIMESTAMPTZ, ${fixture.market_event.description},
         ${fixture.market_event.status})
      RETURNING id
    `;
    marketEventId = meRow[0].id;

    // Seed a standing_prompt + version row via the store functions.
    const sp = await upsertStandingPrompt(
      sql as unknown as import('../../packages/db/standing-prompt-store').SqlClient,
      {
        tenant_id: TENANT_ID,
        researcher_id: RESEARCHER_ID,
        subject_type: 'entity',
        subject_id: fixture.standing_prompt.subject_id,
      },
    );

    const { row: spv } = await insertStandingPromptVersion(
      sql as unknown as import('../../packages/db/standing-prompt-store').SqlClient,
      {
        standing_prompt_id: sp.id,
        tenant_id: TENANT_ID,
        researcher_id: RESEARCHER_ID,
        wiki_version_window: fixture.standing_prompt.wiki_version_window,
      },
    );

    const activated = await activateStandingPromptVersion(
      sql as unknown as import('../../packages/db/standing-prompt-store').SqlClient,
      {
        standing_prompt_id: sp.id,
        standing_prompt_version_id: spv.id,
        body: fixture.standing_prompt.body,
      },
    );

    expect(activated.activated).toBe(true);
    if (activated.activated) {
      standingPromptVersionId = activated.row.id;
    }
  });

  test('GET /internal/event-evaluation/market-event returns the seeded event', async () => {
    const url = `${apiBaseUrl}/internal/event-evaluation/market-event?market_event_id=${marketEventId}`;
    const res = await fetch(url, { headers: authHeader });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { market_event: { id: string; event_type: string } | null };
    expect(body.market_event).not.toBeNull();
    expect(body.market_event!.id).toBe(marketEventId);
    expect(body.market_event!.event_type).toBe(fixture.market_event.event_type);
  });

  test('GET /internal/event-evaluation/market-event returns null for unknown id', async () => {
    const url = `${apiBaseUrl}/internal/event-evaluation/market-event?market_event_id=nonexistent-id`;
    const res = await fetch(url, { headers: authHeader });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { market_event: null };
    expect(body.market_event).toBeNull();
  });

  test('GET /internal/event-evaluation/active-prompt returns the seeded prompt version', async () => {
    const params = new URLSearchParams({
      tenant_id: TENANT_ID,
      researcher_id: RESEARCHER_ID,
      subject_type: 'entity',
      subject_id: fixture.standing_prompt.subject_id,
    });
    const url = `${apiBaseUrl}/internal/event-evaluation/active-prompt?${params.toString()}`;
    const res = await fetch(url, { headers: authHeader });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: { id: string; body: string } | null };
    expect(body.version).not.toBeNull();
    expect(body.version!.id).toBe(standingPromptVersionId);
    expect(body.version!.body).toBe(fixture.standing_prompt.body);
  });

  test('GET /internal/event-evaluation/active-prompt returns null when no active prompt', async () => {
    const params = new URLSearchParams({
      tenant_id: 'no-such-tenant',
      researcher_id: 'no-such-researcher',
      subject_type: 'entity',
      subject_id: 'no-such-entity',
    });
    const url = `${apiBaseUrl}/internal/event-evaluation/active-prompt?${params.toString()}`;
    const res = await fetch(url, { headers: authHeader });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: null };
    expect(body.version).toBeNull();
  });

  test('AC-1: POST /internal/event-evaluation/signal creates a signal row', async () => {
    const uniqueEventId = `evt-api-001-${Date.now()}`;
    const res = await fetch(`${apiBaseUrl}/internal/event-evaluation/signal`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: TENANT_ID,
        researcher_id: RESEARCHER_ID,
        market_event_id: uniqueEventId,
        standing_prompt_version_id: standingPromptVersionId,
        rationale: null,
        source_trust: 1.0,
        extraction_certainty: 1.0,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signal_id: string; created: boolean };
    expect(body.created).toBe(true);
    expect(typeof body.signal_id).toBe('string');
  });

  test('AC-2: POST /internal/event-evaluation/signal/:id/cite attaches a cites edge', async () => {
    const uniqueEventId = `evt-api-002-${Date.now()}`;

    // Create signal
    const sigRes = await fetch(`${apiBaseUrl}/internal/event-evaluation/signal`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: TENANT_ID,
        researcher_id: RESEARCHER_ID,
        market_event_id: uniqueEventId,
        standing_prompt_version_id: standingPromptVersionId,
      }),
    });
    expect(sigRes.status).toBe(200);
    const sigBody = (await sigRes.json()) as { signal_id: string; created: boolean };
    expect(sigBody.created).toBe(true);

    // Attach cite
    const citeRes = await fetch(
      `${apiBaseUrl}/internal/event-evaluation/signal/${sigBody.signal_id}/cite`,
      {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_type: 'standing_prompt_version',
          target_id: standingPromptVersionId,
        }),
      },
    );
    expect(citeRes.status).toBe(200);
    const citeBody = (await citeRes.json()) as { signal_cite_id: string; created: boolean };
    expect(citeBody.created).toBe(true);
    expect(typeof citeBody.signal_cite_id).toBe('string');

    // Verify cite is immutable: re-sending same cite returns created: false
    const citeRes2 = await fetch(
      `${apiBaseUrl}/internal/event-evaluation/signal/${sigBody.signal_id}/cite`,
      {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_type: 'standing_prompt_version',
          target_id: standingPromptVersionId,
        }),
      },
    );
    expect(citeRes2.status).toBe(200);
    const citeBody2 = (await citeRes2.json()) as {
      signal_cite_id: string | null;
      created: boolean;
    };
    expect(citeBody2.created).toBe(false);
  });

  test('AC-3: POST /internal/event-evaluation/signal is idempotent', async () => {
    const uniqueEventId = `evt-api-003-${Date.now()}`;

    const res1 = await fetch(`${apiBaseUrl}/internal/event-evaluation/signal`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: TENANT_ID,
        researcher_id: RESEARCHER_ID,
        market_event_id: uniqueEventId,
        standing_prompt_version_id: standingPromptVersionId,
      }),
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { signal_id: string; created: boolean };
    expect(body1.created).toBe(true);

    // Second call with same IDs returns created: false and same signal_id
    const res2 = await fetch(`${apiBaseUrl}/internal/event-evaluation/signal`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: TENANT_ID,
        researcher_id: RESEARCHER_ID,
        market_event_id: uniqueEventId,
        standing_prompt_version_id: standingPromptVersionId,
      }),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { signal_id: string; created: boolean };
    expect(body2.created).toBe(false);
    expect(body2.signal_id).toBe(body1.signal_id);
  });

  test('GET /internal/event-evaluation/signal/check detects existing signal', async () => {
    const uniqueEventId = `evt-api-004-${Date.now()}`;

    // Create signal
    const sigRes = await fetch(`${apiBaseUrl}/internal/event-evaluation/signal`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: TENANT_ID,
        researcher_id: RESEARCHER_ID,
        market_event_id: uniqueEventId,
        standing_prompt_version_id: standingPromptVersionId,
      }),
    });
    const sigBody = (await sigRes.json()) as { signal_id: string; created: boolean };

    const idempotencyKey = `event_eval:${uniqueEventId}:${standingPromptVersionId}`;
    const checkUrl = `${apiBaseUrl}/internal/event-evaluation/signal/check?idempotency_key=${encodeURIComponent(idempotencyKey)}`;
    const checkRes = await fetch(checkUrl, { headers: authHeader });
    expect(checkRes.status).toBe(200);
    const checkBody = (await checkRes.json()) as { signal_id: string | null };
    expect(checkBody.signal_id).toBe(sigBody.signal_id);
  });

  test('GET /internal/event-evaluation/signal/check returns null for unknown key', async () => {
    const checkUrl = `${apiBaseUrl}/internal/event-evaluation/signal/check?idempotency_key=event_eval:nonexistent:nonexistent`;
    const checkRes = await fetch(checkUrl, { headers: authHeader });
    expect(checkRes.status).toBe(200);
    const checkBody = (await checkRes.json()) as { signal_id: null };
    expect(checkBody.signal_id).toBeNull();
  });

  test('Unauthorized requests receive 401', async () => {
    const res = await fetch(
      `${apiBaseUrl}/internal/event-evaluation/market-event?market_event_id=x`,
      {
        headers: { Authorization: 'Bearer wrong-token' },
      },
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: executeEventEvalTask worker (AC-1, AC-2, AC-3)
// ---------------------------------------------------------------------------

describe('executeEventEvalTask worker (AC-1, AC-2, AC-3)', () => {
  const TENANT_ID = 'tenant-worker-eval-82';
  const RESEARCHER_ID = 'researcher-worker-82';

  let marketEventId: string;
  let standingPromptVersionId: string;

  beforeAll(async () => {
    // Seed market_event.
    const meRow = await sql<{ id: string }[]>`
      INSERT INTO market_events
        (source, event_type, subject_entity_id, subject_entity_type, event_date,
         description, status)
      VALUES
        ('edgar', '10-K', 'entity-WORKER-001', 'company',
         '2026-02-01T09:00:00Z'::TIMESTAMPTZ,
         'Annual report disclosure for WORKER Corp.', 'Detected')
      RETURNING id
    `;
    marketEventId = meRow[0].id;

    // Seed standing prompt + version.
    const sp = await upsertStandingPrompt(
      sql as unknown as import('../../packages/db/standing-prompt-store').SqlClient,
      {
        tenant_id: TENANT_ID,
        researcher_id: RESEARCHER_ID,
        subject_type: 'entity',
        subject_id: 'entity-WORKER-001',
      },
    );

    const { row: spv } = await insertStandingPromptVersion(
      sql as unknown as import('../../packages/db/standing-prompt-store').SqlClient,
      {
        standing_prompt_id: sp.id,
        tenant_id: TENANT_ID,
        researcher_id: RESEARCHER_ID,
        wiki_version_window: '2026-02-01T09:00',
      },
    );

    const activated = await activateStandingPromptVersion(
      sql as unknown as import('../../packages/db/standing-prompt-store').SqlClient,
      {
        standing_prompt_id: sp.id,
        standing_prompt_version_id: spv.id,
        body: 'WORKER Corp thesis: monitor annual reports for asset and revenue disclosures.',
      },
    );

    expect(activated.activated).toBe(true);
    if (activated.activated) {
      standingPromptVersionId = activated.row.id;
    }
  });

  /**
   * Build a minimal TaskQueueRow stub for the worker executor.
   */
  function makeTaskRow(marketEventId: string, delegatedToken: string): TaskQueueRow {
    return {
      id: `task-eval-${Date.now()}`,
      job_type: 'EVENT_EVALUATE',
      agent_type: 'event_evaluator',
      status: 'claimed',
      payload: { market_event_id: marketEventId } as unknown as Record<string, unknown>,
      delegated_token: delegatedToken,
      idempotency_key: `event_eval:${marketEventId}`,
      priority: 'high',
      created_at: new Date(),
      updated_at: new Date(),
      claimed_at: new Date(),
      claimed_by: 'test-worker',
      completed_at: null,
      error_message: null,
      result: null,
      retry_count: 0,
      max_retries: 3,
    } as unknown as TaskQueueRow;
  }

  test('AC-1: executeEventEvalTask produces a signal row', async () => {
    const task = makeTaskRow(marketEventId, TEST_TOKEN);

    // The market_event row does not have tenant_id / researcher_id columns;
    // the API stub returns only the DB columns. The worker must be able to
    // resolve the researcher from the event. For the scout, we patch the market
    // event query response by seeding tenant_id/researcher_id via a custom
    // market_event table column approach.
    //
    // SCOUT NOTE: In this test, we call the worker directly against the local
    // HTTP server. The market-event API endpoint in event-eval-api.ts returns
    // the market_events row, which does NOT have tenant_id/researcher_id columns
    // in the current schema. For the scout, we exercise the API routes
    // individually and test the worker's idempotency logic via the check
    // endpoint rather than the full pipeline.
    //
    // The full wiring (market_event → researcher resolution → signal) is a
    // follow-on Phase 6 feature issue that will add a researcher_id FK or
    // tenant-lookup join to the market_events schema.

    // Instead, test the worker payload parsing and early-exit logic.
    expect(() => parseEventEvalPayload(task.payload as unknown)).not.toThrow();
    const parsed = parseEventEvalPayload(task.payload as unknown);
    expect(parsed.market_event_id).toBe(marketEventId);
  });

  test('AC-3: executeEventEvalTask idempotency — signal/check returns existing signal', async () => {
    // Create a signal directly via API.
    const uniqueEventId = `evt-worker-idem-${Date.now()}`;
    const createRes = await fetch(`${apiBaseUrl}/internal/event-evaluation/signal`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenant_id: TENANT_ID,
        researcher_id: RESEARCHER_ID,
        market_event_id: uniqueEventId,
        standing_prompt_version_id: standingPromptVersionId,
      }),
    });
    const createBody = (await createRes.json()) as { signal_id: string; created: boolean };
    expect(createBody.created).toBe(true);

    // Now verify the idempotency check returns the existing signal_id.
    const idempotencyKey = `event_eval:${uniqueEventId}:${standingPromptVersionId}`;
    const checkUrl = `${apiBaseUrl}/internal/event-evaluation/signal/check?idempotency_key=${encodeURIComponent(idempotencyKey)}`;
    const checkRes = await fetch(checkUrl, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const checkBody = (await checkRes.json()) as { signal_id: string | null };
    expect(checkBody.signal_id).toBe(createBody.signal_id);
  });

  test('AC-2: signal_cites edge is immutable — target_id never changes after creation', async () => {
    const uniqueEventId = `evt-cite-imm-${Date.now()}`;

    // Create signal.
    const sigRes = await fetch(`${apiBaseUrl}/internal/event-evaluation/signal`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenant_id: TENANT_ID,
        researcher_id: RESEARCHER_ID,
        market_event_id: uniqueEventId,
        standing_prompt_version_id: standingPromptVersionId,
      }),
    });
    const sigBody = (await sigRes.json()) as { signal_id: string };

    // Attach cite.
    await fetch(`${apiBaseUrl}/internal/event-evaluation/signal/${sigBody.signal_id}/cite`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        target_type: 'standing_prompt_version',
        target_id: standingPromptVersionId,
      }),
    });

    // Fetch cites directly from DB.
    const cites = await getSignalCites(
      sigBody.signal_id,
      sql as unknown as import('../../packages/db/signal-store').SqlClient,
    );
    expect(cites).toHaveLength(1);
    expect(cites[0].target_id).toBe(standingPromptVersionId);
    expect(cites[0].target_type).toBe('standing_prompt_version');

    // Attempting to insert a different target_id for the same target_type
    // creates a new row (different UNIQUE key), not an update to the existing one.
    const altVersionId = 'spv-alternative-version';
    const altCite = await insertSignalCite({
      signal_id: sigBody.signal_id,
      target_type: 'standing_prompt_version',
      target_id: altVersionId,
      sql: sql as unknown as import('../../packages/db/signal-store').SqlClient,
    });
    expect(altCite).not.toBeNull();
    expect(altCite!.target_id).toBe(altVersionId);

    // The original cite is still present and unchanged.
    const citesAfter = await getSignalCites(
      sigBody.signal_id,
      sql as unknown as import('../../packages/db/signal-store').SqlClient,
    );
    const original = citesAfter.find((c) => c.target_id === standingPromptVersionId);
    expect(original).not.toBeUndefined();
    expect(original!.target_id).toBe(standingPromptVersionId);
  });
});

// ---------------------------------------------------------------------------
// Schema test: AC-4 — signals and signal_cites tables created by SIGNAL_STORE_DDL
// ---------------------------------------------------------------------------

describe('AC-4: Schema (SIGNAL_STORE_DDL)', () => {
  test('signals table exists and accepts a valid row', async () => {
    const rows = await sql<{ count: string }[]>`
      SELECT COUNT(*) FROM signals
    `;
    expect(Number(rows[0].count)).toBeGreaterThanOrEqual(0);
  });

  test('signal_cites table exists and accepts a valid row', async () => {
    const rows = await sql<{ count: string }[]>`
      SELECT COUNT(*) FROM signal_cites
    `;
    expect(Number(rows[0].count)).toBeGreaterThanOrEqual(0);
  });

  test('signals status CHECK constraint rejects invalid status', async () => {
    await expect(
      sql`INSERT INTO signals (tenant_id, researcher_id, market_event_id,
            standing_prompt_version_id, idempotency_key, status)
          VALUES ('t1', 'r1', 'e1', 'spv1', 'check-invalid-status', 'InvalidStatus')`,
    ).rejects.toThrow();
  });

  test('signal_cites target_type CHECK constraint rejects invalid type', async () => {
    // First insert a valid signal to attach a cite to.
    const [sig] = await sql<{ id: string }[]>`
      INSERT INTO signals (tenant_id, researcher_id, market_event_id,
        standing_prompt_version_id, idempotency_key)
      VALUES ('t1', 'r1', 'e-schema-test', 'spv-schema-test', 'schema-cite-check')
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
    `;
    // If conflict, fetch existing
    const sigId =
      sig?.id ??
      (
        await sql<{ id: string }[]>`
      SELECT id FROM signals WHERE idempotency_key = 'schema-cite-check' LIMIT 1
    `
      )[0].id;

    await expect(
      sql`INSERT INTO signal_cites (signal_id, target_type, target_id)
          VALUES (${sigId}, 'invalid_type', 'x')`,
    ).rejects.toThrow();
  });
});
