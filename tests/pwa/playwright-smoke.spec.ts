import { expect, test } from '@playwright/test';

test('PWA smoke test loads the app shell', async ({ page }, testInfo) => {
  await page.goto('/');

  if (testInfo.project.name === 'desktop-chrome') {
    // The app uses passkey-only auth — no password field. Verify the login
    // screen renders by checking the app heading and auth subtitle.
    await expect(page.getByRole('heading', { name: 'Superfield', exact: true })).toBeVisible();
    await expect(page.getByText('Sign in with your passkey')).toBeVisible();
    return;
  }

  await expect(page.getByRole('heading', { name: 'Instantly Install Mobile App' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Maybe later', exact: true })).toBeVisible();
});
