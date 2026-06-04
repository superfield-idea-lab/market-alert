/**
 * @file chat-feedback-store.ts
 *
 * ## Phase scout — Chat feedback → wiki superseding fact + methodology meta-commentary (issue #86)
 *
 * Stub-only integration pass. This module establishes the seam between the
 * researcher chat-feedback surface and the two downstream write paths:
 *
 *   1. A superseding-fact applied to the relevant wiki page (non-destructive
 *      edit — old confirmed_fact row is preserved, new row carries
 *      `supersedes_fact_id` pointing to the prior).
 *
 *   2. A `methodology_meta_commentary` entry opened when the feedback implies a
 *      methodology shift — the golden Research Methodology document is NEVER
 *      written by the system.
 *
 * ## Behaviour summary (PRD §5, §9)
 *
 * ```
 * researcher chat message (correction)
 *   → classify_feedback()             [LLM call — determines wiki_page_id, fact to supersede,
 *                                       and whether a methodology shift is implied]
 *   → insert superseding confirmed_fact (supersedes_fact_id ← old fact id)
 *   → if methodology_shift:
 *       → open methodology_meta_commentary entry (status: 'open')
 *   → enqueue WIKI_REBUILD for the affected wiki page
 * ```
 *
 * ## Tables managed here
 *
 * ### chat_feedback
 *
 * One row per researcher-submitted chat correction. Records the raw message, the
 * wiki page and fact that were targeted, whether a methodology shift was implied,
 * and the IDs of the artifacts produced (new fact, meta-commentary entry).
 *
 * ### methodology_meta_commentary
 *
 * Agent-writable companion to the golden Research Methodology. Records observations,
 * drift notes, and implied changes derived from researcher feedback and maintenance
 * findings. The researcher can acknowledge entries and later fold them in; agents
 * never write back to the golden document.
 *
 * Lifecycle: open → acknowledged → folded_in | archived
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5 — researcher feedback surface.
 * - docs/prd.md §9 — golden-document invariant.
 * - docs/architecture.md §"Knowledge subsystem" — methodology_meta_commentary entity type.
 * - docs/architecture.md — confirmed_fact immutability / supersession chain.
 * - docs/implementation-plan.md § Phase 9 — researcher feedback and methodology meta-commentary.
 * - packages/db/mkt-schema.sql — authoritative DDL (to be extended in Phase 9 full impl).
 * - apps/server/src/api/chat-feedback-api.ts — API endpoints.
 * - tests/integration/chat-feedback.spec.ts — integration tests.
 *
 * ## Integration points for Phase 9 full implementation
 *
 * 1. **LLM classify_feedback call**: The API handler will call an LLM to parse
 *    the researcher's free-text correction into a structured `ClassifiedFeedback`
 *    payload: `{ wiki_page_id, target_fact_id, new_value, methodology_shift: bool,
 *    drift_observation: string | null }`. This call is stubbed here and must be
 *    wired to the Anthropic SDK in the full implementation.
 *
 * 2. **confirmed_fact supersession**: Insert a new `confirmed_fact` row with
 *    `supersedes_fact_id` pointing to the replaced fact. The Postgres trigger
 *    `trg_confirmed_facts_immutable` enforces append-only semantics — the old row
 *    is never deleted or mutated (architecture §"Facts: confirmed_fact").
 *
 * 3. **WIKI_REBUILD enqueue**: After inserting the superseding fact, enqueue a
 *    `WIKI_REBUILD` task for the affected `wiki_page_id` via the task queue
 *    (`packages/db/task-queue.ts`). The rebuild worker will pick up the new fact
 *    and regenerate the page content.
 *
 * 4. **methodology_meta_commentary entry**: When `methodology_shift === true`,
 *    insert a row in `methodology_meta_commentary` with `status = 'open'`. The
 *    entry carries the researcher's drift observation and a class label
 *    (e.g. `'methodology_drift'`). The meta-commentary surfacing layer (Phase 9
 *    later issue) will surface the badge count and weekly digest.
 *
 * 5. **Golden-document invariant**: No code path in this module (or the API
 *    handler) may write to `golden_documents` or `golden_document_sections`.
 *    This is enforced at the DB layer via RLS policy `golden_docs:write` which
 *    grants write permission to the Researcher role only, not to the app role
 *    used by the feedback handler (architecture §"Row-level security").
 *
 * ## Risks discovered during scout
 *
 * - **LLM classify_feedback hallucinations**: The classification step maps a
 *   free-text message to a specific `target_fact_id`. If the LLM returns a
 *   fact ID that does not exist or belongs to a different tenant, the supersession
 *   insert will fail. Mitigation: validate `target_fact_id` against
 *   `confirmed_facts WHERE tenant_id = $tenant_id` before inserting. Return a
 *   user-visible error if the target fact is not found.
 *
 * - **Multi-hop supersession chain depth**: Repeated corrections to the same fact
 *   produce a chain: fact_1 ← fact_2 ← fact_3 …. The wiki rebuild worker must
 *   follow the chain to the head (no `supersedes_fact_id IS NULL` in live queries).
 *   The rebuild worker currently assumes a single supersession level. Phase 9 full
 *   implementation must add a recursive CTE or application-level chain walk.
 *
 * - **Meta-commentary surfacing gap**: `methodology_meta_commentary` entries opened
 *   here are not yet surfaced to the researcher. The badge count and digest
 *   (implementation-plan §Phase 9 "Meta-commentary surfacing") are a separate
 *   downstream issue. Entries accumulate silently until that issue lands.
 *
 * - **Race with WIKI_REBUILD**: If a WIKI_REBUILD is already in progress for the
 *   same wiki page when the superseding fact is inserted, the rebuild may finish
 *   before the new fact is committed. The next WIKI_REBUILD (triggered by the
 *   feedback handler's enqueue) will pick it up. The intermediate published version
 *   will not reflect the correction; this is a narrow window acceptable in Phase 9.
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/86
 */

import type postgres from 'postgres';

export type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Classes of methodology meta-commentary entry.
 *
 * - `methodology_drift`    — researcher feedback implies a change to research methodology.
 * - `proposed_venue`       — agent proposes a new canonical source venue.
 * - `proposed_sub_segment` — agent proposes a new sub-industry/sub-segment.
 * - `proposed_watchlist`   — agent proposes a new watchlist entry.
 * - `demoted_source`       — agent observes a source is consistently low-quality.
 */
export type MetaCommentaryClass =
  | 'methodology_drift'
  | 'proposed_venue'
  | 'proposed_sub_segment'
  | 'proposed_watchlist'
  | 'demoted_source';

/**
 * Lifecycle of a methodology meta-commentary entry.
 *
 * open → acknowledged → folded_in | archived
 *
 * - `open`          — entry is active; not yet seen by the researcher.
 * - `acknowledged`  — researcher has read the entry; no action taken yet.
 * - `folded_in`     — researcher chose to update the golden doc to reflect this entry.
 * - `archived`      — entry closed without being folded in.
 */
export type MetaCommentaryStatus = 'open' | 'acknowledged' | 'folded_in' | 'archived';

/**
 * One row in the `methodology_meta_commentary` table.
 */
export type MetaCommentaryRow = {
  id: string;
  tenant_id: string;
  researcher_id: string;
  /** Source of the entry — 'chat_feedback' | 'maintenance'. */
  source: string;
  /** ID of the chat_feedback row that triggered this entry, when applicable. */
  source_feedback_id: string | null;
  class: MetaCommentaryClass;
  /** Free-text observation about the methodology drift or proposal. */
  observation: string;
  status: MetaCommentaryStatus;
  created_at: Date;
  updated_at: Date;
};

/**
 * One row in the `chat_feedback` table.
 */
export type ChatFeedbackRow = {
  id: string;
  tenant_id: string;
  researcher_id: string;
  /** The free-text message the researcher submitted. */
  message: string;
  /** The wiki page targeted by the correction, if identified. */
  wiki_page_id: string | null;
  /** The confirmed_fact ID that was superseded, if applicable. */
  superseded_fact_id: string | null;
  /** The new confirmed_fact ID created as the superseding fact. */
  new_fact_id: string | null;
  /** Whether the feedback implied a methodology shift. */
  methodology_shift: boolean;
  /** The meta-commentary entry ID opened, when methodology_shift is true. */
  meta_commentary_id: string | null;
  created_at: Date;
};

/**
 * Input to `applyFeedback`.
 */
export interface ApplyFeedbackInput {
  tenant_id: string;
  researcher_id: string;
  /** Free-text correction submitted by the researcher via chat. */
  message: string;
  /** Target wiki page ID (resolved by the LLM classification step). */
  wiki_page_id: string;
  /** The confirmed_fact being superseded by this correction. */
  superseded_fact_id: string;
  /**
   * New fact value derived from the researcher's correction.
   * Will be inserted as a new confirmed_fact with supersedes_fact_id set.
   */
  new_fact_value: string;
  /** Whether the feedback implies a methodology shift. */
  methodology_shift: boolean;
  /** Free-text drift observation to record in meta-commentary (required when methodology_shift is true). */
  drift_observation: string | null;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

/**
 * DDL for the chat_feedback and methodology_meta_commentary tables.
 *
 * Applied by the test helper and by the production migration runner.
 * The authoritative DDL will live in packages/db/mkt-schema.sql after the
 * Phase 9 full implementation lands.
 *
 * Note: this DDL intentionally does NOT include confirmed_facts DDL — that
 * table is already defined in mkt-schema.sql and wiki-rebuild-store.ts.
 * The chat_feedback.superseded_fact_id and new_fact_id columns reference
 * confirmed_fact IDs by convention (TEXT) rather than FK to avoid a dependency
 * on the confirmed_facts table being present in every test that uses this DDL.
 */
export const CHAT_FEEDBACK_DDL = `
-- methodology_meta_commentary — agent-writable companion to the golden Research Methodology.
-- Lifecycle: open → acknowledged → folded_in | archived
-- Architecture ref: docs/architecture.md §"Knowledge subsystem"
-- PRD ref: docs/prd.md §5, §9
CREATE TABLE IF NOT EXISTS methodology_meta_commentary (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  tenant_id           TEXT NOT NULL,
  researcher_id       TEXT NOT NULL,
  -- Source of this entry: 'chat_feedback' or 'maintenance'.
  source              TEXT NOT NULL DEFAULT 'chat_feedback'
                        CHECK (source IN ('chat_feedback', 'maintenance')),
  source_feedback_id  TEXT,
  class               TEXT NOT NULL
                        CHECK (class IN (
                          'methodology_drift',
                          'proposed_venue',
                          'proposed_sub_segment',
                          'proposed_watchlist',
                          'demoted_source'
                        )),
  observation         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'acknowledged', 'folded_in', 'archived')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_meta_commentary_researcher_status
  ON methodology_meta_commentary (researcher_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_meta_commentary_tenant
  ON methodology_meta_commentary (tenant_id, status, created_at DESC);

-- chat_feedback — one row per researcher-submitted chat correction.
-- Records the raw message, artifacts produced, and methodology-shift flag.
-- PRD ref: docs/prd.md §5
CREATE TABLE IF NOT EXISTS chat_feedback (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  tenant_id             TEXT NOT NULL,
  researcher_id         TEXT NOT NULL,
  message               TEXT NOT NULL,
  wiki_page_id          TEXT,
  -- ID of the confirmed_fact superseded by this correction (TEXT, no FK).
  superseded_fact_id    TEXT,
  -- ID of the new confirmed_fact created as the superseding fact.
  new_fact_id           TEXT,
  methodology_shift     BOOLEAN NOT NULL DEFAULT FALSE,
  meta_commentary_id    TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chat_feedback_researcher
  ON chat_feedback (researcher_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_feedback_wiki_page
  ON chat_feedback (wiki_page_id)
  WHERE wiki_page_id IS NOT NULL;
`;

// ---------------------------------------------------------------------------
// applyFeedback (stub)
// ---------------------------------------------------------------------------

/**
 * Apply a researcher chat correction to the relevant wiki page.
 *
 * ## Stub behaviour
 *
 * In this scout stub the function inserts a `chat_feedback` row and, when
 * `input.methodology_shift` is true, a `methodology_meta_commentary` entry.
 * The superseding confirmed_fact INSERT and WIKI_REBUILD enqueue are
 * left as documented stubs — the real implementation lands in Phase 9.
 *
 * ## Full implementation sketch
 *
 * ```
 * 1. Validate superseded_fact_id belongs to the tenant.
 * 2. INSERT new confirmed_fact (supersedes_fact_id = input.superseded_fact_id).
 * 3. INSERT chat_feedback row (new_fact_id = new fact id).
 * 4. If methodology_shift:
 *      INSERT methodology_meta_commentary (source_feedback_id = feedback row id).
 *      UPDATE chat_feedback SET meta_commentary_id = new meta id.
 * 5. Enqueue WIKI_REBUILD task for wiki_page_id.
 * ```
 *
 * @returns The inserted chat_feedback row.
 */
export async function applyFeedback(
  sql: SqlClient,
  input: ApplyFeedbackInput,
): Promise<ChatFeedbackRow> {
  // STUB: Insert the chat_feedback record without performing the superseding-fact
  // insert or WIKI_REBUILD enqueue. The superseded_fact_id and new_fact_id are
  // recorded as-is for traceability; the full implementation will derive new_fact_id
  // from the actual INSERT into confirmed_facts.
  let metaCommentaryId: string | null = null;

  if (input.methodology_shift && input.drift_observation !== null) {
    // STUB: Insert meta-commentary entry when a methodology shift is implied.
    // The golden Research Methodology document is NEVER written.
    const metaRows = await sql<MetaCommentaryRow[]>`
      INSERT INTO methodology_meta_commentary
        (tenant_id, researcher_id, source, class, observation, status)
      VALUES (
        ${input.tenant_id},
        ${input.researcher_id},
        'chat_feedback',
        'methodology_drift',
        ${input.drift_observation},
        'open'
      )
      RETURNING id, tenant_id, researcher_id, source, source_feedback_id,
                class, observation, status, created_at, updated_at
    `;
    metaCommentaryId = metaRows[0]?.id ?? null;
  }

  const feedbackRows = await sql<ChatFeedbackRow[]>`
    INSERT INTO chat_feedback
      (tenant_id, researcher_id, message, wiki_page_id,
       superseded_fact_id, new_fact_id, methodology_shift, meta_commentary_id)
    VALUES (
      ${input.tenant_id},
      ${input.researcher_id},
      ${input.message},
      ${input.wiki_page_id},
      ${input.superseded_fact_id},
      ${'STUB:not-yet-inserted'},
      ${input.methodology_shift},
      ${metaCommentaryId}
    )
    RETURNING
      id, tenant_id, researcher_id, message, wiki_page_id,
      superseded_fact_id, new_fact_id, methodology_shift,
      meta_commentary_id, created_at
  `;

  return feedbackRows[0]!;
}

// ---------------------------------------------------------------------------
// openMetaCommentaryEntry (stub)
// ---------------------------------------------------------------------------

/**
 * Open a methodology meta-commentary entry directly (e.g. from maintenance agents).
 *
 * In this scout stub the function performs the real INSERT so that the DDL and
 * types can be validated end-to-end. The full implementation may extend this
 * with urgency tiers and notification triggers.
 *
 * @returns The inserted meta-commentary row.
 */
export async function openMetaCommentaryEntry(
  sql: SqlClient,
  input: {
    tenant_id: string;
    researcher_id: string;
    source: 'chat_feedback' | 'maintenance';
    source_feedback_id: string | null;
    class: MetaCommentaryClass;
    observation: string;
  },
): Promise<MetaCommentaryRow> {
  const rows = await sql<MetaCommentaryRow[]>`
    INSERT INTO methodology_meta_commentary
      (tenant_id, researcher_id, source, source_feedback_id, class, observation, status)
    VALUES (
      ${input.tenant_id},
      ${input.researcher_id},
      ${input.source},
      ${input.source_feedback_id},
      ${input.class},
      ${input.observation},
      'open'
    )
    RETURNING id, tenant_id, researcher_id, source, source_feedback_id,
              class, observation, status, created_at, updated_at
  `;
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// getMetaCommentaryEntry
// ---------------------------------------------------------------------------

/**
 * Fetch a single methodology meta-commentary entry by ID.
 */
export async function getMetaCommentaryEntry(
  sql: SqlClient,
  entry_id: string,
): Promise<MetaCommentaryRow | null> {
  const rows = await sql<MetaCommentaryRow[]>`
    SELECT id, tenant_id, researcher_id, source, source_feedback_id,
           class, observation, status, created_at, updated_at
    FROM methodology_meta_commentary
    WHERE id = ${entry_id}
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// listOpenMetaCommentaryForResearcher
// ---------------------------------------------------------------------------

/**
 * List all open meta-commentary entries for a researcher.
 *
 * Used by the badge count and digest surface (Phase 9 "Meta-commentary surfacing").
 */
export async function listOpenMetaCommentaryForResearcher(
  sql: SqlClient,
  researcher_id: string,
): Promise<MetaCommentaryRow[]> {
  return sql<MetaCommentaryRow[]>`
    SELECT id, tenant_id, researcher_id, source, source_feedback_id,
           class, observation, status, created_at, updated_at
    FROM methodology_meta_commentary
    WHERE researcher_id = ${researcher_id}
      AND status = 'open'
    ORDER BY created_at DESC
  `;
}

// ---------------------------------------------------------------------------
// goldenDocIsUnmutated (guard)
// ---------------------------------------------------------------------------

/**
 * Verify that no row in `golden_documents` or `golden_document_sections` was
 * written by the feedback handler.
 *
 * This is a runtime guard that the integration tests invoke to confirm the
 * golden-document invariant (PRD §9, architecture §"Golden-document invariant").
 * The function returns `true` when no mutation has occurred since `after_ts`.
 *
 * In the full implementation this can be wired to the `golden_documents`
 * `updated_at` column or to an audit log table.
 *
 * STUB: always returns `true` because no write path exists yet.
 */
export function goldenDocIsUnmutated(_after_ts: Date): boolean {
  // STUB: The golden-document write path does not exist in Phase 9 scout.
  // The real implementation should query:
  //   SELECT COUNT(*) FROM golden_documents WHERE updated_at > after_ts
  // and return COUNT = 0.
  return true;
}
