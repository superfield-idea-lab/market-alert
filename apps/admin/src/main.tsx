/**
 * @file main — apps/admin entrypoint
 *
 * ## Phase 0 — Scaffolding & infrastructure (dev-scout)
 *
 * Admin SPA entry point. Distinct from apps/web/src/main.tsx so the admin
 * bundle is built and served independently.
 *
 * ## Canonical docs
 * - docs/plan.md § Phase 0 (scout)
 * - docs/prd.md § Admin role
 *
 * ## Integration points discovered
 * - Phase 1 adds passkey auth; the login page must be registered at '/' for
 *   the admin origin before any authenticated routes are added.
 * - The admin SPA does NOT share the web SPA's service worker — admin has no
 *   offline requirement.
 *
 * ## Risks captured
 * - Both apps/admin and apps/web import packages/ui. Changes to ui tokens or
 *   primitives affect both SPAs simultaneously — test both on any ui change.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
