/**
 * Vitest project config for root-level structural unit tests.
 *
 * These tests assert structural properties of the monorepo (scaffold, tsconfig
 * flags, workspace aliases) that cannot live inside a single app workspace.
 *
 * Canonical doc: docs/implementation-plan-v1.md § Phase 0
 * Blueprint ref: calypso-blueprint/rules/blueprints/test.yaml
 */
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    name: 'scaffold',
    include: ['scaffold.test.ts'],
    root: resolve(import.meta.dirname),
  },
});
