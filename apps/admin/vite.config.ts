/**
 * @file vite.config — apps/admin
 *
 * ## Phase 0 — Scaffolding & infrastructure (dev-scout)
 *
 * Distinct build config for the admin SPA. Runs on port 5174 in dev (web
 * occupies 5173). Proxies /api/* to the shared server on PORT (default 31415).
 *
 * ## Canonical docs
 * - docs/plan.md § Phase 0 (scout)
 * - docs/prd.md § Admin role
 *
 * ## Integration points discovered
 * - Admin SPA shares packages/ui tokens and packages/core with apps/web.
 *   Both build outputs must be served from distinct origins (or distinct
 *   paths) so the server can differentiate admin vs trader sessions.
 * - Phase 1 will add passkey auth; the admin login page must be the first
 *   route registered in Phase 1 after the scaffold lands.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export function getApiPort(env: NodeJS.ProcessEnv = process.env): number {
  const rawPort = env.PORT ?? '31415';
  const value = Number(rawPort);
  return Number.isFinite(value) ? value : 31415;
}

export function createProxy(env: NodeJS.ProcessEnv = process.env) {
  const target = `http://localhost:${getApiPort(env)}`;
  return {
    '/api': {
      target,
      changeOrigin: true,
    },
  };
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: createProxy(),
  },
});
