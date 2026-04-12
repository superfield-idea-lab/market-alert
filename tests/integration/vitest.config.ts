/**
 * Vitest project config for the autolearn state-machine integration harness.
 *
 * Tests run against a real ephemeral Postgres container (via db/pg-container).
 * Docker must be available on the runner — ubuntu-latest satisfies this.
 *
 * Timeouts are generous to accommodate container start-up (up to 60 s).
 *
 * Blueprint refs: issue #42, PRD §4.3, TEST blueprint.
 */
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

export default defineConfig({
  resolve: {
    alias: [
      // db/* sub-path imports — must come before the bare 'db' alias.
      {
        find: /^db\/(.+)$/,
        replacement: resolve(root, 'packages/db/$1.ts'),
      },
      // bare 'db' import resolves to the package index.
      {
        find: 'db',
        replacement: resolve(root, 'packages/db/index.ts'),
      },
    ],
  },
  test: {
    name: 'autolearn-integration',
    include: ['tests/integration/**/*.spec.ts'],
    environment: 'node',
    // Tests share a single Postgres container started in beforeAll — do not
    // parallelise across files, and run each file sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    root,
  },
});
