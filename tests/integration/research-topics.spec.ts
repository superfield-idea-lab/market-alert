/**
 * @file tests/integration/research-topics.spec.ts
 *
 * Integration tests for research_topics table, topic_members many-to-many,
 * data migration, and topic-scoped RLS + CRUD API (issue #121).
 *
 * ## Test architecture
 *
 * Two distinct describe blocks own their lifecycle independently:
 *
 * 1. "Direct-DB tests" — RLS enforcement, migration idempotency, withRlsContext:
 *    Uses a real ephemeral Postgres container + runInitRemote + direct SQL.
 *    Follows the pattern of wiki-rls.test.ts.
 *
 * 2. "API tests" — CRUD REST endpoints:
 *    Uses the E2E server environment (startE2EServer) with real HTTP requests.
 *
 * ## No mocks
 *
 * Uses real ephemeral Postgres containers, real Bun server process, and real
 * fetch calls. Zero vi.fn, vi.mock, vi.spyOn, vi.stubGlobal.
 *
 * ## Acceptance criteria tested
 *
 *   AC-1: migration idempotency
 *   AC-2: wiki_pages RLS — non-member cannot SELECT
 *   AC-3: wiki_pages RLS — member can SELECT
 *   AC-4: signals RLS — non-member cannot SELECT
 *   AC-5: POST /api/research-topics creates topic + owner
 *   AC-6: POST /api/research-topics/:id/members by owner adds member
 *   AC-7: POST /api/research-topics/:id/members by non-owner returns 403
 *   AC-8: DELETE /api/research-topics/:id/members/:id by owner succeeds
 *   AC-9: withRlsContext topicId propagation
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/121
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../../packages/db/pg-container';
import { startE2EServer, stopE2EServer, type E2EEnvironment } from '../e2e/environment';
import { runInitRemote, dbUrl, makePool } from '../../packages/db/init-remote';
import { configureResearchTopicsRls } from '../../packages/db/init-remote';
import { withRlsContext } from '../../packages/db/rls-context';
import {
  RESEARCH_TOPICS_DDL,
  type ResearchTopicRow,
} from '../../packages/db/research-topics-store';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const TEST_PASSWORDS = {
  app: 'rt_app_test_pw',
  audit: 'rt_audit_test_pw',
  analytics: 'rt_analytics_test_pw',
  dictionary: 'rt_dict_test_pw',
  email_ingest: 'rt_email_ingest_test_pw',
};

const DB_NAMES = { app: 'superfield_app' };

function makeRoleUrl(adminUrl: string, db: string, role: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
}

// Path to the research-topics migration SQL file.
const MKT_RESEARCH_TOPICS_SQL = resolve(
  new URL('../..', import.meta.url).pathname,
  'packages/db/mkt-research-topics.sql',
);

const MKT_SCHEMA_SQL = resolve(
  new URL('../..', import.meta.url).pathname,
  'packages/db/mkt-schema.sql',
);

// ===========================================================================
// Setup 1: Direct-DB tests (RLS enforcement, migration idempotency, AC-9)
// ===========================================================================

describe('Direct-DB tests (AC-1, AC-2, AC-3, AC-4, AC-9)', () => {
  let pg: PgContainer;
  let appRwSql: ReturnType<typeof postgres>;
  let adminAppSql: ReturnType<typeof postgres>;

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

    appRwSql = postgres(makeRoleUrl(pg.url, DB_NAMES.app, 'app_rw', TEST_PASSWORDS.app), {
      max: 5,
    });
    adminAppSql = postgres(dbUrl(pg.url, DB_NAMES.app), { max: 3 });

    // Apply mkt-schema.sql (wiki_pages, signals, canonical_sources, etc.)
    const mktSchemaSql = readFileSync(MKT_SCHEMA_SQL, 'utf-8');
    await adminAppSql.unsafe(mktSchemaSql);

    // Apply RESEARCH_TOPICS_DDL via the store constant
    await adminAppSql.unsafe(RESEARCH_TOPICS_DDL);

    // Apply the full research-topics migration (ALTER TABLE, data migration)
    const rtSql = readFileSync(MKT_RESEARCH_TOPICS_SQL, 'utf-8');
    await adminAppSql.unsafe(rtSql);

    // Apply RLS policies for research_topics, wiki_pages, signals
    const appAdmin = makePool(dbUrl(pg.url, DB_NAMES.app));
    try {
      await configureResearchTopicsRls(appAdmin);
    } finally {
      await appAdmin.end({ timeout: 5 });
    }

    // Seed entity types
    await adminAppSql`
      INSERT INTO entity_types (type, schema) VALUES ('user', '{}')
      ON CONFLICT (type) DO NOTHING
    `;
  }, 120_000);

  afterAll(async () => {
    await appRwSql?.end({ timeout: 5 });
    await adminAppSql?.end({ timeout: 5 });
    await pg?.stop();
  });

  // ---------------------------------------------------------------------------
  // AC-9: withRlsContext topicId propagation
  // ---------------------------------------------------------------------------

  describe('withRlsContext — topicId propagation (AC-9)', () => {
    test('SET LOCAL app.current_topic_id is visible inside the transaction', async () => {
      const topicId = 'test-topic-id-rls-context';
      const result = await withRlsContext(
        appRwSql,
        { userId: 'user-1', tenantId: 'tenant-1', topicId },
        async (tx) => {
          const rows = await (tx as ReturnType<typeof postgres>)<{ val: string }[]>`
            SELECT current_setting('app.current_topic_id', true) AS val
          `;
          return rows[0]?.val ?? null;
        },
      );
      expect(result).toBe(topicId);
    });

    test('app.current_topic_id is not readable after the transaction ends (SET LOCAL scoping)', async () => {
      const topicId = 'test-topic-id-should-clear';

      await withRlsContext(
        appRwSql,
        { userId: 'user-1', tenantId: 'tenant-1', topicId },
        async (tx) => {
          const rows = await (tx as ReturnType<typeof postgres>)<{ val: string }[]>`
            SELECT current_setting('app.current_topic_id', true) AS val
          `;
          expect(rows[0]?.val).toBe(topicId);
          return null;
        },
      );

      // After the transaction, the setting should be reset
      const postTxRows = await appRwSql<{ val: string }[]>`
        SELECT current_setting('app.current_topic_id', true) AS val
      `;
      expect(postTxRows[0]?.val ?? '').not.toBe(topicId);
    });
  });

  // ---------------------------------------------------------------------------
  // AC-1: Migration idempotency
  // ---------------------------------------------------------------------------

  describe('research_topics — migration idempotency (AC-1)', () => {
    test('research_topics and topic_members tables exist after migration', async () => {
      const tables = await adminAppSql<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN ('research_topics', 'topic_members')
        ORDER BY tablename
      `;
      const names = tables.map((r) => r.tablename);
      expect(names).toContain('research_topics');
      expect(names).toContain('topic_members');
    });

    test('inserting the same Default topic twice produces no duplicates (UNIQUE tenant_id, name)', async () => {
      const tenantId = 'idem-test-tenant-' + Date.now();

      await adminAppSql`
        INSERT INTO research_topics (tenant_id, name, description, created_by)
        VALUES (${tenantId}, 'Default', 'Idempotency test', 'system')
        ON CONFLICT (tenant_id, name) DO NOTHING
      `;
      await adminAppSql`
        INSERT INTO research_topics (tenant_id, name, description, created_by)
        VALUES (${tenantId}, 'Default', 'Idempotency test — second run', 'system')
        ON CONFLICT (tenant_id, name) DO NOTHING
      `;

      const rows = await adminAppSql<{ id: string }[]>`
        SELECT id FROM research_topics
        WHERE tenant_id = ${tenantId} AND name = 'Default'
      `;
      expect(rows).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // AC-2, AC-3: wiki_pages RLS — topic membership enforcement
  // ---------------------------------------------------------------------------

  describe('wiki_pages — topic-membership RLS (AC-2, AC-3)', () => {
    const tenantId = 'wiki-rls-topic-tenant';
    const researcherA = 'researcher-a-wiki-rls';
    const researcherB = 'researcher-b-wiki-rls';
    let topicT1Id: string;
    let topicT2Id: string;
    let pageT1Id: string;
    let pageT2Id: string;

    beforeAll(async () => {
      await adminAppSql`
        INSERT INTO entities (id, type, properties, tenant_id)
        VALUES
          (${researcherA}, 'user', '{}', ${tenantId}),
          (${researcherB}, 'user', '{}', ${tenantId})
        ON CONFLICT (id) DO NOTHING
      `;

      const [t1] = await adminAppSql<{ id: string }[]>`
        INSERT INTO research_topics (tenant_id, name, description, created_by)
        VALUES (${tenantId}, 'T1-wiki-rls', 'Topic 1', ${researcherA})
        RETURNING id
      `;
      topicT1Id = t1.id;

      const [t2] = await adminAppSql<{ id: string }[]>`
        INSERT INTO research_topics (tenant_id, name, description, created_by)
        VALUES (${tenantId}, 'T2-wiki-rls', 'Topic 2', ${researcherB})
        RETURNING id
      `;
      topicT2Id = t2.id;

      await adminAppSql`
        INSERT INTO topic_members (topic_id, researcher_id, role)
        VALUES (${topicT1Id}, ${researcherA}, 'owner')
        ON CONFLICT DO NOTHING
      `;
      await adminAppSql`
        INSERT INTO topic_members (topic_id, researcher_id, role)
        VALUES (${topicT2Id}, ${researcherB}, 'owner')
        ON CONFLICT DO NOTHING
      `;

      const [p1] = await adminAppSql<{ id: string }[]>`
        INSERT INTO wiki_pages (tenant_id, topic_id, subject_type, subject_id)
        VALUES (${tenantId}, ${topicT1Id}, 'company', 'AAPL-wiki-rls-t1')
        RETURNING id
      `;
      pageT1Id = p1.id;

      const [p2] = await adminAppSql<{ id: string }[]>`
        INSERT INTO wiki_pages (tenant_id, topic_id, subject_type, subject_id)
        VALUES (${tenantId}, ${topicT2Id}, 'company', 'AAPL-wiki-rls-t2')
        RETURNING id
      `;
      pageT2Id = p2.id;
    });

    test('AC-3: researcherA (member of T1) can SELECT wiki_page rows with topic_id=T1', async () => {
      const rows = await withRlsContext(
        appRwSql,
        { userId: researcherA, tenantId },
        (tx) =>
          (tx as ReturnType<typeof postgres>)<{ id: string }[]>`
            SELECT id FROM wiki_pages WHERE id = ${pageT1Id}
          `,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(pageT1Id);
    });

    test('AC-2: researcherA (NOT member of T2) cannot SELECT wiki_page rows with topic_id=T2 — zero rows returned', async () => {
      const rows = await withRlsContext(
        appRwSql,
        { userId: researcherA, tenantId },
        (tx) =>
          (tx as ReturnType<typeof postgres>)<{ id: string }[]>`
            SELECT id FROM wiki_pages WHERE id = ${pageT2Id}
          `,
      );
      expect(rows).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // AC-4: signals RLS — topic membership enforcement
  // ---------------------------------------------------------------------------

  describe('signals — topic-membership RLS (AC-4)', () => {
    const tenantId = 'signals-rls-topic-tenant';
    const researcherA = 'researcher-a-signals-rls';
    const researcherB = 'researcher-b-signals-rls';
    let topicId: string;
    let signalId: string;

    beforeAll(async () => {
      await adminAppSql`
        INSERT INTO entities (id, type, properties, tenant_id)
        VALUES
          (${researcherA}, 'user', '{}', ${tenantId}),
          (${researcherB}, 'user', '{}', ${tenantId})
        ON CONFLICT (id) DO NOTHING
      `;

      const [t] = await adminAppSql<{ id: string }[]>`
        INSERT INTO research_topics (tenant_id, name, description, created_by)
        VALUES (${tenantId}, 'Topic-signals-rls', 'For signals RLS test', ${researcherA})
        RETURNING id
      `;
      topicId = t.id;

      await adminAppSql`
        INSERT INTO topic_members (topic_id, researcher_id, role)
        VALUES (${topicId}, ${researcherA}, 'owner')
        ON CONFLICT DO NOTHING
      `;

      const meId = 'me-signals-rls-test-' + Date.now();
      await adminAppSql`
        INSERT INTO market_events (id, event_type, event_date, status, subject_entity_type)
        VALUES (${meId}, 'earnings', NOW(), 'Detected', 'company')
        ON CONFLICT (id) DO NOTHING
      `;

      const spvId = 'spv-signals-rls-test-' + Date.now();
      const idempKey = 'event_eval:' + meId + ':' + spvId;

      const [s] = await adminAppSql<{ id: string }[]>`
        INSERT INTO signals (
          tenant_id, researcher_id, market_event_id, standing_prompt_version_id,
          idempotency_key, topic_id, status
        )
        VALUES (
          ${tenantId}, ${researcherA}, ${meId}, ${spvId},
          ${idempKey}, ${topicId}, 'Generated'
        )
        RETURNING id
      `;
      signalId = s.id;
    });

    test('AC-4: researcherA (member of topic) can SELECT their signal', async () => {
      const rows = await withRlsContext(
        appRwSql,
        { userId: researcherA, tenantId },
        (tx) =>
          (tx as ReturnType<typeof postgres>)<{ id: string }[]>`
            SELECT id FROM signals WHERE id = ${signalId}
          `,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(signalId);
    });

    test('AC-4: researcherB (NOT member of topic) cannot SELECT the signal — zero rows returned', async () => {
      const rows = await withRlsContext(
        appRwSql,
        { userId: researcherB, tenantId },
        (tx) =>
          (tx as ReturnType<typeof postgres>)<{ id: string }[]>`
            SELECT id FROM signals WHERE id = ${signalId}
          `,
      );
      expect(rows).toHaveLength(0);
    });
  });
});

// ===========================================================================
// Setup 2: API tests (AC-5, AC-6, AC-7, AC-8) — E2E server environment
// ===========================================================================

describe('API tests (AC-5, AC-6, AC-7, AC-8)', () => {
  let env: E2EEnvironment;
  let e2eSql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    env = await startE2EServer();
    e2eSql = postgres(env.pg.url, { max: 3 });
    // Ensure research_topics tables exist in the direct SQL connection context.
    await e2eSql.unsafe(RESEARCH_TOPICS_DDL);
  }, 120_000);

  afterAll(async () => {
    await e2eSql?.end();
    await stopE2EServer(env);
  });

  // ---------------------------------------------------------------------------
  // Helper
  // ---------------------------------------------------------------------------

  async function getTestSession(
    base: string,
    username: string,
  ): Promise<{ cookie: string; userId: string }> {
    const res = await fetch(`${base}/api/test/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    if (!res.status.toString().startsWith('2')) {
      throw new Error(`test session failed: ${res.status} ${await res.text()}`);
    }
    // The test session endpoint returns { user: { id, username } }
    const body = (await res.json()) as { user?: { id?: string } };
    const cookie = res.headers.get('set-cookie') ?? '';
    const userId = body.user?.id ?? '';
    if (!userId) {
      throw new Error(`test session returned no user id: ${JSON.stringify(body)}`);
    }
    return { cookie, userId };
  }

  // ---------------------------------------------------------------------------
  // AC-5: POST /api/research-topics
  // ---------------------------------------------------------------------------

  describe('POST /api/research-topics — create topic (AC-5)', () => {
    test('creator receives 201 with topic and is inserted as owner', async () => {
      const { cookie: creatorCookie, userId: creatorId } = await getTestSession(
        env.baseUrl,
        'rt-creator-ac5',
      );
      const tenantId = `rt-tenant-ac5-${Date.now()}`;

      const res = await fetch(`${env.baseUrl}/api/research-topics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: creatorCookie },
        body: JSON.stringify({ tenant_id: tenantId, name: 'AC5 Topic', description: 'Test topic' }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { topic: ResearchTopicRow };
      expect(body.topic.name).toBe('AC5 Topic');
      expect(body.topic.tenant_id).toBe(tenantId);
      expect(body.topic.created_by).toBe(creatorId);

      // Verify creator is an owner in topic_members
      const members = await e2eSql<{ researcher_id: string; role: string }[]>`
        SELECT researcher_id, role FROM topic_members
        WHERE topic_id = ${body.topic.id}
      `;
      expect(members.some((m) => m.researcher_id === creatorId && m.role === 'owner')).toBe(true);
    });

    test('GET /api/research-topics returns topic for creator, not for unrelated researcher', async () => {
      const { cookie: creatorCookie } = await getTestSession(env.baseUrl, 'rt-creator-ac5-get');
      const { cookie: otherCookie } = await getTestSession(env.baseUrl, 'rt-other-ac5');
      const tenantId = `rt-tenant-ac5-get-${Date.now()}`;

      const createRes = await fetch(`${env.baseUrl}/api/research-topics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: creatorCookie },
        body: JSON.stringify({ tenant_id: tenantId, name: 'AC5-GET Topic' }),
      });
      expect(createRes.status).toBe(201);
      const { topic } = (await createRes.json()) as { topic: ResearchTopicRow };

      // Creator sees the topic
      const creatorListRes = await fetch(
        `${env.baseUrl}/api/research-topics?tenant_id=${tenantId}`,
        { headers: { Cookie: creatorCookie } },
      );
      expect(creatorListRes.status).toBe(200);
      const creatorList = (await creatorListRes.json()) as { topics: ResearchTopicRow[] };
      expect(creatorList.topics.some((t) => t.id === topic.id)).toBe(true);

      // Unrelated researcher does NOT see the topic
      const otherListRes = await fetch(`${env.baseUrl}/api/research-topics?tenant_id=${tenantId}`, {
        headers: { Cookie: otherCookie },
      });
      expect(otherListRes.status).toBe(200);
      const otherList = (await otherListRes.json()) as { topics: ResearchTopicRow[] };
      expect(otherList.topics.some((t) => t.id === topic.id)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // AC-6, AC-7: POST /api/research-topics/:id/members
  // ---------------------------------------------------------------------------

  describe('POST /api/research-topics/:id/members — add member (AC-6, AC-7)', () => {
    test('AC-6: owner can add a new member; new member then sees the topic via GET', async () => {
      const { cookie: ownerCookie } = await getTestSession(env.baseUrl, 'rt-owner-ac6');
      const { cookie: newMemberCookie, userId: newMemberId } = await getTestSession(
        env.baseUrl,
        'rt-newmember-ac6',
      );
      const tenantId = `rt-tenant-ac6-${Date.now()}`;

      const createRes = await fetch(`${env.baseUrl}/api/research-topics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ tenant_id: tenantId, name: 'AC6 Topic' }),
      });
      expect(createRes.status).toBe(201);
      const { topic } = (await createRes.json()) as { topic: ResearchTopicRow };

      const addRes = await fetch(`${env.baseUrl}/api/research-topics/${topic.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ researcher_id: newMemberId, role: 'member' }),
      });
      expect(addRes.status).toBe(200);

      const listRes = await fetch(`${env.baseUrl}/api/research-topics?tenant_id=${tenantId}`, {
        headers: { Cookie: newMemberCookie },
      });
      const list = (await listRes.json()) as { topics: ResearchTopicRow[] };
      expect(list.topics.some((t) => t.id === topic.id)).toBe(true);
    });

    test('AC-7: non-owner attempting to add a member receives 403', async () => {
      const { cookie: ownerCookie } = await getTestSession(env.baseUrl, 'rt-owner-ac7');
      const { cookie: nonOwnerCookie, userId: nonOwnerId } = await getTestSession(
        env.baseUrl,
        'rt-nonowner-ac7',
      );
      const { userId: targetId } = await getTestSession(env.baseUrl, 'rt-target-ac7');
      const tenantId = `rt-tenant-ac7-${Date.now()}`;

      const createRes = await fetch(`${env.baseUrl}/api/research-topics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ tenant_id: tenantId, name: 'AC7 Topic' }),
      });
      expect(createRes.status).toBe(201);
      const { topic } = (await createRes.json()) as { topic: ResearchTopicRow };

      // Add non-owner as a regular member first
      await fetch(`${env.baseUrl}/api/research-topics/${topic.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ researcher_id: nonOwnerId, role: 'member' }),
      });

      // Non-owner tries to add another member → 403
      const addRes = await fetch(`${env.baseUrl}/api/research-topics/${topic.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: nonOwnerCookie },
        body: JSON.stringify({ researcher_id: targetId, role: 'member' }),
      });
      expect(addRes.status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // AC-8: DELETE /api/research-topics/:id/members/:researcher_id
  // ---------------------------------------------------------------------------

  describe('DELETE /api/research-topics/:id/members/:researcher_id — remove member (AC-8)', () => {
    test('AC-8: owner can remove a member; removed researcher no longer sees the topic', async () => {
      const { cookie: ownerCookie } = await getTestSession(env.baseUrl, 'rt-owner-ac8');
      const { cookie: memberCookie, userId: memberId } = await getTestSession(
        env.baseUrl,
        'rt-member-ac8',
      );
      const tenantId = `rt-tenant-ac8-${Date.now()}`;

      const createRes = await fetch(`${env.baseUrl}/api/research-topics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ tenant_id: tenantId, name: 'AC8 Topic' }),
      });
      expect(createRes.status).toBe(201);
      const { topic } = (await createRes.json()) as { topic: ResearchTopicRow };

      await fetch(`${env.baseUrl}/api/research-topics/${topic.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ researcher_id: memberId, role: 'member' }),
      });

      const removeRes = await fetch(
        `${env.baseUrl}/api/research-topics/${topic.id}/members/${memberId}`,
        {
          method: 'DELETE',
          headers: { Cookie: ownerCookie },
        },
      );
      expect(removeRes.status).toBe(200);

      const listRes = await fetch(`${env.baseUrl}/api/research-topics?tenant_id=${tenantId}`, {
        headers: { Cookie: memberCookie },
      });
      const list = (await listRes.json()) as { topics: ResearchTopicRow[] };
      expect(list.topics.some((t) => t.id === topic.id)).toBe(false);
    });
  });
});
