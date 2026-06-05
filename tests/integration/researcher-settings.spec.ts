/**
 * @file tests/integration/researcher-settings.spec.ts
 *
 * Integration tests for the researcher Sources & Triggers settings API — issue #118.
 *
 * ## Acceptance criteria tested
 *
 *   AC-1: GET /api/researcher/sources returns canonical_sources for researcher's tenant
 *     TC-1: Seed canonical sources for a researcher tenant, call GET with session cookie,
 *           assert all sources returned with correct fields (name, url, trust_tier, status).
 *
 *   AC-2: GET /api/researcher/standing-prompts returns standing_prompts with active version data
 *     TC-2: Seed standing prompts with active versions, call GET, assert subjects,
 *           version word counts, and pin state are returned correctly.
 *
 *   AC-3 & AC-4: Pin and unpin round-trip
 *     TC-3: POST pin on a standing prompt, then GET and assert is_pinned is true;
 *           POST unpin and assert is_pinned is false.
 *
 *   AC-6: Auth enforcement
 *     TC-4: GET /api/researcher/sources without auth returns 401.
 *     TC-5: GET /api/researcher/sources with worker Bearer token returns 403.
 *
 * ## Architecture
 *
 * Uses the shared E2E environment (full server subprocess with a real ephemeral
 * Postgres container). Session cookies are obtained via the TEST_MODE backdoor
 * endpoint POST /api/test/session. Seeds canonical_sources and standing_prompts
 * data directly into the test Postgres container for isolation.
 *
 * ## No mocks
 *
 * Uses a real ephemeral Postgres container, real Bun server process, and real
 * fetch calls. Zero vi.fn, vi.mock, vi.spyOn, vi.stubGlobal.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §3, §5, §7 — researcher sources, standing-prompt routing, pin/override
 * - apps/server/src/api/researcher-settings-api.ts — API
 * - packages/db/canonical-source-store.ts — DB store
 * - packages/db/standing-prompt-store.ts  — DB store
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/118
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import postgres from 'postgres';
import { startE2EServer, stopE2EServer, type E2EEnvironment } from '../e2e/environment';
import {
  CANONICAL_SOURCES_DDL,
  type CanonicalSourceRow,
} from '../../packages/db/canonical-source-store';
import {
  STANDING_PROMPT_DDL,
  type StandingPromptRow,
  type StandingPromptVersionRow,
} from '../../packages/db/standing-prompt-store';

let env: E2EEnvironment;
let sql: ReturnType<typeof postgres>;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  env = await startE2EServer();
  // Open a direct SQL connection to the test DB for seeding.
  sql = postgres(env.pg.url, { max: 2 });

  // Ensure mkt tables exist (migrateMkt runs inside the server process, but
  // we need them accessible from the test's direct SQL connection too).
  await sql.unsafe(CANONICAL_SOURCES_DDL);
  await sql.unsafe(STANDING_PROMPT_DDL);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stopE2EServer(env);
});

// ---------------------------------------------------------------------------
// Helper: obtain session cookie via TEST_MODE backdoor
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
  const body = (await res.json()) as { user_id: string };
  const cookie = res.headers.get('set-cookie') ?? '';
  return { cookie, userId: body.user_id };
}

// ---------------------------------------------------------------------------
// Helper: seed canonical sources for a tenant
// ---------------------------------------------------------------------------

async function seedCanonicalSources(
  tenantId: string,
  authorId: string,
): Promise<CanonicalSourceRow[]> {
  const methodologyId = `methodology-${crypto.randomUUID()}`;
  const rows = await sql<CanonicalSourceRow[]>`
    INSERT INTO canonical_sources
      (methodology_id, author_id, tenant_id, name, url, access_mode, status)
    VALUES
      (${methodologyId}, ${authorId}, ${tenantId}, 'SEC EDGAR', 'https://edgar.sec.gov', 'public', 'active'),
      (${methodologyId}, ${authorId}, ${tenantId}, 'Bloomberg API', 'https://api.bloomberg.com', 'api_key', 'pending'),
      (${methodologyId}, ${authorId}, ${tenantId}, 'Old Venue', 'https://old.example.com', NULL, 'retired')
    ON CONFLICT (methodology_id, url) DO NOTHING
    RETURNING id, methodology_id, author_id, tenant_id, name, url, description, access_mode, status, created_at, updated_at
  `;
  return rows;
}

// ---------------------------------------------------------------------------
// Helper: seed standing prompts with active versions
// ---------------------------------------------------------------------------

async function seedStandingPromptWithActiveVersion(opts: {
  tenantId: string;
  researcherId: string;
  subjectType: 'entity' | 'thesis' | 'portfolio';
  subjectId: string;
  bodyText: string;
  isPinned?: boolean;
}): Promise<{ prompt: StandingPromptRow; version: StandingPromptVersionRow }> {
  const [prompt] = await sql<StandingPromptRow[]>`
    INSERT INTO standing_prompts (tenant_id, researcher_id, subject_type, subject_id)
    VALUES (${opts.tenantId}, ${opts.researcherId}, ${opts.subjectType}, ${opts.subjectId})
    ON CONFLICT (tenant_id, researcher_id, subject_type, subject_id) DO UPDATE
      SET updated_at = CURRENT_TIMESTAMP
    RETURNING id, tenant_id, researcher_id, subject_type, subject_id,
              currently_active_version_id, created_at, updated_at
  `;

  const wordCount = opts.bodyText.trim().split(/\s+/).filter(Boolean).length;

  const [version] = await sql<StandingPromptVersionRow[]>`
    INSERT INTO standing_prompt_versions
      (standing_prompt_id, tenant_id, researcher_id, wiki_version_window, body, status, word_count, is_pinned)
    VALUES
      (${prompt.id}, ${opts.tenantId}, ${opts.researcherId},
       ${`2026-06-05T10:0${Math.floor(Math.random() * 5)}`},
       ${opts.bodyText}, 'active', ${wordCount}, ${opts.isPinned ?? false})
    RETURNING id, standing_prompt_id, tenant_id, researcher_id, wiki_version_window,
              body, status, word_count, is_pinned, created_at, updated_at
  `;

  // Update the parent row to point at the active version.
  await sql`
    UPDATE standing_prompts
    SET currently_active_version_id = ${version.id},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${prompt.id}
  `;

  return { prompt, version };
}

// ---------------------------------------------------------------------------
// TC-1: GET /api/researcher/sources — returns sources for tenant
// ---------------------------------------------------------------------------

describe('TC-1: GET /api/researcher/sources returns sources for researcher tenant', () => {
  test('returns all canonical sources with correct fields', async () => {
    const { cookie, userId } = await getTestSession(
      env.baseUrl,
      `researcher-sources-${Date.now()}`,
    );

    // Seed canonical sources for this researcher's tenant (tenant_id === user_id in tests).
    const seeded = await seedCanonicalSources(userId, userId);
    expect(seeded.length).toBeGreaterThanOrEqual(3);

    const res = await fetch(`${env.baseUrl}/api/researcher/sources`, {
      method: 'GET',
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: unknown[] };
    expect(Array.isArray(body.sources)).toBe(true);

    // All seeded sources should be present.
    expect(body.sources.length).toBeGreaterThanOrEqual(3);

    // Validate field shape of each source.
    for (const source of body.sources as Array<Record<string, unknown>>) {
      expect(typeof source['id']).toBe('string');
      expect(typeof source['name']).toBe('string');
      expect(typeof source['url']).toBe('string');
      // trust_tier is access_mode — may be null for 'retired' sources without access_mode.
      expect(['public', 'authenticated', 'api_key', null]).toContain(source['trust_tier']);
      expect(['pending', 'active', 'retired']).toContain(source['status']);
    }

    // Check specific seeded sources are present.
    const names = (body.sources as Array<Record<string, unknown>>).map((s) => s['name']);
    expect(names).toContain('SEC EDGAR');
    expect(names).toContain('Bloomberg API');
    expect(names).toContain('Old Venue');

    // Verify trust_tier maps correctly.
    const edgar = (body.sources as Array<Record<string, unknown>>).find(
      (s) => s['name'] === 'SEC EDGAR',
    );
    expect(edgar?.['trust_tier']).toBe('public');
    expect(edgar?.['status']).toBe('active');

    const bloomberg = (body.sources as Array<Record<string, unknown>>).find(
      (s) => s['name'] === 'Bloomberg API',
    );
    expect(bloomberg?.['trust_tier']).toBe('api_key');
    expect(bloomberg?.['status']).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// TC-2: GET /api/researcher/standing-prompts — returns prompts with active version data
// ---------------------------------------------------------------------------

describe('TC-2: GET /api/researcher/standing-prompts returns prompts with active version data', () => {
  test('returns standing prompts grouped with word count and pin state', async () => {
    const { cookie, userId } = await getTestSession(
      env.baseUrl,
      `researcher-prompts-${Date.now()}`,
    );

    // Seed three standing prompts (one per subject type).
    const entityBody = 'This is a standing prompt about Apple entity watch thesis horizon signal.';
    const thesisBody =
      'This thesis standing prompt covers the macro rates environment and yield curve dynamics.';
    const portfolioBody = 'Portfolio-level fallback prompt for diversified risk monitoring.';

    await seedStandingPromptWithActiveVersion({
      tenantId: userId,
      researcherId: userId,
      subjectType: 'entity',
      subjectId: 'AAPL',
      bodyText: entityBody,
      isPinned: false,
    });
    await seedStandingPromptWithActiveVersion({
      tenantId: userId,
      researcherId: userId,
      subjectType: 'thesis',
      subjectId: 'rates-thesis',
      bodyText: thesisBody,
      isPinned: true,
    });
    await seedStandingPromptWithActiveVersion({
      tenantId: userId,
      researcherId: userId,
      subjectType: 'portfolio',
      subjectId: 'portfolio',
      bodyText: portfolioBody,
      isPinned: false,
    });

    const res = await fetch(`${env.baseUrl}/api/researcher/standing-prompts`, {
      method: 'GET',
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      standing_prompts: Array<{
        id: string;
        subject_type: string;
        subject_id: string;
        active_version_word_count: number | null;
        is_pinned: boolean | null;
        active_version_id: string | null;
      }>;
    };
    expect(Array.isArray(body.standing_prompts)).toBe(true);
    expect(body.standing_prompts.length).toBeGreaterThanOrEqual(3);

    // Validate entity prompt.
    const entityPrompt = body.standing_prompts.find(
      (p) => p.subject_type === 'entity' && p.subject_id === 'AAPL',
    );
    expect(entityPrompt).toBeDefined();
    expect(entityPrompt?.subject_type).toBe('entity');
    expect(entityPrompt?.is_pinned).toBe(false);
    expect(typeof entityPrompt?.active_version_word_count).toBe('number');
    expect(entityPrompt?.active_version_word_count ?? 0).toBeGreaterThan(0);

    // Validate thesis prompt — should be pinned.
    const thesisPrompt = body.standing_prompts.find(
      (p) => p.subject_type === 'thesis' && p.subject_id === 'rates-thesis',
    );
    expect(thesisPrompt).toBeDefined();
    expect(thesisPrompt?.is_pinned).toBe(true);

    // Validate portfolio prompt.
    const portfolioPrompt = body.standing_prompts.find(
      (p) => p.subject_type === 'portfolio' && p.subject_id === 'portfolio',
    );
    expect(portfolioPrompt).toBeDefined();
    expect(portfolioPrompt?.subject_type).toBe('portfolio');
    expect(portfolioPrompt?.active_version_id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// TC-3: Pin and unpin round-trip
// ---------------------------------------------------------------------------

describe('TC-3: pin and unpin round-trip via POST /api/researcher/standing-prompts/:id/pin', () => {
  test('pin sets is_pinned to true; unpin sets it back to false', async () => {
    const { cookie, userId } = await getTestSession(env.baseUrl, `researcher-pin-${Date.now()}`);

    // Seed an unpinned standing prompt.
    const { prompt } = await seedStandingPromptWithActiveVersion({
      tenantId: userId,
      researcherId: userId,
      subjectType: 'entity',
      subjectId: 'MSFT',
      bodyText: 'Microsoft entity prompt for pin round-trip test.',
      isPinned: false,
    });

    // ── Pin ───────────────────────────────────────────────────────────────────
    const pinRes = await fetch(`${env.baseUrl}/api/researcher/standing-prompts/${prompt.id}/pin`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(pinRes.status).toBe(200);
    const pinBody = (await pinRes.json()) as { is_pinned: boolean };
    expect(pinBody.is_pinned).toBe(true);

    // Verify via GET that is_pinned is reflected.
    const afterPinRes = await fetch(`${env.baseUrl}/api/researcher/standing-prompts`, {
      method: 'GET',
      headers: { Cookie: cookie },
    });
    expect(afterPinRes.status).toBe(200);
    const afterPinBody = (await afterPinRes.json()) as {
      standing_prompts: Array<{ id: string; subject_id: string; is_pinned: boolean | null }>;
    };
    const msftAfterPin = afterPinBody.standing_prompts.find((p) => p.id === prompt.id);
    expect(msftAfterPin?.is_pinned).toBe(true);

    // ── Unpin ─────────────────────────────────────────────────────────────────
    const unpinRes = await fetch(
      `${env.baseUrl}/api/researcher/standing-prompts/${prompt.id}/unpin`,
      {
        method: 'POST',
        headers: { Cookie: cookie },
      },
    );
    expect(unpinRes.status).toBe(200);
    const unpinBody = (await unpinRes.json()) as { is_pinned: boolean };
    expect(unpinBody.is_pinned).toBe(false);

    // Verify via GET that is_pinned is false.
    const afterUnpinRes = await fetch(`${env.baseUrl}/api/researcher/standing-prompts`, {
      method: 'GET',
      headers: { Cookie: cookie },
    });
    expect(afterUnpinRes.status).toBe(200);
    const afterUnpinBody = (await afterUnpinRes.json()) as {
      standing_prompts: Array<{ id: string; subject_id: string; is_pinned: boolean | null }>;
    };
    const msftAfterUnpin = afterUnpinBody.standing_prompts.find((p) => p.id === prompt.id);
    expect(msftAfterUnpin?.is_pinned).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TC-4: Unauthenticated request returns 401
// ---------------------------------------------------------------------------

describe('TC-4: unauthenticated request returns 401', () => {
  test('GET /api/researcher/sources without session cookie returns 401', async () => {
    const res = await fetch(`${env.baseUrl}/api/researcher/sources`, {
      method: 'GET',
      // No Cookie header
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unauthorized/i);
  });

  test('GET /api/researcher/standing-prompts without session cookie returns 401', async () => {
    const res = await fetch(`${env.baseUrl}/api/researcher/standing-prompts`, {
      method: 'GET',
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unauthorized/i);
  });
});

// ---------------------------------------------------------------------------
// TC-5: Worker Bearer token returns 403
// ---------------------------------------------------------------------------

describe('TC-5: worker Bearer token returns 403', () => {
  test('GET /api/researcher/sources with Bearer token returns 403', async () => {
    const res = await fetch(`${env.baseUrl}/api/researcher/sources`, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer some-worker-token-12345',
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/forbidden/i);
  });

  test('GET /api/researcher/standing-prompts with Bearer token returns 403', async () => {
    const res = await fetch(`${env.baseUrl}/api/researcher/standing-prompts`, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer some-worker-token-12345',
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/forbidden/i);
  });
});
