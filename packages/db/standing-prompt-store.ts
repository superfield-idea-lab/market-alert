/**
 * @file standing-prompt-store.ts
 *
 * DB access layer for the standing-prompt distillation pipeline — issue #79.
 *
 * ## Design
 *
 * Workers never call this module directly. They POST to internal API endpoints
 * on apps/server; only apps/server holds DB credentials and calls into this
 * module (WORKER-T-001).
 *
 * ## Tables managed here
 *
 * ### standing_prompts
 *
 * One row per (researcher, subject_type, subject_id) triple. The three subject
 * types correspond to the prompt family (PRD §5, §6):
 *   - `entity`    — per Company/Ticker on the watchlist (default, most specific)
 *   - `thesis`    — per named thesis spanning multiple entities (methodology-declared)
 *   - `portfolio` — coarser portfolio-level fallback (one per researcher)
 *
 * The `currently_active_version_id` pointer is advanced to a new
 * `standing_prompt_versions` row only when its status reaches `active`.
 * Reading code always follows `currently_active_version_id`; in-progress
 * version rows with status < `active` are never exposed to readers.
 *
 * ### standing_prompt_versions (status pipeline)
 *
 * Status pipeline mirrors wiki_page_versions_mkt:
 *   draft → active
 *
 * A new `active` version supersedes the previous `active` version for the same
 * (standing_prompt_id) by flipping the prior row's status to `superseded`.
 *
 * ### Pin / override (PRD §5, §7)
 *
 * A researcher may pin any Active version. Pinned prompts block automatic
 * replacement: `activateStandingPromptVersion` returns early without superseding
 * the pinned version. Pin state is stored in `standing_prompt_versions.is_pinned`.
 *
 * ### Lifecycle transitions
 *
 * - `draft`      — distillation is in-progress; not yet visible to readers.
 * - `active`     — the current effective prompt; exactly one row per
 *                  standing_prompt_id should be `active` at any given time.
 * - `superseded` — this version was Active and has been replaced by a newer version.
 *
 * ## Idempotency
 *
 * `insertStandingPromptVersion` uses a `wiki_version_window` key so that
 * re-running the distiller on the same window of published wiki versions produces
 * no new row (ON CONFLICT DO NOTHING on the unique index over
 * (standing_prompt_id, wiki_version_window)).
 *
 * ## Debounce
 *
 * The debounce is implemented by the 5-minute bucket in wiki_version_window.
 * A burst of wiki publishes within the same 5-minute window maps to the same
 * (standing_prompt_id, wiki_version_window) key, so only the first distillation
 * task creates a new version row; subsequent tasks exit early via idempotency.
 *
 * ## Length bound
 *
 * PRD §9 hard ceiling: ~250 words. Target: ~100 words. The `assertWithinLengthBound`
 * helper counts whitespace-delimited words and throws if the bound is exceeded.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5, §6, §7 — standing prompt family, routing, pin/override
 * - docs/prd.md §9 — standing prompt hard ceiling
 * - docs/prd.md §10 — distillation cadence
 * - docs/architecture.md §"Standing prompt as derived artifact"
 * - packages/db/mkt-schema.sql — DDL (standing_prompts, standing_prompt_versions)
 * - apps/worker/src/standing-prompt-distill-job.ts — worker handler
 * - apps/server/src/api/standing-prompt-distill-api.ts — internal API endpoints
 * - tests/integration/standing-prompt-family.spec.ts — integration tests (issue #79)
 * - tests/integration/standing-prompt-distill.spec.ts — integration tests (issue #78)
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/79
 * @see https://github.com/superfield-idea-lab/market-alert/issues/78
 */

import type postgres from 'postgres';

export type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// Subject types
// ---------------------------------------------------------------------------

/**
 * The three subject types in the standing-prompt family (PRD §5, §6).
 *
 * - `entity`    — per Company/Ticker on the watchlist (default, most specific)
 * - `thesis`    — per named thesis spanning multiple entities (methodology-declared)
 * - `portfolio` — coarser portfolio-level fallback (one per researcher, subject_id = 'portfolio')
 */
export type StandingPromptSubjectType = 'entity' | 'thesis' | 'portfolio';

// ---------------------------------------------------------------------------
// standing_prompts
// ---------------------------------------------------------------------------

export type StandingPromptRow = {
  id: string;
  tenant_id: string;
  researcher_id: string;
  subject_type: StandingPromptSubjectType;
  subject_id: string;
  currently_active_version_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export interface UpsertStandingPromptInput {
  tenant_id: string;
  researcher_id: string;
  /** Subject type: entity (per-ticker), thesis (named thesis), or portfolio (fallback). */
  subject_type: StandingPromptSubjectType;
  /**
   * Subject identifier.
   * - For entity: the ticker/company id.
   * - For thesis: the thesis name/id.
   * - For portfolio: use the constant `'portfolio'`.
   */
  subject_id: string;
}

/**
 * Upsert a standing_prompts row for a (researcher, subject_type, subject_id) triple.
 *
 * Returns the row. Creates a fresh row if none exists; returns the existing row
 * otherwise. The `currently_active_version_id` pointer is only updated by
 * `activateStandingPromptVersion`, not here.
 */
export async function upsertStandingPrompt(
  sql: SqlClient,
  input: UpsertStandingPromptInput,
): Promise<StandingPromptRow> {
  const [row] = await sql<StandingPromptRow[]>`
    INSERT INTO standing_prompts (tenant_id, researcher_id, subject_type, subject_id)
    VALUES (${input.tenant_id}, ${input.researcher_id}, ${input.subject_type}, ${input.subject_id})
    ON CONFLICT (tenant_id, researcher_id, subject_type, subject_id) DO UPDATE
      SET updated_at = CURRENT_TIMESTAMP
    RETURNING id, tenant_id, researcher_id, subject_type, subject_id,
              currently_active_version_id, created_at, updated_at
  `;
  return row;
}

/**
 * Fetch a standing_prompts row by researcher and subject.
 *
 * Returns null if no row exists for the (researcher, subject_type, subject_id) triple.
 */
export async function getStandingPrompt(
  sql: SqlClient,
  tenant_id: string,
  researcher_id: string,
  subject_type: StandingPromptSubjectType,
  subject_id: string,
): Promise<StandingPromptRow | null> {
  const rows = await sql<StandingPromptRow[]>`
    SELECT id, tenant_id, researcher_id, subject_type, subject_id,
           currently_active_version_id, created_at, updated_at
    FROM standing_prompts
    WHERE tenant_id     = ${tenant_id}
      AND researcher_id = ${researcher_id}
      AND subject_type  = ${subject_type}
      AND subject_id    = ${subject_id}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// standing_prompt_versions
// ---------------------------------------------------------------------------

/**
 * Status lifecycle for a standing_prompt_version row.
 *
 * - `draft`      — distillation in-progress; hidden from readers.
 * - `active`     — current effective prompt; exactly one per researcher.
 * - `superseded` — was active; replaced by a newer version.
 */
export type StandingPromptVersionStatus = 'draft' | 'active' | 'superseded';

export type StandingPromptVersionRow = {
  id: string;
  standing_prompt_id: string;
  tenant_id: string;
  researcher_id: string;
  /**
   * ISO-8601 timestamp bucket identifying the window of wiki_page_versions
   * that triggered this distillation pass. Used as the idempotency key.
   * Format: `YYYY-MM-DDTHH:MM` (5-minute bucket).
   */
  wiki_version_window: string;
  /** Markdown body of the distilled prompt. Bounded at ~250 words. */
  body: string | null;
  status: StandingPromptVersionStatus;
  word_count: number | null;
  /**
   * When true, this version is pinned by the researcher (PRD §7).
   * Pinned prompts block automatic replacement: `activateStandingPromptVersion`
   * will not supersede a pinned Active version.
   */
  is_pinned: boolean;
  created_at: Date;
  updated_at: Date;
};

export interface InsertStandingPromptVersionInput {
  standing_prompt_id: string;
  tenant_id: string;
  researcher_id: string;
  wiki_version_window: string;
}

/**
 * Insert a new draft standing_prompt_version row.
 *
 * Idempotent: if a row already exists for (standing_prompt_id, wiki_version_window),
 * returns `{ row, created: false }` without inserting a duplicate.
 * This implements the debounce: a burst of wiki publishes within the same
 * 5-minute window maps to the same key, so only the first distillation task
 * creates a new version row; subsequent tasks exit early via idempotency.
 */
export async function insertStandingPromptVersion(
  sql: SqlClient,
  input: InsertStandingPromptVersionInput,
): Promise<{ row: StandingPromptVersionRow; created: boolean }> {
  const inserted = await sql<StandingPromptVersionRow[]>`
    INSERT INTO standing_prompt_versions
      (standing_prompt_id, tenant_id, researcher_id, wiki_version_window)
    VALUES (
      ${input.standing_prompt_id},
      ${input.tenant_id},
      ${input.researcher_id},
      ${input.wiki_version_window}
    )
    ON CONFLICT (standing_prompt_id, wiki_version_window) DO NOTHING
    RETURNING id, standing_prompt_id, tenant_id, researcher_id, wiki_version_window,
              body, status, word_count, is_pinned, created_at, updated_at
  `;

  if (inserted.length > 0) {
    return { row: inserted[0], created: true };
  }

  // Row already existed — fetch it.
  const existing = await sql<StandingPromptVersionRow[]>`
    SELECT id, standing_prompt_id, tenant_id, researcher_id, wiki_version_window,
           body, status, word_count, is_pinned, created_at, updated_at
    FROM standing_prompt_versions
    WHERE standing_prompt_id    = ${input.standing_prompt_id}
      AND wiki_version_window   = ${input.wiki_version_window}
    LIMIT 1
  `;
  return { row: existing[0], created: false };
}

/**
 * Result of `activateStandingPromptVersion`.
 */
export type ActivateStandingPromptVersionResult =
  | { activated: true; row: StandingPromptVersionRow }
  | { activated: false; reason: 'pinned'; pinnedVersionId: string };

/**
 * Set the body of a draft standing_prompt_version.
 *
 * Validates the word count against the hard ceiling before persisting.
 * Advances status to `active` and patches the `standing_prompts` pointer
 * inside a single transaction; the prior active version is flipped to
 * `superseded` in the same transaction.
 *
 * ## Pin protection (PRD §7)
 *
 * If the currently active version has `is_pinned = true`, this function returns
 * `{ activated: false, reason: 'pinned' }` without superseding the pinned version
 * or activating the new draft. The draft version remains in `draft` status.
 *
 * Only callable on a row currently in `draft` status.
 */
export async function activateStandingPromptVersion(
  sql: SqlClient,
  opts: {
    standing_prompt_id: string;
    standing_prompt_version_id: string;
    body: string;
  },
): Promise<ActivateStandingPromptVersionResult> {
  const wordCount = countWords(opts.body);
  assertWithinLengthBound(wordCount);

  const result = await sql.begin(async (txRaw) => {
    // postgres.TransactionSql extends Sql at runtime; the cast is safe.
    const tx = txRaw as unknown as SqlClient;

    // Check if the currently active version is pinned (PRD §7).
    type PinnedCheckRow = { id: string; is_pinned: boolean };
    const pinnedCheck = await tx<PinnedCheckRow[]>`
      SELECT spv.id, spv.is_pinned
      FROM standing_prompt_versions spv
      WHERE spv.standing_prompt_id = ${opts.standing_prompt_id}
        AND spv.status = 'active'
      LIMIT 1
    `;
    if (pinnedCheck.length > 0 && pinnedCheck[0].is_pinned) {
      // Active version is pinned — do not supersede or activate.
      return {
        activated: false as const,
        reason: 'pinned' as const,
        pinnedVersionId: pinnedCheck[0].id,
      };
    }

    // Supersede the currently active version, if any.
    await tx`
      UPDATE standing_prompt_versions
      SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
      WHERE standing_prompt_id = ${opts.standing_prompt_id}
        AND status = 'active'
    `;

    // Activate the new version.
    const updated = await tx<StandingPromptVersionRow[]>`
      UPDATE standing_prompt_versions
      SET body       = ${opts.body},
          word_count = ${wordCount},
          status     = 'active',
          updated_at = CURRENT_TIMESTAMP
      WHERE id     = ${opts.standing_prompt_version_id}
        AND status = 'draft'
      RETURNING id, standing_prompt_id, tenant_id, researcher_id, wiki_version_window,
                body, status, word_count, is_pinned, created_at, updated_at
    `;

    // Advance the currently_active_version_id pointer on the parent row.
    await tx`
      UPDATE standing_prompts
      SET currently_active_version_id = ${opts.standing_prompt_version_id},
          updated_at                  = CURRENT_TIMESTAMP
      WHERE id = ${opts.standing_prompt_id}
    `;

    return { activated: true as const, row: updated[0] };
  });

  return result as ActivateStandingPromptVersionResult;
}

/**
 * Fetch the currently active standing_prompt_version for a researcher and subject.
 *
 * Returns null if no active version exists.
 */
export async function getActiveStandingPromptVersion(
  sql: SqlClient,
  tenant_id: string,
  researcher_id: string,
  subject_type: StandingPromptSubjectType,
  subject_id: string,
): Promise<StandingPromptVersionRow | null> {
  const rows = await sql<StandingPromptVersionRow[]>`
    SELECT spv.id, spv.standing_prompt_id, spv.tenant_id, spv.researcher_id,
           spv.wiki_version_window, spv.body, spv.status, spv.word_count,
           spv.is_pinned, spv.created_at, spv.updated_at
    FROM standing_prompt_versions spv
    JOIN standing_prompts sp
      ON sp.id = spv.standing_prompt_id
    WHERE sp.tenant_id     = ${tenant_id}
      AND sp.researcher_id = ${researcher_id}
      AND sp.subject_type  = ${subject_type}
      AND sp.subject_id    = ${subject_id}
      AND spv.status       = 'active'
    ORDER BY spv.created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Pin / unpin
// ---------------------------------------------------------------------------

/**
 * Pin the currently active standing_prompt_version for a prompt.
 *
 * Once pinned, automatic distillation will not supersede this version (PRD §7).
 * Returns the updated version row, or null if no active version exists.
 */
export async function pinActiveStandingPromptVersion(
  sql: SqlClient,
  standing_prompt_id: string,
): Promise<StandingPromptVersionRow | null> {
  const rows = await sql<StandingPromptVersionRow[]>`
    UPDATE standing_prompt_versions
    SET is_pinned  = true,
        updated_at = CURRENT_TIMESTAMP
    WHERE standing_prompt_id = ${standing_prompt_id}
      AND status             = 'active'
    RETURNING id, standing_prompt_id, tenant_id, researcher_id, wiki_version_window,
              body, status, word_count, is_pinned, created_at, updated_at
  `;
  return rows[0] ?? null;
}

/**
 * Unpin the currently active standing_prompt_version for a prompt.
 *
 * After unpinning, automatic distillation may supersede this version on the
 * next wiki publish event (PRD §7).
 * Returns the updated version row, or null if no active version exists.
 */
export async function unpinActiveStandingPromptVersion(
  sql: SqlClient,
  standing_prompt_id: string,
): Promise<StandingPromptVersionRow | null> {
  const rows = await sql<StandingPromptVersionRow[]>`
    UPDATE standing_prompt_versions
    SET is_pinned  = false,
        updated_at = CURRENT_TIMESTAMP
    WHERE standing_prompt_id = ${standing_prompt_id}
      AND status             = 'active'
    RETURNING id, standing_prompt_id, tenant_id, researcher_id, wiki_version_window,
              body, status, word_count, is_pinned, created_at, updated_at
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Length-bound helpers
// ---------------------------------------------------------------------------

/** Hard ceiling from PRD §9. */
export const STANDING_PROMPT_HARD_CEILING_WORDS = 250;

/** Target word count from PRD §9. */
export const STANDING_PROMPT_TARGET_WORDS = 100;

/**
 * Count whitespace-delimited words in a markdown string.
 */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Assert that a word count is within the hard ceiling from PRD §9.
 *
 * @throws {StandingPromptLengthError} when the count exceeds the ceiling.
 */
export function assertWithinLengthBound(wordCount: number): void {
  if (wordCount > STANDING_PROMPT_HARD_CEILING_WORDS) {
    throw new StandingPromptLengthError(wordCount, STANDING_PROMPT_HARD_CEILING_WORDS);
  }
}

/**
 * Error thrown when a standing prompt body exceeds the hard ceiling.
 */
export class StandingPromptLengthError extends Error {
  readonly wordCount: number;
  readonly hardCeiling: number;

  constructor(wordCount: number, hardCeiling: number) {
    super(
      `Standing prompt body exceeds hard ceiling: ${wordCount} words > ${hardCeiling} words (PRD §9).`,
    );
    this.name = 'StandingPromptLengthError';
    this.wordCount = wordCount;
    this.hardCeiling = hardCeiling;
  }
}

// ---------------------------------------------------------------------------
// DDL (exported for use in test setup and migration scripts)
// ---------------------------------------------------------------------------

/**
 * DDL for the standing-prompt distillation tables — issue #79.
 *
 * Applied by the test helper and by the production migration runner.
 * Mirrors the authoritative DDL in packages/db/mkt-schema.sql.
 *
 * ## Schema changes since issue #78 scout
 *
 * ### standing_prompts
 *
 * Added `subject_type` (entity|thesis|portfolio) and `subject_id` columns so
 * that the prompt family can hold one row per (researcher, subject). The unique
 * constraint now covers all four columns: (tenant_id, researcher_id, subject_type,
 * subject_id). For portfolio prompts, `subject_id` is the constant `'portfolio'`.
 *
 * ### standing_prompt_versions
 *
 * Added `is_pinned` column (default false). Pinned prompts block automatic
 * replacement: `activateStandingPromptVersion` checks `is_pinned` on the
 * currently active version before superseding it (PRD §7).
 *
 * The idempotency key is now (standing_prompt_id, wiki_version_window) —
 * changed from (researcher_id, wiki_version_window) to allow the same window
 * to produce one row per subject rather than one row per researcher.
 *
 * ## Debounce
 *
 * `wiki_version_window` is a 5-minute ISO-8601 bucket derived from the wiki
 * publish timestamp: truncate to the minute, round down to the nearest 5-minute
 * mark (`YYYY-MM-DDTHH:MM`). A burst of wiki publishes within the same window
 * maps to the same (standing_prompt_id, wiki_version_window) key, so only the
 * first distillation task creates a new version row; subsequent tasks exit early.
 *
 * ## Status transitions
 *
 * The `status` check constraint allows exactly three states: draft → active →
 * superseded. Transitions are enforced at the application layer in
 * `activateStandingPromptVersion`; the DB check constraint is defence-in-depth.
 *
 * The word_count column stores the pre-computed word count of the body at
 * activation time. This avoids re-counting on every read and makes length-bound
 * enforcement auditable from the DB row alone.
 */
export const STANDING_PROMPT_DDL = `
-- standing_prompts — one row per (researcher, subject_type, subject_id).
-- subject_type: entity (per-ticker), thesis (named thesis), portfolio (fallback).
-- For portfolio prompts, subject_id = 'portfolio'.
CREATE TABLE IF NOT EXISTS standing_prompts (
  id                              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  tenant_id                       TEXT NOT NULL,
  researcher_id                   TEXT NOT NULL,
  subject_type                    TEXT NOT NULL DEFAULT 'entity'
                                    CHECK (subject_type IN ('entity', 'thesis', 'portfolio')),
  subject_id                      TEXT NOT NULL DEFAULT 'entity',
  currently_active_version_id     TEXT,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, researcher_id, subject_type, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_standing_prompts_researcher
  ON standing_prompts (tenant_id, researcher_id);
CREATE INDEX IF NOT EXISTS idx_standing_prompts_subject
  ON standing_prompts (tenant_id, researcher_id, subject_type, subject_id);

-- standing_prompt_versions — full-snapshot versions with draft → active → superseded lifecycle.
-- Status: draft → active (supersedes prior active, which flips to superseded).
-- Readers follow standing_prompts.currently_active_version_id only at active.
-- Idempotency: UNIQUE (standing_prompt_id, wiki_version_window).
-- Pin: is_pinned = true blocks automatic supersession (PRD §7).
CREATE TABLE IF NOT EXISTS standing_prompt_versions (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  standing_prompt_id  TEXT NOT NULL REFERENCES standing_prompts(id) ON DELETE CASCADE,
  tenant_id           TEXT NOT NULL,
  researcher_id       TEXT NOT NULL,
  -- Idempotency key: ISO-8601 5-minute bucket of the triggering wiki publish window.
  -- Format: YYYY-MM-DDTHH:MM
  wiki_version_window TEXT NOT NULL,
  -- Markdown body of the distilled standing prompt. Hard ceiling ~250 words (PRD §9).
  body                TEXT,
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'active', 'superseded')),
  -- Pre-computed word count stored at activation time for auditing.
  word_count          INTEGER,
  -- Pin flag: when true, automatic distillation will not supersede this version (PRD §7).
  is_pinned           BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (standing_prompt_id, wiki_version_window)
);

CREATE INDEX IF NOT EXISTS idx_standing_prompt_versions_prompt_id
  ON standing_prompt_versions (standing_prompt_id);
CREATE INDEX IF NOT EXISTS idx_standing_prompt_versions_status
  ON standing_prompt_versions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_standing_prompt_versions_researcher
  ON standing_prompt_versions (tenant_id, researcher_id, created_at DESC);
`;
