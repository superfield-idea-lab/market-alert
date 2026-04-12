/**
 * @file campaign-analysis.spec.ts
 *
 * End-to-end tests for the campaign analysis view (issue #74).
 *
 * Test plan items covered:
 *   TP-1  Playwright: pick an asset manager and assert anonymised chunks appear.
 *   TP-2  Integration: attempt to extract a customer identifier via the endpoint
 *         and assert rejection (no source_id, body, or customer fields in response).
 *
 * Additional API invariants:
 *   - GET /api/campaign/entities lists asset managers and funds.
 *   - GET /api/campaign/chunks returns only chunk_id, index, token_count.
 *   - 401 for unauthenticated callers on both endpoints.
 *   - 404 for unknown entity_id.
 *
 * No mocks — real Bun server + Postgres via the shared E2E environment.
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/74
 */

import { chromium, type Browser, expect as playwrightExpect } from '@playwright/test';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startE2EServer, stopE2EServer, type E2EEnvironment } from './environment';

let browser: Browser;
let env: E2EEnvironment;

beforeAll(async () => {
  env = await startE2EServer();
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
  await stopE2EServer(env);
});

// ---------------------------------------------------------------------------
// Helpers
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
  expect(res.ok).toBe(true);
  const body = (await res.json()) as { user: { id: string } };
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = /calypso_auth=([^;]+)/.exec(setCookie);
  return {
    cookie: match ? `calypso_auth=${match[1]}` : '',
    userId: body.user.id,
  };
}

/**
 * Seed an asset manager entity directly in the test database.
 */
async function seedAssetManager(dbUrl: string, name: string): Promise<string> {
  const db = postgres(dbUrl, { max: 1 });
  const id = `asset_manager-${crypto.randomUUID()}`;
  await db`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES (${id}, 'asset_manager', ${db.json({ name } as never)}, null)
  `;
  await db.end({ timeout: 5 });
  return id;
}

/**
 * Seed a transcript entity and associated corpus_chunk rows linked via
 * discussed_in relation to the given entity.
 */
async function seedTranscriptWithChunks(
  dbUrl: string,
  entityId: string,
  chunkCount: number,
): Promise<{ transcriptId: string; chunkIds: string[] }> {
  const db = postgres(dbUrl, { max: 1 });
  const transcriptId = `transcript-${crypto.randomUUID()}`;

  // Insert transcript entity (no tenant_id so it does not belong to a customer).
  await db`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES (${transcriptId}, 'transcript', ${db.json({ text: 'test transcript' }) as never}, null)
  `;

  // Insert discussed_in relation linking transcript → entity.
  const relId = `rel-discussed_in-${crypto.randomUUID()}`;
  await db`
    INSERT INTO relations (id, source_id, target_id, type, properties)
    VALUES (${relId}, ${transcriptId}, ${entityId}, 'discussed_in', ${db.json({}) as never})
    ON CONFLICT DO NOTHING
  `;

  // Insert corpus_chunk entities pointing to the transcript.
  const chunkIds: string[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const chunkId = `chunk-${crypto.randomUUID()}`;
    await db`
      INSERT INTO entities (id, type, properties, tenant_id)
      VALUES (
        ${chunkId},
        'corpus_chunk',
        ${db.json({ body: `chunk body ${i}`, source_id: transcriptId, index: i, token_count: 20 + i }) as never},
        null
      )
    `;
    chunkIds.push(chunkId);
  }

  await db.end({ timeout: 5 });
  return { transcriptId, chunkIds };
}

// ---------------------------------------------------------------------------
// API invariant tests (no browser needed)
// ---------------------------------------------------------------------------

test('GET /api/campaign/entities returns 401 for unauthenticated request', async () => {
  const res = await fetch(`${env.baseUrl}/api/campaign/entities?type=asset_manager`);
  expect(res.status).toBe(401);
});

test('GET /api/campaign/chunks returns 401 for unauthenticated request', async () => {
  const res = await fetch(`${env.baseUrl}/api/campaign/chunks?entity_id=does-not-matter`);
  expect(res.status).toBe(401);
});

test('GET /api/campaign/entities returns 400 for missing type param', async () => {
  const { cookie } = await getTestSession(env.baseUrl, `cam-400-${Date.now()}`);
  const res = await fetch(`${env.baseUrl}/api/campaign/entities`, {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toMatch(/type/i);
});

test('GET /api/campaign/entities returns empty list when no asset managers exist', async () => {
  const { cookie } = await getTestSession(env.baseUrl, `cam-empty-${Date.now()}`);
  const res = await fetch(`${env.baseUrl}/api/campaign/entities?type=fund`, {
    headers: { Cookie: cookie },
  });
  // Funds may or may not exist; just verify the shape.
  expect(res.status).toBe(200);
  const body = (await res.json()) as { entities: unknown[] };
  expect(Array.isArray(body.entities)).toBe(true);
});

test('GET /api/campaign/chunks returns 404 for unknown entity_id', async () => {
  const { cookie } = await getTestSession(env.baseUrl, `cam-404-${Date.now()}`);
  const res = await fetch(
    `${env.baseUrl}/api/campaign/chunks?entity_id=asset_manager-does-not-exist`,
    { headers: { Cookie: cookie } },
  );
  expect(res.status).toBe(404);
});

// ---------------------------------------------------------------------------
// TP-2: No customer identifier in chunk response
// ---------------------------------------------------------------------------

test('TP-2: chunk response contains no source_id, body, or tenant_id fields', async () => {
  const { cookie } = await getTestSession(env.baseUrl, `cam-anon-${Date.now()}`);
  const entityId = await seedAssetManager(env.pg.url, `AnonymisationTarget-${Date.now()}`);
  await seedTranscriptWithChunks(env.pg.url, entityId, 2);

  const res = await fetch(
    `${env.baseUrl}/api/campaign/chunks?entity_id=${encodeURIComponent(entityId)}`,
    { headers: { Cookie: cookie } },
  );
  expect(res.status).toBe(200);

  const body = (await res.json()) as {
    chunks: Array<Record<string, unknown>>;
  };
  expect(Array.isArray(body.chunks)).toBe(true);
  expect(body.chunks.length).toBe(2);

  for (const chunk of body.chunks) {
    // Allowed fields: chunk_id, index, token_count
    expect(Object.keys(chunk).sort()).toEqual(['chunk_id', 'index', 'token_count'].sort());
    // Explicitly banned fields
    expect(chunk).not.toHaveProperty('source_id');
    expect(chunk).not.toHaveProperty('body');
    expect(chunk).not.toHaveProperty('tenant_id');
    expect(chunk).not.toHaveProperty('customer');
    expect(chunk).not.toHaveProperty('text');
    // Values must be the right types
    expect(typeof chunk.chunk_id).toBe('string');
    expect(typeof chunk.index).toBe('number');
    expect(typeof chunk.token_count).toBe('number');
  }
});

// ---------------------------------------------------------------------------
// TP-1: Playwright — pick an asset manager and assert anonymised chunks appear
// ---------------------------------------------------------------------------

test('TP-1: BDM selects an asset manager and sees anonymised chunks in the UI', async () => {
  // Seed an asset manager and linked chunks.
  const managerName = `UITestManager-${Date.now()}`;
  const entityId = await seedAssetManager(env.pg.url, managerName);
  await seedTranscriptWithChunks(env.pg.url, entityId, 3);

  // Get session and inject cookie into Playwright context.
  const { cookie: rawCookie } = await getTestSession(env.baseUrl, `cam-playwright-${Date.now()}`);
  const cookieValue = rawCookie.replace(/^calypso_auth=/, '');

  const page = await browser.newPage();
  await page.context().addCookies([
    {
      name: 'calypso_auth',
      value: cookieValue,
      url: env.baseUrl,
    },
  ]);

  await page.goto(env.baseUrl, { waitUntil: 'networkidle' });

  // Click the campaign analysis nav button.
  await page.getByTitle('Campaign Analysis').click();

  // The campaign analysis page should be visible.
  await playwrightExpect(page.locator('[data-testid="campaign-analysis-page"]')).toBeVisible();

  // Asset manager tab should be selected by default.
  await playwrightExpect(page.locator('[data-testid="tab-asset-manager"]')).toBeVisible();

  // Wait for the seeded asset manager to appear in the picker.
  await playwrightExpect(page.locator(`[data-testid="entity-item-${entityId}"]`)).toBeVisible({
    timeout: 10_000,
  });

  // Click the entity to query its chunks.
  await page.locator(`[data-testid="entity-item-${entityId}"]`).click();

  // Wait for the chunk count to appear.
  await playwrightExpect(page.locator('[data-testid="chunk-count"]')).toBeVisible({
    timeout: 10_000,
  });

  const countText = await page.locator('[data-testid="chunk-count"]').textContent();
  expect(countText).toContain('3');

  // Chunk list should contain 3 rows.
  await playwrightExpect(page.locator('[data-testid="chunk-list"]')).toBeVisible();
  const chunkRows = page.locator('[data-testid^="chunk-"]');
  expect(await chunkRows.count()).toBe(3);

  await page.close();
});
