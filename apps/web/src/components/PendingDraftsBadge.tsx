/**
 * @file PendingDraftsBadge.tsx
 *
 * Badge that displays the count of WikiPageVersions awaiting review for a
 * given customer. The badge is only rendered when:
 *   - The current user has approval authority (APPROVER_IDS or superuser), AND
 *   - The count is greater than zero.
 *
 * Non-approvers see nothing — the badge is hidden entirely to avoid leaking
 * the existence of pending drafts to users who cannot act on them.
 *
 * Issue #48 — pending-drafts indicator badge for approvers
 * PRD §5.5 — Draft vs. Published Wiki Versions
 */

import React from 'react';
import { usePendingDraftsCount } from '../hooks/use-pending-drafts-count';

export interface PendingDraftsBadgeProps {
  /** The customer whose pending drafts should be counted. */
  customerId: string;
}

/**
 * PendingDraftsBadge — renders an orange badge with the count of drafts
 * awaiting review, visible only to designated approvers.
 *
 * Renders null (nothing) when:
 *   - loading
 *   - the user has no approval authority
 *   - count is 0 or null
 */
export function PendingDraftsBadge({
  customerId,
}: PendingDraftsBadgeProps): React.ReactElement | null {
  const { hasApprovalAuthority, count, loading } = usePendingDraftsCount(customerId);

  if (loading) return null;
  if (!hasApprovalAuthority) return null;
  if (!count || count === 0) return null;

  return (
    <span
      data-testid="pending-drafts-badge"
      className="inline-flex items-center justify-center rounded-full bg-amber-500 px-2 py-0.5 text-xs font-semibold text-white leading-none"
      title={`${count} draft${count === 1 ? '' : 's'} awaiting review`}
    >
      {count}
    </span>
  );
}
