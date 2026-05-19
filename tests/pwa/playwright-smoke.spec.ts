import { expect, test } from '@playwright/test';

test('PWA smoke test loads the app shell', async ({ page }) => {
  await page.goto('/');

  // The app uses passkey-only auth — no password field. Verify the login
  // screen renders by checking the app heading and auth subtitle.
  await expect(page.getByRole('heading', { name: 'Superfield', exact: true })).toBeVisible();
  await expect(page.getByText('Sign in with your passkey')).toBeVisible();
});
