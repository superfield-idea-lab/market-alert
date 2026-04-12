/**
 * @file bdm-rls-boundary
 *
 * Phase 7 BDM campaign-analysis RLS boundary types and constants.
 *
 * This module defines the session-context type for BDM sessions and the
 * canonical inventory of database attack shapes that the Phase 7 RLS policies
 * block. The actual policies are applied in `packages/db/init-remote.ts` via
 * `configureBdmRls()`.
 *
 * Session wiring:
 *   BDM sessions set `bdmDepartmentId` in `RlsSessionContext` (rls-context.ts).
 *   `withRlsContext` translates this to a `SET LOCAL app.current_bdm_department_id`
 *   binding inside the transaction. The RESTRICTIVE RLS policies on `entities`,
 *   `relations`, and `wiki_page_versions` use `current_setting(...)` to detect
 *   BDM sessions and deny access to customer-identifying rows.
 *
 * Blocked at the database layer for BDM sessions (PRD §4.7):
 *   - entity types: customer, crm_update, customer_interest, email,
 *     wiki_page, wiki_page_version, wiki_annotation, identity_token
 *   - relation type: has_ground_truth (traversal re-identification escape hatch)
 *   - table: wiki_page_versions (all rows)
 *
 * Allowed for BDM sessions (anonymised campaign-analysis path):
 *   - entity types: transcript, corpus_chunk, asset_manager, fund, department, user
 *   - relation type: discussed_in (asset manager → transcript tagging)
 *
 * Canonical docs:
 * - docs/PRD.md §4.7 (BDM workflow RLS boundary)
 * - docs/PRD.md §7 (structural DB blocks replace application-layer filtering)
 * - packages/db/init-remote.ts — configureBdmRls()
 * - packages/db/rls-context.ts — withRlsContext()
 * - packages/db/bdm-rls.test.ts — integration pen-test suite
 *
 * Issue #73 — feat: restrictive RLS policies blocking BDM access to customer data.
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
  /** The RLS policy name that enforces the block. */
  enforcedBy: string;
}

/**
 * Canonical attack inventory for Phase 7.
 *
 * Each entry identifies a database-layer escape hatch and the RLS policy that
 * blocks it. The integration pen-test suite (`packages/db/bdm-rls.test.ts`)
 * exercises each of these shapes under a BDM session and asserts zero rows.
 *
 * PRD §4.7: "the BDM's database session cannot read customer entities, wiki
 * entities, ground-truth emails, customer interests, or identity dictionary
 * entries, and cannot traverse relations that would link a transcript back to
 * a customer."
 */
export const BDM_RLS_BOUNDARY_PROBES: readonly BdmBoundaryProbe[] = [
  {
    name: 'customer-row',
    description: 'Direct SELECT from customer-scoped rows under a BDM session.',
    enforcedBy: 'entities_bdm_block',
  },
  {
    name: 'wiki-page',
    description: 'Direct SELECT from wiki rows that could reveal customer identity.',
    enforcedBy: 'entities_bdm_block',
  },
  {
    name: 'ground-truth-email',
    description: 'Direct SELECT from ground-truth email rows under the BDM role.',
    enforcedBy: 'entities_bdm_block',
  },
  {
    name: 'identity-dictionary',
    description: 'Any attempt to reach the identity dictionary from the BDM path.',
    enforcedBy: 'entities_bdm_block',
  },
  {
    name: 'has_ground_truth-traversal',
    description: 'Relation traversal that tries to walk from transcript back to customer.',
    enforcedBy: 'relations_bdm_block',
  },
] as const;
