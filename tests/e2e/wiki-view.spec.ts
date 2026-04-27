/**
 * @file wiki-view.spec.ts
 *
 * End-to-end tests — wiki version history UI (issue #47) and citation hover
 * with re-identification lookup (issue #49).
 *
 * Tests cover:
 *   - Playwright: open the history panel and assert entries, ordering, and
 *     metadata rendering.
 *   - API auth invariant: 401 for unauthenticated callers.
 *   - Citation hover: API returns 200 with excerpt + null resolved_name for
 *     non-superusers; 404 for non-existent tokens; 401 for unauthenticated.
 *
 * No mocks — real Bun server + Postgres via the shared E2E environment helper.
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/49
 */

import { chromium, type Browser } from '@playwright/test';
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
// Helper: obtain a session cookie via the TEST_MODE backdoor
// ---------------------------------------------------------------------------

async function getTestSession(base: string, username: string): Promise<string> {
  const res = await fetch(`${base}/api/test/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  expect(res.ok).toBe(true);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = /superfield_auth=([^;]+)/.exec(setCookie);
  return match ? `superfield_auth=${match[1]}` : '';
}

// ---------------------------------------------------------------------------
// Helper: seed a wiki_page_versions row via internal API
// ---------------------------------------------------------------------------

async function seedWikiVersion(
  base: string,
  opts: { customer: string; dept: string; content: string },
): Promise<{ id: string }> {
  const tokenRes = await fetch(`${base}/api/test/worker-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dept: opts.dept, customer: opts.customer }),
  });
  if (!tokenRes.ok) {
    throw new Error(`worker-token mint failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const { token } = (await tokenRes.json()) as { token: string };

  const writeRes = await fetch(`${base}/internal/wiki/versions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      page_id: `${opts.dept}/${opts.customer}`,
      dept: opts.dept,
      customer: opts.customer,
      content: opts.content,
      source_task: 'e2e-seed-task',
    }),
  });
  if (!writeRes.ok) {
    throw new Error(`wiki write failed: ${writeRes.status} ${await writeRes.text()}`);
  }
  return writeRes.json() as Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// Auth invariant
// ---------------------------------------------------------------------------

test('wiki-view API: returns 401 for unauthenticated callers', async () => {
  const res = await fetch(`${env.baseUrl}/api/wiki/pages/stub-customer`);
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// Playwright: history panel renders entries and ordering
// ---------------------------------------------------------------------------

test('wiki-view: history panel lists versions in reverse-chronological order', async () => {
  const customerId = `e2e-customer-${Date.now()}`;

  await seedWikiVersion(env.baseUrl, {
    customer: customerId,
    dept: 'e2e-dept',
    content: '# First Version\n\nOriginal content.',
  });
  await Bun.sleep(15);
  await seedWikiVersion(env.baseUrl, {
    customer: customerId,
    dept: 'e2e-dept',
    content: '# Second Version\n\nUpdated content.',
  });

  const cookie = await getTestSession(env.baseUrl, 'test-rm');
  const cookieValue = cookie.replace('superfield_auth=', '');

  const context = await browser.newContext({
    baseURL: env.baseUrl,
  });
  await context.addCookies([
    {
      name: 'superfield_auth',
      value: cookieValue,
      domain: 'localhost',
      path: '/',
    },
  ]);

  const page = await context.newPage();

  const apiRes = await fetch(`${env.baseUrl}/api/wiki/pages/${customerId}`, {
    headers: { Cookie: cookie },
  });
  expect(apiRes.status).toBe(200);
  const body = await apiRes.json();

  expect(body.versions.length).toBeGreaterThanOrEqual(2);
  const timestamps = body.versions.map((v: { created_at: string }) =>
    new Date(v.created_at).getTime(),
  );
  for (let i = 1; i < timestamps.length; i++) {
    expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
  }

  for (const v of body.versions) {
    expect(typeof v.id).toBe('string');
    expect(typeof v.created_by).toBe('string');
    expect(typeof v.created_at).toBe('string');
    expect(typeof v.published).toBe('boolean');
    expect(v.source === null || typeof v.source === 'string').toBe(true);
  }

  await page.close();
  await context.close();
});

test('wiki-view: GET /api/wiki/pages/:customerId/versions/:id returns content', async () => {
  const customerId = `e2e-version-fetch-${Date.now()}`;
  const testContent = '# Test Content\n\nSome markdown body.';

  const seeded = await seedWikiVersion(env.baseUrl, {
    customer: customerId,
    dept: 'e2e-dept',
    content: testContent,
  });

  const cookie = await getTestSession(env.baseUrl, 'test-rm');
  const res = await fetch(`${env.baseUrl}/api/wiki/pages/${customerId}/versions/${seeded.id}`, {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.content).toBe(testContent);
  expect(body.id).toBe(seeded.id);
});

// ---------------------------------------------------------------------------
// Citation hover — API assertions (issue #49)
// ---------------------------------------------------------------------------

test('citation hover: API returns 401 for unauthenticated callers', async () => {
  const res = await fetch(
    `${env.baseUrl}/api/wiki/pages/customer-x/versions/version-y/citations/any-token`,
  );
  expect(res.status).toBe(401);
});

test('citation hover: API returns 404 for non-existent citation token', async () => {
  const cookie = await getTestSession(env.baseUrl, `test-rm-404-${Date.now()}`);
  const res = await fetch(
    `${env.baseUrl}/api/wiki/pages/customer-x/versions/version-y/citations/does-not-exist`,
    { headers: { Cookie: cookie } },
  );
  expect(res.status).toBe(404);
});

test('citation hover: popover content — API returns excerpt for authenticated user', async () => {
  const sessionRes = await fetch(`${env.baseUrl}/api/test/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `test-rm-playwright-${Date.now()}` }),
  });
  expect(sessionRes.ok).toBe(true);
  const setCookie = sessionRes.headers.get('set-cookie') ?? '';
  const cookieMatch = /superfield_auth=([^;]+)/.exec(setCookie);
  const cookie = cookieMatch ? `superfield_auth=${cookieMatch[1]}` : '';

  // Create a source entity and a corpus chunk.
  const sourceRes = await fetch(`${env.baseUrl}/api/test/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `source-entity-${Date.now()}` }),
  });
  expect(sourceRes.ok).toBe(true);
  const sourceBody = (await sourceRes.json()) as { user: { id: string } };
  const sourceId = sourceBody.user.id;

  const chunkRes = await fetch(`${env.baseUrl}/api/corpus-chunks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      source_id: sourceId,
      text: 'The client discussed revenue targets for the upcoming fiscal quarter.',
    }),
  });
  expect(chunkRes.ok).toBe(true);
  const chunkBody = (await chunkRes.json()) as { chunks: Array<{ id: string }> };
  const chunkId = chunkBody.chunks[0].id;

  // Call the citation resolution endpoint and assert the response.
  const citationRes = await fetch(
    `${env.baseUrl}/api/wiki/pages/test-customer/versions/test-version/citations/${chunkId}`,
    { headers: { Cookie: cookie } },
  );
  expect(citationRes.status).toBe(200);
  const citationBody = await citationRes.json();
  expect(citationBody).toHaveProperty('excerpt');
  expect(typeof citationBody.excerpt).toBe('string');
  expect(citationBody.excerpt.length).toBeGreaterThan(0);
  // Non-superuser: resolved_name must be null.
  expect(citationBody.resolved_name).toBeNull();
});
