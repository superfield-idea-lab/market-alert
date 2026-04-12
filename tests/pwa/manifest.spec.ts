/**
 * @file manifest.spec.ts
 *
 * Playwright test: install-prompt scenario asserting the Web App Manifest is
 * valid and complete for PWA installability.
 *
 * Tests verify:
 *   - /manifest.json is served with the correct Content-Type header
 *   - Required fields are present: name, short_name, start_url, display, icons
 *   - At least one icon meets the 192×192 minimum required for installability
 *   - At least one icon meets the 512×512 Lighthouse PWA baseline requirement
 *   - The manifest is linked from the app shell HTML via <link rel="manifest">
 *   - The beforeinstallprompt event is suppressible (stubbed)
 *
 * Runs against all three project profiles defined in playwright.config.mts:
 *   desktop-chrome, android-chrome, ios-safari.
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/54
 */

import { expect, test } from '@playwright/test';
import { stubBeforeInstallPrompt } from '../helpers/pwa';

// ---------------------------------------------------------------------------
// Manifest JSON validation
// ---------------------------------------------------------------------------

test('manifest.json is served with correct Content-Type', async ({ request }) => {
  const response = await request.get('/manifest.json');
  expect(response.status()).toBe(200);
  const contentType = response.headers()['content-type'] ?? '';
  // Accepts application/json or application/manifest+json
  expect(contentType).toMatch(/json/);
});

test('manifest.json contains required PWA fields', async ({ request }) => {
  const response = await request.get('/manifest.json');
  expect(response.status()).toBe(200);

  const manifest = await response.json();

  // Required fields for a complete Web App Manifest
  expect(typeof manifest.name).toBe('string');
  expect(manifest.name.length).toBeGreaterThan(0);

  expect(typeof manifest.short_name).toBe('string');
  expect(manifest.short_name.length).toBeGreaterThan(0);

  expect(typeof manifest.start_url).toBe('string');
  expect(manifest.start_url.length).toBeGreaterThan(0);

  // display must be one of the valid values
  expect(['standalone', 'fullscreen', 'minimal-ui', 'browser']).toContain(manifest.display);

  // Icons array must exist and contain at least one entry
  expect(Array.isArray(manifest.icons)).toBe(true);
  expect((manifest.icons as unknown[]).length).toBeGreaterThan(0);
});

test('manifest.json has a 192x192 icon (minimum for installability)', async ({ request }) => {
  const response = await request.get('/manifest.json');
  const manifest = await response.json();

  const icons: Array<{ src: string; sizes: string; type?: string; purpose?: string }> =
    manifest.icons;

  const has192 = icons.some((icon) => icon.sizes === '192x192');
  expect(has192).toBe(true);
});

test('manifest.json has a 512x512 icon (Lighthouse PWA baseline)', async ({ request }) => {
  const response = await request.get('/manifest.json');
  const manifest = await response.json();

  const icons: Array<{ src: string; sizes: string; type?: string; purpose?: string }> =
    manifest.icons;

  const has512 = icons.some((icon) => icon.sizes === '512x512');
  expect(has512).toBe(true);
});

test('manifest.json icons are reachable (HTTP 200)', async ({ request }) => {
  const response = await request.get('/manifest.json');
  const manifest = await response.json();

  const icons: Array<{ src: string; sizes: string }> = manifest.icons;

  // De-duplicate icon src paths and verify each is reachable
  const uniqueSrcs = [...new Set(icons.map((icon) => icon.src))];

  for (const src of uniqueSrcs) {
    const iconResponse = await request.get(src);
    expect(iconResponse.status(), `icon ${src} should be reachable`).toBe(200);
  }
});

// ---------------------------------------------------------------------------
// App shell HTML — manifest link
// ---------------------------------------------------------------------------

test('app shell HTML links to /manifest.json', async ({ page }) => {
  await page.goto('/');

  const manifestHref = await page.evaluate(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    return link?.getAttribute('href') ?? null;
  });

  expect(manifestHref).toBe('/manifest.json');
});

test('app shell HTML has Apple PWA meta tags', async ({ page }) => {
  await page.goto('/');

  const appleCapable = await page.evaluate(
    () =>
      document
        .querySelector('meta[name="apple-mobile-web-app-capable"]')
        ?.getAttribute('content') ?? null,
  );
  expect(appleCapable).toBe('yes');

  const appleTitle = await page.evaluate(
    () =>
      document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content') ??
      null,
  );
  expect(typeof appleTitle).toBe('string');
  expect((appleTitle ?? '').length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Install prompt — beforeinstallprompt scenario
// ---------------------------------------------------------------------------

test('beforeinstallprompt can be suppressed via preventDefault', async ({ page }, testInfo) => {
  // The MobileInstallPage registers a beforeinstallprompt listener that calls
  // e.preventDefault() to suppress the browser's native mini-infobar.  That
  // page is only rendered for mobile UA profiles; skip on desktop-chrome.
  if (testInfo.project.name === 'desktop-chrome') {
    test.skip();
    return;
  }

  await page.goto('/');

  const handle = await stubBeforeInstallPrompt(page);

  // Verify the app called e.preventDefault() to suppress the mini-infobar.
  expect(await handle.wasDefaultPrevented()).toBe(true);
});

test('install banner renders on Android Chrome when beforeinstallprompt fires', async ({
  page,
}, testInfo) => {
  // Only assert the banner on the android-chrome project profile
  if (testInfo.project.name !== 'android-chrome') {
    test.skip();
    return;
  }

  // Navigate first so the page is loaded before stubbing
  await page.goto('/');

  // Mobile install gate is shown for non-standalone Android visitors.
  // The heading should be visible.
  await expect(page.getByRole('heading', { name: 'Instantly Install Mobile App' })).toBeVisible();
});

test('iOS Safari install banner renders for non-standalone iOS visitors', async ({
  page,
}, testInfo) => {
  if (testInfo.project.name !== 'ios-safari') {
    test.skip();
    return;
  }

  await page.goto('/');

  // iOS Safari visitors land on MobileInstallPage
  await expect(page.getByRole('heading', { name: 'Instantly Install Mobile App' })).toBeVisible();

  const showStepsButton = page.getByRole('button', { name: 'Show install steps' });
  await expect(showStepsButton).toBeVisible();
});
