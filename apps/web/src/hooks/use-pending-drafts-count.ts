/**
 * @file use-pending-drafts-count.ts
 *
 * React hook that fetches the count of WikiPageVersions awaiting review for a
 * given customer. The API returns `has_approval_authority: false` when the
 * authenticated user is not an approver; in that case the hook returns null so
 * callers can hide the badge entirely.
 *
 * Issue #48 — pending-drafts indicator badge for approvers
 */

import { useEffect, useState } from 'react';

export interface PendingDraftsState {
  /** Whether the current user has approval authority for wiki drafts. */
  hasApprovalAuthority: boolean;
  /** Count of drafts awaiting review, or null when authority is absent. */
  count: number | null;
  /** True while the fetch is in progress. */
  loading: boolean;
  /** Error message, if the request failed. */
  error: string | null;
}

/**
 * Fetches the pending-drafts count for the given customer.
 *
 * Re-fetches whenever `customerId` changes. The returned `count` is null when
 * the current user does not have approval authority — callers should hide the
 * badge in that case.
 */
export function usePendingDraftsCount(customerId: string): PendingDraftsState {
  const [state, setState] = useState<PendingDraftsState>({
    hasApprovalAuthority: false,
    count: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!customerId) {
      setState({ hasApprovalAuthority: false, count: null, loading: false, error: null });
      return;
    }

    let cancelled = false;

    setState((prev: PendingDraftsState) => ({ ...prev, loading: true, error: null }));

    fetch(`/api/wiki/pending-drafts?customer_id=${encodeURIComponent(customerId)}`, {
      credentials: 'include',
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const message = (body as { error?: string }).error ?? `HTTP ${res.status}`;
          setState({ hasApprovalAuthority: false, count: null, loading: false, error: message });
          return;
        }
        const data = (await res.json()) as {
          has_approval_authority: boolean;
          count: number | null;
        };
        setState({
          hasApprovalAuthority: data.has_approval_authority,
          count: data.count,
          loading: false,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Network error';
        setState({ hasApprovalAuthority: false, count: null, loading: false, error: message });
      });

    return () => {
      cancelled = true;
    };
  }, [customerId]);

  return state;
}
