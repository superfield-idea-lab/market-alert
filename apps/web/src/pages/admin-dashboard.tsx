/**
 * @file admin-dashboard — apps/web admin dashboard page
 *
 * ## Phase 0 — Scaffolding & infrastructure (dev-scout)
 *
 * Empty stub for the admin-facing route. Establishes the page module boundary
 * and documents the integration surface before Phase 5 implements the real
 * PRD-aligned admin dashboard (source configuration, alert suppression,
 * audit trail).
 *
 * Prior incarnations of this file rendered upstream-template tabs (CRM
 * entities, Legal Holds, generic Task Queue, generic Users) that have no
 * place in the market-alert PRD. Those tabs and their client-side fetch
 * calls to template-only admin endpoints were removed by issue #64 so the
 * demo only shows market-alert features or honest Phase 0 stubs.
 *
 * ## Canonical docs
 * - docs/prd.md § Admin role — source configuration, alert suppression, audit trail
 * - docs/plan.md § Phase 5 acceptance criteria for the real admin UI
 *
 * ## Future Plan issues
 * - #88 — scout for the real PRD-aligned admin dashboard
 * - #89 — implementation of the real admin dashboard
 */

import React from 'react';

/**
 * AdminDashboard — Phase 0 stub.
 *
 * Renders a placeholder that documents the future admin UI. No data fetching,
 * no WebSocket — safe to render without a running server. The real UI is
 * owned by Plan #89 and gated behind scout #88.
 */
export function AdminDashboard(): React.ReactElement {
  return (
    <main aria-label="Admin dashboard" className="p-8">
      <h1 className="text-xl font-bold text-zinc-900">Admin Dashboard</h1>
      {/* Phase 5: source configuration, alert suppression, audit trail (Plan #89) */}
      <p data-testid="admin-stub" className="mt-2 text-sm text-zinc-500">
        Admin dashboard — Phase 5 implementation pending (see Plan #89).
      </p>
    </main>
  );
}
