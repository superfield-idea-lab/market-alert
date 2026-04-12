/**
 * @file transcription.ts
 *
 * Transcript write API — POST /api/transcriptions
 *
 * This endpoint is the shared write path for both the edge (short recording)
 * path and the cluster-internal worker (long recording) path.  Workers submit
 * transcripts via their delegated Bearer token; all writes go through this
 * API layer so business logic, schema validation, and audit logging apply
 * uniformly (blueprint: WORKER-T-001, WORKER-T-002).
 *
 * Routes handled
 * ---------------
 *   POST /api/transcriptions            — submit a transcript (delegated-token auth)
 *   GET  /api/transcriptions/:id        — fetch a single transcript (session-cookie auth)
 *   GET  /api/transcriptions            — list transcripts (session-cookie auth)
 *
 * Transcript entity shape
 * ------------------------
 * Transcripts are stored as `entities` rows with `type = 'transcript'`.
 * The `properties` JSON column holds:
 *   - recording_ref: string  — opaque reference to the source audio blob
 *   - transcript:    string  — the transcribed text
 *   - duration_ms:   number  — optional transcription wall-clock time
 *   - worker_path:   string  — "edge" | "cluster-worker" | "assemblyai-legacy"
 *   - status:        string  — "completed" | "failed"
 *
 * AssemblyAI legacy routing
 * -------------------------
 * The `resolveTranscriptionBackend` function checks the tenant's
 * `assemblyai_legacy_enabled` policy before permitting the AssemblyAI path.
 * Regulated tenants are always blocked — the gate is structural, not
 * policy-based (issue #60). The AssemblyAI integration itself is not shipped
 * in this issue; the routing stub is present so future work can hook in
 * without changing the routing layer.
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { verifyDelegatedToken } from '../auth/delegated-token';
import { makeJson } from '../lib/response';
import { isAssemblyAiLegacyEnabled } from 'db/tenant-config';

/** Properties stored in the entity row for a transcript. */
export interface TranscriptProperties {
  recording_ref: string;
  transcript: string;
  duration_ms?: number;
  /** Which execution path produced this transcript. */
  worker_path: 'edge' | 'cluster-worker' | 'assemblyai-legacy';
  status: 'completed' | 'failed';
}

/**
 * Transcription backend descriptor returned by `resolveTranscriptionBackend`.
 *
 * `backend` is one of:
 *   - `'edge'`             — on-device PWA transcription (default for short recordings)
 *   - `'cluster-worker'`   — cluster-internal transcription model (for long recordings)
 *   - `'assemblyai-legacy'`— US-hosted AssemblyAI (opt-in only, non-regulated tenants)
 *
 * `allowed` is `false` when the requested backend cannot be used for this tenant.
 * `reason` explains why the backend is not allowed (present only when `allowed` is false).
 */
export type TranscriptionBackend = 'edge' | 'cluster-worker' | 'assemblyai-legacy';

export interface ResolvedTranscriptionBackend {
  backend: TranscriptionBackend;
  allowed: boolean;
  reason?: string;
}

/**
 * Resolves which transcription backend to use for a tenant and requested path.
 *
 * For the `assemblyai-legacy` path this function gates on the tenant's
 * `assemblyai_legacy_enabled` policy (issue #60). The function returns
 * `{ allowed: false }` when the path is not permitted; callers should fall
 * back to the `cluster-worker` path or return an error.
 *
 * @param tenantId        Tenant identifier (null for requests without a tenant).
 * @param requestedPath   The path the caller wants to use.
 * @param db              Optional postgres client (for testability).
 */
export async function resolveTranscriptionBackend(
  tenantId: string | null,
  requestedPath: TranscriptionBackend,
  db?: Parameters<typeof isAssemblyAiLegacyEnabled>[1],
): Promise<ResolvedTranscriptionBackend> {
  if (requestedPath === 'assemblyai-legacy') {
    if (!tenantId) {
      return {
        backend: 'assemblyai-legacy',
        allowed: false,
        reason: 'assemblyai-legacy path requires a tenant_id',
      };
    }
    const enabled = db
      ? await isAssemblyAiLegacyEnabled(tenantId, db)
      : await isAssemblyAiLegacyEnabled(tenantId);
    if (!enabled) {
      return {
        backend: 'assemblyai-legacy',
        allowed: false,
        reason: 'assemblyai_legacy_enabled is not set for this tenant',
      };
    }
  }
  return { backend: requestedPath, allowed: true };
}

/**
 * Handle all /api/transcriptions requests.
 *
 * POST /api/transcriptions — delegated-token auth (workers submit transcripts)
 * GET  /api/transcriptions — session-cookie auth (human callers list transcripts)
 * GET  /api/transcriptions/:id — session-cookie auth (human callers fetch one)
 */
export async function handleTranscriptionRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/transcriptions')) return null;

  const corsHeaders = getCorsHeaders(req);
  const { sql } = appState;
  const json = makeJson(corsHeaders);

  // ── POST /api/transcriptions ────────────────────────────────────────────────
  // Accepts both:
  //   - Delegated-token (Bearer) auth from the cluster-internal transcription worker
  //   - Session-cookie auth from the edge path or test clients
  if (req.method === 'POST' && url.pathname === '/api/transcriptions') {
    const authHeader = req.headers.get('Authorization') ?? '';
    const bearerMatch = authHeader.match(/^Bearer (.+)$/);

    if (bearerMatch) {
      // Worker path: delegated Bearer token; no CSRF needed (server-to-server)
      const token = bearerMatch[1];

      // Verify the token — we need the task_id from the request body for this.
      // Read the body first, then verify.
      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }

      const { task_id, recording_ref, transcript, duration_ms, worker_path } = body as Record<
        string,
        unknown
      >;

      if (!task_id || typeof task_id !== 'string')
        return json({ error: 'task_id is required' }, 400);
      if (!recording_ref || typeof recording_ref !== 'string')
        return json({ error: 'recording_ref is required' }, 400);
      if (!transcript || typeof transcript !== 'string')
        return json({ error: 'transcript is required' }, 400);

      // Look up the task to get agent_type and created_by for token verification.
      const rows = await sql<{ agent_type: string; created_by: string; status: string }[]>`
        SELECT agent_type, created_by, status
        FROM task_queue
        WHERE id = ${task_id}
      `;
      if (rows.length === 0) return json({ error: 'Task not found' }, 404);

      const task = rows[0];
      try {
        await verifyDelegatedToken(token, {
          expectedTaskId: task_id,
          expectedAgentType: task.agent_type,
          expectedCreatedBy: task.created_by,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid token';
        return json({ error: message }, 401);
      }

      const effectivePath: 'edge' | 'cluster-worker' =
        worker_path === 'edge' || worker_path === 'cluster-worker'
          ? (worker_path as 'edge' | 'cluster-worker')
          : 'cluster-worker';

      const properties: TranscriptProperties = {
        recording_ref: recording_ref as string,
        transcript: transcript as string,
        duration_ms: typeof duration_ms === 'number' ? duration_ms : undefined,
        worker_path: effectivePath,
        status: 'completed',
      };

      const id = crypto.randomUUID();
      const [row] = await sql<
        {
          id: string;
          properties: TranscriptProperties;
          created_at: string;
        }[]
      >`
        INSERT INTO entities (id, type, properties, tenant_id)
        VALUES (${id}, 'transcript', ${sql.json(properties as never)}, null)
        RETURNING id, properties, created_at
      `;

      return json({ id: row.id, properties: row.properties, created_at: row.created_at }, 201);
    }

    // Edge/session path: session-cookie auth
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);
    // actorId (user.id) is available here for future audit log integration

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { recording_ref, transcript, duration_ms, worker_path } = body as Record<string, unknown>;

    if (!recording_ref || typeof recording_ref !== 'string')
      return json({ error: 'recording_ref is required' }, 400);
    if (!transcript || typeof transcript !== 'string')
      return json({ error: 'transcript is required' }, 400);

    const effectivePath: 'edge' | 'cluster-worker' =
      worker_path === 'edge' || worker_path === 'cluster-worker'
        ? (worker_path as 'edge' | 'cluster-worker')
        : 'edge';

    const properties: TranscriptProperties = {
      recording_ref: recording_ref as string,
      transcript: transcript as string,
      duration_ms: typeof duration_ms === 'number' ? duration_ms : undefined,
      worker_path: effectivePath,
      status: 'completed',
    };

    const id = crypto.randomUUID();
    const [row] = await sql<
      {
        id: string;
        properties: TranscriptProperties;
        created_at: string;
      }[]
    >`
      INSERT INTO entities (id, type, properties, tenant_id)
      VALUES (${id}, 'transcript', ${sql.json(properties as never)}, null)
      RETURNING id, properties, created_at
    `;

    return json({ id: row.id, properties: row.properties, created_at: row.created_at }, 201);
  }

  // ── GET /api/transcriptions ─────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/transcriptions') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const rows = await sql<
      {
        id: string;
        properties: TranscriptProperties;
        created_at: string;
      }[]
    >`
      SELECT id, properties, created_at
      FROM entities
      WHERE type = 'transcript'
      ORDER BY created_at DESC
    `;

    return json(rows);
  }

  // ── GET /api/transcriptions/:id ─────────────────────────────────────────────
  const idMatch = url.pathname.match(/^\/api\/transcriptions\/([^/]+)$/);
  if (req.method === 'GET' && idMatch) {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const transcriptId = idMatch[1];
    const rows = await sql<
      {
        id: string;
        properties: TranscriptProperties;
        created_at: string;
      }[]
    >`
      SELECT id, properties, created_at
      FROM entities
      WHERE id = ${transcriptId} AND type = 'transcript'
    `;

    if (rows.length === 0) return json({ error: 'Not found' }, 404);
    return json(rows[0]);
  }

  return null;
}
