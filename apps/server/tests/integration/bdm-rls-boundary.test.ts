/**
 * @file bdm-rls-boundary.test.ts
 *
 * Unit tests — Phase 7 BDM RLS boundary probe inventory (issue #73).
 *
 * Asserts the static invariants of the BDM_RLS_BOUNDARY_PROBES constant:
 *   - all five attack shapes are documented
 *   - each probe carries an enforcedBy policy name
 *
 * The full database-layer pen-test suite lives in:
 *   packages/db/bdm-rls.test.ts
 *
 * That suite provisions a real Postgres container, runs configureBdmRls(),
 * and exercises every attack shape under a BDM session to assert zero rows.
 *
 * Canonical docs:
 * - docs/PRD.md §4.7 (BDM workflow RLS boundary)
 * - apps/server/src/security/bdm-rls-boundary.ts
 */

import { expect, test } from 'vitest';
import { BDM_RLS_BOUNDARY_PROBES } from '../../src/security/bdm-rls-boundary';

test('BDM RLS boundary probe inventory covers every planned database escape hatch', () => {
  expect(BDM_RLS_BOUNDARY_PROBES.map((probe) => probe.name)).toEqual([
    'customer-row',
    'wiki-page',
    'ground-truth-email',
    'identity-dictionary',
    'has_ground_truth-traversal',
  ]);
});

test('every BDM RLS boundary probe carries an enforcedBy policy name', () => {
  for (const probe of BDM_RLS_BOUNDARY_PROBES) {
    expect(probe.enforcedBy, `probe "${probe.name}" is missing enforcedBy`).toBeTruthy();
  }
});

test('entity-level attack shapes are enforced by entities_bdm_block', () => {
  const entityProbes = BDM_RLS_BOUNDARY_PROBES.filter((p) =>
    ['customer-row', 'wiki-page', 'ground-truth-email', 'identity-dictionary'].includes(p.name),
  );
  for (const probe of entityProbes) {
    expect(probe.enforcedBy).toBe('entities_bdm_block');
  }
});

test('has_ground_truth-traversal is enforced by relations_bdm_block', () => {
  const traversalProbe = BDM_RLS_BOUNDARY_PROBES.find(
    (p) => p.name === 'has_ground_truth-traversal',
  );
  expect(traversalProbe).toBeDefined();
  expect(traversalProbe!.enforcedBy).toBe('relations_bdm_block');
});
