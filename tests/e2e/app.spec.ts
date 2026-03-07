import { test, expect } from '@playwright/test';

test('prototype workflow test', async ({ page }) => {
    // Navigate to the root (which is served by the Bun server serving apps/web/dist/index.html)
    await page.goto('/');

    // 1. Verify the layout renders correctly
    await expect(page.locator('text=Weekly Recap Draft')).toBeVisible();
    await expect(page.locator('text=News Feeds')).toBeVisible();
    await expect(page.locator('button', { hasText: 'Yahoo' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Bloomberg' })).toBeVisible();

    // 2. Test the Draft Editor synopsis input
    const textarea = page.locator('textarea');
    await textarea.fill('Testing the AI synopsis generator...');
    await expect(textarea).toHaveValue('Testing the AI synopsis generator...');

    // 3. Test the Export to Substack modal
    await page.locator('button', { hasText: 'Export to Substack' }).click();
    await expect(page.locator('text=Preview Export')).toBeVisible();
    await expect(page.locator('button', { hasText: 'Copy HTML Source' })).toBeVisible();

    // Close modal
    await page.locator('button.text-gray-400').click();
    await expect(page.locator('text=Preview Export')).toBeHidden();
});
