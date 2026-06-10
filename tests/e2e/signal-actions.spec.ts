/**
 * @file signal-actions.spec.ts
 *
 * End-to-end tests for signal action buttons (Acknowledge, Act, Dismiss).
 *
 * Boots the full stack with DEMO_MODE=true, authenticates as the demo researcher,
 * and exercises the complete click → PATCH /api/signals/:id/status → UI
 * state-change flow against a real Postgres + Bun server.
 *
 * Three distinct transitions are tested:
 *   - acknowledge: no status change; signal row remains visible
 *   - act:         no status change (Delivered stays Delivered); feed refreshes
 *   - dismiss:     Delivered → Suppressed; row disappears from the Delivered view
 *
 * No mocks — real Bun server + Postgres via the shared E2E environment.
 *
 * @see apps/server/src/api/signal-feed-api.ts   — PATCH /api/signals/:id/status
 * @see apps/web/src/pages/signal-feed.tsx        — data-testid attributes
 * @see packages/db/demo-seed.ts                  — fixture signal IDs
 * @see tests/e2e/fixtures.ts                     — getFixtureSession helper
 * @see docs/prd.md §4 — signal feed spec
 */

import { chromium, type Browser, expect as playwrightExpect } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startE2EServer, stopE2EServer, type E2EEnvironment } from './environment';
import { DEMO_FIXTURES, getFixtureSession } from './fixtures';

let env: E2EEnvironment;
let browser: Browser;

beforeAll(async () => {
  env = await startE2EServer();
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
  await stopE2EServer(env);
});

// ---------------------------------------------------------------------------
// API-level tests: PATCH /api/signals/:id/status
// These exercise the server directly without a browser, asserting that each
// action returns 200 and the correct status transition.
// ---------------------------------------------------------------------------

describe('signal actions — API (PATCH /api/signals/:id/status)', () => {
  it('seeded demo researcher has at least one Delivered signal', async () => {
    const session = await getFixtureSession(env.baseUrl, 'researcher');
    const res = await fetch(`${env.baseUrl}/api/signals`, {
      headers: { Cookie: session.cookie.split(';')[0] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      signals: Array<{ id: string; status: string }>;
    };
    const delivered = body.signals.filter((s) => s.status === 'Delivered');
    expect(delivered.length).toBeGreaterThanOrEqual(1);

    // The two canonical Delivered fixtures must be present.
    const ids = body.signals.map((s) => s.id);
    expect(ids).toContain(DEMO_FIXTURES.signals.readoutSignal.id);
    expect(ids).toContain(DEMO_FIXTURES.signals.btdSignal.id);
  });

  it('acknowledge returns 200 and signal status is unchanged', async () => {
    const session = await getFixtureSession(env.baseUrl, 'researcher');
    const signalId = DEMO_FIXTURES.signals.readoutSignal.id;

    const res = await fetch(`${env.baseUrl}/api/signals/${signalId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: session.cookie.split(';')[0],
      },
      body: JSON.stringify({ action: 'acknowledge' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      signal_id: string;
      status: string;
      action: string;
    };
    expect(body.signal_id).toBe(signalId);
    expect(body.action).toBe('acknowledge');
    // acknowledge does not change status — signal remains Delivered
    expect(body.status).toBe('Delivered');
  });

  it('act returns 200 and signal status remains Delivered', async () => {
    const session = await getFixtureSession(env.baseUrl, 'researcher');
    // Use btdSignal so dismiss test on readoutSignal stays independent
    const signalId = DEMO_FIXTURES.signals.btdSignal.id;

    const res = await fetch(`${env.baseUrl}/api/signals/${signalId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: session.cookie.split(';')[0],
      },
      body: JSON.stringify({ action: 'act' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      signal_id: string;
      status: string;
      action: string;
    };
    expect(body.signal_id).toBe(signalId);
    expect(body.action).toBe('act');
    // act does not change DB status yet (journal only) — Delivered stays Delivered
    expect(body.status).toBe('Delivered');
  });

  it('dismiss returns 200 and signal status transitions to Suppressed', async () => {
    const session = await getFixtureSession(env.baseUrl, 'researcher');
    // Use readoutSignal for dismiss — it starts as Delivered
    const signalId = DEMO_FIXTURES.signals.readoutSignal.id;

    const res = await fetch(`${env.baseUrl}/api/signals/${signalId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: session.cookie.split(';')[0],
      },
      body: JSON.stringify({ action: 'dismiss' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      signal_id: string;
      status: string;
      action: string;
    };
    expect(body.signal_id).toBe(signalId);
    expect(body.action).toBe('dismiss');
    expect(body.status).toBe('Suppressed');
  });

  it('dismissed signal no longer appears in GET /api/signals Delivered view', async () => {
    // readoutSignal was dismissed in the previous test; confirm it is filtered out
    const session = await getFixtureSession(env.baseUrl, 'researcher');
    const res = await fetch(`${env.baseUrl}/api/signals`, {
      headers: { Cookie: session.cookie.split(';')[0] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      signals: Array<{ id: string; status: string }>;
    };
    // The dismissed readoutSignal must not appear (its status is Suppressed,
    // which the feed query excludes — only Delivered and Generated are returned).
    const ids = body.signals.map((s) => s.id);
    expect(ids).not.toContain(DEMO_FIXTURES.signals.readoutSignal.id);
  });

  it('unknown action returns 400', async () => {
    const session = await getFixtureSession(env.baseUrl, 'researcher');
    const signalId = DEMO_FIXTURES.signals.btdSignal.id;

    const res = await fetch(`${env.baseUrl}/api/signals/${signalId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: session.cookie.split(';')[0],
      },
      body: JSON.stringify({ action: 'unknown' }),
    });

    expect(res.status).toBe(400);
  });

  it('unauthenticated PATCH returns 401', async () => {
    const signalId = DEMO_FIXTURES.signals.btdSignal.id;
    const res = await fetch(`${env.baseUrl}/api/signals/${signalId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'acknowledge' }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Browser-level tests: click action buttons in the signal feed UI
// These confirm that clicking the data-testid buttons fires the PATCH call
// and the UI reacts correctly (row stays visible or disappears).
// ---------------------------------------------------------------------------

/**
 * Injects the researcher fixture session into the browser context and
 * navigates to the signal feed page.
 */
async function openSignalFeed(
  page: Awaited<ReturnType<Browser['newPage']>>,
  cookie: string,
): Promise<void> {
  const cookieValue = cookie.match(/superfield_auth=([^;]+)/)?.[1] ?? '';
  await page.context().addCookies([
    {
      name: 'superfield_auth',
      value: cookieValue,
      url: env.baseUrl,
    },
  ]);
  await page.goto(env.baseUrl, { waitUntil: 'networkidle' });
}

describe('signal actions — browser (Playwright)', () => {
  it('signal feed loads and shows at least one signal row', async () => {
    const session = await getFixtureSession(env.baseUrl, 'researcher');
    const page = await browser.newPage();
    try {
      await openSignalFeed(page, session.cookie);

      // The signal feed table should be visible.
      const table = page.getByTestId('signal-feed-table');
      await playwrightExpect(table).toBeVisible({ timeout: 10_000 });

      // At least one signal row should be present.
      const firstRow = page.locator('[data-testid^="signal-row-"]').first();
      await playwrightExpect(firstRow).toBeVisible({ timeout: 10_000 });
    } finally {
      await page.close();
    }
  });

  it('clicking Acknowledge button leaves the signal row visible', async () => {
    // btdSignal is Delivered and has not been dismissed — safe to acknowledge.
    const signalId = DEMO_FIXTURES.signals.btdSignal.id;
    const session = await getFixtureSession(env.baseUrl, 'researcher');
    const page = await browser.newPage();
    try {
      await openSignalFeed(page, session.cookie);

      // Wait for the signal row to be present.
      const row = page.getByTestId(`signal-row-${signalId}`);
      await playwrightExpect(row).toBeVisible({ timeout: 10_000 });

      // Click the Acknowledge button.
      const acknowledgeBtn = page.getByTestId(`acknowledge-${signalId}`);
      await playwrightExpect(acknowledgeBtn).toBeVisible({ timeout: 5_000 });
      await acknowledgeBtn.click();

      // After acknowledging, the row must still be visible (no status change).
      await playwrightExpect(row).toBeVisible({ timeout: 10_000 });

      // No error state should appear.
      await playwrightExpect(page.getByText(/error/i)).not.toBeVisible();
    } finally {
      await page.close();
    }
  });

  it('clicking Act button on a Delivered signal keeps the row visible and the feed reloads', async () => {
    // btdSignal is Delivered — act keeps the status Delivered (journal only).
    const signalId = DEMO_FIXTURES.signals.btdSignal.id;
    const session = await getFixtureSession(env.baseUrl, 'researcher');
    const page = await browser.newPage();
    try {
      await openSignalFeed(page, session.cookie);

      const row = page.getByTestId(`signal-row-${signalId}`);
      await playwrightExpect(row).toBeVisible({ timeout: 10_000 });

      const actBtn = page.getByTestId(`act-${signalId}`);
      await playwrightExpect(actBtn).toBeVisible({ timeout: 5_000 });
      await actBtn.click();

      // Row should remain visible after act (status stays Delivered).
      await playwrightExpect(row).toBeVisible({ timeout: 10_000 });

      // No error state.
      await playwrightExpect(page.getByText(/error/i)).not.toBeVisible();
    } finally {
      await page.close();
    }
  });

  it('clicking Dismiss button removes the signal row from the Delivered feed', async () => {
    // btdSignal starts Delivered — dismiss transitions it to Suppressed.
    // (readoutSignal was already dismissed in the API tests above.)
    const signalId = DEMO_FIXTURES.signals.btdSignal.id;
    const session = await getFixtureSession(env.baseUrl, 'researcher');
    const page = await browser.newPage();
    try {
      await openSignalFeed(page, session.cookie);

      const row = page.getByTestId(`signal-row-${signalId}`);
      await playwrightExpect(row).toBeVisible({ timeout: 10_000 });

      const dismissBtn = page.getByTestId(`dismiss-${signalId}`);
      await playwrightExpect(dismissBtn).toBeVisible({ timeout: 5_000 });
      await dismissBtn.click();

      // After dismiss the row must disappear from the Delivered feed.
      await playwrightExpect(row).not.toBeVisible({ timeout: 10_000 });
    } finally {
      await page.close();
    }
  });
});
