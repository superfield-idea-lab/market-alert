/**
 * @file standing-prompt-distill-job.ts
 *
 * STANDING_PROMPT_DISTILL worker job handler — Phase 3 scout (issue #78).
 *
 * ## What this file does
 *
 * Implements `executeStandingPromptDistillTask`, which for one researcher:
 *
 *   1. Resolves or creates a standing_prompts row via
 *      POST /internal/standing-prompt/prompt
 *   2. Checks idempotency: creates a draft standing_prompt_version for the
 *      given wiki_version_window via POST /internal/standing-prompt/version.
 *      If `status: 'exists'` is returned, the window was already distilled —
 *      the task exits with `already_distilled: true` without further work.
 *   3. Fetches all currently published wiki_page_versions for the researcher's
 *      subjects via GET /internal/standing-prompt/wiki-pages
 *   4. Distils the wiki bodies into a compact bounded prompt via
 *      `distilToStandingPrompt` (deterministic stub — concatenates wiki
 *      summaries up to the hard ceiling).
 *   5. Activates the draft version via
 *      POST /internal/standing-prompt/version/:id/activate
 *      This atomically supersedes the prior Active version and advances the
 *      standing_prompts.currently_active_version_id pointer.
 *   6. Returns a result summary.
 *
 * ## Phase 3 synthesis (deterministic stub)
 *
 * The distillation step in this scout is intentionally minimal — it takes the
 * first N words from each wiki page body up to the ~100-word target, with a
 * hard stop at ~250 words. LLM-backed synthesis (thematic compression,
 * investment thesis extraction, portfolio coherence) is deferred to a follow-on
 * Phase 4 issue. The goal here is to validate the full pipeline
 * (wiki publish → version → active → superseded) end-to-end.
 *
 * ## Idempotency
 *
 * Re-running STANDING_PROMPT_DISTILL for the same (researcher_id,
 * wiki_version_window) pair is safe: the version creation step at the API layer
 * returns `status: 'exists'` and the task exits early without creating a
 * duplicate or changing the active version. This implements the acceptance
 * criterion: "Distillation is idempotent for the same wiki window."
 *
 * ## Supersession
 *
 * The activate step atomically:
 *   1. Flips the prior Active version to Superseded.
 *   2. Activates the new version (body + word_count).
 *   3. Advances standing_prompts.currently_active_version_id.
 * All three steps are inside a single DB transaction in the API layer
 * (packages/db/standing-prompt-store.ts :: activateStandingPromptVersion).
 *
 * ## Security
 *
 * Workers hold no database credentials (WORKER-T-001, WORKER-T-002). All reads
 * and writes are made through authenticated internal API calls. The delegated
 * token from the task row scopes access to the assigned researcher only.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §9 — standing prompt hard ceiling (~250 words)
 * - docs/prd.md §10 — distillation cadence
 * - docs/architecture.md §"Standing prompt as derived artifact"
 * - packages/db/task-queue.ts — TaskType.STANDING_PROMPT_DISTILL
 * - packages/db/standing-prompt-store.ts — DB store
 * - apps/server/src/api/standing-prompt-distill-api.ts — internal API endpoints
 * - tests/integration/standing-prompt-distill.spec.ts — integration tests
 *
 * ## Integration points discovered during scout (issue #78)
 *
 * - WIKI_REBUILD workers (issue #76) must enqueue STANDING_PROMPT_DISTILL when
 *   a wiki_page_version reaches `indexed`. The enqueue logic needs to be wired
 *   into apps/worker/src/wiki-rebuild-job.ts in a follow-on issue. The task
 *   key format is: `sp_distill:<researcher_id>:<wiki_version_window>`.
 * - The wiki_version_window is a 5-minute ISO-8601 bucket derived from the
 *   wiki publish timestamp. Bucket formula:
 *     `new Date(Math.floor(publishedAt.getTime() / 300_000) * 300_000).toISOString().slice(0, 16)`
 *   This debounce collapses burst wiki publishes into a single distillation pass.
 * - Thesis and portfolio subjects are out of scope for this scout. The GET
 *   /internal/standing-prompt/wiki-pages endpoint in the follow-on feature
 *   issue must support subject_type filtering.
 * - Pin/override capability is out of scope for this scout. The
 *   standing_prompt_versions table has no pin column; it will be added in a
 *   dedicated phase feature issue.
 * - A downstream signal evaluation issue (N+1 from this scout) reads the active
 *   standing_prompt_version body to evaluate market events. The interface is:
 *   GET /internal/standing-prompt/active?tenant_id=&researcher_id=
 *   → { version: { id, body, word_count, status } | null }
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/78
 */

import type { TaskQueueRow } from 'db/task-queue';
import { assertNoDatabaseUrl } from './startup';

/** The job_type constant for STANDING_PROMPT_DISTILL tasks. */
export const STANDING_PROMPT_DISTILL_JOB_TYPE = 'STANDING_PROMPT_DISTILL' as const;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/**
 * Payload for a STANDING_PROMPT_DISTILL task.
 *
 * Task key format: `sp_distill:<researcher_id>:<wiki_version_window>`
 * Triggered by: wiki_page_version publish events (WIKI_REBUILD indexed stage).
 */
export interface StandingPromptDistillPayload {
  /** The researcher whose standing prompt should be re-distilled. */
  researcher_id: string;
  /** Tenant scope for the distillation. */
  tenant_id: string;
  /**
   * 5-minute ISO-8601 bucket identifying the publish-event window that triggered
   * this distillation. Format: `YYYY-MM-DDTHH:MM` (truncated to the minute,
   * rounded down to the nearest 5 minutes).
   *
   * Used as the idempotency key in standing_prompt_versions. Re-running the
   * distiller for the same window produces no new row.
   */
  wiki_version_window: string;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface StandingPromptDistillResult {
  researcher_id: string;
  tenant_id: string;
  wiki_version_window: string;
  standing_prompt_id: string | null;
  standing_prompt_version_id: string | null;
  /**
   * True when the window was already distilled (idempotent early-exit).
   * AC: "Distillation is idempotent for the same wiki window."
   */
  already_distilled: boolean;
  /** Word count of the distilled prompt body. */
  word_count: number | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Phase 3 distillation stub (deterministic)
// ---------------------------------------------------------------------------

export interface DistillInput {
  researcher_id: string;
  wiki_pages: Array<{
    subject_type: string;
    subject_id: string;
    body: string;
  }>;
}

/**
 * Distil a compact standing prompt body from a set of wiki page bodies.
 *
 * Phase 3 stub: concatenates a trimmed prefix of each wiki page body,
 * separated by a markdown rule, up to `targetWords`. Hard stops at
 * `hardCeiling` words. LLM-backed synthesis is deferred to Phase 4.
 *
 * The returned string is plain UTF-8 markdown, bounded by the hard ceiling.
 * Encryption (if any) is handled by the API layer before storage.
 *
 * @param input      Wiki pages to distil.
 * @param targetWords  Soft target word count (~100, PRD §9).
 * @param hardCeiling  Hard ceiling word count (~250, PRD §9).
 */
export function distilToStandingPrompt(
  input: DistillInput,
  targetWords = 100,
  hardCeiling = 250,
): string {
  if (input.wiki_pages.length === 0) {
    return `# Standing Prompt\n\n_Researcher ${input.researcher_id}: no published wiki pages available._`;
  }

  const perPage = Math.max(1, Math.floor(targetWords / input.wiki_pages.length));
  const parts: string[] = [];
  let totalWords = 0;

  for (const page of input.wiki_pages) {
    if (totalWords >= hardCeiling) break;

    const words = page.body.trim().split(/\s+/).filter(Boolean);
    const take = Math.min(perPage, hardCeiling - totalWords, words.length);
    const excerpt = words.slice(0, take).join(' ');

    parts.push(`**${page.subject_type}/${page.subject_id}**: ${excerpt}`);
    totalWords += take;
  }

  return parts.join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Main task executor
// ---------------------------------------------------------------------------

/**
 * Execute a STANDING_PROMPT_DISTILL task.
 *
 * Called by the worker runner. Carries the full pipeline from wiki-page
 * fetch through distillation to standing-prompt activation.
 *
 * @param task        The claimed task row from the queue.
 * @param apiBaseUrl  Base URL for the internal API (e.g. http://localhost:3000).
 * @param authToken   Delegated worker token authorising this task's writes.
 */
export async function executeStandingPromptDistillTask(
  task: TaskQueueRow,
  apiBaseUrl: string,
  authToken: string,
): Promise<StandingPromptDistillResult> {
  // Workers must never hold a DB URL (WORKER-T-001).
  assertNoDatabaseUrl();

  const payload = task.payload as StandingPromptDistillPayload;
  const { researcher_id, tenant_id, wiki_version_window } = payload;

  const authHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authToken}`,
  };

  // --- 1. Upsert standing_prompts row ---
  const promptRes = await fetch(`${apiBaseUrl}/internal/standing-prompt/prompt`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ tenant_id, researcher_id }),
  });

  if (!promptRes.ok) {
    return {
      researcher_id,
      tenant_id,
      wiki_version_window,
      standing_prompt_id: null,
      standing_prompt_version_id: null,
      already_distilled: false,
      word_count: null,
      error: `Failed to upsert standing_prompts: HTTP ${promptRes.status}`,
    };
  }

  const { standing_prompt_id } = (await promptRes.json()) as { standing_prompt_id: string };

  // --- 2. Create draft version (idempotency check) ---
  const versionRes = await fetch(`${apiBaseUrl}/internal/standing-prompt/version`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      standing_prompt_id,
      tenant_id,
      researcher_id,
      wiki_version_window,
    }),
  });

  if (!versionRes.ok) {
    return {
      researcher_id,
      tenant_id,
      wiki_version_window,
      standing_prompt_id,
      standing_prompt_version_id: null,
      already_distilled: false,
      word_count: null,
      error: `Failed to create draft version: HTTP ${versionRes.status}`,
    };
  }

  const versionData = (await versionRes.json()) as {
    standing_prompt_version_id: string;
    status: 'draft' | 'exists';
    wiki_version_window: string;
  };

  // Idempotent early-exit: this window was already distilled.
  if (versionData.status === 'exists') {
    return {
      researcher_id,
      tenant_id,
      wiki_version_window,
      standing_prompt_id,
      standing_prompt_version_id: versionData.standing_prompt_version_id,
      already_distilled: true,
      word_count: null,
      error: null,
    };
  }

  const standing_prompt_version_id = versionData.standing_prompt_version_id;

  // --- 3. Fetch published wiki pages for this researcher ---
  const wikiRes = await fetch(
    `${apiBaseUrl}/internal/standing-prompt/wiki-pages?tenant_id=${encodeURIComponent(tenant_id)}&researcher_id=${encodeURIComponent(researcher_id)}`,
    { headers: authHeaders },
  );

  if (!wikiRes.ok) {
    return {
      researcher_id,
      tenant_id,
      wiki_version_window,
      standing_prompt_id,
      standing_prompt_version_id,
      already_distilled: false,
      word_count: null,
      error: `Failed to fetch wiki pages: HTTP ${wikiRes.status}`,
    };
  }

  const wikiData = (await wikiRes.json()) as {
    wiki_pages: Array<{ subject_type: string; subject_id: string; body: string }>;
  };

  // --- 4. Distil to standing prompt body ---
  const body = distilToStandingPrompt({ researcher_id, wiki_pages: wikiData.wiki_pages });

  // --- 5. Activate the draft version ---
  const activateRes = await fetch(
    `${apiBaseUrl}/internal/standing-prompt/version/${standing_prompt_version_id}/activate`,
    {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ standing_prompt_id, body }),
    },
  );

  if (!activateRes.ok) {
    const errBody = (await activateRes.json().catch(() => ({}))) as {
      error?: string;
      word_count?: number;
      hard_ceiling?: number;
    };
    return {
      researcher_id,
      tenant_id,
      wiki_version_window,
      standing_prompt_id,
      standing_prompt_version_id,
      already_distilled: false,
      word_count: errBody.word_count ?? null,
      error: `Failed to activate version: HTTP ${activateRes.status} — ${errBody.error ?? 'unknown error'}`,
    };
  }

  const activateData = (await activateRes.json()) as {
    standing_prompt_version_id: string;
    status: string;
    word_count: number;
  };

  return {
    researcher_id,
    tenant_id,
    wiki_version_window,
    standing_prompt_id,
    standing_prompt_version_id: activateData.standing_prompt_version_id,
    already_distilled: false,
    word_count: activateData.word_count,
    error: null,
  };
}
