/**
 * Vitest configuration for apps/server.
 *
 * ## Coverage (Phase 0 scaffold — ARCH-C-012)
 *
 * Coverage is collected for the Phase 0 health-probe module (src/api/health.ts)
 * and enforced at 99% line coverage per the Phase 0 acceptance criteria.
 *
 * ## Integration risk captured (Phase 0 dev-scout)
 *
 * `@vitest/coverage-v8` requires `node:inspector` which is not yet implemented
 * in Bun (https://github.com/oven-sh/bun/issues/2445). Coverage must therefore
 * be run WITHOUT the `--bun` flag (i.e. `bun vitest run --coverage`, not
 * `bun --bun vitest run --coverage`). The CI coverage step must NOT use
 * `--bun` until Bun resolves this upstream issue.
 *
 * The threshold is intentionally scoped to Phase 0 modules only — future
 * phases expand the include list as they add source files.
 *
 * Canonical doc: docs/implementation-plan-v1.md § Phase 0
 * Blueprint ref: calypso-blueprint/rules/blueprints/test.yaml
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Only enforce coverage on Phase 0 scaffold modules.
      // Expand this list as each subsequent phase lands its source files.
      include: ['src/api/health.ts'],
      thresholds: {
        lines: 99,
        branches: 99,
        functions: 99,
        statements: 99,
      },
    },
  },
});
