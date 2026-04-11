/**
 * @file full.spec.ts
 *
 * Full end-to-end smoke tests using a real Playwright browser against the
 * full-stack environment (real Postgres + real Bun server + compiled web app).
 *
 * These tests verify the passkey-only auth UI introduced in issue #14.
 * Password form fields are intentionally absent; the login page shows only
 * the "Sign in with a passkey" button and a toggle to switch to registration.
 */
import { chromium, type Browser, expect as playwrightExpect } from '@playwright/test';
import { afterAll, beforeAll, expect as vitestExpect, test } from 'vitest';
import { startE2EServer, stopE2EServer, type E2EEnvironment } from './environment';

const INVALID_ERROR_PATTERNS = ['favicon', '401', 'Unauthorized'];

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

function isExpectedError(msg: string) {
  return INVALID_ERROR_PATTERNS.some((pattern) => msg.includes(pattern));
}

test('app loads and shows passkey login screen', async () => {
  const consoleErrors: string[] = [];
  const page = await browser.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto(env.baseUrl, { waitUntil: 'networkidle' });

  await playwrightExpect(page.getByRole('heading', { name: 'Calypso' })).toBeVisible();
  // Passkey-only UI: no password field
  await playwrightExpect(page.getByPlaceholder('••••••••')).not.toBeVisible();
  // "Sign in with a passkey" button visible in login mode
  await playwrightExpect(
    page.getByRole('button', { name: 'Sign in with a passkey' }),
  ).toBeVisible();
  vitestExpect(consoleErrors.filter((e) => !isExpectedError(e))).toHaveLength(0);

  await page.close();
});

test('register toggle shows username field and passkey register button', async () => {
  const consoleErrors: string[] = [];
  const page = await browser.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto(env.baseUrl, { waitUntil: 'networkidle' });

  // Switch to register mode
  await page.getByRole('button', { name: 'Need an account? Register' }).click();

  // Username field should be visible, no password field
  await playwrightExpect(page.getByPlaceholder('e.g. yourname')).toBeVisible();
  await playwrightExpect(page.getByPlaceholder('••••••••')).not.toBeVisible();
  // Register passkey button visible
  await playwrightExpect(
    page.getByRole('button', { name: 'Register with a passkey' }),
  ).toBeVisible();
  vitestExpect(consoleErrors.filter((e) => !isExpectedError(e))).toHaveLength(0);

  await page.close();
});
