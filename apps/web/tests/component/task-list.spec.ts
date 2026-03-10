import { test, expect } from '@playwright/test';

// Shared login helper — registers a fresh user and returns to the app shell
async function loginAsNewUser(page: import('@playwright/test').Page) {
  await page.goto('/');
  const username = `component_${Date.now()}`;
  await page.getByRole('button', { name: 'Need an account? Register' }).click();
  await page.getByPlaceholder('e.g. KaraSwisher').fill(username);
  await page.getByPlaceholder('••••••••').fill('testpass123');
  await page.getByRole('button', { name: 'Create Account' }).click();
  await expect(page.getByRole('heading', { name: 'Main Project' })).toBeVisible({
    timeout: 15000,
  });
}

test('TaskListView renders the correct column headers', async ({ page }) => {
  await loginAsNewUser(page);

  // The task table is visible (even when empty it renders the header row)
  // Trigger "New Task" to ensure the table is shown (empty state also valid)
  // Column headers are always rendered once a task exists — create one first
  await page.getByRole('button', { name: 'New Task' }).first().click();
  await page.getByPlaceholder('Task name').fill('Header check task');
  await page.getByRole('button', { name: 'Create Task' }).click();

  await expect(page.getByRole('columnheader', { name: /name/i })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /owner/i })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /priority/i })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /status/i })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /due/i })).toBeVisible();
});

test('TaskListView creates a task via the New Task modal', async ({ page }) => {
  await loginAsNewUser(page);

  await page.getByRole('button', { name: 'New Task' }).first().click();

  // Modal is visible
  await expect(page.getByRole('heading', { name: 'New Task' })).toBeVisible();

  // Fill and submit
  await page.getByPlaceholder('Task name').fill('My first task');
  await page.getByPlaceholder('Username').fill('alice');
  await page.getByRole('button', { name: 'Create Task' }).click();

  // Task appears in the list
  await expect(page.getByRole('cell', { name: 'My first task' })).toBeVisible();
});

test('TaskListView cycles task status on click', async ({ page }) => {
  await loginAsNewUser(page);

  // Create a task
  await page.getByRole('button', { name: 'New Task' }).first().click();
  await page.getByPlaceholder('Task name').fill('Status cycle task');
  await page.getByRole('button', { name: 'Create Task' }).click();
  await expect(page.getByRole('cell', { name: 'Status cycle task' })).toBeVisible();

  // Initial status is "todo"
  const statusBadge = page.getByRole('button', { name: 'todo' });
  await expect(statusBadge).toBeVisible();

  // Click once → in progress
  await statusBadge.click();
  await expect(page.getByRole('button', { name: 'in progress' })).toBeVisible();

  // Click again → done
  await page.getByRole('button', { name: 'in progress' }).click();
  await expect(page.getByRole('button', { name: 'done' })).toBeVisible();
});
