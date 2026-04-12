/**
 * @file bdm-rls-boundary
 *
 * Phase 7 BDM campaign-analysis boundary scaffold.
 *
 * This module does not implement the BDM feature. It only captures the
 * session-context seam and the database-layer attack shapes that the follow-on
 * issue must prove.
 *
 * Canonical docs:
 * - docs/implementation-plan-v1.md § Phase 7 (scout)
 * - docs/PRD.md §4.7 (Cross-Customer Campaign Summary)
 * - docs/PRD.md §7 (RLS boundary: no customer rows, wiki content, ground-truth,
 *   dictionary access, or relation traversal back to a customer)
 *
 * Scout findings / integration points:
 * - BDM work still rides on the app database role; there is no separate query
 *   surface in place yet for campaign analysis.
 * - The next issue must prove that a BDM session cannot pivot from anonymised
 *   campaign analysis into customer-facing tables or reverse links.
 * - Direct dictionary access remains structurally denied via the separate
 *   kb_dictionary pool; the BDM path must never depend on it.
 *
 * Risks captured during scout:
 * - A first-pass test suite can accidentally "pass" without testing a real
 *   blocker if it only checks positive rows. The follow-on must keep the first
 *   deliberate attack shape negative and database-enforced.
 * - Relation traversal is the highest-risk escape hatch because it can leak a
 *   customer even when direct row reads are blocked.
 */

export interface BdmSessionContext {
  /** Authenticated user or agent identity. */
  userId: string;
  /** Tenant the BDM is operating within. */
  tenantId: string | null;
  /** Department scope that the BDM campaign analysis query must stay inside. */
  departmentId: string;
}

export type BdmBoundaryAttackShape =
  | 'customer-row'
  | 'wiki-page'
  | 'ground-truth-email'
  | 'identity-dictionary'
  | 'has_ground_truth-traversal';

export interface BdmBoundaryProbe {
  /** Short name for the attempted escape hatch. */
  name: BdmBoundaryAttackShape;
  /** Human-readable description of the boundary shape being exercised. */
  description: string;
}

/**
 * Canonical attack inventory for the Phase 7 scout.
 *
 * The follow-on issue will replace these documented shapes with real database
 * probes that assert the first deliberate attempt fails at the RLS layer.
 */
export const BDM_RLS_BOUNDARY_PROBES: readonly BdmBoundaryProbe[] = [
  {
    name: 'customer-row',
    description: 'Direct SELECT from customer-scoped rows under a BDM session.',
  },
  {
    name: 'wiki-page',
    description: 'Direct SELECT from wiki rows that could reveal customer identity.',
  },
  {
    name: 'ground-truth-email',
    description: 'Direct SELECT from ground-truth email rows under the BDM role.',
  },
  {
    name: 'identity-dictionary',
    description: 'Any attempt to reach the identity dictionary from the BDM path.',
  },
  {
    name: 'has_ground_truth-traversal',
    description: 'Relation traversal that tries to walk from transcript back to customer.',
  },
] as const;
