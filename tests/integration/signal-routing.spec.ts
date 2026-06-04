/**
 * @file tests/integration/signal-routing.spec.ts
 *
 * Integration tests for signal routing — issue #83.
 *
 * ## What this tests
 *
 * Validates the three acceptance criteria for issue #83:
 *
 *   AC-1  An event routes to the most specific matching prompt.
 *         TC-1: entity-level prompt is selected when available.
 *         TC-2: thesis-level prompt is selected when entity-level is absent.
 *         TC-3: portfolio-level prompt is selected when neither entity nor thesis exists.
 *         TC-4: routing specificity: entity beats thesis beats portfolio.
 *
 *   AC-2  Confidence factors are stored independently on the signal.
 *         TC-5: source_trust and extraction_certainty stored on signal row.
 *         TC-6: confidence = source_trust × extraction_certainty (unit).
 *         TC-7: values are clamped to [0.0, 1.0] by computeConfidence.
 *
 *   AC-3  Below-threshold signals require reviewer approval before Delivered.
 *         TC-8: high-confidence signal routed to 'direct' (≥ threshold).
 *         TC-9: low-confidence signal routed to 'reviewer' (< threshold).
 *         TC-10: Reviewer approve → Queued → Delivered (journal entry written).
 *         TC-11: Reviewer edit → Queued → Delivered (rationale updated, journal written).
 *         TC-12: Reviewer suppress → Queued → Suppressed (journal entry written).
 *         TC-13: Concurrent triage — second approve returns transitioned: false.
 *
 * ## No mocks
 *
 * Uses a real ephemeral Postgres container. No vi.fn, vi.mock, vi.spyOn.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5, §9
 * - docs/architecture.md §"Signal routing"
 * - packages/db/signal-routing.ts — routing logic
 * - packages/db/signal-reviewer-store.ts — reviewer queue
 * - apps/server/src/api/signal-routing-api.ts — routing HTTP surface
 * - apps/server/src/api/reviewer-api.ts — reviewer HTTP surface
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/83
 */

import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../../packages/db/pg-container';
import { runInitRemote } from '../../packages/db/init-remote';
import { migrate, migrateMkt } from '../../packages/db/index';
import { WIKI_REBUILD_DDL } from '../../packages/db/wiki-rebuild-store';
import { STANDING_PROMPT_DDL } from '../../packages/db/standing-prompt-store';
import { SIGNAL_STORE_DDL, insertSignal } from '../../packages/db/signal-store';
import {
  resolveStandingPromptForEvent,
  computeConfidence,
  routeByConfidence,
  DEFAULT_CONFIDENCE_THRESHOLD,
} from '../../packages/db/signal-routing';
import {
  listQueuedSignals,
  approveQueuedSignal,
  editAndApproveQueuedSignal,
  suppressQueuedSignal,
} from '../../packages/db/signal-reviewer-store';
import {
  upsertStandingPrompt,
  insertStandingPromptVersion,
  activateStandingPromptVersion,
} from '../../packages/db/standing-prompt-store';
import {
  handleSignalRoutingApiRequest,
  SIGNAL_ROUTING_TEST_TOKEN,
} from '../../apps/server/src/api/signal-routing-api';
import {
  handleReviewerApiRequest,
  REVIEWER_TEST_TOKEN,
} from '../../apps/server/src/api/reviewer-api';
import type { AppState } from '../../apps/server/src/index';
import fixture from '../fixtures/signal-routing/signal-routing-fixture.json';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const TEST_PASSWORDS = {
  app: 'app_routing83_pw',
  audit: 'audit_routing83_pw',
  analytics: 'analytics_routing83_pw',
  dictionary: 'dict_routing83_pw',
  email_ingest: 'email_routing83_pw',
};

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

function makeRoleUrl(adminUrl: string, db: string, user: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
}

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
          const response =
            (await handleSignalRoutingApiRequest(fetchReq, url, state)) ??
            (await handleReviewerApiRequest(fetchReq, url, state));

          if (response) {
            const resBody = await response.text();
            res.writeHead(response.status, { 'Content-Type': 'application/json' });
            res.end(resBody);
            return;
          }

          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        } catch (err) {
          console.error('[routing-test-server] Unhandled error:', err);
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
  await sql.unsafe(STANDING_PROMPT_DDL);
  await sql.unsafe(SIGNAL_STORE_DDL);

  appState = {
    sql: sql as unknown as typeof import('../../packages/db/index').sql,
    auditSql: sql as unknown as typeof import('../../packages/db/index').sql,
    analyticsSql: sql as unknown as typeof import('../../packages/db/index').sql,
    dictionarySql: sql as unknown as typeof import('../../packages/db/index').sql,
  };

  process.env['TEST_MODE'] = 'true';

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
// Unit tests: computeConfidence + routeByConfidence
// ---------------------------------------------------------------------------

describe('computeConfidence (unit)', () => {
  test('TC-6: confidence = source_trust × extraction_certainty', () => {
    const r = computeConfidence(0.8, 0.9);
    expect(r.source_trust).toBeCloseTo(0.8);
    expect(r.extraction_certainty).toBeCloseTo(0.9);
    expect(r.confidence).toBeCloseTo(0.72);
  });

  test('TC-7: values > 1.0 are clamped to 1.0', () => {
    const r = computeConfidence(1.5, 2.0);
    expect(r.source_trust).toBe(1);
    expect(r.extraction_certainty).toBe(1);
    expect(r.confidence).toBe(1);
  });

  test('TC-7: values < 0.0 are clamped to 0.0', () => {
    const r = computeConfidence(-0.5, 0.8);
    expect(r.source_trust).toBe(0);
    expect(r.confidence).toBe(0);
  });

  test('boundary: both 0 → confidence 0', () => {
    const r = computeConfidence(0, 0);
    expect(r.confidence).toBe(0);
  });

  test('boundary: both 1 → confidence 1', () => {
    const r = computeConfidence(1, 1);
    expect(r.confidence).toBe(1);
  });
});

describe('routeByConfidence (unit)', () => {
  test('TC-8: confidence ≥ threshold → direct', () => {
    expect(routeByConfidence(0.7, 0.7)).toBe('direct');
    expect(routeByConfidence(0.9, 0.7)).toBe('direct');
    expect(routeByConfidence(1.0, 0.7)).toBe('direct');
  });

  test('TC-9: confidence < threshold → reviewer', () => {
    expect(routeByConfidence(0.69, 0.7)).toBe('reviewer');
    expect(routeByConfidence(0.0, 0.7)).toBe('reviewer');
  });

  test('uses DEFAULT_CONFIDENCE_THRESHOLD when threshold omitted', () => {
    expect(routeByConfidence(DEFAULT_CONFIDENCE_THRESHOLD)).toBe('direct');
    expect(routeByConfidence(DEFAULT_CONFIDENCE_THRESHOLD - 0.01)).toBe('reviewer');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: prompt routing specificity (AC-1)
// ---------------------------------------------------------------------------

describe('resolveStandingPromptForEvent — routing specificity (AC-1)', () => {
  const TENANT_ID = `${fixture.tenant_id}-resolve`;
  const RESEARCHER_ID = `${fixture.researcher_id}-resolve`;
  const ENTITY_ID = 'entity-specificity-001';
  const THESIS_ID = 'thesis-specificity-001';

  test('TC-1: entity-level prompt is resolved when available', async () => {
    // Seed entity + portfolio prompts; entity should win.
    const entityVersionId = await seedPromptForTenant(
      TENANT_ID,
      RESEARCHER_ID,
      'entity',
      ENTITY_ID,
      fixture.entity_prompt_body,
      '2026-01-21T10:00',
    );
    await seedPromptForTenant(
      TENANT_ID,
      RESEARCHER_ID,
      'portfolio',
      'portfolio',
      fixture.portfolio_prompt_body,
      '2026-01-21T10:01',
    );

    const resolved = await resolveStandingPromptForEvent({
      sql: sql as unknown as import('../../packages/db/signal-routing').SqlClient,
      tenant_id: TENANT_ID,
      researcher_id: RESEARCHER_ID,
      subject_entity_id: ENTITY_ID,
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.subjectType).toBe('entity');
    expect(resolved!.subjectId).toBe(ENTITY_ID);
    expect(resolved!.promptVersion.id).toBe(entityVersionId);
  });

  test('TC-2: thesis-level prompt selected when entity-level absent', async () => {
    // Only thesis + portfolio; no entity-level.
    const tn = `${TENANT_ID}-2`;
    const rn = `${RESEARCHER_ID}-2`;

    const thesisVersionId = await seedPromptForTenant(
      tn,
      rn,
      'thesis',
      THESIS_ID,
      fixture.thesis_prompt_body,
      '2026-01-21T11:00',
    );
    await seedPromptForTenant(
      tn,
      rn,
      'portfolio',
      'portfolio',
      fixture.portfolio_prompt_body,
      '2026-01-21T11:01',
    );

    const resolved = await resolveStandingPromptForEvent({
      sql: sql as unknown as import('../../packages/db/signal-routing').SqlClient,
      tenant_id: tn,
      researcher_id: rn,
      subject_entity_id: 'entity-no-entity-level',
      thesis_ids: [THESIS_ID],
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.subjectType).toBe('thesis');
    expect(resolved!.subjectId).toBe(THESIS_ID);
    expect(resolved!.promptVersion.id).toBe(thesisVersionId);
  });

  test('TC-3: portfolio-level prompt selected when neither entity nor thesis exists', async () => {
    const tn = `${TENANT_ID}-3`;
    const rn = `${RESEARCHER_ID}-3`;

    const portfolioVersionId = await seedPromptForTenant(
      tn,
      rn,
      'portfolio',
      'portfolio',
      fixture.portfolio_prompt_body,
      '2026-01-21T12:00',
    );

    const resolved = await resolveStandingPromptForEvent({
      sql: sql as unknown as import('../../packages/db/signal-routing').SqlClient,
      tenant_id: tn,
      researcher_id: rn,
      subject_entity_id: 'entity-no-prompts',
      thesis_ids: [],
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.subjectType).toBe('portfolio');
    expect(resolved!.subjectId).toBe('portfolio');
    expect(resolved!.promptVersion.id).toBe(portfolioVersionId);
  });

  test('TC-4: entity beats thesis beats portfolio — specificity ordering', async () => {
    // All three levels present; entity must win.
    const tn = `${TENANT_ID}-4`;
    const rn = `${RESEARCHER_ID}-4`;

    const entityVersionId = await seedPromptForTenant(
      tn,
      rn,
      'entity',
      ENTITY_ID,
      fixture.entity_prompt_body,
      '2026-01-21T13:00',
    );
    await seedPromptForTenant(
      tn,
      rn,
      'thesis',
      THESIS_ID,
      fixture.thesis_prompt_body,
      '2026-01-21T13:01',
    );
    await seedPromptForTenant(
      tn,
      rn,
      'portfolio',
      'portfolio',
      fixture.portfolio_prompt_body,
      '2026-01-21T13:02',
    );

    const resolved = await resolveStandingPromptForEvent({
      sql: sql as unknown as import('../../packages/db/signal-routing').SqlClient,
      tenant_id: tn,
      researcher_id: rn,
      subject_entity_id: ENTITY_ID,
      thesis_ids: [THESIS_ID],
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.subjectType).toBe('entity');
    expect(resolved!.promptVersion.id).toBe(entityVersionId);
  });

  test('returns null when no prompt exists at any level', async () => {
    const resolved = await resolveStandingPromptForEvent({
      sql: sql as unknown as import('../../packages/db/signal-routing').SqlClient,
      tenant_id: 'no-tenant',
      researcher_id: 'no-researcher',
      subject_entity_id: 'no-entity',
    });
    expect(resolved).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration tests: confidence stored on signal (AC-2)
// ---------------------------------------------------------------------------

describe('Confidence decomposition stored on signal row (AC-2)', () => {
  const TENANT_ID = `${fixture.tenant_id}-conf`;
  const RESEARCHER_ID = `${fixture.researcher_id}-conf`;

  test('TC-5: source_trust and extraction_certainty stored independently on signal', async () => {
    const row = await insertSignal({
      tenant_id: TENANT_ID,
      researcher_id: RESEARCHER_ID,
      market_event_id: `evt-conf-${Date.now()}`,
      standing_prompt_version_id: `spv-conf-${Date.now()}`,
      source_trust: 0.9,
      extraction_certainty: 0.8,
      sql: sql as unknown as import('../../packages/db/signal-store').SqlClient,
    });

    expect(row).not.toBeNull();
    expect(row!.source_trust).toBeCloseTo(0.9);
    expect(row!.extraction_certainty).toBeCloseTo(0.8);
  });

  test('TC-5: source_trust and extraction_certainty can differ independently', async () => {
    const row = await insertSignal({
      tenant_id: TENANT_ID,
      researcher_id: RESEARCHER_ID,
      market_event_id: `evt-conf2-${Date.now()}`,
      standing_prompt_version_id: `spv-conf2-${Date.now()}`,
      source_trust: 0.3,
      extraction_certainty: 0.95,
      sql: sql as unknown as import('../../packages/db/signal-store').SqlClient,
    });

    expect(row).not.toBeNull();
    // Independently stored — they are NOT equal.
    expect(row!.source_trust).toBeCloseTo(0.3);
    expect(row!.extraction_certainty).toBeCloseTo(0.95);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: reviewer queue triage (AC-3)
// ---------------------------------------------------------------------------

describe('Reviewer queue triage (AC-3)', () => {
  const TENANT_ID = `${fixture.tenant_id}-review`;
  const RESEARCHER_ID = `${fixture.researcher_id}-review`;
  const REVIEWER_ID = 'reviewer-83-test';

  async function seedQueuedSignal(): Promise<string> {
    const row = await insertSignal({
      tenant_id: TENANT_ID,
      researcher_id: RESEARCHER_ID,
      market_event_id: `evt-review-${Date.now()}-${Math.random()}`,
      standing_prompt_version_id: `spv-review-${Date.now()}`,
      source_trust: 0.4,
      extraction_certainty: 0.5,
      status: 'Queued',
      sql: sql as unknown as import('../../packages/db/signal-store').SqlClient,
    });
    if (!row) throw new Error('Failed to seed signal');
    return row.id;
  }

  test('TC-10: approveQueuedSignal transitions Queued → Delivered', async () => {
    const signalId = await seedQueuedSignal();

    const approved = await approveQueuedSignal(
      signalId,
      REVIEWER_ID,
      sql as unknown as import('../../packages/db/signal-reviewer-store').SqlClient,
    );

    expect(approved).not.toBeNull();
    expect(approved!.status).toBe('Delivered');
    expect(approved!.id).toBe(signalId);
  });

  test('TC-10: journal entry written on approve', async () => {
    const signalId = await seedQueuedSignal();

    await approveQueuedSignal(
      signalId,
      REVIEWER_ID,
      sql as unknown as import('../../packages/db/signal-reviewer-store').SqlClient,
    );

    const journalRows = await sql<{ event_type: string; entity_id: string }[]>`
      SELECT event_type, entity_id FROM business_journal
      WHERE entity_id = ${signalId}
        AND event_type = 'signal.reviewer.approved'
      LIMIT 1
    `;
    expect(journalRows).toHaveLength(1);
    expect(journalRows[0].entity_id).toBe(signalId);
  });

  test('TC-11: editAndApproveQueuedSignal updates rationale and transitions Queued → Delivered', async () => {
    const signalId = await seedQueuedSignal();
    const newRationale = 'Reviewer confirmed thesis alignment.';

    const edited = await editAndApproveQueuedSignal(
      signalId,
      newRationale,
      REVIEWER_ID,
      sql as unknown as import('../../packages/db/signal-reviewer-store').SqlClient,
    );

    expect(edited).not.toBeNull();
    expect(edited!.status).toBe('Delivered');
    expect(edited!.rationale).toBe(newRationale);
  });

  test('TC-11: journal entry written on edit', async () => {
    const signalId = await seedQueuedSignal();

    await editAndApproveQueuedSignal(
      signalId,
      'Edited rationale.',
      REVIEWER_ID,
      sql as unknown as import('../../packages/db/signal-reviewer-store').SqlClient,
    );

    const journalRows = await sql<{ event_type: string }[]>`
      SELECT event_type FROM business_journal
      WHERE entity_id  = ${signalId}
        AND event_type = 'signal.reviewer.edited'
      LIMIT 1
    `;
    expect(journalRows).toHaveLength(1);
  });

  test('TC-12: suppressQueuedSignal transitions Queued → Suppressed', async () => {
    const signalId = await seedQueuedSignal();

    const suppressed = await suppressQueuedSignal(
      signalId,
      REVIEWER_ID,
      sql as unknown as import('../../packages/db/signal-reviewer-store').SqlClient,
    );

    expect(suppressed).not.toBeNull();
    expect(suppressed!.status).toBe('Suppressed');
  });

  test('TC-12: journal entry written on suppress', async () => {
    const signalId = await seedQueuedSignal();

    await suppressQueuedSignal(
      signalId,
      REVIEWER_ID,
      sql as unknown as import('../../packages/db/signal-reviewer-store').SqlClient,
    );

    const journalRows = await sql<{ event_type: string }[]>`
      SELECT event_type FROM business_journal
      WHERE entity_id  = ${signalId}
        AND event_type = 'signal.reviewer.suppressed'
      LIMIT 1
    `;
    expect(journalRows).toHaveLength(1);
  });

  test('TC-13: second approve on already-approved signal returns null (no double-transition)', async () => {
    const signalId = await seedQueuedSignal();

    const first = await approveQueuedSignal(
      signalId,
      REVIEWER_ID,
      sql as unknown as import('../../packages/db/signal-reviewer-store').SqlClient,
    );
    expect(first).not.toBeNull();

    // Second approve — signal is now Delivered, not Queued → returns null.
    const second = await approveQueuedSignal(
      signalId,
      REVIEWER_ID,
      sql as unknown as import('../../packages/db/signal-reviewer-store').SqlClient,
    );
    expect(second).toBeNull();
  });

  test('listQueuedSignals returns only Queued signals for researcher', async () => {
    // Seed one Queued and one Delivered signal for this researcher.
    const queuedId = await seedQueuedSignal();
    const deliveredRow = await insertSignal({
      tenant_id: TENANT_ID,
      researcher_id: RESEARCHER_ID,
      market_event_id: `evt-delivered-${Date.now()}`,
      standing_prompt_version_id: `spv-delivered-${Date.now()}`,
      status: 'Delivered',
      sql: sql as unknown as import('../../packages/db/signal-store').SqlClient,
    });

    const queued = await listQueuedSignals({
      sql: sql as unknown as import('../../packages/db/signal-reviewer-store').SqlClient,
      tenant_id: TENANT_ID,
      researcher_id: RESEARCHER_ID,
    });

    const queuedIds = queued.map((s) => s.id);
    expect(queuedIds).toContain(queuedId);
    if (deliveredRow) {
      expect(queuedIds).not.toContain(deliveredRow.id);
    }
    queued.forEach((s) => expect(s.status).toBe('Queued'));
  });
});

// ---------------------------------------------------------------------------
// Integration tests: HTTP API surface
// ---------------------------------------------------------------------------

describe('Signal-routing API (AC-1)', () => {
  const TENANT_ID = `${fixture.tenant_id}-api`;
  const RESEARCHER_ID = `${fixture.researcher_id}-api`;
  const ENTITY_ID = 'entity-api-routing-001';

  const routingAuth = { Authorization: `Bearer ${SIGNAL_ROUTING_TEST_TOKEN}` };

  beforeAll(async () => {
    // Seed entity prompt for API tests.
    await seedPromptForTenant(
      TENANT_ID,
      RESEARCHER_ID,
      'entity',
      ENTITY_ID,
      fixture.entity_prompt_body,
      '2026-01-22T10:00',
    );
  });

  test('GET /internal/signal-routing/resolve-prompt returns entity prompt', async () => {
    const params = new URLSearchParams({
      tenant_id: TENANT_ID,
      researcher_id: RESEARCHER_ID,
      subject_entity_id: ENTITY_ID,
    });
    const res = await fetch(`${apiBaseUrl}/internal/signal-routing/resolve-prompt?${params}`, {
      headers: routingAuth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      prompt_version: { id: string } | null;
      subject_type: string | null;
    };
    expect(body.prompt_version).not.toBeNull();
    expect(body.subject_type).toBe('entity');
  });

  test('GET /internal/signal-routing/resolve-prompt returns null for unknown researcher', async () => {
    const params = new URLSearchParams({
      tenant_id: 'unknown',
      researcher_id: 'unknown',
      subject_entity_id: 'unknown',
    });
    const res = await fetch(`${apiBaseUrl}/internal/signal-routing/resolve-prompt?${params}`, {
      headers: routingAuth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { prompt_version: null };
    expect(body.prompt_version).toBeNull();
  });

  test('POST /internal/signal-routing/route returns direct for high confidence', async () => {
    const res = await fetch(`${apiBaseUrl}/internal/signal-routing/route`, {
      method: 'POST',
      headers: { ...routingAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_trust: 0.9, extraction_certainty: 0.9 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      route: string;
      confidence: number;
      source_trust: number;
      extraction_certainty: number;
    };
    expect(body.route).toBe('direct');
    expect(body.confidence).toBeCloseTo(0.81);
    expect(body.source_trust).toBeCloseTo(0.9);
    expect(body.extraction_certainty).toBeCloseTo(0.9);
  });

  test('POST /internal/signal-routing/route returns reviewer for low confidence', async () => {
    const res = await fetch(`${apiBaseUrl}/internal/signal-routing/route`, {
      method: 'POST',
      headers: { ...routingAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_trust: 0.4, extraction_certainty: 0.5 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { route: string; confidence: number };
    expect(body.route).toBe('reviewer');
    expect(body.confidence).toBeCloseTo(0.2);
  });

  test('POST /internal/signal-routing/route respects custom threshold', async () => {
    const res = await fetch(`${apiBaseUrl}/internal/signal-routing/route`, {
      method: 'POST',
      headers: { ...routingAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_trust: 0.5, extraction_certainty: 0.5, threshold: 0.2 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { route: string };
    // 0.5 × 0.5 = 0.25 ≥ threshold 0.2 → direct
    expect(body.route).toBe('direct');
  });

  test('Unauthorized requests receive 401', async () => {
    const res = await fetch(
      `${apiBaseUrl}/internal/signal-routing/resolve-prompt?tenant_id=x&researcher_id=x&subject_entity_id=x`,
      { headers: { Authorization: 'Bearer wrong' } },
    );
    expect(res.status).toBe(401);
  });
});

describe('Reviewer API (AC-3)', () => {
  const TENANT_ID = `${fixture.tenant_id}-revapi`;
  const RESEARCHER_ID = `${fixture.researcher_id}-revapi`;
  const REVIEWER_ID = 'reviewer-api-83';

  const reviewerAuth = { Authorization: `Bearer ${REVIEWER_TEST_TOKEN}` };

  async function seedQueuedSignalApi(): Promise<string> {
    const row = await insertSignal({
      tenant_id: TENANT_ID,
      researcher_id: RESEARCHER_ID,
      market_event_id: `evt-revapi-${Date.now()}-${Math.random()}`,
      standing_prompt_version_id: `spv-revapi-${Date.now()}`,
      source_trust: 0.3,
      extraction_certainty: 0.4,
      status: 'Queued',
      sql: sql as unknown as import('../../packages/db/signal-store').SqlClient,
    });
    if (!row) throw new Error('Failed to seed signal for API test');
    return row.id;
  }

  test('GET /internal/reviewer/queue lists queued signals', async () => {
    const signalId = await seedQueuedSignalApi();
    const params = new URLSearchParams({ tenant_id: TENANT_ID, researcher_id: RESEARCHER_ID });
    const res = await fetch(`${apiBaseUrl}/internal/reviewer/queue?${params}`, {
      headers: reviewerAuth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signals: { id: string; status: string }[] };
    const ids = body.signals.map((s) => s.id);
    expect(ids).toContain(signalId);
    body.signals.forEach((s) => expect(s.status).toBe('Queued'));
  });

  test('POST /internal/reviewer/signal/:id/approve transitions to Delivered', async () => {
    const signalId = await seedQueuedSignalApi();
    const res = await fetch(`${apiBaseUrl}/internal/reviewer/signal/${signalId}/approve`, {
      method: 'POST',
      headers: { ...reviewerAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewer_id: REVIEWER_ID }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signal: { status: string } | null; transitioned: boolean };
    expect(body.transitioned).toBe(true);
    expect(body.signal!.status).toBe('Delivered');
  });

  test('POST /internal/reviewer/signal/:id/edit updates rationale and transitions to Delivered', async () => {
    const signalId = await seedQueuedSignalApi();
    const res = await fetch(`${apiBaseUrl}/internal/reviewer/signal/${signalId}/edit`, {
      method: 'POST',
      headers: { ...reviewerAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reviewer_id: REVIEWER_ID,
        rationale: 'Confirmed thesis alignment — approved with context.',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      signal: { status: string; rationale: string } | null;
      transitioned: boolean;
    };
    expect(body.transitioned).toBe(true);
    expect(body.signal!.status).toBe('Delivered');
    expect(body.signal!.rationale).toBe('Confirmed thesis alignment — approved with context.');
  });

  test('POST /internal/reviewer/signal/:id/suppress transitions to Suppressed', async () => {
    const signalId = await seedQueuedSignalApi();
    const res = await fetch(`${apiBaseUrl}/internal/reviewer/signal/${signalId}/suppress`, {
      method: 'POST',
      headers: { ...reviewerAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewer_id: REVIEWER_ID }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      signal: { status: string } | null;
      transitioned: boolean;
    };
    expect(body.transitioned).toBe(true);
    expect(body.signal!.status).toBe('Suppressed');
  });

  test('Unauthorized reviewer requests receive 401', async () => {
    const res = await fetch(`${apiBaseUrl}/internal/reviewer/queue?tenant_id=x&researcher_id=x`, {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Helper: seed prompt for a specific tenant/researcher (scoped to avoid conflicts)
// ---------------------------------------------------------------------------

async function seedPromptForTenant(
  tenant_id: string,
  researcher_id: string,
  subjectType: 'entity' | 'thesis' | 'portfolio',
  subjectId: string,
  body: string,
  window: string,
): Promise<string> {
  const sp = await upsertStandingPrompt(
    sql as unknown as import('../../packages/db/standing-prompt-store').SqlClient,
    {
      tenant_id,
      researcher_id,
      subject_type: subjectType,
      subject_id: subjectId,
    },
  );

  const { row: spv } = await insertStandingPromptVersion(
    sql as unknown as import('../../packages/db/standing-prompt-store').SqlClient,
    {
      standing_prompt_id: sp.id,
      tenant_id,
      researcher_id,
      wiki_version_window: window,
    },
  );

  const activated = await activateStandingPromptVersion(
    sql as unknown as import('../../packages/db/standing-prompt-store').SqlClient,
    {
      standing_prompt_id: sp.id,
      standing_prompt_version_id: spv.id,
      body,
    },
  );

  if (!activated.activated) {
    // If pin blocked, return the existing pinned version
    if (activated.reason === 'pinned') return activated.pinnedVersionId;
    throw new Error(`Failed to activate ${subjectType} prompt`);
  }
  return activated.row.id;
}
