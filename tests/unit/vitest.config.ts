/**
 * Vitest project config for root-level structural unit tests.
 *
 * These tests assert structural properties of the monorepo (scaffold, tsconfig
 * flags, workspace aliases) that cannot live inside a single app workspace.
 *
 * Tests added here:
 *  - scaffold.test.ts         — monorepo structure assertions (Phase 0 dev-scout)
 *  - secrets.test.ts          — packages/core/secrets abstraction layer (issue #11)
 *  - fixture-recorder.test.ts — golden fixture recorder + MSW handler factory (issue #98)
 *
 * Canonical doc: docs/implementation-plan-v1.md § Phase 0
 * Blueprint ref: calypso-blueprint/rules/blueprints/test.yaml
 */
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    name: 'scaffold',
    include: ['scaffold.test.ts', 'secrets.test.ts', 'fixture-recorder.test.ts'],
    root: resolve(import.meta.dirname),
  },
});
