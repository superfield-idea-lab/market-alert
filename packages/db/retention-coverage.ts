/**
 * @file retention-coverage
 *
 * Phase 8 — Retention deletion block across entity types (issue #80).
 *
 * ## Purpose
 *
 * This module declares the canonical set of entity types that are protected by
 * the `guard_retention_floor` database-layer trigger.  The trigger fires on
 * every DELETE from the `entities` table, so any entity type that stores rows
 * there is automatically covered — no per-type policy configuration is required.
 *
 * The list below is the authoritative record of which types have been verified
 * through integration tests to be blocked when a row carries a non-null
 * `retention_class` that maps to a policy whose floor has not elapsed.
 *
 * ## How the block works
 *
 * 1. Every ground-truth and synthetic entity is stored in the `entities` table.
 * 2. Ingestion workers populate `retention_class` (and `legal_hold`) from the
 *    tenant's default policy row in `tenant_retention_policies` at write time.
 * 3. `trg_entities_retention_floor` calls `guard_retention_floor()` BEFORE
 *    DELETE for every row.  The function raises a `restrict_violation` exception
 *    when `NOW() < created_at + (retention_floor_days * INTERVAL '1 day')`.
 * 4. The block is enforced regardless of which database role issues the DELETE —
 *    it is not an RLS policy (which can be bypassed by superuser) but a trigger,
 *    which applies to all roles including `app_rw` and `app_ro`.
 *
 * ## Covered entity types
 *
 * | Type               | Domain           | Retention-sensitive |
 * |--------------------|------------------|---------------------|
 * | email              | Ground truth     | Yes                 |
 * | corpus_chunk       | Corpus chunks    | Yes                 |
 * | transcript         | Phase 5 audio    | Yes                 |
 * | wiki_page_version  | Wiki (synthetic) | Yes                 |
 * | wiki_annotation    | Wiki (synthetic) | Yes                 |
 * | wiki_page          | Wiki (synthetic) | Yes                 |
 *
 * ## Out of scope
 *
 * - WORM mode (separate follow-on issue).
 * - Legal hold entity + four-eyes removal (separate follow-on issue).
 * - Entities with null `retention_class` are not affected by the trigger and can
 *   be freely deleted.
 *
 * Canonical docs: docs/PRD.md §7a, docs/implementation-plan-v1.md Phase 8
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/80
 */

// ---------------------------------------------------------------------------
// Covered entity type registry
// ---------------------------------------------------------------------------

/**
 * A record of an entity type that has been verified to be protected by the
 * `guard_retention_floor` database-layer trigger.
 */
export interface RetentionCoveredType {
  /** Canonical entity type string stored in `entities.type`. */
  type: string;
  /** Human-readable description of the entity type. */
  description: string;
  /** Whether this type is expected to have `retention_class` populated at write time. */
  requiresRetentionClass: boolean;
}

/**
 * The canonical list of entity types protected by the Phase 8 retention
 * deletion block.
 *
 * This list is used by `retention-multi-entity.test.ts` to drive parametric
 * integration tests that assert the block for each type.
 */
export const RETENTION_COVERED_TYPES: RetentionCoveredType[] = [
  {
    type: 'email',
    description: 'Ingested email — ground-truth source record',
    requiresRetentionClass: true,
  },
  {
    type: 'corpus_chunk',
    description: 'Text chunk extracted from ground-truth source material',
    requiresRetentionClass: true,
  },
  {
    type: 'transcript',
    description: 'Meeting transcript produced from on-device audio recording',
    requiresRetentionClass: true,
  },
  {
    type: 'wiki_page_version',
    description: 'Versioned snapshot of a wiki page (synthetic, agent-maintained)',
    requiresRetentionClass: true,
  },
  {
    type: 'wiki_annotation',
    description: 'Annotation thread on a specific wiki page version (synthetic)',
    requiresRetentionClass: true,
  },
  {
    type: 'wiki_page',
    description: 'Stable wiki page handle pointing to the current version (synthetic)',
    requiresRetentionClass: true,
  },
];

/**
 * Returns `true` when the given entity type is in the covered set.
 *
 * This is a pure look-up helper for callers that need to decide at runtime
 * whether to populate `retention_class` on a new entity row.
 */
export function isRetentionCoveredType(entityType: string): boolean {
  return RETENTION_COVERED_TYPES.some((entry) => entry.type === entityType);
}
