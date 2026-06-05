/**
 * @file researcher-wiki.spec.ts
 *
 * End-to-end tests verifying that the demo researcher persona can reach and
 * navigate the wiki using the canonical demo fixture data.
 *
 * These tests prove that the demo and the e2e test suite share the same
 * starting state: the wiki page seeded by `seedDemoFixtures` is accessible to
 * the researcher via the same session mechanism the demo uses.
 *
 * Test strategy:
 *   - Use `getFixtureSession('researcher')` to authenticate as the demo
 *     researcher via POST /api/demo/session — the same path the demo uses
 *     when the user clicks "Sign in as Account Manager".
 *   - Call the wiki-nav API directly to assert fixture data is visible.
 *   - Use a Playwright browser to assert the wiki nav page renders in the UI.
 *
 * No mocks — real Bun server + Postgres via the shared E2E environment.
 *
 * @see packages/db/demo-seed.ts   — fixture definitions
 * @see tests/e2e/fixtures.ts      — getFixtureSession helper
 * @see apps/server/src/api/wiki-nav-api.ts — API under test
 */

import { chromium, type Browser, expect as playwrightExpect } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startE2EServer, stopE2EServer, type E2EEnvironment } from './environment';
import { DEMO_FIXTURES, getFixtureSession } from './fixtures';

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

describe('researcher wiki — API', () => {
  test('GET /api/wiki-nav/pages returns the seeded demo wiki page', async () => {
    const session = await getFixtureSession(env.baseUrl, 'researcher');
    const f = DEMO_FIXTURES.wikiPage;

    const res = await fetch(`${env.baseUrl}/api/wiki-nav/pages?tenant_id=${f.tenantId}`, {
      headers: { Cookie: session.cookie.split(';')[0] },
    });
    expect(res.status).toBe(200);
    const pages = (await res.json()) as Array<{
      id: string;
      subject_type: string;
      subject_id: string;
      currently_published_version_id: string | null;
    }>;

    const seededPage = pages.find((p) => p.id === f.id);
    expect(seededPage).toBeDefined();
    expect(seededPage?.subject_type).toBe(f.subjectType);
    expect(seededPage?.subject_id).toBe(f.subjectId);
    expect(seededPage?.currently_published_version_id).toBe(f.versionId);
  });

  test('GET /api/wiki-nav/pages/:id returns the seeded page detail', async () => {
    const session = await getFixtureSession(env.baseUrl, 'researcher');
    const f = DEMO_FIXTURES.wikiPage;

    const res = await fetch(`${env.baseUrl}/api/wiki-nav/pages/${f.id}`, {
      headers: { Cookie: session.cookie.split(';')[0] },
    });
    expect(res.status).toBe(200);
    const page = (await res.json()) as {
      id: string;
      currently_published_version_id: string | null;
    };
    expect(page.id).toBe(f.id);
    expect(page.currently_published_version_id).toBe(f.versionId);
  });

  test('GET /api/wiki-nav/pages/:id/versions lists the seeded indexed version', async () => {
    const session = await getFixtureSession(env.baseUrl, 'researcher');
    const f = DEMO_FIXTURES.wikiPage;

    const res = await fetch(`${env.baseUrl}/api/wiki-nav/pages/${f.id}/versions`, {
      headers: { Cookie: session.cookie.split(';')[0] },
    });
    expect(res.status).toBe(200);
    const versions = (await res.json()) as Array<{ id: string; status: string }>;

    const seededVersion = versions.find((v) => v.id === f.versionId);
    expect(seededVersion).toBeDefined();
    expect(seededVersion?.status).toBe('indexed');
  });

  test('unauthenticated request to wiki-nav is rejected with 401', async () => {
    const f = DEMO_FIXTURES.wikiPage;
    const res = await fetch(`${env.baseUrl}/api/wiki-nav/pages?tenant_id=${f.tenantId}`);
    expect(res.status).toBe(401);
  });
});

describe('researcher wiki — browser', () => {
  test('authenticated researcher sees the wiki nav page in the UI', async () => {
    const session = await getFixtureSession(env.baseUrl, 'researcher');
    const page = await browser.newPage();
    try {
      await page.context().addCookies([
        {
          name: 'superfield_auth',
          value: session.cookie.match(/superfield_auth=([^;]+)/)?.[1] ?? '',
          url: env.baseUrl,
        },
      ]);

      await page.goto(env.baseUrl, { waitUntil: 'networkidle' });

      // The login screen should be gone.
      await playwrightExpect(
        page.getByRole('button', { name: 'Sign in with a passkey' }),
      ).not.toBeVisible();

      // Wiki nav button should be in the sidebar.
      await playwrightExpect(page.getByTitle('Wiki')).toBeVisible();

      // Navigate to the wiki page.
      await page.getByTitle('Wiki').click();

      // The wiki nav page renders a subject list — the seeded company should appear.
      await playwrightExpect(page.getByText(DEMO_FIXTURES.wikiPage.subjectId)).toBeVisible({
        timeout: 8_000,
      });
    } finally {
      await page.close();
    }
  });
});
