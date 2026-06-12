/**
 * @file logout.spec.ts
 *
 * End-to-end tests for the user logout flow.
 *
 * Boots the full stack with DEMO_MODE=true, logs in as the demo researcher
 * (account_manager role) via the quick-login button, then clicks the logout
 * button in the sidebar and verifies:
 *
 *   1. The browser returns to the login page.
 *   2. A subsequent authenticated request to GET /api/signals returns 401,
 *      confirming the session cookie was revoked server-side.
 *
 * Uses a real Playwright browser against a real Postgres + Bun server.
 * No mocks. No vi.fn / vi.mock / vi.spyOn.
 *
 * @see demo-login.spec.ts  — pattern reference for startDemoServer / DEMO_FIXTURES
 * @see apps/web/src/App.tsx:119 — logout button (rounded-full User icon button)
 * @see apps/server/src/api/auth.ts — POST /api/auth/logout implementation
 */

import { chromium, type Browser, expect as playwrightExpect } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startE2EServer, stopE2EServer, type E2EEnvironment } from './environment';
import { DEMO_FIXTURES } from './fixtures';

let browser: Browser;
let env: E2EEnvironment;

beforeAll(async () => {
  env = await startE2EServer();
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser.close();
  await stopE2EServer(env);
});

describe('user logout flow', () => {
  it('POST /api/auth/logout clears the session cookie', async () => {
    // Obtain a session cookie for the demo researcher via /api/demo/session.
    const sessionRes = await fetch(`${env.baseUrl}/api/demo/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: DEMO_FIXTURES.users.researcher.id }),
    });
    expect(sessionRes.status).toBe(200);

    const setCookieHeader = sessionRes.headers.get('set-cookie') ?? '';
    const match = /superfield_auth=([^;]+)/.exec(setCookieHeader);
    const authCookie = match ? `superfield_auth=${match[1]}` : '';
    expect(authCookie).toBeTruthy();

    // Confirm the session is valid: GET /api/signals should return 200.
    const beforeLogout = await fetch(`${env.baseUrl}/api/signals`, {
      headers: { Cookie: authCookie },
    });
    expect(beforeLogout.status).toBe(200);

    // Call the logout endpoint directly.
    const logoutRes = await fetch(`${env.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: authCookie },
    });
    expect(logoutRes.status).toBe(200);

    // After logout the same token should be revoked; GET /api/signals returns 401.
    const afterLogout = await fetch(`${env.baseUrl}/api/signals`, {
      headers: { Cookie: authCookie },
    });
    expect(afterLogout.status).toBe(401);
  });

  it('clicking the logout button returns the browser to the login page', async () => {
    const page = await browser.newPage();
    try {
      // Navigate to the app; the login page should be shown initially.
      await page.goto(env.baseUrl, { waitUntil: 'networkidle' });

      // Verify the login page is visible (quick-login button for Account Manager
      // maps to the demo researcher fixture whose role is account_manager).
      const loginBtn = page.getByRole('button', { name: 'Sign in as Account Manager' });
      await playwrightExpect(loginBtn).toBeVisible();

      // Click the demo quick-login button to authenticate as the researcher.
      await loginBtn.click();

      // Wait for the authenticated app shell to mount.  The login page
      // disappears once the passkey button is no longer in the DOM.
      await page.waitForFunction(
        () => {
          const passkeyBtn = document.querySelector('button[aria-label="Sign in with a passkey"]');
          const loginHeading = Array.from(document.querySelectorAll('h1')).find(
            (el) => el.textContent?.trim() === 'Superfield' && el.closest('.min-h-screen'),
          );
          return !passkeyBtn && !loginHeading;
        },
        { timeout: 15_000 },
      );

      // Confirm signal feed or main nav is visible — the alerts nav button is
      // rendered only in the authenticated app shell.
      const alertsNav = page.locator('[data-testid="nav-alerts"]');
      await playwrightExpect(alertsNav).toBeVisible();

      // Locate the logout button — the rounded-full User icon button at the
      // bottom of the sidebar (App.tsx:119).  It is the only `rounded-full`
      // button inside the <nav> element.
      const logoutBtn = page.locator('nav button.rounded-full');
      await playwrightExpect(logoutBtn).toBeVisible();

      // Capture the session cookie from the browser before logout so we can
      // probe the API after the browser has cleared its cookie jar.
      const cookies = await page.context().cookies();
      const authCookieEntry = cookies.find(
        (c: { name: string; value: string }) => c.name === 'superfield_auth',
      );
      const rawCookieValue = authCookieEntry ? `superfield_auth=${authCookieEntry.value}` : '';

      // Click logout.
      await logoutBtn.click();

      // Assert the login page is now visible.  We wait for the passkey sign-in
      // button (or its text) to reappear, which signals that the React root has
      // remounted the <Login /> component.
      await playwrightExpect(page.getByText(/Sign in with your passkey/i)).toBeVisible({
        timeout: 10_000,
      });

      // The authenticated shell (nav-alerts) should no longer be present.
      await playwrightExpect(alertsNav).not.toBeVisible();

      // If we captured a cookie value before logout, verify the token is now
      // revoked server-side: a direct fetch with the old cookie must return 401.
      if (rawCookieValue) {
        const probeRes = await fetch(`${env.baseUrl}/api/signals`, {
          headers: { Cookie: rawCookieValue },
        });
        expect(probeRes.status).toBe(401);
      }
    } finally {
      await page.close();
    }
  }, 60_000);
});
