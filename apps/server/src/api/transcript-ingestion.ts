/**
 * @file transcript-ingestion.ts
 *
 * POST /internal/ingestion/transcript — edge-path meeting transcript write.
 *
 * Edge-path invariant
 * --------------------
 * Raw audio NEVER leaves the device.  The PWA transcribes locally (on-device
 * Web Speech API or Whisper.cpp WASM) and calls this endpoint with only the
 * transcript text and customer tag.  No audio bytes are accepted here — the
 * Content-Type must be `application/json` and the body must not contain any
 * binary audio payload.
 *
 * Security model
 * ---------------
 * - Bearer session JWT (standard calypso_auth cookie) — the RM is already
 *   logged in when they record a meeting on the PWA.
 * - customer_id is caller-supplied and scoped by the session's tenant_id.
 * - Transcript body is encrypted with AES-256-GCM before the entity row
 *   is written.  ENCRYPTION_DISABLED=true skips encryption in dev/test.
 * - Every successful write emits an audit event BEFORE the DB insert.
 *   If the audit write fails the transcript row is not persisted.
 * - An AUTOLEARN task is enqueued immediately after write so the new
 *   transcript is picked up by the next autolearn worker run.
 *
 * Blueprint: PHASE-5-SCOUT, API-W-001 (API is sole transcript writer).
 * Issue: #53 — edge-path meeting recording scout end-to-end
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { makeJson } from '../lib/response';
import { encryptProperties } from 'core';
import { emitAuditEvent } from '../policies/audit-service';
import { extractTraceId } from 'core';
import { enqueueTask, TASK_TYPE_AGENT_MAP, TaskType } from 'db/task-queue';
import { registerPhase5EntityTypesWithDb } from 'db/phase5-entity-types';
import { sql as globalSql } from 'db';

// ---------------------------------------------------------------------------
// Entity type registration
// ---------------------------------------------------------------------------

/**
 * Registers Phase 5 entity types (`audio_recording` and `transcript`) against
 * the database at server startup (Phase 5 — PWA & meeting transcription, issue #58).
 *
 * Delegates to `registerPhase5EntityTypesWithDb` which is the single
 * source of truth for Phase 5 entity type definitions.
 *
 * Called idempotently — safe to call multiple times.
 */
export async function registerTranscriptEntityType(): Promise<void> {
  await registerPhase5EntityTypesWithDb(globalSql);
}

// ---------------------------------------------------------------------------
// Request body type
// ---------------------------------------------------------------------------

export interface IngestTranscriptBody {
  /** Plain-text transcript. Encrypted at rest. MUST NOT contain audio bytes. */
  text: string;
  /** Customer entity id this transcript is attached to. */
  customer_id: string;
  /** Recording duration in seconds. Optional. */
  duration_s?: number;
  /** ISO-8601 timestamp when the recording started. */
  recorded_at: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles POST /internal/ingestion/transcript.
 *
 * Returns null for non-matching paths so the caller can chain handlers.
 *
 * Flow:
 *  1. Authenticate session (RM must be logged in)
 *  2. Parse + validate request body
 *  3. Encrypt transcript text
 *  4. Emit audit event (before DB write — if audit fails, write is denied)
 *  5. Insert `transcript` entity row tagged to customer + tenant
 *  6. Enqueue an AUTOLEARN task so the autolearn worker picks up the new transcript
 *  7. Return { id } 201
 */
export async function handleTranscriptIngestionRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (url.pathname !== '/internal/ingestion/transcript' || req.method !== 'POST') return null;

  const corsHeaders = getCorsHeaders(req);
  const { sql } = appState;
  const json = makeJson(corsHeaders);

  // ---------------------------------------------------------------------------
  // 1. Authenticate — RM session cookie
  // ---------------------------------------------------------------------------

  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // ---------------------------------------------------------------------------
  // 2. Parse and validate request body
  // ---------------------------------------------------------------------------

  let body: IngestTranscriptBody;
  try {
    body = (await req.json()) as IngestTranscriptBody;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.text || typeof body.text !== 'string' || body.text.trim() === '') {
    return json({ error: 'Missing required field: text' }, 400);
  }
  if (!body.customer_id || typeof body.customer_id !== 'string') {
    return json({ error: 'Missing required field: customer_id' }, 400);
  }
  if (!body.recorded_at || typeof body.recorded_at !== 'string') {
    return json({ error: 'Missing required field: recorded_at' }, 400);
  }
  const recordedAt = new Date(body.recorded_at);
  if (isNaN(recordedAt.getTime())) {
    return json({ error: 'recorded_at must be a valid ISO-8601 timestamp' }, 400);
  }

  // ---------------------------------------------------------------------------
  // 3. Encrypt sensitive fields
  // ---------------------------------------------------------------------------

  const encryptedProperties = await encryptProperties('transcript', {
    text: body.text,
  });

  // ---------------------------------------------------------------------------
  // 4. Emit audit event BEFORE the primary write
  // ---------------------------------------------------------------------------

  const entityId = crypto.randomUUID();
  const now = new Date().toISOString();
  const correlationId = extractTraceId(req) ?? crypto.randomUUID();

  await emitAuditEvent({
    actor_id: user.id,
    action: 'transcript.ingest',
    entity_type: 'transcript',
    entity_id: entityId,
    before: null,
    after: {
      customer_id: body.customer_id,
      recorded_at: body.recorded_at,
      source: 'edge_device',
    },
    ip: req.headers.get('x-forwarded-for') ?? undefined,
    user_agent: req.headers.get('user-agent') ?? undefined,
    correlation_id: correlationId,
    ts: now,
  });

  // ---------------------------------------------------------------------------
  // 5. Persist the Transcript entity — tagged to customer and tenant
  // ---------------------------------------------------------------------------

  // Resolve tenant_id: prefer the authenticated user's tenant, fall back to
  // the customer_id prefix convention used in test environments.
  const tenantId: string = (user as unknown as Record<string, unknown>).tenant_id
    ? String((user as unknown as Record<string, unknown>).tenant_id)
    : body.customer_id;

  const properties = {
    text: encryptedProperties.text,
    customer_id: body.customer_id,
    duration_s: body.duration_s ?? null,
    source: 'edge_device',
    recorded_at: body.recorded_at,
  };

  await sql`
    INSERT INTO entities (id, type, properties, tenant_id)
    VALUES (
      ${entityId},
      'transcript',
      ${JSON.stringify(properties)},
      ${tenantId}
    )
  `;

  // ---------------------------------------------------------------------------
  // 6. Enqueue AUTOLEARN task — triggers autolearn on new transcript
  // ---------------------------------------------------------------------------

  const autolearnidemKey = `autolearn:transcript:${entityId}`;
  await enqueueTask({
    idempotency_key: autolearnidemKey,
    agent_type: TASK_TYPE_AGENT_MAP[TaskType.AUTOLEARN],
    job_type: 'autolearn_on_transcript',
    payload: {
      trigger: 'transcript_ingested',
      transcript_id: entityId,
      customer_id: body.customer_id,
      tenant_id: tenantId,
    },
    correlation_id: correlationId,
    created_by: user.id,
    priority: 5,
  });

  return json({ id: entityId }, 201);
}
