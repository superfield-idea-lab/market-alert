/**
 * @file wiki-pending-drafts.ts
 *
 * GET /api/wiki/pending-drafts?customer_id=<id>
 *
 * Returns the count of WikiPageVersions in the AWAITING_REVIEW state (stored
 * as `state = 'draft'` in wiki_page_versions) for the given customer, subject
 * to the following rules:
 *
 *   1. The caller must be authenticated (401 if not).
 *   2. The caller must have approval authority — i.e. their user ID must appear
 *      in the APPROVER_IDS env-var list, or they must be the SUPERUSER_ID.
 *      Non-approvers receive { has_approval_authority: false, count: null }.
 *   3. The count is filtered by customer_id under RLS-visible rows only.
 *
 * The `customer_id` query param is required; 400 is returned when absent.
 *
 * Issue: #48 — pending-drafts indicator badge for approvers
 * PRD §5.5 — Draft vs. Published Wiki Versions
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';

// ---------------------------------------------------------------------------
// Approval authority helpers (mirrors approvals.ts)
// ---------------------------------------------------------------------------

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
// Route handler
// ---------------------------------------------------------------------------

export async function handleWikiPendingDraftsRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (url.pathname !== '/api/wiki/pending-drafts') return null;
  if (req.method !== 'GET') return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  // ── Auth ──────────────────────────────────────────────────────────────────
  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // ── customer_id param ─────────────────────────────────────────────────────
  const customerId = url.searchParams.get('customer_id');
  if (!customerId || !customerId.trim()) {
    return json({ error: 'customer_id query parameter is required' }, 400);
  }

  // ── Approval authority check ───────────────────────────────────────────────
  // Non-approvers receive a structured response rather than an error so the
  // client can hide the badge without treating the response as a failure.
  if (!hasApprovalAuthority(user.id)) {
    return json({ has_approval_authority: false, count: null });
  }

  // ── Count AWAITING_REVIEW (draft) WikiPageVersions for this customer ──────
  // In the DB the state is stored as 'draft' (wiki_page_versions.state) and
  // the autolearn lifecycle transitions to AWAITING_REVIEW (autolearn_jobs.state).
  // The badge should surface wiki_page_versions rows in 'draft' state, which
  // represent versions that are awaiting human review before publication.
  const rows = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count
    FROM wiki_page_versions
    WHERE customer = ${customerId}
      AND state    = 'draft'
  `;

  const count = parseInt(rows[0]?.count ?? '0', 10);

  return json({ has_approval_authority: true, count, customer_id: customerId });
}
