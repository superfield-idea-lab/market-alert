/**
 * @file tests/integration/standing-prompt-family.spec.ts
 *
 * Integration tests for the standing-prompt family: per-entity, per-thesis,
 * portfolio-fallback, debounce, and pin/override — issue #79.
 *
 * ## Acceptance criteria tested
 *
 *   AC-1: All three subject types (entity, thesis, portfolio) are produced and kept current.
 *     TC-1: Entity standing prompt is produced from a wiki publish.
 *     TC-2: Thesis standing prompt is produced independently.
 *     TC-3: Portfolio standing prompt is produced independently.
 *     TC-4: Each subject type has its own standing_prompts row; they coexist.
 *
 *   AC-2: A burst of publishes collapses to one rebuild via debounce.
 *     TC-5: Two distillation tasks with the same wiki_version_window produce
 *           exactly one standing_prompt_versions row (idempotent).
 *
 *   AC-3: A pinned prompt is not replaced by automatic distillation.
 *     TC-6: Pinning an active version blocks the next automatic distillation.
 *     TC-7: Unpinning allows the next automatic distillation to supersede.
 *
 * ## Architecture
 *
 * All handler functions are called directly against a real ephemeral Postgres
 * container. No mocks — uses real DB, real `node:http` server, real handler
 * functions. No vi.fn, vi.mock, vi.spyOn, vi.stubGlobal.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5, §6 — standing prompt family, routing
 * - docs/prd.md §7 — pin/override
 * - docs/prd.md §9 — hard ceiling ~250 words
 * - packages/db/standing-prompt-store.ts — DB store
 * - apps/worker/src/standing-prompt-distill-job.ts — worker handler
 * - apps/server/src/api/standing-prompt-distill-api.ts — internal API endpoints
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/79
 */

import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../../packages/db/pg-container';
import { runInitRemote } from '../../packages/db/init-remote';
import { migrate, migrateMkt } from '../../packages/db/index';
import { WIKI_REBUILD_DDL } from '../../packages/db/wiki-rebuild-store';
import {
  STANDING_PROMPT_DDL,
  STANDING_PROMPT_HARD_CEILING_WORDS,
} from '../../packages/db/standing-prompt-store';
import {
  handleStandingPromptDistillApiRequest,
  STANDING_PROMPT_TEST_TOKEN,
} from '../../apps/server/src/api/standing-prompt-distill-api';
import {
  executeStandingPromptDistillTask,
  STANDING_PROMPT_DISTILL_JOB_TYPE,
} from '../../apps/worker/src/standing-prompt-distill-job';
import type { AppState } from '../../apps/server/src/index';
import fixture from '../fixtures/standing-prompt-family/standing-prompt-family-fixture.json';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const TEST_TOKEN = STANDING_PROMPT_TEST_TOKEN;
const TEST_PASSWORDS = {
  app: 'app_sp79_test_pw',
  audit: 'audit_sp79_test_pw',
  analytics: 'analytics_sp79_test_pw',
  dictionary: 'dict_sp79_test_pw',
  email_ingest: 'email_ingest_sp79_test_pw',
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
// Local HTTP server — routes /internal/standing-prompt/*
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
          const response = await handleStandingPromptDistillApiRequest(fetchReq, url, state);

          if (response) {
            const resBody = await response.text();
            res.writeHead(response.status, { 'Content-Type': 'application/json' });
            res.end(resBody);
            return;
          }

          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        } catch (err) {
          console.error('[sp-family-test-server] Unhandled error:', err);
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
// Helper: build a fake task row
// ---------------------------------------------------------------------------

function makeTask(payload: Record<string, unknown>) {
  return {
    id: `task-${crypto.randomUUID()}`,
    idempotency_key: crypto.randomUUID(),
    job_type: STANDING_PROMPT_DISTILL_JOB_TYPE,
    agent_type: 'sp_distiller',
    payload,
    status: 'claimed' as const,
    correlation_id: null,
    created_by: 'test',
    claimed_by: 'test',
    claimed_at: new Date(),
    claim_expires_at: null,
    delegated_token: TEST_TOKEN,
    result: null,
    error_message: null,
    attempt: 1,
    max_attempts: 3,
    next_retry_at: null,
    priority: 0,
    created_at: new Date(),
    updated_at: new Date(),
  };
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

  // 4. Apply base schema and mkt-schema
  await migrate({ databaseUrl: appRwUrl });
  await migrateMkt({ databaseUrl: appRwUrl });

  // 5. Apply wiki rebuild DDL (needed for wiki_pages query in /wiki-pages route)
  await sql.unsafe(WIKI_REBUILD_DDL);

  // 6. Apply standing-prompt DDL (issue #79 schema with subject_type + is_pinned)
  await sql.unsafe(STANDING_PROMPT_DDL);

  // 7. Build AppState
  appState = {
    sql: sql as unknown as typeof import('../../packages/db/index').sql,
    auditSql: sql as unknown as typeof import('../../packages/db/index').sql,
    analyticsSql: sql as unknown as typeof import('../../packages/db/index').sql,
    dictionarySql: sql as unknown as typeof import('../../packages/db/index').sql,
  };

  // 8. Set TEST_MODE for auth
  process.env['TEST_MODE'] = 'true';
  process.env['STANDING_PROMPT_TEST_TOKEN'] = TEST_TOKEN;

  // 9. Start local HTTP server
  const server = await startLocalServer(appState);
  httpServer = server.server;
  apiBaseUrl = server.url;
}, 60_000);

afterAll(async () => {
  httpServer?.close();
  await sql?.end({ timeout: 5 });
  await pg?.stop();
  delete process.env['TEST_MODE'];
  delete process.env['STANDING_PROMPT_TEST_TOKEN'];
});

// ---------------------------------------------------------------------------
// AC-1: All three subject types are produced and kept current
// ---------------------------------------------------------------------------

describe('AC-1: Standing-prompt family — all three subject types', () => {
  /**
   * TC-1: Entity standing prompt is produced from a wiki publish.
   *
   * Distills an entity-level standing prompt and verifies the active version
   * is within the word bound.
   */
  test('TC-1: entity-level standing prompt is produced and active', async () => {
    const task = makeTask({
      researcher_id: fixture.researcher_id,
      tenant_id: fixture.tenant_id,
      subject_type: 'entity',
      subject_id: fixture.entity_subject_id,
      wiki_version_window: fixture.wiki_version_window_1,
    });

    const result = await executeStandingPromptDistillTask(task, apiBaseUrl, TEST_TOKEN);

    expect(result.error).toBeNull();
    expect(result.already_distilled).toBe(false);
    expect(result.pinned_blocked).toBe(false);
    expect(result.subject_type).toBe('entity');
    expect(result.subject_id).toBe(fixture.entity_subject_id);
    expect(result.standing_prompt_id).toBeTruthy();
    expect(result.standing_prompt_version_id).toBeTruthy();
    expect(result.word_count).not.toBeNull();
    expect(result.word_count!).toBeLessThanOrEqual(STANDING_PROMPT_HARD_CEILING_WORDS);

    // Verify the version is active via the API.
    const activeRes = await fetch(
      `${apiBaseUrl}/internal/standing-prompt/active?tenant_id=${fixture.tenant_id}&researcher_id=${fixture.researcher_id}&subject_type=entity&subject_id=${fixture.entity_subject_id}`,
      { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    );
    expect(activeRes.status).toBe(200);
    const activeData = (await activeRes.json()) as {
      version: { id: string; status: string } | null;
    };
    expect(activeData.version).not.toBeNull();
    expect(activeData.version!.id).toBe(result.standing_prompt_version_id);
    expect(activeData.version!.status).toBe('active');
  });

  /**
   * TC-2: Thesis standing prompt is produced independently.
   *
   * Uses a different subject_type='thesis' and verifies it produces its own
   * standing_prompts row, separate from the entity prompt.
   */
  test('TC-2: thesis-level standing prompt is produced independently', async () => {
    const task = makeTask({
      researcher_id: fixture.researcher_id,
      tenant_id: fixture.tenant_id,
      subject_type: 'thesis',
      subject_id: fixture.thesis_subject_id,
      wiki_version_window: fixture.wiki_version_window_1,
    });

    const result = await executeStandingPromptDistillTask(task, apiBaseUrl, TEST_TOKEN);

    expect(result.error).toBeNull();
    expect(result.subject_type).toBe('thesis');
    expect(result.subject_id).toBe(fixture.thesis_subject_id);
    expect(result.standing_prompt_id).toBeTruthy();

    // Verify active version exists for the thesis subject.
    const activeRes = await fetch(
      `${apiBaseUrl}/internal/standing-prompt/active?tenant_id=${fixture.tenant_id}&researcher_id=${fixture.researcher_id}&subject_type=thesis&subject_id=${fixture.thesis_subject_id}`,
      { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    );
    expect(activeRes.status).toBe(200);
    const activeData = (await activeRes.json()) as {
      version: { id: string; status: string } | null;
    };
    expect(activeData.version).not.toBeNull();
    expect(activeData.version!.status).toBe('active');
  });

  /**
   * TC-3: Portfolio standing prompt is produced independently.
   *
   * Uses subject_type='portfolio' with subject_id='portfolio' and verifies it
   * has its own standing_prompts row.
   */
  test('TC-3: portfolio-level standing prompt is produced independently', async () => {
    const task = makeTask({
      researcher_id: fixture.researcher_id,
      tenant_id: fixture.tenant_id,
      subject_type: 'portfolio',
      subject_id: 'portfolio',
      wiki_version_window: fixture.wiki_version_window_1,
    });

    const result = await executeStandingPromptDistillTask(task, apiBaseUrl, TEST_TOKEN);

    expect(result.error).toBeNull();
    expect(result.subject_type).toBe('portfolio');
    expect(result.subject_id).toBe('portfolio');
    expect(result.standing_prompt_id).toBeTruthy();

    // Verify active version exists for portfolio.
    const activeRes = await fetch(
      `${apiBaseUrl}/internal/standing-prompt/active?tenant_id=${fixture.tenant_id}&researcher_id=${fixture.researcher_id}&subject_type=portfolio&subject_id=portfolio`,
      { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    );
    expect(activeRes.status).toBe(200);
    const activeData = (await activeRes.json()) as {
      version: { id: string; status: string } | null;
    };
    expect(activeData.version).not.toBeNull();
    expect(activeData.version!.status).toBe('active');
  });

  /**
   * TC-4: Each subject type has its own standing_prompts row; they coexist.
   *
   * Verifies that entity, thesis, and portfolio standing_prompts rows exist
   * simultaneously in the DB (one per subject type).
   */
  test('TC-4: entity, thesis, and portfolio standing_prompts rows coexist independently', async () => {
    type PromptRow = { subject_type: string; subject_id: string };
    const rows = await sql<PromptRow[]>`
      SELECT subject_type, subject_id
      FROM standing_prompts
      WHERE tenant_id     = ${fixture.tenant_id}
        AND researcher_id = ${fixture.researcher_id}
      ORDER BY subject_type ASC
    `;

    const subjectTypes = rows.map((r) => r.subject_type);
    expect(subjectTypes).toContain('entity');
    expect(subjectTypes).toContain('thesis');
    expect(subjectTypes).toContain('portfolio');

    // Verify they are distinct rows (not merged).
    expect(rows.length).toBeGreaterThanOrEqual(3);

    // Verify the portfolio row has subject_id = 'portfolio'.
    const portfolioRow = rows.find((r) => r.subject_type === 'portfolio');
    expect(portfolioRow?.subject_id).toBe('portfolio');
  });
});

// ---------------------------------------------------------------------------
// AC-2: A burst of publishes collapses to one rebuild via debounce
// ---------------------------------------------------------------------------

describe('AC-2: Debounce — burst of publishes collapses to one version', () => {
  /**
   * TC-5: Two distillation tasks with the same (subject, wiki_version_window)
   * produce exactly one standing_prompt_versions row (debounce via idempotency).
   *
   * The second task returns `already_distilled: true` and creates no new row.
   */
  test('TC-5: burst of publishes with same window collapses to one version row', async () => {
    const debounceResearcherId = 'researcher-sp-79-debounce';
    const debounceSubjectId = 'company-sp-79-debounce';
    const debounceWindow = '2024-02-02T10:00';

    // First distillation task.
    const task1 = makeTask({
      researcher_id: debounceResearcherId,
      tenant_id: fixture.tenant_id,
      subject_type: 'entity',
      subject_id: debounceSubjectId,
      wiki_version_window: debounceWindow,
    });
    const result1 = await executeStandingPromptDistillTask(task1, apiBaseUrl, TEST_TOKEN);
    expect(result1.error).toBeNull();
    expect(result1.already_distilled).toBe(false);
    expect(result1.standing_prompt_version_id).toBeTruthy();

    // Count rows before second task.
    type CountRow = { count: string };
    const [before] = await sql<CountRow[]>`
      SELECT COUNT(*) AS count
      FROM standing_prompt_versions spv
      JOIN standing_prompts sp ON sp.id = spv.standing_prompt_id
      WHERE sp.tenant_id     = ${fixture.tenant_id}
        AND sp.researcher_id = ${debounceResearcherId}
        AND spv.wiki_version_window = ${debounceWindow}
    `;
    const countBefore = parseInt(before?.count ?? '0', 10);
    expect(countBefore).toBe(1);

    // Second distillation task — same window, same subject. Should be idempotent.
    const task2 = makeTask({
      researcher_id: debounceResearcherId,
      tenant_id: fixture.tenant_id,
      subject_type: 'entity',
      subject_id: debounceSubjectId,
      wiki_version_window: debounceWindow,
    });
    const result2 = await executeStandingPromptDistillTask(task2, apiBaseUrl, TEST_TOKEN);
    expect(result2.error).toBeNull();
    expect(result2.already_distilled).toBe(true);
    expect(result2.pinned_blocked).toBe(false);

    // Still exactly one row.
    const [after] = await sql<CountRow[]>`
      SELECT COUNT(*) AS count
      FROM standing_prompt_versions spv
      JOIN standing_prompts sp ON sp.id = spv.standing_prompt_id
      WHERE sp.tenant_id     = ${fixture.tenant_id}
        AND sp.researcher_id = ${debounceResearcherId}
        AND spv.wiki_version_window = ${debounceWindow}
    `;
    const countAfter = parseInt(after?.count ?? '0', 10);
    expect(countAfter).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// AC-3: A pinned prompt is not replaced by automatic distillation
// ---------------------------------------------------------------------------

describe('AC-3: Pin — pinned prompt blocks automatic distillation', () => {
  /**
   * TC-6: Pinning an active version blocks the next automatic distillation.
   *
   * 1. Run a first distillation to get an active version.
   * 2. Pin the active version via the API.
   * 3. Run a second distillation with a new window.
   * 4. Verify `pinned_blocked: true` is returned and the original version is still active.
   */
  test('TC-6: pinned active version blocks automatic distillation', async () => {
    const pinResearcherId = 'researcher-sp-79-pin';
    const pinSubjectId = 'company-sp-79-pin';

    // 1. First distillation — produce an active version.
    const task1 = makeTask({
      researcher_id: pinResearcherId,
      tenant_id: fixture.tenant_id,
      subject_type: 'entity',
      subject_id: pinSubjectId,
      wiki_version_window: '2024-02-03T08:00',
    });
    const result1 = await executeStandingPromptDistillTask(task1, apiBaseUrl, TEST_TOKEN);
    expect(result1.error).toBeNull();
    expect(result1.already_distilled).toBe(false);
    const firstVersionId = result1.standing_prompt_version_id!;
    const standingPromptId = result1.standing_prompt_id!;

    // 2. Pin the active version via the API.
    const pinRes = await fetch(
      `${apiBaseUrl}/internal/standing-prompt/prompt/${standingPromptId}/pin`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
      },
    );
    expect(pinRes.status).toBe(200);
    const pinData = (await pinRes.json()) as {
      standing_prompt_version_id: string;
      is_pinned: boolean;
    };
    expect(pinData.is_pinned).toBe(true);
    expect(pinData.standing_prompt_version_id).toBe(firstVersionId);

    // 3. Run a second distillation with a new window.
    const task2 = makeTask({
      researcher_id: pinResearcherId,
      tenant_id: fixture.tenant_id,
      subject_type: 'entity',
      subject_id: pinSubjectId,
      wiki_version_window: '2024-02-03T08:05',
    });
    const result2 = await executeStandingPromptDistillTask(task2, apiBaseUrl, TEST_TOKEN);

    // 4. Verify the distillation was blocked by the pin.
    expect(result2.error).toBeNull();
    expect(result2.already_distilled).toBe(false);
    expect(result2.pinned_blocked).toBe(true);

    // The original version should still be active.
    const activeRes = await fetch(
      `${apiBaseUrl}/internal/standing-prompt/active?tenant_id=${fixture.tenant_id}&researcher_id=${pinResearcherId}&subject_type=entity&subject_id=${pinSubjectId}`,
      { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    );
    const activeData = (await activeRes.json()) as {
      version: { id: string; is_pinned: boolean } | null;
    };
    expect(activeData.version).not.toBeNull();
    expect(activeData.version!.id).toBe(firstVersionId);
    expect(activeData.version!.is_pinned).toBe(true);
  });

  /**
   * TC-7: Unpinning allows the next automatic distillation to supersede.
   *
   * Continues from TC-6: unpin the active version, then run another distillation.
   * Verify the new version becomes active and the prior version is superseded.
   */
  test('TC-7: unpinning allows the next distillation to supersede the active version', async () => {
    const unpinResearcherId = 'researcher-sp-79-unpin';
    const unpinSubjectId = 'company-sp-79-unpin';

    // 1. First distillation — produce an active version.
    const task1 = makeTask({
      researcher_id: unpinResearcherId,
      tenant_id: fixture.tenant_id,
      subject_type: 'entity',
      subject_id: unpinSubjectId,
      wiki_version_window: '2024-02-04T09:00',
    });
    const result1 = await executeStandingPromptDistillTask(task1, apiBaseUrl, TEST_TOKEN);
    expect(result1.error).toBeNull();
    const firstVersionId = result1.standing_prompt_version_id!;
    const standingPromptId = result1.standing_prompt_id!;

    // 2. Pin the active version.
    const pinRes = await fetch(
      `${apiBaseUrl}/internal/standing-prompt/prompt/${standingPromptId}/pin`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
      },
    );
    expect(pinRes.status).toBe(200);

    // 3. Verify distillation is blocked.
    const blockedTask = makeTask({
      researcher_id: unpinResearcherId,
      tenant_id: fixture.tenant_id,
      subject_type: 'entity',
      subject_id: unpinSubjectId,
      wiki_version_window: '2024-02-04T09:05',
    });
    const blockedResult = await executeStandingPromptDistillTask(
      blockedTask,
      apiBaseUrl,
      TEST_TOKEN,
    );
    expect(blockedResult.pinned_blocked).toBe(true);

    // 4. Unpin the active version.
    const unpinRes = await fetch(
      `${apiBaseUrl}/internal/standing-prompt/prompt/${standingPromptId}/unpin`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
      },
    );
    expect(unpinRes.status).toBe(200);
    const unpinData = (await unpinRes.json()) as {
      standing_prompt_version_id: string;
      is_pinned: boolean;
    };
    expect(unpinData.is_pinned).toBe(false);

    // 5. Run a new distillation — should now supersede the prior active version.
    const task3 = makeTask({
      researcher_id: unpinResearcherId,
      tenant_id: fixture.tenant_id,
      subject_type: 'entity',
      subject_id: unpinSubjectId,
      wiki_version_window: '2024-02-04T09:10',
    });
    const result3 = await executeStandingPromptDistillTask(task3, apiBaseUrl, TEST_TOKEN);
    expect(result3.error).toBeNull();
    expect(result3.already_distilled).toBe(false);
    expect(result3.pinned_blocked).toBe(false);

    // 6. The new version is now active; the prior version is superseded.
    const newVersionId = result3.standing_prompt_version_id!;
    expect(newVersionId).not.toBe(firstVersionId);

    const activeRes = await fetch(
      `${apiBaseUrl}/internal/standing-prompt/active?tenant_id=${fixture.tenant_id}&researcher_id=${unpinResearcherId}&subject_type=entity&subject_id=${unpinSubjectId}`,
      { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    );
    const activeData = (await activeRes.json()) as {
      version: { id: string; status: string } | null;
    };
    expect(activeData.version!.id).toBe(newVersionId);

    // Confirm prior version is superseded.
    type VersionStatusRow = { status: string };
    const [priorRow] = await sql<VersionStatusRow[]>`
      SELECT status FROM standing_prompt_versions WHERE id = ${firstVersionId}
    `;
    expect(priorRow?.status).toBe('superseded');
  });
});
