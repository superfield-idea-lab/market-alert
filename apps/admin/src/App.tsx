/**
 * @file App — apps/admin root component
 *
 * ## Phase 0 — Scaffolding & infrastructure (dev-scout)
 *
 * Root application shell. In Phase 0 this is a minimal stub that proves the
 * admin SPA builds and renders without errors. No routing library is wired yet
 * — Phase 1 adds react-router + passkey auth guard.
 *
 * ## Canonical docs
 * - docs/plan.md § Phase 0 (scout)
 * - docs/prd.md § Admin role
 *
 * ## Integration points discovered
 * - The /admin/trader route (stub below) will become the trader-management
 *   page in Phase 4. See apps/admin/src/pages/trader.tsx.
 * - Phase 1 auth guard wraps this App component; no auth logic lives here.
 */

import React from 'react';
import TraderPage from './pages/trader';

export default function App(): React.ReactElement {
  // Phase 0 stub: render the trader management page stub directly.
  // Phase 1 adds react-router with passkey auth guard.
  return <TraderPage />;
}
