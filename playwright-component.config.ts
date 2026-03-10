import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './apps/web/tests/component',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['html', { open: 'never', outputFolder: 'playwright-report-component' }]],
  use: {
    baseURL: 'http://localhost:31415',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'bun run --filter web build && bun run apps/server/src/index.ts',
    url: 'http://localhost:31415',
    timeout: 60000,
    reuseExistingServer: !process.env.CI,
  },
});
