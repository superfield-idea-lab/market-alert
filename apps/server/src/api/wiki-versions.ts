/**
 * @file wiki-versions.ts
 *
 * Internal wiki version write endpoint — POST /internal/wiki/versions.
 *
 * ## Scout stub (Phase 3)
 *
 * This file is a **no-op stub** for the dev-scout issue that proves the
 * API-mediated wiki write invariant. The handler is wired into the router
 * and returns a structured 501 Not Implemented response, encoding the
 * expected request/response contract without implementing the full DB write.
 *
 * The real implementation will:
 *   1. Validate the Bearer token as a single-use scoped worker token.
 *   2. Verify the token scope matches the (department_ref, customer_ref) in
 *      the request body.
 *   3. Write a new WikiPageVersion row in AWAITING_REVIEW state via the app
 *      DB role (not the worker DB role — WORKER-T-001).
 *   4. Invalidate the delegated token immediately after write.
 *   5. Return the opaque wiki_version_ref for the runner to echo in its result.
 *
 * Blueprint references:
 * - WORKER domain — API-mediated write, no direct DB access from worker pod
 * - PRD §4.3 — WRITING_NEW_VERSION → AWAITING_REVIEW transition
 * - Implementation plan Phase 3 — POST /internal/wiki/versions follow-on issue
 */

import type { AppState } from '../index';
import { makeJson } from '../lib/response';

/**
 * WikiPageVersion states modelled at the API layer.
 *
 * AWAITING_REVIEW is the only state the worker write endpoint can produce.
 * Transitions to PUBLISHED or REJECTED are controlled by the publication gate
 * (Phase 6).
 */
export type WikiPageVersionState = 'AWAITING_REVIEW' | 'PUBLISHED' | 'REJECTED' | 'ARCHIVED';

/**
 * Request body shape for POST /internal/wiki/versions.
 *
 * Only opaque identifiers and the wiki markdown content (already anonymised
 * by the worker) are accepted. No PII may appear in this payload.
 */
export interface CreateWikiVersionRequest {
  /** Opaque reference to the customer this version belongs to. */
  customer_ref: string;
  /** Opaque reference to the department scope. */
  department_ref: string;
  /** Anonymised wiki markdown content produced by Claude CLI. */
  content_markdown: string;
  /** Opaque reference to the ground-truth source used for this version. */
  ground_truth_ref: string;
  /** Task ID of the autolearn job that produced this version. */
  created_by_task_id: string;
}

/**
 * Response body shape for a successful POST /internal/wiki/versions.
 */
export interface CreateWikiVersionResponse {
  /** Opaque reference to the newly created WikiPageVersion row. */
  wiki_version_ref: string;
  /** State of the newly created version — always AWAITING_REVIEW for worker writes. */
  state: WikiPageVersionState;
}

/**
 * Handle POST /internal/wiki/versions.
 *
 * Scout stub: returns 501 Not Implemented with the expected response shape
 * documented so follow-on issues can implement against a stable contract.
 *
 * Authentication: Bearer token (single-use scoped worker token). The stub
 * enforces the presence of the Authorization header and returns 401 when
 * absent so integration tests can assert the auth invariant even before the
 * real implementation lands.
 */
export async function handleWikiVersionsRequest(
  req: Request,
  url: URL,
  _appState: AppState,
): Promise<Response | null> {
  if (url.pathname !== '/internal/wiki/versions' || req.method !== 'POST') {
    return null;
  }

  const json = makeJson({});

  // Enforce presence of Authorization header — auth invariant (WORKER-T-005).
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'Unauthorized — scoped worker token required' }, 401);
  }

  // Scout stub: full implementation deferred to the Phase 3 follow-on issue.
  // The 501 body encodes the expected success-response shape for integration
  // tests to assert against once the real implementation lands.
  return json(
    {
      error: 'Not Implemented — wiki version write is a Phase 3 follow-on issue',
      expected_response_shape: {
        wiki_version_ref: '<uuid>',
        state: 'AWAITING_REVIEW',
      } satisfies Record<string, unknown>,
    },
    501,
  );
}
