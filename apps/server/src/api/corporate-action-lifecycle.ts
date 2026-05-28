/**
 * @file corporate-action-lifecycle.ts
 *
 * Corporate Action state machine API handlers — Phase 2 (issue #16).
 *
 * ## Endpoints
 *
 *   PATCH /internal/corporate-actions/:id/advance
 *     — Advances the CorporateAction state by one step in the machine.
 *       Valid transitions: Announced→Effective, Effective→Closed.
 *       Returns 409 for illegal transitions.
 *
 *   POST /internal/corporate-actions/:id/dispute
 *     — Forces the CorporateAction to Disputed state.
 *       Requires a non-empty `reason` field in the JSON body.
 *       Returns 422 when reason is missing or empty.
 *       Returns 409 when the action is already Disputed.
 *
 * ## Auth
 *
 * Both endpoints require a Bearer token. In TEST_MODE=true the static
 * INTERNAL_TEST_TOKEN env var is accepted. In production a signed machine
 * token is required (follow-on hardening issue).
 *
 * ## Journal
 *
 * Every transition produces exactly one journal entry with actor, from_state,
 * to_state, timestamp (and reason for dispute).
 *
 * ## Canonical docs
 *
 * - packages/db/mkt-corporate-action-lifecycle.ts — state machine data access
 * - packages/db/mkt-schema.sql — DDL
 * - docs/plan.md — Phase 2 scope
 */

import type { AppState } from '../index';
import { makeJson } from '../lib/response';
import {
  advanceCorporateAction,
  disputeCorporateAction,
  CorporateActionTransitionError,
} from 'db/mkt-corporate-action-lifecycle';

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

/**
 * Verifies the Bearer token for lifecycle endpoints.
 *
 * Test mode: accepts INTERNAL_TEST_TOKEN env var.
 * Production (follow-on): verify a signed machine JWT.
 */
function isAuthorized(req: Request): boolean {
  const authHeader = req.headers.get('Authorization') ?? '';
  const tokenMatch = authHeader.match(/^Bearer (.+)$/);
  if (!tokenMatch) return false;
  const token = tokenMatch[1];

  if (process.env.TEST_MODE === 'true') {
    const testToken = process.env.INTERNAL_TEST_TOKEN ?? '';
    if (testToken && token === testToken) return true;
    // Also accept EDGAR_TEST_TOKEN for test convenience.
    const edgarToken = process.env.EDGAR_TEST_TOKEN ?? '';
    if (edgarToken && token === edgarToken) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Route parser
// ---------------------------------------------------------------------------

/**
 * Parses /internal/corporate-actions/:id/advance and
 * /internal/corporate-actions/:id/dispute paths.
 *
 * Returns { id, action } or null if the path does not match.
 */
function parsePath(pathname: string): { id: string; action: 'advance' | 'dispute' } | null {
  const advanceMatch = pathname.match(/^\/internal\/corporate-actions\/([^/]+)\/advance$/);
  if (advanceMatch) {
    return { id: advanceMatch[1], action: 'advance' };
  }
  const disputeMatch = pathname.match(/^\/internal\/corporate-actions\/([^/]+)\/dispute$/);
  if (disputeMatch) {
    return { id: disputeMatch[1], action: 'dispute' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// PATCH /internal/corporate-actions/:id/advance
// ---------------------------------------------------------------------------

/**
 * Handles PATCH /internal/corporate-actions/:id/advance.
 *
 * Returns:
 *   200 { id, state }  on success.
 *   401                when Bearer token is invalid.
 *   404                when the corporate action does not exist.
 *   409                when the transition is not legal (CorporateActionTransitionError).
 */
async function handleAdvance(req: Request, id: string, appState: AppState): Promise<Response> {
  const json = makeJson({});

  if (!isAuthorized(req)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  try {
    const newState = await advanceCorporateAction(id, 'system:corp-action-advance', appState.sql);
    return json({ id, state: newState }, 200);
  } catch (err) {
    if (err instanceof CorporateActionTransitionError) {
      return json(
        {
          error: 'Illegal state transition',
          from_state: err.from_state,
          attempted_to_state: err.attempted_to_state,
        },
        409,
      );
    }
    if (err instanceof Error && err.message.includes('not found')) {
      return json({ error: 'Corporate action not found' }, 404);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// POST /internal/corporate-actions/:id/dispute
// ---------------------------------------------------------------------------

/**
 * Handles POST /internal/corporate-actions/:id/dispute.
 *
 * Body: { reason: string }  — non-empty reason is required.
 *
 * Returns:
 *   200 { id, state: 'Disputed' }  on success.
 *   401                             when Bearer token is invalid.
 *   404                             when the corporate action does not exist.
 *   409                             when already in Disputed state.
 *   422                             when reason is missing or empty.
 */
async function handleDispute(req: Request, id: string, appState: AppState): Promise<Response> {
  const json = makeJson({});

  if (!isAuthorized(req)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch (_err) {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const body = rawBody as Record<string, unknown>;
  const reason = body?.reason;

  if (typeof reason !== 'string' || reason.trim() === '') {
    return json(
      {
        error: 'Validation failed',
        issues: [
          { path: ['reason'], message: 'Required and must be non-empty', code: 'invalid_type' },
        ],
      },
      422,
    );
  }

  try {
    await disputeCorporateAction(id, reason.trim(), 'system:admin-dispute', appState.sql);
    return json({ id, state: 'Disputed' }, 200);
  } catch (err) {
    if (err instanceof CorporateActionTransitionError) {
      return json(
        {
          error: 'Illegal state transition',
          from_state: err.from_state,
          attempted_to_state: err.attempted_to_state,
        },
        409,
      );
    }
    if (err instanceof Error && err.message.includes('not found')) {
      return json({ error: 'Corporate action not found' }, 404);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Routes PATCH .../advance and POST .../dispute requests.
 *
 * Returns null for non-matching paths so the caller can chain handlers.
 */
export async function handleCorporateActionLifecycleRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  const parsed = parsePath(url.pathname);
  if (!parsed) return null;

  const { id, action } = parsed;

  if (action === 'advance' && req.method === 'PATCH') {
    return handleAdvance(req, id, appState);
  }

  if (action === 'dispute' && req.method === 'POST') {
    return handleDispute(req, id, appState);
  }

  return null;
}
