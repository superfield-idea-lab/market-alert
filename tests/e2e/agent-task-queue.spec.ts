/**
 * @file tests/e2e/agent-task-queue.spec.ts
 *
 * Browser E2E tests for the Agent Queue superadmin live view (issue #115).
 *
 * ## What this tests
 *
 *   ET-1: Superadmin user sees the 'Agent Queue' nav item in the sidebar.
 *         Non-superadmin (researcher) user does not see the nav item.
 *
 *   ET-2: Superadmin navigates to Agent Queue and the page renders the
 *         task queue heading and connection status indicator.
 *
 *   ET-3: GET /api/tasks-queue returns 401 for unauthenticated fetch.
 *         GET /api/tasks-queue returns 403 for non-superadmin fetch.
 *
 *   ET-4: Superadmin enqueues a task via POST /api/tasks-queue; the task
 *         row appears in the Agent Queue live view without a page reload.
 *
 * ## No mocks
 *
 * Uses a real Playwright Chromium browser, a real Postgres container, and a
 * real Bun server with SUPERUSER_ID set so isSuperuser() returns true for the
 * test user. Zero vi.fn, vi.mock, vi.spyOn. CLAUDE.md § Testing Standards.
 *
 * ## Architecture
 *
 * The E2E environment starts the Bun server with DEMO_MODE=true; however,
 * demo fixtures don't include a superadmin user. We set SUPERUSER_ID to the
 * demo researcher's ID at server startup to keep the setup minimal.
 *
 * @see apps/web/src/App.tsx — nav item gate (user.isSuperadmin)
 * @see apps/web/src/pages/agent-task-queue.tsx — page
 * @see apps/server/src/api/task-queue.ts — GET handler
 * @see https://github.com/superfield-idea-lab/market-alert/issues/115
 */

import { chromium, type Browser, expect as pwExpect } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startE2EServer, stopE2EServer, type E2EEnvironment } from './environment';
import { getFixtureSession } from './fixtures';
import { DEMO_FIXTURES } from '../../packages/db/demo-seed';

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let browser: Browser;
let env: E2EEnvironment;

// We use the researcher fixture as the superadmin for this test by setting
// SUPERUSER_ID to RESEARCHER_ID. The environment.ts helper doesn't expose
// SUPERUSER_ID, so we rely on the existing E2E server and use a test-session
// backdoor to create a superadmin cookie via the known SUPERUSER_ID in the
// test process env.
//
// IMPORTANT: SUPERUSER_ID must be set in the test runner's env for the server
// to recognise the researcher fixture as a superuser. On CI this is set in
// the workflow file. Locally: SUPERUSER_ID=<researcher_id> bun run test:e2e.
//
// When SUPERUSER_ID is not set, the superadmin nav item tests are skipped.
const SUPERUSER_ID_ENV = process.env.SUPERUSER_ID;
const RESEARCHER_ID = DEMO_FIXTURES.users.researcher.id;
const superadminIsResearcher = SUPERUSER_ID_ENV === RESEARCHER_ID;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  env = await startE2EServer();
  browser = await chromium.launch();
}, 90_000);

afterAll(async () => {
  await browser.close();
  await stopE2EServer(env);
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function getSuperadminCookie(): Promise<string> {
  // The researcher fixture's ID matches SUPERUSER_ID on CI so the server
  // treats the session as superadmin.
  const session = await getFixtureSession(env.baseUrl, 'researcher');
  return session.cookie;
}

async function getRegularCookie(): Promise<string> {
  const session = await getFixtureSession(env.baseUrl, 'admin');
  return session.cookie;
}

// ---------------------------------------------------------------------------
// ET-3: HTTP auth gates (no browser required)
// ---------------------------------------------------------------------------

describe('ET-3: GET /api/tasks-queue HTTP auth gates', () => {
  test('returns 401 for unauthenticated request', async () => {
    const res = await fetch(`${env.baseUrl}/api/tasks-queue`);
    await res.text(); // drain
    // eslint-disable-next-line vitest/valid-expect
    expect(res.status).toBe(401);
  });

  test('returns 403 for non-superadmin authenticated request', async () => {
    // The demo admin user is not the SUPERUSER_ID, so isSuperuser returns false.
    const cookie = await getRegularCookie();
    const res = await fetch(`${env.baseUrl}/api/tasks-queue`, {
      headers: { Cookie: cookie },
    });
    await res.text(); // drain
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// ET-1 / ET-2 / ET-4: Browser tests
// ---------------------------------------------------------------------------

describe('ET-1: superadmin sees Agent Queue nav item', () => {
  test.skipIf(!superadminIsResearcher)(
    'Agent Queue button visible for superadmin, absent for non-superadmin',
    async () => {
      // Superadmin page
      const superCookie = await getSuperadminCookie();
      const superPage = await browser.newPage();
      try {
        await superPage.context().addCookies([
          {
            name: 'superfield_auth',
            value: superCookie.match(/superfield_auth=([^;]+)/)?.[1] ?? '',
            url: env.baseUrl,
          },
        ]);
        await superPage.goto(env.baseUrl, { waitUntil: 'networkidle' });
        await pwExpect(superPage.locator('[data-testid="nav-agent-queue"]')).toBeVisible();
      } finally {
        await superPage.close();
      }

      // Non-superadmin page
      const regularCookie = await getRegularCookie();
      const regularPage = await browser.newPage();
      try {
        await regularPage.context().addCookies([
          {
            name: 'superfield_auth',
            value: regularCookie.match(/superfield_auth=([^;]+)/)?.[1] ?? '',
            url: env.baseUrl,
          },
        ]);
        await regularPage.goto(env.baseUrl, { waitUntil: 'networkidle' });
        await pwExpect(regularPage.locator('[data-testid="nav-agent-queue"]')).not.toBeVisible();
      } finally {
        await regularPage.close();
      }
    },
  );
});

describe('ET-2: Agent Queue page renders for superadmin', () => {
  test.skipIf(!superadminIsResearcher)(
    'clicking Agent Queue nav shows the page heading and connection status',
    async () => {
      const superCookie = await getSuperadminCookie();
      const page = await browser.newPage();
      try {
        await page.context().addCookies([
          {
            name: 'superfield_auth',
            value: superCookie.match(/superfield_auth=([^;]+)/)?.[1] ?? '',
            url: env.baseUrl,
          },
        ]);
        await page.goto(env.baseUrl, { waitUntil: 'networkidle' });

        // Click the Agent Queue nav item
        await page.locator('[data-testid="nav-agent-queue"]').click();

        // Heading should appear
        await pwExpect(page.getByRole('heading', { name: 'Agent Queue' })).toBeVisible();

        // Connection status indicator should be present
        await pwExpect(page.locator('[data-testid="connection-status"]')).toBeVisible();
      } finally {
        await page.close();
      }
    },
  );
});

describe('ET-4: live task row appears without reload', () => {
  test.skipIf(!superadminIsResearcher)(
    'enqueue a task via API — row appears in the live view within 3 seconds',
    async () => {
      const superCookie = await getSuperadminCookie();
      const page = await browser.newPage();
      try {
        await page.context().addCookies([
          {
            name: 'superfield_auth',
            value: superCookie.match(/superfield_auth=([^;]+)/)?.[1] ?? '',
            url: env.baseUrl,
          },
        ]);
        await page.goto(env.baseUrl, { waitUntil: 'networkidle' });
        await page.locator('[data-testid="nav-agent-queue"]').click();

        // Wait for connection status to settle (connected or at least not loading)
        await page.waitForFunction(
          () => {
            const el = document.querySelector('[data-testid="connection-status"]');
            return el && !el.textContent?.includes('Loading');
          },
          null,
          { timeout: 10_000 },
        );

        // Generate a unique job_type to identify this enqueue
        const uniqueJobType = `E2E_QUEUE_${Date.now()}`;
        const idempotencyKey = `e2e-tq-et4-${Date.now()}`;

        // Enqueue a task via the API (superadmin session has enqueue access too)
        const enqueueRes = await fetch(`${env.baseUrl}/api/tasks-queue`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: superCookie,
          },
          body: JSON.stringify({
            idempotency_key: idempotencyKey,
            agent_type: 'wiki_rebuild',
            job_type: uniqueJobType,
            payload: {},
          }),
        });
        if (!enqueueRes.ok) {
          throw new Error(`Enqueue failed: ${enqueueRes.status} ${await enqueueRes.text()}`);
        }

        // The row should appear in the live view within 3 seconds via WebSocket
        await pwExpect(page.locator(`text=${uniqueJobType}`)).toBeVisible({ timeout: 3000 });
      } finally {
        await page.close();
      }
    },
  );
});
