/**
 * @file bdm-rls-boundary.test.ts
 *
 * Integration test scaffold — Phase 7 BDM RLS boundary scout (issue #70).
 *
 * This suite is intentionally stub-only. It documents the database-layer
 * attack shapes the follow-on issue must convert into real pen tests:
 *   1. Direct customer row read
 *   2. Direct wiki page read
 *   3. Direct ground-truth email read
 *   4. Direct identity-dictionary read
 *   5. Relation traversal through has_ground_truth back to a customer
 *
 * The production follow-on will replace the todos below with real Postgres
 * probes running under a BDM session context. For the scout, the constant
 * inventory is enough to keep the seam visible without changing runtime
 * behavior.
 *
 * Canonical docs:
 * - docs/implementation-plan-v1.md § Phase 7 (scout)
 * - docs/PRD.md §4.7 and §7
 */

import { expect, test } from 'vitest';
import { BDM_RLS_BOUNDARY_PROBES } from '../../src/security/bdm-rls-boundary';

test('BDM RLS scout documents every planned database escape hatch', () => {
  expect(BDM_RLS_BOUNDARY_PROBES.map((probe) => probe.name)).toEqual([
    'customer-row',
    'wiki-page',
    'ground-truth-email',
    'identity-dictionary',
    'has_ground_truth-traversal',
  ]);
});

test.todo('BDM session cannot read a customer row at the database layer');
test.todo('BDM session cannot read a wiki page at the database layer');
test.todo('BDM session cannot read a ground-truth email at the database layer');
test.todo('BDM session cannot read an identity-dictionary entry at the database layer');
test.todo('BDM session cannot traverse has_ground_truth back to a customer at the database layer');
test.todo('the first deliberate BDM attempt fails before any identity can be recovered');
