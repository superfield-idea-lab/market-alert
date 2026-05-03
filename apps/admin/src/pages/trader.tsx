/**
 * @file trader — apps/admin trader management page
 *
 * ## Phase 0 — Scaffolding & infrastructure (dev-scout)
 *
 * Empty stub for the admin-side trader route. Establishes the page module
 * boundary and documents the integration surface before Phase 4 implements
 * the real trader CRUD UI.
 *
 * ## Canonical docs
 * - docs/plan.md § Phase 0 acceptance criteria: "apps/admin … [has] a distinct
 *   entry point and build config"
 * - docs/prd.md § Admin role — manages trader accounts and permissions
 *
 * ## Integration points discovered
 * - Trader management calls POST /api/admin/traders (Phase 4 endpoint).
 *   Admin role must be verified server-side via RLS context before any write.
 * - The admin SPA origin and the web SPA origin must be configured as distinct
 *   CORS origins in apps/server/src/index.ts.
 * - Phase 1 auth guard: admin must hold the 'admin' role claim in the session
 *   JWT. Any trader-management API call with a trader-role JWT must return 403.
 *
 * ## Risks captured
 * - If apps/admin is served from the same origin as apps/web, session cookies
 *   for trader vs admin accounts will collide. The k3d dev cluster (Phase 0
 *   follow-on) must expose them on distinct subdomains or ports.
 */

import React from 'react';

/**
 * TraderPage (admin) — Phase 0 stub.
 *
 * Renders a placeholder that documents the future trader management UI.
 * No data fetching, no mutations — safe to render without a running server.
 */
export default function TraderPage(): React.ReactElement {
  return (
    <main aria-label="Trader management">
      <h1>Trader Management</h1>
      {/* Phase 4: trader list, invite, role assignment, deactivation */}
      <p data-testid="trader-stub">Trader management UI — Phase 4 implementation pending.</p>
    </main>
  );
}
