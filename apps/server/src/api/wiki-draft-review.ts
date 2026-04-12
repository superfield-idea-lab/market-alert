/**
 * @file wiki-draft-review.ts
 *
 * Publication gate API — approve or reject autolearn drafts (issue #66).
 *
 * Routes:
 *
 *   GET  /api/wiki/drafts/:id
 *     Fetch a single draft wiki_page_version with its diff and materiality
 *     classification against the current published version for the same page.
 *     Auth: designated approvers only.
 *
 *   POST /api/wiki/drafts/:id/approve
 *     Publish the draft: set state = 'published', emit audit event.
 *     Auth: designated approvers only.
 *     Drafts above the materiality threshold cannot auto-publish — explicit
 *     approval (via this endpoint) is required.
 *
 *   POST /api/wiki/drafts/:id/reject
 *     Close the draft without publishing: set state = 'archived', emit audit event.
 *     Auth: designated approvers only.
 *
 * Materiality classification:
 *   The diff ratio is computed as the fraction of lines changed relative to
 *   the published version's line count.  The threshold is read from the
 *   MATERIALITY_THRESHOLD env var (float 0–1, default 0.2).  Drafts whose
 *   ratio exceeds the threshold are classified as "material" and cannot
 *   auto-publish — they require an explicit human approval via this endpoint.
 *
 * Audit events:
 *   - wiki_draft.approved  — emitted on /approve before the DB write
 *   - wiki_draft.rejected  — emitted on /reject before the DB write
 *
 * Blueprint references:
 * - PRD §5.5 — Draft vs. Published Wiki Versions
 * - Implementation plan Phase 6 — Publication gate UI
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/66
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { makeJson, isSuperuser } from '../lib/response';
import { emitAuditEvent } from '../policies/audit-service';

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

function getMaterialityThreshold(): number {
  const raw = process.env.MATERIALITY_THRESHOLD;
  if (raw !== undefined) {
    const parsed = parseFloat(raw);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  }
  return 0.2;
}

function getDesignatedApprovers(): string[] {
  const raw = process.env.APPROVER_IDS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function hasApprovalAuthority(userId: string): boolean {
  if (isSuperuser(userId)) return true;
  return getDesignatedApprovers().includes(userId);
}

// ---------------------------------------------------------------------------
// Diff + materiality helpers
// ---------------------------------------------------------------------------

/**
 * Compute a simple line-level diff between two text bodies.
 * Returns an array of diff hunks for display in the UI.
 */
export function computeLineDiff(
  published: string,
  draft: string,
): Array<{ type: 'unchanged' | 'removed' | 'added'; line: string }> {
  // When there is no published version, every draft line is 'added'.
  if (published === '') {
    return (draft === '' ? [] : draft.split('\n')).map((line) => ({
      type: 'added' as const,
      line,
    }));
  }

  const publishedLines = published.split('\n');
  const draftLines = draft.split('\n');

  // Build a longest-common-subsequence diff.
  // For simplicity we use a greedy linear diff: mark removed/added by
  // comparing both sets against each other using a diffing approach.
  const hunks: Array<{ type: 'unchanged' | 'removed' | 'added'; line: string }> = [];

  // Use a simple two-pointer approach with a LCS lookup table.
  const m = publishedLines.length;
  const n = draftLines.length;

  // dp[i][j] = LCS length for publishedLines[0..i-1], draftLines[0..j-1]
  // Limit to 500 lines each to avoid O(m*n) blowup on huge diffs.
  const maxLines = 500;
  const pLines = publishedLines.slice(0, maxLines);
  const dLines = draftLines.slice(0, maxLines);
  const pm = pLines.length;
  const dn = dLines.length;

  const dp: number[][] = Array.from({ length: pm + 1 }, () => new Array(dn + 1).fill(0));
  for (let i = 1; i <= pm; i++) {
    for (let j = 1; j <= dn; j++) {
      if (pLines[i - 1] === dLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff
  let i = pm;
  let j = dn;
  const backtracked: Array<{ type: 'unchanged' | 'removed' | 'added'; line: string }> = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && pLines[i - 1] === dLines[j - 1]) {
      backtracked.push({ type: 'unchanged', line: pLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      backtracked.push({ type: 'added', line: dLines[j - 1] });
      j--;
    } else {
      backtracked.push({ type: 'removed', line: pLines[i - 1] });
      i--;
    }
  }

  backtracked.reverse();
  hunks.push(...backtracked);

  // If we truncated, indicate remaining lines
  if (m > maxLines || n > maxLines) {
    hunks.push({ type: 'unchanged', line: `… (diff truncated at ${maxLines} lines)` });
  }

  return hunks;
}

/**
 * Classify the materiality of a diff.
 *
 * Returns the ratio of changed lines to the published version's total line
 * count, and whether the ratio exceeds the configured threshold.
 */
export function classifyMateriality(
  diff: Array<{ type: 'unchanged' | 'removed' | 'added'; line: string }>,
  publishedLineCount: number,
  threshold: number,
): { ratio: number; is_material: boolean; threshold: number } {
  const changedLines = diff.filter((d) => d.type === 'removed' || d.type === 'added').length;
  const ratio = publishedLineCount === 0 ? 1 : changedLines / publishedLineCount;
  return {
    ratio: Math.round(ratio * 10000) / 10000,
    is_material: ratio > threshold,
    threshold,
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleWikiDraftReviewRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/wiki/drafts')) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // All draft review routes require approval authority.
  if (!hasApprovalAuthority(user.id)) {
    return json({ error: 'Forbidden — approval authority required' }, 403);
  }

  // ── GET /api/wiki/drafts/:id ──────────────────────────────────────────────

  const idMatch = url.pathname.match(/^\/api\/wiki\/drafts\/([^/]+)(\/[^/]+)?$/);
  if (!idMatch) return null;

  const draftId = idMatch[1];
  const subpath = idMatch[2] ?? '';

  if (req.method === 'GET' && subpath === '') {
    // Fetch the draft
    const draftRows = await sql<
      {
        id: string;
        page_id: string;
        dept: string;
        customer: string;
        content: string;
        state: string;
        created_by: string;
        source_task: string | null;
        created_at: Date;
      }[]
    >`
      SELECT id, page_id, dept, customer, content, state, created_by, source_task, created_at
      FROM wiki_page_versions
      WHERE id = ${draftId}
    `;

    if (draftRows.length === 0) return json({ error: 'Not found' }, 404);
    const draft = draftRows[0];

    if (draft.state !== 'draft') {
      return json({ error: `Draft is not in review state (current state: ${draft.state})` }, 422);
    }

    // Fetch the current published version for the same page
    const publishedRows = await sql<
      {
        id: string;
        content: string;
        created_at: Date;
      }[]
    >`
      SELECT id, content, created_at
      FROM wiki_page_versions
      WHERE page_id   = ${draft.page_id}
        AND customer  = ${draft.customer}
        AND dept      = ${draft.dept}
        AND state     = 'published'
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const published = publishedRows[0] ?? null;

    // Compute diff and materiality
    const publishedContent = published?.content ?? '';
    const diff = computeLineDiff(publishedContent, draft.content);
    const publishedLineCount = publishedContent === '' ? 0 : publishedContent.split('\n').length;
    const threshold = getMaterialityThreshold();
    const materiality = classifyMateriality(diff, publishedLineCount, threshold);

    return json({
      id: draft.id,
      page_id: draft.page_id,
      dept: draft.dept,
      customer: draft.customer,
      state: draft.state,
      created_by: draft.created_by,
      source_task: draft.source_task,
      created_at:
        draft.created_at instanceof Date
          ? draft.created_at.toISOString()
          : String(draft.created_at),
      draft_content: draft.content,
      published_version: published
        ? {
            id: published.id,
            created_at:
              published.created_at instanceof Date
                ? published.created_at.toISOString()
                : String(published.created_at),
          }
        : null,
      diff,
      materiality,
    });
  }

  // ── POST /api/wiki/drafts/:id/approve ────────────────────────────────────

  if (req.method === 'POST' && subpath === '/approve') {
    const draftRows = await sql<
      {
        id: string;
        page_id: string;
        dept: string;
        customer: string;
        content: string;
        state: string;
      }[]
    >`
      SELECT id, page_id, dept, customer, content, state
      FROM wiki_page_versions
      WHERE id = ${draftId}
    `;

    if (draftRows.length === 0) return json({ error: 'Not found' }, 404);
    const draft = draftRows[0];

    if (draft.state !== 'draft') {
      return json({ error: `Draft is not in review state (current state: ${draft.state})` }, 422);
    }

    // Emit audit event BEFORE the DB write.
    await emitAuditEvent({
      actor_id: user.id,
      action: 'wiki_draft.approved',
      entity_type: 'wiki_page_version',
      entity_id: draftId,
      before: { state: 'draft' },
      after: { state: 'published', approved_by: user.id },
      ts: new Date().toISOString(),
    });

    // Update: set state to 'published', archive the previous published version
    // for the same page (to ensure only one published at a time).
    await sql`
      UPDATE wiki_page_versions
      SET state = 'archived'
      WHERE page_id  = ${draft.page_id}
        AND customer = ${draft.customer}
        AND dept     = ${draft.dept}
        AND state    = 'published'
        AND id      != ${draftId}
    `;

    await sql`
      UPDATE wiki_page_versions
      SET state = 'published'
      WHERE id = ${draftId}
    `;

    return json({
      id: draftId,
      state: 'published',
      approved_by: user.id,
      approved_at: new Date().toISOString(),
    });
  }

  // ── POST /api/wiki/drafts/:id/reject ─────────────────────────────────────

  if (req.method === 'POST' && subpath === '/reject') {
    const draftRows = await sql<
      { id: string; page_id: string; customer: string; dept: string; state: string }[]
    >`
      SELECT id, page_id, customer, dept, state
      FROM wiki_page_versions
      WHERE id = ${draftId}
    `;

    if (draftRows.length === 0) return json({ error: 'Not found' }, 404);
    const draft = draftRows[0];

    if (draft.state !== 'draft') {
      return json({ error: `Draft is not in review state (current state: ${draft.state})` }, 422);
    }

    // Emit audit event BEFORE the DB write.
    await emitAuditEvent({
      actor_id: user.id,
      action: 'wiki_draft.rejected',
      entity_type: 'wiki_page_version',
      entity_id: draftId,
      before: { state: 'draft' },
      after: { state: 'archived', rejected_by: user.id },
      ts: new Date().toISOString(),
    });

    await sql`
      UPDATE wiki_page_versions
      SET state = 'archived'
      WHERE id = ${draftId}
    `;

    return json({
      id: draftId,
      state: 'archived',
      rejected_by: user.id,
      rejected_at: new Date().toISOString(),
    });
  }

  return null;
}
