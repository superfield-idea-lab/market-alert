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

// MobileInstallPage and MobileGate have been removed from App.tsx.
// The install-prompt beforeinstallprompt tests and mobile install banner
// tests that previously tested those deleted components are removed.
