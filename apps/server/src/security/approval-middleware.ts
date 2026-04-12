/**
 * @file approval-middleware
 *
 * Enforcement middleware for M-of-N approval gating of privileged operations.
 *
 * How to use:
 *   Call `requireApproval(sql, req, operationType)` at the top of any route
 *   handler that executes a privileged operation. The caller must supply an
 *   `X-Approval-Request-Id` header carrying the UUID of a previously approved
 *   ApprovalRequest for the matching operation type.
 *
 *   On success the function returns the approved ApprovalRequest. After the
 *   operation executes, the caller must call `markExecuted()` from
 *   `db/approvals` to close the request and record the audit event.
 *
 *   On failure a `Response` is returned instead — the caller must return it
 *   immediately to the client.
 *
 * Canonical docs: docs/implementation-plan-v1.md
 * Related issue: #24
 */

import postgres from 'postgres';
import { assertApproved, type ApprovalRequest } from 'db/approvals';
import { makeJson } from '../lib/response';
import { getCorsHeaders } from '../api/auth';

type SqlClient = postgres.Sql;

/**
 * Verifies that the `X-Approval-Request-Id` header refers to a genuinely
 * approved ApprovalRequest for the expected `operationType`.
 *
 * Returns:
 *   - `{ approved: true, request }` when the gate is cleared.
 *   - `{ approved: false, response }` when the gate blocks — caller must
 *     return the `response` to the client immediately.
 */
export async function requireApproval(
  sql: SqlClient,
  req: Request,
  operationType: string,
): Promise<{ approved: true; request: ApprovalRequest } | { approved: false; response: Response }> {
  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);

  const requestId = req.headers.get('X-Approval-Request-Id');
  if (!requestId) {
    return {
      approved: false,
      response: json(
        {
          error: 'Missing X-Approval-Request-Id header',
          detail:
            'Privileged operations require a pre-approved ApprovalRequest. ' +
            'Create one via POST /api/approvals and collect M approvals before retrying.',
        },
        403,
      ),
    };
  }

  let request: ApprovalRequest;
  try {
    request = await assertApproved(sql, requestId);
  } catch (err) {
    return {
      approved: false,
      response: json(
        {
          error: 'Approval gate blocked',
          detail: err instanceof Error ? err.message : String(err),
        },
        403,
      ),
    };
  }

  // Verify the approval was granted for the correct operation type
  if (request.operation_type !== operationType) {
    return {
      approved: false,
      response: json(
        {
          error: 'Approval type mismatch',
          detail:
            `ApprovalRequest ${requestId} was granted for operation ` +
            `'${request.operation_type}', not '${operationType}'.`,
        },
        403,
      ),
    };
  }

  return { approved: true, request };
}
