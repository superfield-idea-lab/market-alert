/**
 * Deepclean API — on-demand full-ground-truth wiki rebuild.
 *
 * POST /api/deepclean
 *   Trigger a deepclean run for a specific (dept, customer) pair.
 *   Body: { dept_id: string, customer_id: string, idempotency_key?: string }
 *   Auth: operator role only (properties.role === 'operator' or superuser).
 *
 * Deepclean semantics (PRD §4.5, issue #41):
 *   - Full ground truth is fetched (not incremental).
 *   - The resulting WikiPageVersion always lands in AWAITING_REVIEW.
 *   - Explicit human approval is required regardless of diff materiality.
 *   - Auto-publish is explicitly forbidden for deepclean output.
 *
 * Blueprint refs:
 *   - TQ-D-001: single-table multi-type queue
 *   - TQ-P-003: idempotent task creation
 *   - WORKER-T-001: writes route through API, never direct DB
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import { enqueueTask, TASK_TYPE_AGENT_MAP, TaskType } from 'db/task-queue';
import { emitAuditEvent } from '../policies/audit-service';

/** Job type constant for the deepclean worker path. */
export const DEEPCLEAN_JOB_TYPE = 'deepclean_full_rebuild';

/**
 * Deepclean task payload shape.
 *
 * `full_ground_truth` is always true — it signals the stager to fetch the
 * entire corpus for the (dept, customer) pair rather than an incremental diff.
 * `review_required` is always true — the worker must write AWAITING_REVIEW
 * regardless of materiality.
 */
export interface DeepcleanTaskPayload {
  dept_id: string;
  customer_id: string;
  full_ground_truth: true;
  review_required: true;
}

/**
 * Returns true when the given user has the operator role.
 *
 * An operator is either:
 *   - A platform superuser (SUPERUSER_ID env var), or
 *   - A user whose `properties.role` is 'operator'.
 *
 * The role is stored in the `entities` table JSONB `properties` column.
 * The caller is responsible for fetching the user row if they need DB-backed
 * role checking (the JWT payload only carries `id` and `username`).
 */
export function isOperatorById(userId: string): boolean {
  return isSuperuser(userId);
}

/**
 * Returns true when the authenticated user's DB entity has role 'operator'
 * or when they are the platform superuser.
 */
export async function isOperator(userId: string, appState: AppState): Promise<boolean> {
  if (isSuperuser(userId)) return true;

  const rows = await appState.sql<{ role: string | null }[]>`
    SELECT properties->>'role' AS role
    FROM entities
    WHERE id = ${userId} AND type = 'user'
    LIMIT 1
  `;

  const role = rows[0]?.role ?? null;
  return role === 'operator';
}

export async function handleDeepcleanRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/deepclean')) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);

  // POST /api/deepclean — trigger a deepclean run
  if (req.method === 'POST' && url.pathname === '/api/deepclean') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    // Role check: operator or superuser only
    const authorised = await isOperator(user.id, appState);
    if (!authorised) return json({ error: 'Forbidden' }, 403);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { dept_id, customer_id, idempotency_key } = body as Record<string, unknown>;

    if (!dept_id || typeof dept_id !== 'string') {
      return json({ error: 'dept_id is required' }, 400);
    }
    if (!customer_id || typeof customer_id !== 'string') {
      return json({ error: 'customer_id is required' }, 400);
    }

    // Derive an idempotency key: caller may supply one, or we generate from
    // dept+customer+timestamp so repeated manual triggers don't silently dedupe.
    const idemKey =
      typeof idempotency_key === 'string' && idempotency_key.trim()
        ? idempotency_key.trim()
        : `deepclean:${dept_id}:${customer_id}:${Date.now()}`;

    const payload: DeepcleanTaskPayload = {
      dept_id,
      customer_id,
      full_ground_truth: true,
      review_required: true,
    };

    const task = await enqueueTask({
      idempotency_key: idemKey,
      agent_type: TASK_TYPE_AGENT_MAP[TaskType.DEEPCLEAN],
      job_type: DEEPCLEAN_JOB_TYPE,
      payload: payload as unknown as Record<string, unknown>,
      created_by: user.id,
      priority: 3, // Deepclean is operator-initiated; higher priority than default.
    });

    // Audit the trigger
    await emitAuditEvent({
      actor_id: user.id,
      action: 'deepclean.triggered',
      entity_type: 'task_queue',
      entity_id: task.id,
      before: null,
      after: {
        task_id: task.id,
        dept_id,
        customer_id,
        idempotency_key: idemKey,
      },
      ts: new Date().toISOString(),
    }).catch((err) => console.warn('[audit] deepclean.triggered audit write failed:', err));

    return json(
      {
        task_id: task.id,
        status: task.status,
        idempotency_key: task.idempotency_key,
        agent_type: task.agent_type,
        job_type: task.job_type,
        // Callers can poll task status; full ground truth and AWAITING_REVIEW
        // routing happen inside the worker.
        review_required: true,
        full_ground_truth: true,
      },
      202,
    );
  }

  return null;
}
