/**
 * @file analytics-emitter.test.ts
 *
 * Integration tests for the Phase 7 analytics event emitter.
 *
 * Spins up a real ephemeral Postgres container, provisions all four databases
 * via runInitRemote, then exercises:
 *
 *   TP-1  Ingest: emit a session event and assert it is written to kb_analytics.
 *   TP-2  BDM query plan: queryBdmCampaignEvents touches only kb_analytics.
 *   TP-3  Permission denied: analytics_w cannot SELECT from kb_app.
 *   TP-4  Cross-tenant isolation: tenant A's events are not visible to tenant B's query.
 *
 * No mocks — real Postgres, real HMAC crypto, real role grants.
 *
 * Acceptance criteria addressed:
 *   AC-1  Analytics events written to kb_analytics
 *   AC-2  Session pseudonyms are HMAC-SHA256 hashes — no user ID in kb_analytics
 *   AC-3  BDM query reads from kb_analytics only
 *   AC-4  analytics_w role cannot SELECT from kb_app
 *   AC-5  Cross-tenant isolation
 *
 * Canonical docs:
 *   - docs/implementation-plan-v1.md § Phase 7
 *   - DATA-C-031, DATA-C-035
 */

import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { runInitRemote, dbUrl } from './init-remote';
import {
  emitSessionEvent,
  queryBdmCampaignEvents,
  deriveSessionPseudonym,
  hashChunkExcerpt,
} from './analytics-emitter';

let pg: PgContainer;

let analyticsWSql: ReturnType<typeof postgres>;
let adminAnalyticsSql: ReturnType<typeof postgres>;

const TEST_PASSWORDS = {
  app: 'app_test_pw',
  audit: 'audit_test_pw',
  analytics: 'analytics_test_pw',
  dictionary: 'dict_test_pw',
  email_ingest: 'email_ingest_test_pw',
};

const DB_NAMES = {
  app: 'superfield_app',
  analytics: 'superfield_analytics',
};

function makeRoleUrl(adminUrl: string, db: string, role: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
}

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

  analyticsWSql = postgres(
    makeRoleUrl(pg.url, DB_NAMES.analytics, 'analytics_w', TEST_PASSWORDS.analytics),
    { max: 3 },
  );

  // Admin pool on the analytics database for verification queries.
  adminAnalyticsSql = postgres(dbUrl(pg.url, DB_NAMES.analytics), { max: 3 });
}, 120_000);

afterAll(async () => {
  await analyticsWSql?.end({ timeout: 5 });
  await adminAnalyticsSql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// TP-1 / AC-1: analytics events written to kb_analytics
// ---------------------------------------------------------------------------

describe('emitSessionEvent — writes to kb_analytics (TP-1 / AC-1)', () => {
  test('emits a chunk_indexed event and persists it to session_events', async () => {
    const tenantId = `tenant-emit-${Date.now()}`;
    const sessionId = `session-${Date.now()}`;
    const assetManagerId = `am-${Date.now()}`;
    const fundId = `fund-${Date.now()}`;
    const chunkContent = 'Sample chunk content for testing';
    const chunkExcerptHash = await hashChunkExcerpt(chunkContent);

    const row = await emitSessionEvent({
      analyticsSql: analyticsWSql,
      tenantId,
      sessionId,
      assetManagerId,
      fundId,
      chunkExcerptHash,
      eventType: 'chunk_indexed',
    });

    expect(row.id).toBeTruthy();
    expect(row.tenant_id).toBe(tenantId);
    expect(row.event_type).toBe('chunk_indexed');
    expect(row.asset_manager_id).toBe(assetManagerId);
    expect(row.fund_id).toBe(fundId);
    expect(row.chunk_excerpt_hash).toBe(chunkExcerptHash);

    // Verify the row is in the database.
    const [persisted] = await adminAnalyticsSql<
      { id: string; tenant_id: string; event_type: string }[]
    >`
      SELECT id, tenant_id, event_type FROM session_events WHERE id = ${row.id}
    `;
    expect(persisted.tenant_id).toBe(tenantId);
    expect(persisted.event_type).toBe('chunk_indexed');
  });

  test('emits a wiki_published event', async () => {
    const tenantId = `tenant-publish-${Date.now()}`;
    const sessionId = `session-pub-${Date.now()}`;

    const row = await emitSessionEvent({
      analyticsSql: analyticsWSql,
      tenantId,
      sessionId,
      assetManagerId: `am-pub-${Date.now()}`,
      fundId: `fund-pub-${Date.now()}`,
      chunkExcerptHash: await hashChunkExcerpt('wiki content'),
      eventType: 'wiki_published',
    });

    expect(row.event_type).toBe('wiki_published');
  });
});

// ---------------------------------------------------------------------------
// TP-1 / AC-2: session pseudonyms are HMAC-SHA256 — no user ID in kb_analytics
// ---------------------------------------------------------------------------

describe('session pseudonym — HMAC-SHA256 (TP-1 / AC-2)', () => {
  test('stored session_id is not the raw session ID', async () => {
    const tenantId = `tenant-pseudo-${Date.now()}`;
    const rawSessionId = `raw-session-${Date.now()}`;

    const row = await emitSessionEvent({
      analyticsSql: analyticsWSql,
      tenantId,
      sessionId: rawSessionId,
      assetManagerId: `am-${Date.now()}`,
      fundId: `fund-${Date.now()}`,
      chunkExcerptHash: await hashChunkExcerpt('content'),
      eventType: 'chunk_indexed',
    });

    // The stored session_id must differ from the raw session ID.
    expect(row.session_id).not.toBe(rawSessionId);
    // The stored session_id must match the HMAC-SHA256 pseudonym.
    const expectedPseudonym = await deriveSessionPseudonym(tenantId, rawSessionId);
    expect(row.session_id).toBe(expectedPseudonym);
  });

  test('same session in same tenant always maps to the same pseudonym', async () => {
    const tenantId = 'deterministic-tenant';
    const sessionId = 'deterministic-session';
    const p1 = await deriveSessionPseudonym(tenantId, sessionId);
    const p2 = await deriveSessionPseudonym(tenantId, sessionId);
    expect(p1).toBe(p2);
  });

  test('same session in different tenants produces different pseudonyms', async () => {
    const sessionId = 'shared-session';
    const p1 = await deriveSessionPseudonym('tenant-a', sessionId);
    const p2 = await deriveSessionPseudonym('tenant-b', sessionId);
    expect(p1).not.toBe(p2);
  });
});

// ---------------------------------------------------------------------------
// TP-2 / AC-3: BDM query reads from kb_analytics only
// ---------------------------------------------------------------------------

describe('queryBdmCampaignEvents — reads from kb_analytics only (TP-2 / AC-3)', () => {
  test('returns events for the given tenant from kb_analytics', async () => {
    const tenantId = `tenant-bdm-query-${Date.now()}`;

    // Seed two events for tenantId.
    await emitSessionEvent({
      analyticsSql: analyticsWSql,
      tenantId,
      sessionId: `s1-${Date.now()}`,
      assetManagerId: `am-1`,
      fundId: `fund-1`,
      chunkExcerptHash: await hashChunkExcerpt('chunk 1'),
      eventType: 'chunk_indexed',
    });
    await emitSessionEvent({
      analyticsSql: analyticsWSql,
      tenantId,
      sessionId: `s2-${Date.now()}`,
      assetManagerId: `am-2`,
      fundId: `fund-2`,
      chunkExcerptHash: await hashChunkExcerpt('chunk 2'),
      eventType: 'wiki_published',
    });

    const events = await queryBdmCampaignEvents({
      analyticsSql: analyticsWSql,
      tenantId,
    });

    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const event of events) {
      expect(event.tenant_id).toBe(tenantId);
    }
  });

  test('filters by event_type when specified', async () => {
    const tenantId = `tenant-filter-${Date.now()}`;

    await emitSessionEvent({
      analyticsSql: analyticsWSql,
      tenantId,
      sessionId: `sf1-${Date.now()}`,
      assetManagerId: `am-f1`,
      fundId: `fund-f1`,
      chunkExcerptHash: await hashChunkExcerpt('chunk-f1'),
      eventType: 'chunk_indexed',
    });
    await emitSessionEvent({
      analyticsSql: analyticsWSql,
      tenantId,
      sessionId: `sf2-${Date.now()}`,
      assetManagerId: `am-f2`,
      fundId: `fund-f2`,
      chunkExcerptHash: await hashChunkExcerpt('chunk-f2'),
      eventType: 'wiki_published',
    });

    const chunkEvents = await queryBdmCampaignEvents({
      analyticsSql: analyticsWSql,
      tenantId,
      eventType: 'chunk_indexed',
    });

    for (const event of chunkEvents) {
      expect(event.event_type).toBe('chunk_indexed');
    }
  });
});

// ---------------------------------------------------------------------------
// TP-3 / AC-4: analytics_w cannot SELECT from kb_app
// ---------------------------------------------------------------------------

describe('analytics_w cross-pool isolation — cannot reach kb_app (TP-3 / AC-4)', () => {
  test('analytics_w cannot connect to kb_app — blocked at the database layer', async () => {
    // analytics_w holds no CONNECT privilege on the app database.
    // Attempting to connect as analytics_w to superfield_app must fail.
    const analyticsWAppSql = postgres(
      makeRoleUrl(pg.url, DB_NAMES.app, 'analytics_w', TEST_PASSWORDS.analytics),
      { max: 1, connect_timeout: 5 },
    );
    await expect(analyticsWAppSql`SELECT 1`).rejects.toThrow();
    await analyticsWAppSql.end({ timeout: 3 }).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// TP-4 / AC-5: cross-tenant isolation
// ---------------------------------------------------------------------------

describe('cross-tenant isolation — tenant A cannot see tenant B events (TP-4 / AC-5)', () => {
  test('BDM query for tenant A does not return tenant B events', async () => {
    const tenantA = `tenant-isolation-a-${Date.now()}`;
    const tenantB = `tenant-isolation-b-${Date.now()}`;

    // Seed one event for each tenant.
    await emitSessionEvent({
      analyticsSql: analyticsWSql,
      tenantId: tenantA,
      sessionId: `sa-${Date.now()}`,
      assetManagerId: `am-a`,
      fundId: `fund-a`,
      chunkExcerptHash: await hashChunkExcerpt('chunk-a'),
      eventType: 'chunk_indexed',
    });
    await emitSessionEvent({
      analyticsSql: analyticsWSql,
      tenantId: tenantB,
      sessionId: `sb-${Date.now()}`,
      assetManagerId: `am-b`,
      fundId: `fund-b`,
      chunkExcerptHash: await hashChunkExcerpt('chunk-b'),
      eventType: 'chunk_indexed',
    });

    // Query for tenant A — must not see tenant B's event.
    const eventsA = await queryBdmCampaignEvents({
      analyticsSql: analyticsWSql,
      tenantId: tenantA,
    });
    for (const event of eventsA) {
      expect(event.tenant_id).toBe(tenantA);
      expect(event.tenant_id).not.toBe(tenantB);
    }

    // Query for tenant B — must not see tenant A's event.
    const eventsB = await queryBdmCampaignEvents({
      analyticsSql: analyticsWSql,
      tenantId: tenantB,
    });
    for (const event of eventsB) {
      expect(event.tenant_id).toBe(tenantB);
      expect(event.tenant_id).not.toBe(tenantA);
    }
  });
});
