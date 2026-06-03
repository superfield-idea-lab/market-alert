/**
 * @file tests/integration/standing-prompt-distill.spec.ts
 *
 * Integration tests for the standing-prompt distillation pipeline — Phase 3 scout (issue #78).
 *
 * ## What this tests
 *
 * Three acceptance criteria from the issue test plan:
 *
 *   TC-1 (wiki publish → bounded active standing prompt):
 *     A STANDING_PROMPT_DISTILL task for a researcher whose wiki pages are
 *     indexed produces a new standing_prompt_version row with status `active`,
 *     body within the ~250-word hard ceiling, and advances
 *     standing_prompts.currently_active_version_id.
 *     Acceptance criterion AC-1: "A wiki publish yields a new Active per-entity
 *     prompt within the length bound."
 *
 *   TC-2 (prior Active prompt is Superseded):
 *     When a second distillation pass runs for the same researcher, the prior
 *     `active` version is flipped to `superseded` and the new version becomes
 *     `active`. Exactly one `active` version exists per researcher at all times.
 *     Acceptance criterion AC-2: "The prior Active prompt for that subject is Superseded."
 *
 *   TC-3 (distillation idempotent for same wiki window):
 *     Re-running STANDING_PROMPT_DISTILL for the same (researcher_id,
 *     wiki_version_window) pair returns `already_distilled: true` without
 *     creating a new row or changing the active version.
 *     Acceptance criterion AC-3: "Distillation is idempotent for the same wiki window."
 *
 * ## Architecture
 *
 * All handler functions are called directly against a real ephemeral Postgres
 * container. No mocks — uses real DB, real `node:http` server, real handler
 * functions. No vi.fn, vi.mock, vi.spyOn, vi.stubGlobal.
 *
 * ## Unit tests
 *
 * An additional describe block covers `distilToStandingPrompt` in isolation:
 *   - Length-bound enforcement (hard ceiling).
 *   - Empty wiki pages (empty-state fallback).
 *   - Word-count helper and `assertWithinLengthBound`.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §9 — standing prompt hard ceiling (~250 words)
 * - docs/architecture.md §"Standing prompt as derived artifact"
 * - packages/db/standing-prompt-store.ts — DB store
 * - apps/worker/src/standing-prompt-distill-job.ts — worker handler
 * - apps/server/src/api/standing-prompt-distill-api.ts — internal API endpoints
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/78
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
  countWords,
  assertWithinLengthBound,
  StandingPromptLengthError,
  STANDING_PROMPT_HARD_CEILING_WORDS,
} from '../../packages/db/standing-prompt-store';
import {
  handleStandingPromptDistillApiRequest,
  STANDING_PROMPT_TEST_TOKEN,
} from '../../apps/server/src/api/standing-prompt-distill-api';
import {
  executeStandingPromptDistillTask,
  distilToStandingPrompt,
  STANDING_PROMPT_DISTILL_JOB_TYPE,
} from '../../apps/worker/src/standing-prompt-distill-job';
import type { AppState } from '../../apps/server/src/index';
import fixture from '../fixtures/standing-prompt-distill/standing-prompt-distill-fixture.json';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const TEST_TOKEN = STANDING_PROMPT_TEST_TOKEN;
const TEST_PASSWORDS = {
  app: 'app_sp_test_pw',
  audit: 'audit_sp_test_pw',
  analytics: 'analytics_sp_test_pw',
  dictionary: 'dict_sp_test_pw',
  email_ingest: 'email_ingest_sp_test_pw',
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
          console.error('[sp-distill-test-server] Unhandled error:', err);
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

  // 6. Apply standing-prompt DDL
  await sql.unsafe(STANDING_PROMPT_DDL);

  // 7. Build AppState
  appState = {
    sql: sql as unknown as typeof import('../../packages/db/index').sql,
    auditSql: sql as unknown as typeof import('../../packages/db/index').sql,
    analyticsSql: sql as unknown as typeof import('../../packages/db/index').sql,
    dictionarySql: sql as unknown as typeof import('../../packages/db/index').sql,
  };

  // 8. Set TEST_MODE and token in environment for auth
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
// Unit tests: distilToStandingPrompt (no DB required)
// ---------------------------------------------------------------------------

describe('distilToStandingPrompt', () => {
  test('produces output within the hard ceiling for multiple pages', () => {
    const result = distilToStandingPrompt({
      researcher_id: 'r-001',
      wiki_pages: fixture.wiki_pages,
    });

    const wordCount = countWords(result);
    expect(wordCount).toBeLessThanOrEqual(STANDING_PROMPT_HARD_CEILING_WORDS);
    expect(wordCount).toBeGreaterThan(0);
  });

  test('produces empty-state message when no wiki pages are available', () => {
    const result = distilToStandingPrompt({
      researcher_id: 'r-empty',
      wiki_pages: [],
    });

    expect(result).toContain('r-empty');
    expect(result).toContain('no published wiki pages');
  });

  test('respects hard ceiling even with very large wiki page bodies', () => {
    const longBody = 'word '.repeat(500).trim();
    const result = distilToStandingPrompt(
      {
        researcher_id: 'r-001',
        wiki_pages: [
          { subject_type: 'company', subject_id: 'c-001', body: longBody },
          { subject_type: 'company', subject_id: 'c-002', body: longBody },
        ],
      },
      100,
      250,
    );

    const wordCount = countWords(result);
    expect(wordCount).toBeLessThanOrEqual(250);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: length-bound helpers (no DB required)
// ---------------------------------------------------------------------------

describe('countWords / assertWithinLengthBound', () => {
  test('countWords counts whitespace-delimited words', () => {
    expect(countWords('hello world foo')).toBe(3);
    expect(countWords('  leading  trailing  ')).toBe(2);
    expect(countWords('')).toBe(0);
  });

  test('assertWithinLengthBound throws StandingPromptLengthError when over ceiling', () => {
    expect(() => assertWithinLengthBound(251)).toThrow(StandingPromptLengthError);
    expect(() => assertWithinLengthBound(251)).toThrow(/250 words/);
  });

  test('assertWithinLengthBound does not throw when at or under ceiling', () => {
    expect(() => assertWithinLengthBound(250)).not.toThrow();
    expect(() => assertWithinLengthBound(0)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration tests: full pipeline via HTTP server + real DB
// ---------------------------------------------------------------------------

describe('standing-prompt distillation pipeline', () => {
  /**
   * TC-1: wiki publish → bounded active standing prompt
   *
   * Runs a STANDING_PROMPT_DISTILL task end-to-end:
   * - Upserts standing_prompts row.
   * - Creates draft version.
   * - Fetches wiki pages (empty in this test — no indexed pages yet).
   * - Distils and activates the version.
   * - Verifies the active version is within the hard ceiling.
   */
  test('TC-1: wiki publish yields an Active standing prompt within the length bound', async () => {
    const task = makeTask({
      researcher_id: fixture.researcher_id,
      tenant_id: fixture.tenant_id,
      wiki_version_window: fixture.wiki_version_window,
    });

    const result = await executeStandingPromptDistillTask(task, apiBaseUrl, TEST_TOKEN);

    expect(result.error).toBeNull();
    expect(result.already_distilled).toBe(false);
    expect(result.standing_prompt_id).toBeTruthy();
    expect(result.standing_prompt_version_id).toBeTruthy();
    expect(result.word_count).not.toBeNull();
    expect(result.word_count!).toBeLessThanOrEqual(STANDING_PROMPT_HARD_CEILING_WORDS);

    // Verify the version is now active in the DB.
    const activeRes = await fetch(
      `${apiBaseUrl}/internal/standing-prompt/active?tenant_id=${fixture.tenant_id}&researcher_id=${fixture.researcher_id}`,
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
   * TC-2: prior Active prompt is Superseded
   *
   * Runs a second distillation pass for the same researcher with a new window.
   * Verifies the prior active version is now superseded.
   */
  test('TC-2: prior Active prompt is Superseded when a new distillation runs', async () => {
    // Get the currently active version id before the second pass.
    const activeRes1 = await fetch(
      `${apiBaseUrl}/internal/standing-prompt/active?tenant_id=${fixture.tenant_id}&researcher_id=${fixture.researcher_id}`,
      { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    );
    const { version: priorActive } = (await activeRes1.json()) as {
      version: { id: string } | null;
    };
    expect(priorActive).not.toBeNull();
    const priorActiveId = priorActive!.id;

    // Run a second pass with a different wiki_version_window.
    const secondWindow = '2024-01-15T10:05';
    const task = makeTask({
      researcher_id: fixture.researcher_id,
      tenant_id: fixture.tenant_id,
      wiki_version_window: secondWindow,
    });

    const result = await executeStandingPromptDistillTask(task, apiBaseUrl, TEST_TOKEN);
    expect(result.error).toBeNull();
    expect(result.already_distilled).toBe(false);

    // The new version should be active.
    const activeRes2 = await fetch(
      `${apiBaseUrl}/internal/standing-prompt/active?tenant_id=${fixture.tenant_id}&researcher_id=${fixture.researcher_id}`,
      { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    );
    const { version: newActive } = (await activeRes2.json()) as { version: { id: string } | null };
    expect(newActive).not.toBeNull();
    expect(newActive!.id).not.toBe(priorActiveId);

    // The prior version should now be superseded in the DB.
    type VersionStatusRow = { status: string };
    const [priorRow] = await sql<VersionStatusRow[]>`
      SELECT status FROM standing_prompt_versions
      WHERE id = ${priorActiveId}
    `;
    expect(priorRow?.status).toBe('superseded');
  });

  /**
   * TC-3: distillation is idempotent for the same wiki window
   *
   * Re-runs STANDING_PROMPT_DISTILL for the original wiki_version_window.
   * Verifies `already_distilled: true` and no new version row is created.
   */
  test('TC-3: distillation is idempotent for the same wiki window', async () => {
    // Count versions before the idempotent run.
    type CountRow = { count: string };
    const [before] = await sql<CountRow[]>`
      SELECT COUNT(*) AS count FROM standing_prompt_versions
      WHERE researcher_id = ${fixture.researcher_id}
        AND wiki_version_window = ${fixture.wiki_version_window}
    `;
    const countBefore = parseInt(before?.count ?? '0', 10);
    expect(countBefore).toBe(1);

    // Re-run with the same window.
    const task = makeTask({
      researcher_id: fixture.researcher_id,
      tenant_id: fixture.tenant_id,
      wiki_version_window: fixture.wiki_version_window,
    });

    const result = await executeStandingPromptDistillTask(task, apiBaseUrl, TEST_TOKEN);

    expect(result.error).toBeNull();
    expect(result.already_distilled).toBe(true);

    // No new row should have been created.
    const [after] = await sql<CountRow[]>`
      SELECT COUNT(*) AS count FROM standing_prompt_versions
      WHERE researcher_id = ${fixture.researcher_id}
        AND wiki_version_window = ${fixture.wiki_version_window}
    `;
    const countAfter = parseInt(after?.count ?? '0', 10);
    expect(countAfter).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: length-bound enforcement via API
// ---------------------------------------------------------------------------

describe('length-bound enforcement (API)', () => {
  test('activate endpoint returns HTTP 422 when body exceeds hard ceiling', async () => {
    // Create a new standing_prompts row for a different researcher.
    const overLimitResearcher = 'researcher-over-limit-78';
    const promptRes = await fetch(`${apiBaseUrl}/internal/standing-prompt/prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        tenant_id: fixture.tenant_id,
        researcher_id: overLimitResearcher,
      }),
    });
    expect(promptRes.status).toBe(200);
    const { standing_prompt_id } = (await promptRes.json()) as { standing_prompt_id: string };

    // Create a draft version.
    const versionRes = await fetch(`${apiBaseUrl}/internal/standing-prompt/version`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        standing_prompt_id,
        tenant_id: fixture.tenant_id,
        researcher_id: overLimitResearcher,
        wiki_version_window: '2024-01-15T12:00',
      }),
    });
    expect(versionRes.status).toBe(200);
    const { standing_prompt_version_id } = (await versionRes.json()) as {
      standing_prompt_version_id: string;
    };

    // Try to activate with a body over the 250-word ceiling.
    const overLimitBody = 'word '.repeat(300).trim(); // 300 words > 250 ceiling
    const activateRes = await fetch(
      `${apiBaseUrl}/internal/standing-prompt/version/${standing_prompt_version_id}/activate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({ standing_prompt_id, body: overLimitBody }),
      },
    );

    expect(activateRes.status).toBe(422);
    const errData = (await activateRes.json()) as {
      error: string;
      word_count: number;
      hard_ceiling: number;
    };
    expect(errData.error).toBe('length_exceeded');
    expect(errData.word_count).toBe(300);
    expect(errData.hard_ceiling).toBe(STANDING_PROMPT_HARD_CEILING_WORDS);
  });
});
