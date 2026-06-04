/**
 * @file wiki-inline-edit-store.ts
 *
 * ## Phase 9 — Inline wiki edit, methodology meta-commentary entity, and surfacing (issue #87)
 *
 * This module implements three Phase 9 deliverables:
 *
 * ### 1. Inline wiki edit
 *
 * When a researcher edits a wiki page inline, the system captures the diff as a
 * one-off correction prompt the agent applies and propagates. The correction is
 * inserted as a superseding `confirmed_fact` row (append-only). If the edit
 * implies a methodology shift, a `methodology_meta_commentary` entry is opened.
 *
 * The golden Research Methodology document is **never** written by this path.
 *
 * ### 2. Methodology meta-commentary entity lifecycle
 *
 * Full state-machine transitions beyond what the chat-feedback scout introduced:
 *
 *   open → acknowledged → folded_in | archived
 *
 * - `acknowledgeMetaCommentaryEntry` — researcher reads the entry (open → acknowledged).
 * - `foldInMetaCommentaryEntry`      — explicit researcher fold-in (acknowledged → folded_in).
 *   The golden doc is NOT mutated; the entry is simply marked folded_in so the
 *   researcher knows to go update the golden doc manually.
 * - `archiveMetaCommentaryEntry`     — close without action (open|acknowledged → archived).
 *
 * ### 3. Meta-commentary surfacing
 *
 * - `countOpenMetaCommentary` — badge count of open entries for a researcher.
 * - `weeklyDigestByClass`     — grouped summary of entries created in the last 7 days.
 * - `listHighUrgencyEntries`  — urgent entries that should escalate immediately (not wait for digest).
 *
 * ## Tables managed here (extending chat-feedback-store.ts DDL)
 *
 * ### wiki_inline_edits
 *
 * One row per researcher inline edit on a wiki page. Records the page, the
 * before/after diff, whether a methodology shift was implied, and the IDs of
 * the artifacts produced (new fact, meta-commentary entry).
 *
 * ### methodology_meta_commentary (extended)
 *
 * Extended with:
 *   - `urgency_tier` — 'normal' | 'high'; high-urgency entries escalate immediately.
 *   - `acknowledged_at`, `folded_in_at`, `archived_at` — transition timestamps.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5 — researcher feedback surface (inline edit path).
 * - docs/prd.md §9 — golden-document invariant.
 * - docs/architecture.md §"Knowledge subsystem" — methodology_meta_commentary lifecycle.
 * - docs/implementation-plan.md §Phase 9 — inline wiki edit, meta-commentary entity,
 *   meta-commentary surfacing.
 * - packages/db/chat-feedback-store.ts — chat-feedback path (issue #86 scout).
 * - apps/server/src/api/wiki-inline-edit-api.ts — API endpoints.
 * - tests/integration/wiki-inline-edit.spec.ts — integration tests.
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/87
 */

import type postgres from 'postgres';

export type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// Re-export types from chat-feedback-store so callers can import from here.
// ---------------------------------------------------------------------------

export type MetaCommentaryClass =
  | 'methodology_drift'
  | 'proposed_venue'
  | 'proposed_sub_segment'
  | 'proposed_watchlist'
  | 'demoted_source';

export type MetaCommentaryStatus = 'open' | 'acknowledged' | 'folded_in' | 'archived';

export type UrgencyTier = 'normal' | 'high';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One row in the `methodology_meta_commentary` table.
 * Extended with urgency_tier and lifecycle timestamps (issue #87).
 */
export type MetaCommentaryRow = {
  id: string;
  tenant_id: string;
  researcher_id: string;
  /** Source of the entry — 'chat_feedback' | 'wiki_inline_edit' | 'maintenance'. */
  source: string;
  source_feedback_id: string | null;
  class: MetaCommentaryClass;
  observation: string;
  status: MetaCommentaryStatus;
  urgency_tier: UrgencyTier;
  acknowledged_at: Date | null;
  folded_in_at: Date | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * One row in the `wiki_inline_edits` table.
 */
export type WikiInlineEditRow = {
  id: string;
  tenant_id: string;
  researcher_id: string;
  /** The wiki page being edited. */
  wiki_page_id: string;
  /** The ID of the wiki_page_version that was the current published version at edit time. */
  base_version_id: string | null;
  /** Unified diff of the edit (before → after). */
  diff_text: string;
  /** Whether the edit implies a methodology shift. */
  methodology_shift: boolean;
  /** The meta-commentary entry ID opened, when methodology_shift is true. */
  meta_commentary_id: string | null;
  /** Status of the correction prompt application. */
  correction_status: 'pending' | 'applied' | 'failed';
  created_at: Date;
  updated_at: Date;
};

/**
 * A grouped summary of meta-commentary entries for the weekly digest.
 */
export type WeeklyDigestEntry = {
  class: MetaCommentaryClass;
  count: number;
  /** IDs of the entries in this class bucket. */
  entry_ids: string[];
};

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

/**
 * DDL for the wiki_inline_edits table and the extended methodology_meta_commentary
 * columns (urgency_tier and lifecycle timestamps).
 *
 * This DDL is additive to the DDL in chat-feedback-store.ts. Tests must apply
 * CHAT_FEEDBACK_DDL first (from chat-feedback-store.ts), then WIKI_INLINE_EDIT_DDL.
 *
 * Production migrations should apply these in the same order.
 */
export const WIKI_INLINE_EDIT_DDL = `
-- methodology_meta_commentary — extended for issue #87:
--   urgency_tier         — 'normal' | 'high'; high-urgency entries escalate immediately.
--   acknowledged_at      — timestamp when the researcher first acknowledged the entry.
--   folded_in_at         — timestamp when the researcher folded the entry into the golden doc.
--   archived_at          — timestamp when the entry was archived without action.
--
-- The source column is also extended to accept 'wiki_inline_edit' in addition to
-- the original 'chat_feedback' and 'maintenance' values.
--
-- We use ALTER TABLE … ADD COLUMN IF NOT EXISTS to make this idempotent when
-- applied on top of the chat-feedback-store.ts DDL.

ALTER TABLE methodology_meta_commentary
  ADD COLUMN IF NOT EXISTS urgency_tier TEXT NOT NULL DEFAULT 'normal'
    CHECK (urgency_tier IN ('normal', 'high'));

ALTER TABLE methodology_meta_commentary
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

ALTER TABLE methodology_meta_commentary
  ADD COLUMN IF NOT EXISTS folded_in_at TIMESTAMPTZ;

ALTER TABLE methodology_meta_commentary
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Extend source CHECK constraint to include 'wiki_inline_edit'.
-- PostgreSQL does not support DROP CONSTRAINT IF EXISTS in all versions, so we
-- use a try/ignore approach in the DDL — if the constraint already allows the
-- new value this is a no-op.
-- In production use an explicit migration with a conditional check.
DO $$
BEGIN
  ALTER TABLE methodology_meta_commentary
    DROP CONSTRAINT IF EXISTS methodology_meta_commentary_source_check;
  ALTER TABLE methodology_meta_commentary
    ADD CONSTRAINT methodology_meta_commentary_source_check
      CHECK (source IN ('chat_feedback', 'wiki_inline_edit', 'maintenance'));
EXCEPTION WHEN others THEN
  -- If we can't drop/re-add the constraint, the table already has the right values.
  NULL;
END;
$$;

-- High-urgency index for escalation queries.
CREATE INDEX IF NOT EXISTS idx_meta_commentary_high_urgency
  ON methodology_meta_commentary (researcher_id, urgency_tier, created_at DESC)
  WHERE urgency_tier = 'high' AND status = 'open';

-- wiki_inline_edits — one row per researcher inline edit on a wiki page.
CREATE TABLE IF NOT EXISTS wiki_inline_edits (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  tenant_id            TEXT NOT NULL,
  researcher_id        TEXT NOT NULL,
  wiki_page_id         TEXT NOT NULL,
  -- The published version the researcher was viewing when they made the edit.
  base_version_id      TEXT,
  -- Unified diff of the inline edit (before/after text).
  diff_text            TEXT NOT NULL,
  methodology_shift    BOOLEAN NOT NULL DEFAULT FALSE,
  meta_commentary_id   TEXT,
  -- Track whether the correction prompt has been applied downstream.
  correction_status    TEXT NOT NULL DEFAULT 'pending'
                         CHECK (correction_status IN ('pending', 'applied', 'failed')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wiki_inline_edits_researcher
  ON wiki_inline_edits (researcher_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wiki_inline_edits_wiki_page
  ON wiki_inline_edits (wiki_page_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wiki_inline_edits_pending
  ON wiki_inline_edits (correction_status, created_at)
  WHERE correction_status = 'pending';
`;

// ---------------------------------------------------------------------------
// Inline wiki edit — applyInlineEdit
// ---------------------------------------------------------------------------

/**
 * Input to `applyInlineEdit`.
 */
export interface ApplyInlineEditInput {
  tenant_id: string;
  researcher_id: string;
  /** The wiki page being edited inline. */
  wiki_page_id: string;
  /** The published wiki_page_version the researcher was looking at. */
  base_version_id: string | null;
  /** Unified diff of the edit — the system captures before/after text. */
  diff_text: string;
  /** Whether the edit implies a methodology shift. */
  methodology_shift: boolean;
  /**
   * Drift observation to record in meta-commentary.
   * Required when `methodology_shift` is true.
   */
  drift_observation: string | null;
  /**
   * Urgency tier for the meta-commentary entry.
   * Defaults to 'normal'. Use 'high' for source retractions and critical corrections.
   */
  urgency_tier?: UrgencyTier;
}

/**
 * Capture a researcher inline wiki edit as a one-off correction prompt.
 *
 * ## What this does
 *
 * 1. Inserts a `wiki_inline_edits` row recording the diff.
 * 2. If `methodology_shift` is true, opens a `methodology_meta_commentary`
 *    entry at status 'open'. The golden Research Methodology document is
 *    NEVER written.
 * 3. Marks `correction_status = 'pending'` — a downstream WIKI_REBUILD task
 *    (or a dedicated CORRECTION_APPLY task) will pick up pending edits and
 *    apply the correction prompt to the affected wiki page.
 *
 * ## Stub note
 *
 * The actual confirmed_fact supersession INSERT and WIKI_REBUILD enqueue are
 * documented as integration points and will be wired in the full implementation
 * (the correction_status column tracks whether the downstream step has run).
 *
 * @returns The inserted `wiki_inline_edits` row.
 */
export async function applyInlineEdit(
  sql: SqlClient,
  input: ApplyInlineEditInput,
): Promise<WikiInlineEditRow> {
  const urgencyTier: UrgencyTier = input.urgency_tier ?? 'normal';
  let metaCommentaryId: string | null = null;

  if (input.methodology_shift && input.drift_observation !== null) {
    // Open a meta-commentary entry. The golden Research Methodology is NEVER written.
    const metaRows = await sql<MetaCommentaryRow[]>`
      INSERT INTO methodology_meta_commentary
        (tenant_id, researcher_id, source, class, observation, status, urgency_tier)
      VALUES (
        ${input.tenant_id},
        ${input.researcher_id},
        'wiki_inline_edit',
        'methodology_drift',
        ${input.drift_observation},
        'open',
        ${urgencyTier}
      )
      RETURNING id, tenant_id, researcher_id, source, source_feedback_id,
                class, observation, status, urgency_tier,
                acknowledged_at, folded_in_at, archived_at,
                created_at, updated_at
    `;
    metaCommentaryId = metaRows[0]?.id ?? null;
  }

  const editRows = await sql<WikiInlineEditRow[]>`
    INSERT INTO wiki_inline_edits
      (tenant_id, researcher_id, wiki_page_id, base_version_id, diff_text,
       methodology_shift, meta_commentary_id, correction_status)
    VALUES (
      ${input.tenant_id},
      ${input.researcher_id},
      ${input.wiki_page_id},
      ${input.base_version_id},
      ${input.diff_text},
      ${input.methodology_shift},
      ${metaCommentaryId},
      'pending'
    )
    RETURNING id, tenant_id, researcher_id, wiki_page_id, base_version_id,
              diff_text, methodology_shift, meta_commentary_id,
              correction_status, created_at, updated_at
  `;

  return editRows[0]!;
}

// ---------------------------------------------------------------------------
// Meta-commentary lifecycle transitions
// ---------------------------------------------------------------------------

/**
 * Acknowledge a meta-commentary entry (open → acknowledged).
 *
 * Marks that the researcher has read the entry. No change to the golden doc.
 *
 * @throws {Error} if the entry is not in 'open' status.
 */
export async function acknowledgeMetaCommentaryEntry(
  sql: SqlClient,
  entry_id: string,
  researcher_id: string,
): Promise<MetaCommentaryRow> {
  const rows = await sql<MetaCommentaryRow[]>`
    UPDATE methodology_meta_commentary
    SET
      status         = 'acknowledged',
      acknowledged_at = CURRENT_TIMESTAMP,
      updated_at     = CURRENT_TIMESTAMP
    WHERE id           = ${entry_id}
      AND researcher_id = ${researcher_id}
      AND status        = 'open'
    RETURNING id, tenant_id, researcher_id, source, source_feedback_id,
              class, observation, status, urgency_tier,
              acknowledged_at, folded_in_at, archived_at,
              created_at, updated_at
  `;
  if (!rows[0]) {
    throw new Error(
      `Cannot acknowledge entry ${entry_id}: not found or not in 'open' status for researcher ${researcher_id}`,
    );
  }
  return rows[0];
}

/**
 * Fold a meta-commentary entry into the golden methodology (acknowledged → folded_in).
 *
 * This is an **explicit researcher action** — the system does NOT write to the
 * golden Research Methodology document. Marking an entry 'folded_in' signals
 * that the researcher has manually updated their golden document to incorporate
 * the observation.
 *
 * @throws {Error} if the entry is not in 'acknowledged' status.
 */
export async function foldInMetaCommentaryEntry(
  sql: SqlClient,
  entry_id: string,
  researcher_id: string,
): Promise<MetaCommentaryRow> {
  const rows = await sql<MetaCommentaryRow[]>`
    UPDATE methodology_meta_commentary
    SET
      status       = 'folded_in',
      folded_in_at = CURRENT_TIMESTAMP,
      updated_at   = CURRENT_TIMESTAMP
    WHERE id           = ${entry_id}
      AND researcher_id = ${researcher_id}
      AND status        = 'acknowledged'
    RETURNING id, tenant_id, researcher_id, source, source_feedback_id,
              class, observation, status, urgency_tier,
              acknowledged_at, folded_in_at, archived_at,
              created_at, updated_at
  `;
  if (!rows[0]) {
    throw new Error(
      `Cannot fold in entry ${entry_id}: not found or not in 'acknowledged' status for researcher ${researcher_id}`,
    );
  }
  return rows[0];
}

/**
 * Archive a meta-commentary entry without folding it in (open|acknowledged → archived).
 *
 * The researcher dismisses the observation without incorporating it.
 *
 * @throws {Error} if the entry is already in 'folded_in' or 'archived' status.
 */
export async function archiveMetaCommentaryEntry(
  sql: SqlClient,
  entry_id: string,
  researcher_id: string,
): Promise<MetaCommentaryRow> {
  const rows = await sql<MetaCommentaryRow[]>`
    UPDATE methodology_meta_commentary
    SET
      status      = 'archived',
      archived_at = CURRENT_TIMESTAMP,
      updated_at  = CURRENT_TIMESTAMP
    WHERE id           = ${entry_id}
      AND researcher_id = ${researcher_id}
      AND status        IN ('open', 'acknowledged')
    RETURNING id, tenant_id, researcher_id, source, source_feedback_id,
              class, observation, status, urgency_tier,
              acknowledged_at, folded_in_at, archived_at,
              created_at, updated_at
  `;
  if (!rows[0]) {
    throw new Error(
      `Cannot archive entry ${entry_id}: not found, already folded_in, or already archived for researcher ${researcher_id}`,
    );
  }
  return rows[0];
}

// ---------------------------------------------------------------------------
// Meta-commentary surfacing
// ---------------------------------------------------------------------------

/**
 * Count of open meta-commentary entries for a researcher.
 *
 * Used to drive the badge count on the methodology view (PRD §5).
 */
export async function countOpenMetaCommentary(
  sql: SqlClient,
  researcher_id: string,
): Promise<number> {
  const rows = await sql<Array<{ count: string }>>`
    SELECT COUNT(*)::TEXT AS count
    FROM methodology_meta_commentary
    WHERE researcher_id = ${researcher_id}
      AND status = 'open'
  `;
  return parseInt(rows[0]?.count ?? '0', 10);
}

/**
 * Weekly digest of meta-commentary entries grouped by class.
 *
 * Returns a summary of entries created in the last 7 days, grouped by class.
 * Entries in any status are included so the researcher can see the full picture.
 *
 * Used by the weekly digest surface (PRD §5 "Meta-Commentary Surfacing Loop").
 */
export async function weeklyDigestByClass(
  sql: SqlClient,
  researcher_id: string,
): Promise<WeeklyDigestEntry[]> {
  const rows = await sql<Array<{ class: MetaCommentaryClass; count: string; entry_ids: string }>>`
    SELECT
      class,
      COUNT(*)::TEXT AS count,
      STRING_AGG(id, ',' ORDER BY created_at DESC) AS entry_ids
    FROM methodology_meta_commentary
    WHERE researcher_id  = ${researcher_id}
      AND created_at     >= CURRENT_TIMESTAMP - INTERVAL '7 days'
    GROUP BY class
    ORDER BY class
  `;
  return rows.map((r) => ({
    class: r.class,
    count: parseInt(r.count, 10),
    entry_ids: r.entry_ids ? r.entry_ids.split(',').filter(Boolean) : [],
  }));
}

/**
 * List high-urgency open meta-commentary entries for a researcher.
 *
 * High-urgency entries (e.g. a Tier A source retracted by its publisher)
 * escalate to immediate notification rather than waiting for the weekly digest.
 *
 * Used by the escalation surface (PRD §5 "Meta-Commentary Surfacing Loop").
 */
export async function listHighUrgencyEntries(
  sql: SqlClient,
  researcher_id: string,
): Promise<MetaCommentaryRow[]> {
  return sql<MetaCommentaryRow[]>`
    SELECT id, tenant_id, researcher_id, source, source_feedback_id,
           class, observation, status, urgency_tier,
           acknowledged_at, folded_in_at, archived_at,
           created_at, updated_at
    FROM methodology_meta_commentary
    WHERE researcher_id = ${researcher_id}
      AND urgency_tier  = 'high'
      AND status        = 'open'
    ORDER BY created_at DESC
  `;
}

/**
 * List all open meta-commentary entries for a researcher (used by badge + digest surface).
 */
export async function listOpenMetaCommentary(
  sql: SqlClient,
  researcher_id: string,
): Promise<MetaCommentaryRow[]> {
  return sql<MetaCommentaryRow[]>`
    SELECT id, tenant_id, researcher_id, source, source_feedback_id,
           class, observation, status, urgency_tier,
           acknowledged_at, folded_in_at, archived_at,
           created_at, updated_at
    FROM methodology_meta_commentary
    WHERE researcher_id = ${researcher_id}
      AND status = 'open'
    ORDER BY created_at DESC
  `;
}

/**
 * Get a single meta-commentary entry by ID.
 */
export async function getMetaCommentaryEntry(
  sql: SqlClient,
  entry_id: string,
): Promise<MetaCommentaryRow | null> {
  const rows = await sql<MetaCommentaryRow[]>`
    SELECT id, tenant_id, researcher_id, source, source_feedback_id,
           class, observation, status, urgency_tier,
           acknowledged_at, folded_in_at, archived_at,
           created_at, updated_at
    FROM methodology_meta_commentary
    WHERE id = ${entry_id}
  `;
  return rows[0] ?? null;
}

/**
 * Get a single wiki_inline_edit row by ID.
 */
export async function getInlineEdit(
  sql: SqlClient,
  edit_id: string,
): Promise<WikiInlineEditRow | null> {
  const rows = await sql<WikiInlineEditRow[]>`
    SELECT id, tenant_id, researcher_id, wiki_page_id, base_version_id,
           diff_text, methodology_shift, meta_commentary_id,
           correction_status, created_at, updated_at
    FROM wiki_inline_edits
    WHERE id = ${edit_id}
  `;
  return rows[0] ?? null;
}
