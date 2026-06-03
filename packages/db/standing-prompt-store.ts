/**
 * @file standing-prompt-store.ts
 *
 * DB access layer for the standing-prompt distillation pipeline — Phase 3 scout (issue #78).
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
 * One row per researcher. The `currently_active_version_id` pointer is advanced
 * to a new `standing_prompt_versions` row only when its status reaches `active`.
 * Reading code always follows `currently_active_version_id`; in-progress version
 * rows with status < `active` are never exposed to readers.
 *
 * ### standing_prompt_versions (status pipeline)
 *
 * Status pipeline mirrors wiki_page_versions_mkt:
 *   draft → active
 *
 * A new `active` version supersedes the previous `active` version for the same
 * researcher by flipping the prior row's status to `superseded`.
 *
 * ### Lifecycle transitions
 *
 * - `draft`      — distillation is in-progress; not yet visible to readers.
 * - `active`     — the current effective prompt for the researcher; exactly one
 *                  row per researcher should be `active` at any given time.
 * - `superseded` — this version was Active and has been replaced by a newer version.
 *
 * ## Idempotency
 *
 * `insertStandingPromptVersion` uses a `wiki_version_window` key so that
 * re-running the distiller on the same window of published wiki versions produces
 * no new row (ON CONFLICT DO NOTHING on the unique index over
 * (researcher_id, wiki_version_window)).
 *
 * ## Length bound
 *
 * PRD §9 hard ceiling: ~250 words. Target: ~100 words. The `assertWithinLengthBound`
 * helper counts whitespace-delimited words and throws if the bound is exceeded.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §9 — standing prompt hard ceiling
 * - docs/prd.md §10 — distillation cadence
 * - docs/architecture.md §"Standing prompt as derived artifact"
 * - packages/db/mkt-schema.sql — DDL (standing_prompts, standing_prompt_versions)
 * - apps/worker/src/standing-prompt-distill-job.ts — worker handler
 * - apps/server/src/api/standing-prompt-distill-api.ts — internal API endpoints
 * - tests/integration/standing-prompt-distill.spec.ts — integration tests
 *
 * ## Integration points discovered during scout (issue #78)
 *
 * - WIKI_REBUILD workers (issue #76) must enqueue a STANDING_PROMPT_DISTILL task
 *   when a wiki_page_version reaches `indexed` status for a subject within a
 *   researcher's scope. Task key format:
 *   `sp_distill:<researcher_id>:<wiki_version_window>`
 *   The wiki_version_window is the ISO-8601 timestamp of the publish event, truncated
 *   to the debounce bucket size (e.g. 5-minute windows).
 * - The `currently_active_version_id` update MUST be inside the same transaction
 *   that flips status to `active` and the prior version to `superseded` to prevent
 *   double-active races under concurrent workers.
 * - Thesis and portfolio subjects are out of scope for this scout; the distiller
 *   currently only covers entity-level wiki publishes (AC phase feature).
 * - Pin/override capability is out of scope for this scout (phase feature).
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/78
 */

import type postgres from 'postgres';

export type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// standing_prompts
// ---------------------------------------------------------------------------

export type StandingPromptRow = {
  id: string;
  tenant_id: string;
  researcher_id: string;
  currently_active_version_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export interface UpsertStandingPromptInput {
  tenant_id: string;
  researcher_id: string;
}

/**
 * Upsert a standing_prompts row for a researcher.
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
    INSERT INTO standing_prompts (tenant_id, researcher_id)
    VALUES (${input.tenant_id}, ${input.researcher_id})
    ON CONFLICT (tenant_id, researcher_id) DO UPDATE
      SET updated_at = CURRENT_TIMESTAMP
    RETURNING id, tenant_id, researcher_id, currently_active_version_id,
              created_at, updated_at
  `;
  return row;
}

/**
 * Fetch a standing_prompts row by researcher.
 *
 * Returns null if no row exists for the researcher.
 */
export async function getStandingPrompt(
  sql: SqlClient,
  tenant_id: string,
  researcher_id: string,
): Promise<StandingPromptRow | null> {
  const rows = await sql<StandingPromptRow[]>`
    SELECT id, tenant_id, researcher_id, currently_active_version_id,
           created_at, updated_at
    FROM standing_prompts
    WHERE tenant_id = ${tenant_id}
      AND researcher_id = ${researcher_id}
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
   * Format: `<researcher_id>:<YYYY-MM-DDTHH:MM>` (5-minute bucket).
   */
  wiki_version_window: string;
  /** Markdown body of the distilled prompt. Bounded at ~250 words. */
  body: string | null;
  status: StandingPromptVersionStatus;
  word_count: number | null;
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
 * Idempotent: if a row already exists for (researcher_id, wiki_version_window),
 * returns `{ row, created: false }` without inserting a duplicate.
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
    ON CONFLICT (researcher_id, wiki_version_window) DO NOTHING
    RETURNING id, standing_prompt_id, tenant_id, researcher_id, wiki_version_window,
              body, status, word_count, created_at, updated_at
  `;

  if (inserted.length > 0) {
    return { row: inserted[0], created: true };
  }

  // Row already existed — fetch it.
  const existing = await sql<StandingPromptVersionRow[]>`
    SELECT id, standing_prompt_id, tenant_id, researcher_id, wiki_version_window,
           body, status, word_count, created_at, updated_at
    FROM standing_prompt_versions
    WHERE researcher_id = ${input.researcher_id}
      AND wiki_version_window = ${input.wiki_version_window}
    LIMIT 1
  `;
  return { row: existing[0], created: false };
}

/**
 * Set the body of a draft standing_prompt_version.
 *
 * Validates the word count against the hard ceiling before persisting.
 * Advances status to `active` and patches the `standing_prompts` pointer
 * inside a single transaction; the prior active version is flipped to
 * `superseded` in the same transaction.
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
): Promise<StandingPromptVersionRow> {
  const wordCount = countWords(opts.body);
  assertWithinLengthBound(wordCount);

  const [row] = await sql.begin(async (tx) => {
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
                body, status, word_count, created_at, updated_at
    `;

    // Advance the currently_active_version_id pointer on the parent row.
    await tx`
      UPDATE standing_prompts
      SET currently_active_version_id = ${opts.standing_prompt_version_id},
          updated_at                  = CURRENT_TIMESTAMP
      WHERE id = ${opts.standing_prompt_id}
    `;

    return updated;
  });

  return row;
}

/**
 * Fetch the currently active standing_prompt_version for a researcher.
 *
 * Returns null if no active version exists.
 */
export async function getActiveStandingPromptVersion(
  sql: SqlClient,
  tenant_id: string,
  researcher_id: string,
): Promise<StandingPromptVersionRow | null> {
  const rows = await sql<StandingPromptVersionRow[]>`
    SELECT spv.id, spv.standing_prompt_id, spv.tenant_id, spv.researcher_id,
           spv.wiki_version_window, spv.body, spv.status, spv.word_count,
           spv.created_at, spv.updated_at
    FROM standing_prompt_versions spv
    JOIN standing_prompts sp
      ON sp.id = spv.standing_prompt_id
    WHERE sp.tenant_id     = ${tenant_id}
      AND sp.researcher_id = ${researcher_id}
      AND spv.status       = 'active'
    ORDER BY spv.created_at DESC
    LIMIT 1
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
 * DDL for the standing-prompt distillation tables.
 *
 * Applied by the test helper and by the production migration runner.
 * Mirrors the authoritative DDL in packages/db/mkt-schema.sql.
 *
 * ## Integration note (issue #78 scout)
 *
 * `standing_prompt_versions.wiki_version_window` acts as the idempotency key so
 * that re-running the distiller on the same publish-event window produces no new
 * row. The window is a 5-minute ISO-8601 bucket derived from the wiki publish
 * timestamp: truncate to the minute, round down to the nearest 5-minute mark.
 * This debounce collapses burst wiki publishes into a single distillation pass
 * without requiring an external debounce service.
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
-- standing_prompts — one row per researcher; points at the currently active version.
CREATE TABLE IF NOT EXISTS standing_prompts (
  id                              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  tenant_id                       TEXT NOT NULL,
  researcher_id                   TEXT NOT NULL,
  currently_active_version_id     TEXT,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, researcher_id)
);

CREATE INDEX IF NOT EXISTS idx_standing_prompts_researcher
  ON standing_prompts (tenant_id, researcher_id);

-- standing_prompt_versions — full-snapshot versions with draft → active → superseded lifecycle.
-- Status: draft → active (supersedes prior active, which flips to superseded).
-- Readers follow standing_prompts.currently_active_version_id only at active.
-- Idempotency: UNIQUE (researcher_id, wiki_version_window).
CREATE TABLE IF NOT EXISTS standing_prompt_versions (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  standing_prompt_id  TEXT NOT NULL REFERENCES standing_prompts(id) ON DELETE CASCADE,
  tenant_id           TEXT NOT NULL,
  researcher_id       TEXT NOT NULL,
  -- Idempotency key: ISO-8601 5-minute bucket of the triggering wiki publish window.
  -- Format: <researcher_id>:<YYYY-MM-DDTHH:MM>
  wiki_version_window TEXT NOT NULL,
  -- Markdown body of the distilled standing prompt. Hard ceiling ~250 words (PRD §9).
  body                TEXT,
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'active', 'superseded')),
  -- Pre-computed word count stored at activation time for auditing.
  word_count          INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (researcher_id, wiki_version_window)
);

CREATE INDEX IF NOT EXISTS idx_standing_prompt_versions_prompt_id
  ON standing_prompt_versions (standing_prompt_id);
CREATE INDEX IF NOT EXISTS idx_standing_prompt_versions_status
  ON standing_prompt_versions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_standing_prompt_versions_researcher
  ON standing_prompt_versions (tenant_id, researcher_id, created_at DESC);
`;
