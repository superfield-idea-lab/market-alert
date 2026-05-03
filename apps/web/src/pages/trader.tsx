/**
 * @file trader — apps/web trader alert feed page
 *
 * ## Phase 0 — Scaffolding & infrastructure (dev-scout)
 *
 * Empty stub for the trader-facing alert route. Establishes the page module
 * boundary and documents the integration surface before Phase 2 implements
 * the real alert feed UI.
 *
 * ## Canonical docs
 * - docs/plan.md § Phase 0 acceptance criteria: "apps/web … [has] a distinct
 *   entry point and build config"
 * - docs/prd.md § Trader role — receives enriched alerts via WebSocket
 *
 * ## Integration points discovered
 * - Alert feed subscribes to the WebSocket path /ws/alerts (Phase 2 endpoint).
 *   The apps/server WebSocket handler in src/websocket.ts must accept
 *   'alerts' as a valid channel name before this page goes live.
 * - TanStack Query is the planned cache layer for the alert list (GET
 *   /api/alerts). MSW fixtures under tests/fixtures/ must be recorded before
 *   the first real network call is made in tests.
 * - Phase 1 auth guard: the trader session must be established before the
 *   alert feed route is accessible. Unauthenticated requests redirect to /login.
 *
 * ## Risks captured
 * - WebSocket reconnect on network failure must be handled client-side; the
 *   server does not buffer missed events. Missed-event recovery relies on
 *   GET /api/alerts polling as the fallback path.
 * - Sub-second latency assertion (merge gate) requires a real Playwright
 *   browser test — cannot be met with vitest-browser-react alone.
 */

import React from 'react';

/**
 * TraderPage — Phase 0 stub.
 *
 * Renders a placeholder that documents the future alert feed UI.
 * No data fetching, no WebSocket — safe to render without a running server.
 */
export default function TraderPage(): React.ReactElement {
  return (
    <main aria-label="Alert feed">
      <h1>Alert Feed</h1>
      {/* Phase 2: live alert table, spread/event-type filters, sub-second WS delivery */}
      <p data-testid="trader-stub">Trader alert feed — Phase 2 implementation pending.</p>
    </main>
  );
}
