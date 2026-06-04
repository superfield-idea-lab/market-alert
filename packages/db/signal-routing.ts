/**
 * @file signal-routing.ts
 *
 * Prompt routing, confidence decomposition, and threshold-based routing — issue #83.
 *
 * ## Routing algorithm (PRD §5, §9; architecture §"Signal routing")
 *
 * When a market event arrives, the routing layer selects the most specific Active
 * standing prompt for the event's subject entity using the following fallback chain:
 *
 *   1. **Entity-level prompt** — the standing prompt whose `subject_type = 'entity'`
 *      and `subject_id` matches the event's `subject_entity_id`. Most specific.
 *   2. **Thesis-level prompt** — a standing prompt whose `subject_type = 'thesis'`
 *      and whose `subject_id` is associated with the event's entity (resolved via
 *      the `entity_thesis_membership` table, or a list of thesis IDs provided by
 *      the caller). Used when no entity-level prompt exists.
 *   3. **Portfolio-level prompt** — a standing prompt whose `subject_type = 'portfolio'`
 *      and `subject_id = 'portfolio'`. Coarsest fallback. Used when neither entity-
 *      nor thesis-level prompts exist.
 *
 * ## Confidence decomposition (PRD §9)
 *
 * Confidence is decomposed into two factors:
 *   - `source_trust`         — tier of the supporting wiki claims (Research Methodology)
 *   - `extraction_certainty` — how unambiguously the event maps to the standing prompt
 *
 * Both factors are floats in [0.0, 1.0]. The composite confidence is their product:
 *   `confidence = source_trust × extraction_certainty`
 *
 * Both factors are stored independently on the `signals` row.
 *
 * ## Threshold routing (PRD §5, §9; architecture §"Signal routing")
 *
 * After computing confidence:
 *   - confidence ≥ threshold → signal transitions Generated → Delivered (direct delivery)
 *   - confidence < threshold → signal transitions Generated → Queued (Reviewer queue)
 *
 * The default threshold is 0.7. It is configurable per-tenant via
 * `CONFIDENCE_THRESHOLD` (architecture §7 open question).
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5, §9 — event evaluation, confidence, auditability
 * - docs/architecture.md §"Signal routing"
 * - packages/db/signal-store.ts — signal row types and state machine
 * - packages/db/standing-prompt-store.ts — standing_prompt_versions store
 * - apps/server/src/api/signal-routing-api.ts — internal API surface
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/83
 */

import type postgres from 'postgres';
import {
  getActiveStandingPromptVersion,
  type StandingPromptVersionRow,
  type StandingPromptSubjectType,
} from './standing-prompt-store';

export type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

/** Default confidence threshold below which signals are routed to the Reviewer queue. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Confidence decomposition for one signal (PRD §9).
 *
 * - `source_trust`         — tier of the supporting wiki claims in [0.0, 1.0].
 * - `extraction_certainty` — how unambiguously the event maps to the prompt in [0.0, 1.0].
 * - `confidence`           — composite: source_trust × extraction_certainty.
 */
export interface ConfidenceDecomposition {
  source_trust: number;
  extraction_certainty: number;
  confidence: number;
}

/**
 * Compute the confidence decomposition for a signal.
 *
 * Both factors are clamped to [0.0, 1.0] before multiplication to guard against
 * out-of-range values propagating from caller-supplied LLM output.
 *
 * Architecture ref: docs/architecture.md §"Signal routing"
 * PRD ref: §9 — confidence decomposition
 */
export function computeConfidence(
  source_trust: number,
  extraction_certainty: number,
): ConfidenceDecomposition {
  const clampedSourceTrust = Math.max(0, Math.min(1, source_trust));
  const clampedExtractionCertainty = Math.max(0, Math.min(1, extraction_certainty));
  const confidence = clampedSourceTrust * clampedExtractionCertainty;
  return {
    source_trust: clampedSourceTrust,
    extraction_certainty: clampedExtractionCertainty,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Routing decision
// ---------------------------------------------------------------------------

/**
 * The routing decision for one signal.
 *
 * - `route = 'direct'` — confidence ≥ threshold; signal delivers directly
 *   (Generated → Delivered).
 * - `route = 'reviewer'` — confidence < threshold; signal routes to the
 *   Reviewer queue (Generated → Queued).
 */
export type RoutingDecision = 'direct' | 'reviewer';

/**
 * Determine the routing path for a signal based on its confidence.
 *
 * Architecture ref: docs/architecture.md §"Signal routing" routing table.
 * PRD ref: §5, §9.
 *
 * @param confidence   Composite confidence value (source_trust × extraction_certainty).
 * @param threshold    Minimum confidence for direct delivery. Defaults to
 *                     `DEFAULT_CONFIDENCE_THRESHOLD` (0.7).
 */
export function routeByConfidence(
  confidence: number,
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): RoutingDecision {
  return confidence >= threshold ? 'direct' : 'reviewer';
}

// ---------------------------------------------------------------------------
// Prompt resolution
// ---------------------------------------------------------------------------

/**
 * The result of resolving the most specific standing prompt for a market event.
 *
 * - `promptVersion`  — the active `standing_prompt_versions` row that was selected.
 * - `subjectType`    — which level of the prompt family was chosen.
 * - `subjectId`      — the subject_id of the chosen prompt.
 */
export interface ResolvedPrompt {
  promptVersion: StandingPromptVersionRow;
  subjectType: StandingPromptSubjectType;
  subjectId: string;
}

/**
 * Options for `resolveStandingPromptForEvent`.
 */
export interface ResolvePromptOptions {
  sql: SqlClient;
  tenant_id: string;
  researcher_id: string;
  /** The subject entity ID from the market_event row. */
  subject_entity_id: string;
  /**
   * Optional list of thesis IDs that cover the subject entity.
   * Caller is responsible for resolving these from the methodology / knowledge graph.
   * The resolver tries each in order; the first match wins.
   */
  thesis_ids?: string[];
}

/**
 * Resolve the most specific Active standing prompt for a market event.
 *
 * Fallback chain (PRD §5, §9; architecture §"Signal routing"):
 *   1. Entity-level   — subject_type='entity',    subject_id=subject_entity_id
 *   2. Thesis-level   — subject_type='thesis',    subject_id=<thesis_id> (first match)
 *   3. Portfolio-level— subject_type='portfolio', subject_id='portfolio'
 *
 * Returns the first matched `ResolvedPrompt`, or null if no Active prompt exists
 * at any level for this researcher.
 *
 * Architecture ref: docs/architecture.md §"Signal routing"
 * PRD ref: §5 — "routes it to the most specific matching prompt"
 */
export async function resolveStandingPromptForEvent(
  options: ResolvePromptOptions,
): Promise<ResolvedPrompt | null> {
  const { sql, tenant_id, researcher_id, subject_entity_id, thesis_ids = [] } = options;

  // --- 1. Entity-level (most specific) ---
  const entityVersion = await getActiveStandingPromptVersion(
    sql,
    tenant_id,
    researcher_id,
    'entity',
    subject_entity_id,
  );
  if (entityVersion) {
    return {
      promptVersion: entityVersion,
      subjectType: 'entity',
      subjectId: subject_entity_id,
    };
  }

  // --- 2. Thesis-level (try each thesis in order) ---
  for (const thesisId of thesis_ids) {
    const thesisVersion = await getActiveStandingPromptVersion(
      sql,
      tenant_id,
      researcher_id,
      'thesis',
      thesisId,
    );
    if (thesisVersion) {
      return {
        promptVersion: thesisVersion,
        subjectType: 'thesis',
        subjectId: thesisId,
      };
    }
  }

  // --- 3. Portfolio-level (coarsest fallback) ---
  const portfolioVersion = await getActiveStandingPromptVersion(
    sql,
    tenant_id,
    researcher_id,
    'portfolio',
    'portfolio',
  );
  if (portfolioVersion) {
    return {
      promptVersion: portfolioVersion,
      subjectType: 'portfolio',
      subjectId: 'portfolio',
    };
  }

  return null;
}
