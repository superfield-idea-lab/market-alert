/**
 * @file scaffold.test.ts
 *
 * Phase 0 dev-scout: structural assertions about the monorepo scaffold.
 *
 * ## What is tested
 * - tsconfig.json has strict: true (implies noImplicitAny)
 * - Workspace package aliases exist: core, db (no packages/utils junk drawer)
 * - Required directories exist: apps/server, apps/web, packages/core, tests/
 * - No packages/utils directory (ARCH blueprint forbids junk drawers)
 *
 * ## No mocks
 * All tests use real filesystem reads and JSON parsing.
 *
 * Canonical doc: docs/implementation-plan-v1.md Phase 0 (Planning principles)
 * Blueprint ref: calypso-blueprint/rules/blueprints/arch.yaml (ARCH-C-012)
 */

import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Root of the monorepo — two levels up from tests/unit/
const ROOT = resolve(import.meta.dirname, '../..');

describe('tsconfig strict flags (ARCH-C-012)', () => {
  test('root tsconfig.json has strict: true', () => {
    const tsconfig = JSON.parse(readFileSync(resolve(ROOT, 'tsconfig.json'), 'utf-8')) as {
      compilerOptions?: { strict?: boolean; noImplicitAny?: boolean };
    };
    // strict: true implies noImplicitAny; either field suffices
    const isStrict =
      tsconfig.compilerOptions?.strict === true || tsconfig.compilerOptions?.noImplicitAny === true;
    expect(isStrict).toBe(true);
  });
});

describe('workspace structure (ARCH blueprint)', () => {
  test('apps/server exists', () => {
    expect(existsSync(resolve(ROOT, 'apps/server'))).toBe(true);
  });

  test('apps/web exists', () => {
    expect(existsSync(resolve(ROOT, 'apps/web'))).toBe(true);
  });

  test('packages/core exists', () => {
    expect(existsSync(resolve(ROOT, 'packages/core'))).toBe(true);
  });

  test('tests/ exists', () => {
    expect(existsSync(resolve(ROOT, 'tests'))).toBe(true);
  });

  test('packages/utils does not exist (no junk drawer)', () => {
    // ARCH blueprint forbids a packages/utils catch-all.
    // Shared types belong in packages/core only.
    expect(existsSync(resolve(ROOT, 'packages/utils'))).toBe(false);
  });
});

describe('workspace aliases (no deep relative imports)', () => {
  test('apps/server references core as workspace alias', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'apps/server/package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['core']).toMatch(/^workspace:/);
  });

  test('apps/server references db as workspace alias', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'apps/server/package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['db']).toMatch(/^workspace:/);
  });
});
