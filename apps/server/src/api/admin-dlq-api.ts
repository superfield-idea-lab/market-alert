/**
 * @file admin-dlq-api.ts
 *
 * Admin DLQ (dead-letter queue) management endpoints — Phase 10 (issue #89).
 *
 * ## Routes
 *
 *   GET  /api/admin/dlq
 *     List dead-letter tasks. Optional query params:
 *       ?agent_type=<type>  — filter to a specific agent type
 *       ?limit=<n>          — max rows (default 50)
 *       ?offset=<n>         — pagination offset (default 0)
 *     Auth: Admin or superuser only.
 *     Returns: { tasks: TaskQueueAdminRow[]; total_dead: number }
 *
 *   POST /api/admin/dlq/:id/requeue
 *     Requeue a dead task back to pending status.
 *     Auth: Admin or superuser only.
 *     Returns 200 { task_id, new_status } on success.
 *     Returns 404 when the task does not exist or is not dead.
 *
 * ## Architecture
 *
 * DLQ replay is the Admin mechanism for recovering from persistent worker
 * failures. The Admin inspects the dead-task list, resolves the root cause,
 * and re-enqueues the affected tasks.
 *
 * Architecture ref: docs/architecture.md §"DLQ replay"
 *
 * ## Security model
 *
 * Admin-scoped session required. Non-admin sessions receive 403.
 *
 * ## Canonical docs
 *
 * - `docs/prd.md` §7, §9 — admin DLQ control surface
 * - `docs/architecture.md` §"DLQ replay"
 * - `packages/db/task-queue.ts` — listDlqTasks, requeueDlqTask
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/89
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import { listDlqTasks, requeueDlqTask, getDlqDepth } from 'db/task-queue';
import { emitAuditEvent } from '../policies/audit-service';

// ---------------------------------------------------------------------------
// Role check helper
// ---------------------------------------------------------------------------

async function isAdminOrSuperuser(sql: AppState['sql'], userId: string): Promise<boolean> {
  if (isSuperuser(userId)) return true;

  const rows = await sql<{ role: string }[]>`
    SELECT (properties->>'role') AS role
    FROM entities
    WHERE id = ${userId} AND type = 'user'
    LIMIT 1
  `;
  const role = rows[0]?.role ?? '';
  return role === 'admin';
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle all /api/admin/dlq/* requests.
 *
 * Returns null for unmatched paths so the caller can fall through.
 */
export async function handleAdminDlqRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/admin/dlq')) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  // ── Session auth ──────────────────────────────────────────────────────────
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return json({ error: 'Unauthorized — session required' }, 401);
  }

  // ── Admin role check ──────────────────────────────────────────────────────
  const isAdmin = await isAdminOrSuperuser(sql, user.id);
  if (!isAdmin) {
    return json({ error: 'Forbidden — admin role required' }, 403);
  }

  // ── POST /api/admin/dlq/:id/requeue ─────────────────────────────────────
  const requeueMatch = url.pathname.match(/^\/api\/admin\/dlq\/([^/]+)\/requeue$/);
  if (requeueMatch && req.method === 'POST') {
    const taskId = requeueMatch[1]!;

    // Emit audit event before the state mutation.
    await emitAuditEvent({
      actor_id: user.id,
      action: 'dlq.requeue',
      entity_type: 'task_queue',
      entity_id: taskId,
      before: { status: 'dead' },
      after: { status: 'pending' },
      ts: new Date().toISOString(),
    });

    const result = await requeueDlqTask(taskId, { sql });
    if (!result) {
      return json({ error: `Task not found or not in dead status: ${taskId}` }, 404);
    }

    return json(result, 200);
  }

  // ── GET /api/admin/dlq ───────────────────────────────────────────────────
  if (url.pathname === '/api/admin/dlq' && req.method === 'GET') {
    const agent_type = url.searchParams.get('agent_type') ?? undefined;
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
    const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10), 0);

    const [tasks, depths] = await Promise.all([
      listDlqTasks({ agent_type, limit, offset, sql }),
      getDlqDepth({ sql }),
    ]);

    // Total dead across all agent types (or for the filtered type).
    const totalDead = agent_type
      ? (depths.find((d) => d.agent_type === agent_type)?.dead_count ?? 0)
      : depths.reduce((sum, d) => sum + d.dead_count, 0);

    return json({ tasks, total_dead: totalDead, depths }, 200);
  }

  return null;
}
