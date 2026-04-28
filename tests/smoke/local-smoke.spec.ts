/**
 * @file local-smoke.spec.ts
 *
 * Smoke checks against an externally-booted demo cluster (started via
 * `bun run demo --no-tunnel`). Reads the cluster URL from SMOKE_BASE_URL.
 *
 * The goal is to catch the failure mode that pure code-level e2e cannot:
 * the deployed image, the Kubernetes manifests, env vars, demo seeding, and
 * the static web bundle all wired together as a real user would hit them.
 */
import { chromium, type Browser, expect as playwrightExpect } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE_URL = process.env.SMOKE_BASE_URL;
if (!BASE_URL) {
  throw new Error('SMOKE_BASE_URL must be set (e.g. http://localhost:31480)');
}

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

describe('local demo smoke', () => {
  it('GET /health/live returns 200', async () => {
    const res = await fetch(`${BASE_URL}/health/live`);
    expect(res.status).toBe(200);
  });

  it('GET /api/demo/users returns the seeded demo roles', async () => {
    const res = await fetch(`${BASE_URL}/api/demo/users`);
    expect(res.status).toBe(200);
    const users = (await res.json()) as Array<{ role: string }>;
    expect(Array.isArray(users)).toBe(true);
    const roles = users.map((u) => u.role);
    expect(roles).toContain('account_manager');
    expect(roles).toContain('supervisor');
  });

  it('login page renders "Sign in as" buttons in DEMO_MODE', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(BASE_URL, { waitUntil: 'networkidle' });
      const signInButtons = page.getByRole('button', { name: /^Sign in as / });
      await playwrightExpect(signInButtons.first()).toBeVisible();
    } finally {
      await page.close();
    }
  });
});
