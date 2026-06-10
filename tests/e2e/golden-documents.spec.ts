/**
 * @file golden-documents.spec.ts
 *
 * End-to-end tests for the Golden Documents UI lifecycle.
 *
 * Exercises the full researcher authoring surface:
 *   1. Create a new industry_definition document via the UI
 *   2. Save a section (section_key + content)
 *   3. Activate the document — verify state badge transitions to 'active'
 *   4. Retire the document — verify state badge transitions to 'retired'
 *
 * Boots a real Postgres container and Bun server via startE2EServer (DEMO_MODE=true,
 * CSRF_DISABLED=true). Authenticates as the demo researcher using the fixture session
 * helper. No mocks — real browser (Playwright Chromium) against real API.
 *
 * ## Canonical docs
 * - docs/prd.md §6, §9 — golden documents are author-only forever.
 *
 * @see tests/e2e/environment.ts  — startE2EServer / stopE2EServer
 * @see tests/e2e/fixtures.ts     — getFixtureSession / DEMO_FIXTURES
 * @see apps/web/src/pages/golden-documents.tsx — UI under test
 * @see apps/server/src/api/golden-documents.ts  — API under test
 */

import { chromium, type Browser, expect as playwrightExpect } from '@playwright/test';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { startE2EServer, stopE2EServer, type E2EEnvironment } from './environment';
import { getFixtureSession } from './fixtures';

let browser: Browser;
let env: E2EEnvironment;

// Allow enough time for the web asset build + Postgres container startup.
const SETUP_TIMEOUT_MS = 120_000;

beforeAll(async () => {
  env = await startE2EServer();
  browser = await chromium.launch();
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await browser.close();
  await stopE2EServer(env);
}, SETUP_TIMEOUT_MS);

// ---------------------------------------------------------------------------
// Helper: open a browser page already authenticated as the demo researcher.
// ---------------------------------------------------------------------------

async function openResearcherPage() {
  const session = await getFixtureSession(env.baseUrl, 'researcher');
  const page = await browser.newPage();
  // Inject the session cookie so the server treats this page load as the demo
  // researcher — same mechanism as researcher-wiki.spec.ts.
  await page.context().addCookies([
    {
      name: 'superfield_auth',
      value: session.cookie.match(/superfield_auth=([^;]+)/)?.[1] ?? '',
      url: env.baseUrl,
    },
  ]);
  return page;
}

// ---------------------------------------------------------------------------
// Helper: navigate to the Golden Documents page from the authenticated shell.
// ---------------------------------------------------------------------------

async function navigateToGoldenDocuments(
  page: Awaited<ReturnType<typeof openResearcherPage>>,
): Promise<void> {
  await page.goto(env.baseUrl, { waitUntil: 'networkidle' });

  // Confirm we are authenticated (login page is gone).
  await playwrightExpect(
    page.getByRole('button', { name: 'Sign in with a passkey' }),
  ).not.toBeVisible();

  // Click the Golden Documents nav button in the sidebar.
  const navBtn = page.getByTitle('Golden Documents');
  await playwrightExpect(navBtn).toBeVisible({ timeout: 8_000 });
  await navBtn.click();

  // The list view heading should now be visible.
  await playwrightExpect(page.getByRole('heading', { name: 'Golden Documents' })).toBeVisible({
    timeout: 8_000,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('golden documents — UI lifecycle', () => {
  /**
   * Full lifecycle test: create → section edit → activate → retire.
   *
   * Written as a single sequential test to avoid re-booting the stack between
   * state transitions. The title includes a timestamp to prevent collision with
   * the pre-seeded fixture documents.
   */
  test('create, section edit, activate, and retire a golden document via the UI', async () => {
    const page = await openResearcherPage();
    try {
      await navigateToGoldenDocuments(page);

      // ----------------------------------------------------------------
      // Step 1: Open the create form
      // ----------------------------------------------------------------
      const createBtn = page.getByTestId('golden-documents-create-btn');
      await playwrightExpect(createBtn).toBeVisible();
      await createBtn.click();

      // The create form should now be visible.
      await playwrightExpect(
        page.getByRole('heading', { name: 'Create new golden document' }),
      ).toBeVisible({ timeout: 5_000 });

      // ----------------------------------------------------------------
      // Step 2: Select type = industry_definition and fill in a title
      // ----------------------------------------------------------------
      const titleInput = page.getByPlaceholder('Document title');
      await playwrightExpect(titleInput).toBeVisible();

      // Select 'industry_definition' from the kind dropdown.
      await page.selectOption('select', 'industry_definition');

      const docTitle = `E2E Test Doc ${Date.now()}`;
      await titleInput.fill(docTitle);

      // ----------------------------------------------------------------
      // Step 3: Submit — click the "Create" button inside the form
      // ----------------------------------------------------------------
      await page.getByRole('button', { name: 'Create' }).click();

      // After creation the app navigates to the document detail view and the
      // list re-loads. The title should appear as a heading in the detail view.
      await playwrightExpect(page.getByRole('heading', { name: docTitle })).toBeVisible({
        timeout: 10_000,
      });

      // ----------------------------------------------------------------
      // Step 4: Navigate back to the list and verify the new document row
      // ----------------------------------------------------------------
      await page.getByRole('button', { name: 'Back' }).click();

      // Wait for the list to reload and the new document row to appear.
      const list = page.getByTestId('golden-documents-list');
      await playwrightExpect(list).toBeVisible({ timeout: 8_000 });

      // Find the new document row by its title text inside the list.
      const docRow = list.getByText(docTitle);
      await playwrightExpect(docRow).toBeVisible({ timeout: 8_000 });

      // ----------------------------------------------------------------
      // Step 5: Drill into the document — click the row item
      // ----------------------------------------------------------------
      // The row button wraps the title; click the containing button.
      await docRow.click();

      // Detail view should load — heading with the title is visible.
      await playwrightExpect(page.getByRole('heading', { name: docTitle })).toBeVisible({
        timeout: 8_000,
      });

      // ----------------------------------------------------------------
      // Step 6: Add a section
      // ----------------------------------------------------------------
      const sectionKeyInput = page.getByPlaceholder('section_key (e.g. overview)');
      await playwrightExpect(sectionKeyInput).toBeVisible({ timeout: 5_000 });
      await sectionKeyInput.fill('overview');

      const contentTextarea = page.getByPlaceholder('Section content (Markdown supported)');
      await playwrightExpect(contentTextarea).toBeVisible();
      await contentTextarea.fill('This is the overview content for the e2e test document.');

      await page.getByRole('button', { name: 'Save section' }).click();

      // After saving, the section key 'overview' should appear in the section list.
      await playwrightExpect(page.getByText('overview')).toBeVisible({ timeout: 8_000 });

      // ----------------------------------------------------------------
      // Step 7: Activate the document
      // ----------------------------------------------------------------
      await page.getByRole('button', { name: 'Activate' }).click();

      // After activation the state badge should show 'active'.
      // The StateChip renders the state as text inside a <span> in the header row.
      // We look for the 'active' chip text inside the main section (not the sidebar).
      await playwrightExpect(page.locator('main').getByText('active', { exact: true })).toBeVisible(
        { timeout: 10_000 },
      );

      // The Activate button should be gone (doc is already active).
      await playwrightExpect(page.getByRole('button', { name: 'Activate' })).not.toBeVisible();

      // ----------------------------------------------------------------
      // Step 8: Retire the document
      // ----------------------------------------------------------------
      await page.getByRole('button', { name: 'Retire' }).click();

      // After retirement the state badge should show 'retired'.
      await playwrightExpect(
        page.locator('main').getByText('retired', { exact: true }),
      ).toBeVisible({ timeout: 10_000 });

      // The Retire button should be gone (doc is already retired).
      await playwrightExpect(page.getByRole('button', { name: 'Retire' })).not.toBeVisible();
    } finally {
      await page.close();
    }
  }, 120_000); // Extended timeout: full stack boot + UI interactions take time.

  test('authenticated researcher sees the Golden Documents page with pre-seeded documents', async () => {
    const page = await openResearcherPage();
    try {
      await navigateToGoldenDocuments(page);

      // The list of documents should be visible (pre-seeded by DEMO fixtures).
      const list = page.getByTestId('golden-documents-list');
      await playwrightExpect(list).toBeVisible({ timeout: 8_000 });

      // The 'New document' create button should be present.
      await playwrightExpect(page.getByTestId('golden-documents-create-btn')).toBeVisible();
    } finally {
      await page.close();
    }
  });
});
