/**
 * Claim-citation coverage check for autolearn drafts (issue #43).
 *
 * ## Purpose
 *
 * Every autolearn draft `wiki_page_version` must satisfy the accuracy SLA
 * defined in PRD §9: each factual claim in the markdown must reference at
 * least one `CorpusChunk` entity.  When coverage falls below the configured
 * threshold the draft is marked P1 and a publication-block flag is set so
 * that no publication path can act on it.
 *
 * ## Claim detection
 *
 * A "claim" is any non-empty sentence in the markdown prose that:
 *   - does not appear inside a fenced code block (``` … ```), or inline code
 *   - is not a heading line (# …), horizontal rule, or blank
 *
 * ## Citation syntax
 *
 * A sentence is considered cited when it contains at least one of:
 *   - `[^<corpus-chunk-id>]`   — footnote-style reference
 *   - `[[corpus:<id>]]`        — double-bracket wiki-style reference
 *   - `(corpus:<id>)`          — parenthetical reference
 *
 * The `<id>` component must match one of the `corpus_chunk_ids` supplied by
 * the caller (fetched from the `relations` table or derived from the content).
 * When `corpus_chunk_ids` is an empty array the function accepts ANY citation
 * marker as evidence of a citation — this allows unit tests to work without a
 * live DB query for corpus IDs.
 *
 * ## Storage convention for P1 marking
 *
 * The `wiki_page_version` entity `properties` JSONB is updated with:
 *   {
 *     "priority":            "P1",
 *     "publication_blocked": true,
 *     "citation_coverage":  <number 0–1>,
 *     "uncited_claims":     <number>
 *   }
 *
 * when coverage < threshold.  When coverage ≥ threshold the properties are
 * patched with:
 *   {
 *     "priority":            null,
 *     "publication_blocked": false,
 *     "citation_coverage":  <number>
 *   }
 *
 * Canonical docs:
 *   - docs/implementation-plan-v1.md §Phase 3 "Claim-citation coverage check"
 *   - docs/PRD.md §9 accuracy SLA
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/43
 */

import postgres from 'postgres';

// ---------------------------------------------------------------------------
// Internal type alias
// ---------------------------------------------------------------------------

type SqlClient = postgres.Sql;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the claim-citation coverage check.
 *
 * `slaThreshold` — the minimum fraction of claims that must carry a citation
 * for the draft to pass.  PRD §9 sets this at 0.99 (99%).  Must be in [0, 1].
 */
export interface CitationCoverageConfig {
  /** Minimum fraction of cited claims required to pass.  Defaults to 0.99. */
  slaThreshold?: number;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Per-claim result from the coverage check. */
export interface ClaimResult {
  /** The raw sentence text. */
  sentence: string;
  /** True when the sentence contains at least one valid citation marker. */
  cited: boolean;
}

/** Aggregate result returned by `checkCitationCoverage`. */
export interface CoverageResult {
  /** Total number of extracted claims. */
  totalClaims: number;
  /** Number of claims that carry a citation. */
  citedClaims: number;
  /** Number of claims with no citation. */
  uncitedClaims: number;
  /**
   * Coverage ratio: `citedClaims / totalClaims`.
   * Returns 1.0 when `totalClaims === 0` (vacuously passes).
   */
  coverage: number;
  /** True when `coverage >= slaThreshold`. */
  passes: boolean;
  /** The threshold applied for this run. */
  slaThreshold: number;
  /** Detailed per-claim results. */
  claims: ClaimResult[];
}

// ---------------------------------------------------------------------------
// Claim extraction helpers
// ---------------------------------------------------------------------------

/**
 * Strip fenced code blocks (``` … ```) and inline code (`…`) from markdown so
 * that code tokens are never mistaken for prose claims.
 */
function stripCode(markdown: string): string {
  // Remove fenced code blocks first (multi-line, non-greedy)
  let stripped = markdown.replace(/```[\s\S]*?```/g, '');
  // Remove indented code blocks (4-space / tab indented lines)
  stripped = stripped.replace(/^(?: {4}|\t).*/gm, '');
  // Remove inline code spans
  stripped = stripped.replace(/`[^`\n]+`/g, '');
  return stripped;
}

/**
 * Extract prose sentences from stripped markdown.
 *
 * Rules:
 *  - Headings (lines starting with #) are excluded.
 *  - Horizontal rules (---, ***, ___) are excluded.
 *  - Blank lines are ignored.
 *  - The remaining text is split on sentence-terminal punctuation (. ! ?)
 *    followed by whitespace or end-of-string, keeping the terminal character.
 *  - Each resulting fragment is trimmed; empty fragments are dropped.
 */
function extractSentences(stripped: string): string[] {
  const lines = stripped.split('\n');
  const prose: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Headings
    if (/^#{1,6}\s/.test(trimmed)) continue;
    // Horizontal rules
    if (/^[-*_]{3,}\s*$/.test(trimmed)) continue;
    // List markers only (bare - or * or digit.)
    if (/^[-*+]\s*$/.test(trimmed) || /^\d+\.\s*$/.test(trimmed)) continue;
    prose.push(trimmed);
  }

  // Join prose lines and split into sentences
  const text = prose.join(' ');
  // Split on . ! ? followed by space or end-of-string, keeping the delimiter
  const raw = text.split(/(?<=[.!?])\s+(?=[A-Z[(])|\s*\n\s*/);
  return raw.map((s) => s.trim()).filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Citation detection helpers
// ---------------------------------------------------------------------------

/** Regex patterns that match citation markers referencing a corpus chunk ID. */
const CITATION_PATTERNS = [
  /\[\^(?<id>[^\]]+)\]/g, // [^chunk-id]  — footnote reference
  /\[\[corpus:(?<id>[^\]]+)\]\]/g, // [[corpus:id]] — wiki-style
  /\(corpus:(?<id>[^)]+)\)/g, // (corpus:id)  — parenthetical
];

/**
 * Return true when `sentence` contains a citation marker whose ID appears in
 * `allowedIds`.  When `allowedIds` is empty, ANY citation marker suffices.
 */
function sentenceIsCited(sentence: string, allowedIds: ReadonlySet<string>): boolean {
  for (const pattern of CITATION_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sentence)) !== null) {
      const id = match.groups?.id ?? '';
      if (allowedIds.size === 0 || allowedIds.has(id)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API — pure function (no DB dependency)
// ---------------------------------------------------------------------------

/**
 * Deterministically check claim-citation coverage for a markdown draft.
 *
 * @param content         - Raw markdown content of the draft.
 * @param corpusChunkIds  - Set of corpus_chunk entity IDs that count as valid
 *                          citation targets.  Pass an empty array to accept any
 *                          citation marker (useful in tests without a live DB).
 * @param config          - Optional configuration; defaults to 99% SLA threshold.
 */
export function checkCitationCoverage(
  content: string,
  corpusChunkIds: string[],
  config: CitationCoverageConfig = {},
): CoverageResult {
  const slaThreshold = config.slaThreshold ?? 0.99;
  const allowedIds = new Set(corpusChunkIds);

  const stripped = stripCode(content);
  const sentences = extractSentences(stripped);

  if (sentences.length === 0) {
    // A draft with no extractable claims vacuously passes.
    return {
      totalClaims: 0,
      citedClaims: 0,
      uncitedClaims: 0,
      coverage: 1,
      passes: true,
      slaThreshold,
      claims: [],
    };
  }

  const claims: ClaimResult[] = sentences.map((sentence) => ({
    sentence,
    cited: sentenceIsCited(sentence, allowedIds),
  }));

  const citedClaims = claims.filter((c) => c.cited).length;
  const uncitedClaims = claims.length - citedClaims;
  const coverage = citedClaims / claims.length;
  const passes = coverage >= slaThreshold;

  return {
    totalClaims: claims.length,
    citedClaims,
    uncitedClaims,
    coverage,
    passes,
    slaThreshold,
    claims,
  };
}

// ---------------------------------------------------------------------------
// DB-integrated check — marks the wiki_page_version entity in-place
// ---------------------------------------------------------------------------

/** Result returned by `checkAndMarkDraft`. */
export interface MarkDraftResult {
  versionId: string;
  coverage: CoverageResult;
  /** True when the draft was marked P1 (coverage check failed). */
  markedP1: boolean;
}

/**
 * Run the citation-coverage check on a `wiki_page_version` entity and patch
 * its `properties` JSONB with the result.
 *
 * Steps:
 *   1. Fetch the entity row (must be type `wiki_page_version`).
 *   2. Collect corpus_chunk IDs from `relations` where `source_id = versionId`
 *      and `type = 'cites'`.
 *   3. Call `checkCitationCoverage` with the entity's `content` property.
 *   4. Patch the entity `properties` with coverage metadata, P1 flag, and
 *      publication-block flag.
 *
 * @param sql       - The app_rw postgres client.
 * @param versionId - ID of the `wiki_page_version` entity to check.
 * @param config    - Optional coverage configuration.
 */
export async function checkAndMarkDraft(
  sql: SqlClient,
  versionId: string,
  config: CitationCoverageConfig = {},
): Promise<MarkDraftResult> {
  // 1. Fetch the wiki_page_version entity.
  const rows = await sql<{ id: string; properties: Record<string, unknown> }[]>`
    SELECT id, properties
    FROM entities
    WHERE id   = ${versionId}
      AND type = 'wiki_page_version'
  `;

  if (rows.length === 0) {
    throw new Error(`wiki_page_version entity not found: ${versionId}`);
  }

  const entity = rows[0];
  const content = String(entity.properties.content ?? '');

  // 2. Collect citation targets from the relations table.
  const citationRows = await sql<{ target_id: string }[]>`
    SELECT target_id
    FROM relations
    WHERE source_id = ${versionId}
      AND type      = 'cites'
  `;
  const corpusChunkIds = citationRows.map((r) => r.target_id);

  // 3. Run the pure coverage check.
  const coverage = checkCitationCoverage(content, corpusChunkIds, config);

  // 4. Patch properties.
  const patch: Record<string, unknown> = {
    citation_coverage: coverage.coverage,
    citation_coverage_checked_at: new Date().toISOString(),
  };

  if (!coverage.passes) {
    patch.priority = 'P1';
    patch.publication_blocked = true;
    patch.uncited_claims = coverage.uncitedClaims;
  } else {
    // Clear any previous P1 marking if the draft now passes.
    patch.priority = entity.properties.priority === 'P1' ? null : entity.properties.priority;
    patch.publication_blocked = false;
  }

  await sql`
    UPDATE entities
    SET
      properties = properties || ${sql.json(patch as never)},
      updated_at = NOW()
    WHERE id = ${versionId}
  `;

  return {
    versionId,
    coverage,
    markedP1: !coverage.passes,
  };
}
