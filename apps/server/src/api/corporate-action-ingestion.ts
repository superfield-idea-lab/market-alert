/**
 * @file corporate-action-ingestion.ts
 *
 * POST /internal/ingestion/corporate-action — API-mediated corporate action
 * write endpoint — Phase 2 implementation (issue #14).
 *
 * ## Security model
 *
 * Bearer token from the task's delegated_token column (set by claimNextTask).
 * In TEST_MODE the token is verified against the X-Test-Worker-Token header
 * value stored on the server at test-mode setup (see test-session.ts).
 *
 * For the Phase 2 scout, TEST_MODE=true allows the integration test to pass
 * a static bearer token set via the EDGAR_TEST_TOKEN env var. Production
 * always requires a properly signed worker token (follow-on hardening issue).
 *
 * ## Write path
 *
 *   1. Extract and validate Bearer token (test-mode: static secret; prod: JWT).
 *   2. Validate request body against CorporateActionIngestBody.
 *   3. Encrypt filing_text via encryptField('corporate_action', plaintext).
 *   4. Insert row into mkt_corporate_actions via insertCorporateAction
 *      (ON CONFLICT DO NOTHING for idempotency).
 *   5. Enqueue one ALERT_ENRICH task with payload { corporate_action_id }.
 *   6. Return 201 with the new row id (or 200 if idempotent duplicate).
 *
 * ## Canonical docs
 *
 * - docs/architecture.md — ingestion pipeline
 * - blueprint: worker.yaml § WORKER-P-001 (API-gateway sole writer)
 * - packages/db/mkt-corporate-action.ts — CorporateAction schema
 * - packages/db/task-queue.ts — enqueueTask, TaskType.ALERT_ENRICH
 * - packages/core/encryption.ts — encryptField
 */

import type { AppState } from '../index';
import { makeJson } from '../lib/response';
import { encryptField } from 'core';
import { insertCorporateAction } from 'db/mkt-corporate-action';
import { enqueueTask, TaskType, TASK_TYPE_AGENT_MAP } from 'db/task-queue';

// ---------------------------------------------------------------------------
// Request body type
// ---------------------------------------------------------------------------

/**
 * Body expected by POST /internal/ingestion/corporate-action.
 *
 * All fields are mandatory. filing_text is raw filing XML/text from the
 * edgar_ingest worker — encrypted at rest by this handler, not by the caller.
 */
export interface CorporateActionIngestBody {
  /** Normalised EDGAR accession number (with dashes). */
  accession_number: string;
  /** EDGAR form type, e.g. '8-K'. */
  form_type: string;
  /** CIK of the reporting entity (string; no leading zeros). */
  cik: string;
  /** Legal name of the issuer from the EDGAR feed entry. May be absent. */
  issuer_name?: string | null;
  /** ISO-8601 UTC filing date from the ATOM <updated> element. */
  filing_date: string;
  /**
   * Raw filing entry text (ATOM XML fragment or full filing document).
   * Encrypted at rest by this handler — caller provides plaintext.
   */
  filing_text: string;
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

/**
 * Verifies the Bearer token on the request.
 *
 * Phase 2 scout model:
 *   - TEST_MODE=true: accepts EDGAR_TEST_TOKEN env var as a static shared secret.
 *   - Production (follow-on): verify a signed worker JWT via issueWorkerToken.
 *
 * Returns true when the token is valid.
 */
function isAuthorized(req: Request): boolean {
  const authHeader = req.headers.get('Authorization') ?? '';
  const tokenMatch = authHeader.match(/^Bearer (.+)$/);
  if (!tokenMatch) return false;
  const token = tokenMatch[1];

  // Test-mode: static shared secret from env (never set in production).
  if (process.env.TEST_MODE === 'true') {
    const testToken = process.env.EDGAR_TEST_TOKEN ?? '';
    if (testToken && token === testToken) return true;
  }

  // Production (follow-on): verify signed worker JWT.
  // TODO(follow-on): replace static secret with issueWorkerToken/verifyWorkerToken.
  return false;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles POST /internal/ingestion/corporate-action.
 *
 * Returns null for non-matching paths so the caller can chain handlers.
 */
export async function handleCorporateActionIngestionRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (req.method !== 'POST' || url.pathname !== '/internal/ingestion/corporate-action') {
    return null;
  }

  const corsHeaders = {};
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  // ---------------------------------------------------------------------------
  // 1. Auth
  // ---------------------------------------------------------------------------

  if (!isAuthorized(req)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // ---------------------------------------------------------------------------
  // 2. Parse and validate body
  // ---------------------------------------------------------------------------

  let body: Partial<CorporateActionIngestBody>;
  try {
    body = (await req.json()) as Partial<CorporateActionIngestBody>;
  } catch (_err) {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const required: (keyof CorporateActionIngestBody)[] = [
    'accession_number',
    'form_type',
    'cik',
    'filing_date',
    'filing_text',
  ];
  for (const field of required) {
    if (!body[field]) {
      return json({ error: `Missing required field: ${field}` }, 400);
    }
  }

  const {
    accession_number,
    form_type,
    cik,
    issuer_name = null,
    filing_date,
    filing_text,
  } = body as Required<CorporateActionIngestBody>;

  // ---------------------------------------------------------------------------
  // 3. Encrypt filing_text (AES-256-GCM via encryptField)
  // ---------------------------------------------------------------------------

  const filingTextEncrypted = await encryptField('corporate_action', filing_text);

  // ---------------------------------------------------------------------------
  // 4. Insert CorporateAction row (ON CONFLICT DO NOTHING for idempotency)
  // ---------------------------------------------------------------------------

  const idempotencyKey = `edgar:${accession_number}`;
  const filingDateObj = new Date(filing_date);

  const row = await insertCorporateAction({
    idempotency_key: idempotencyKey,
    form_type,
    accession_number,
    cik,
    issuer_name: issuer_name ?? null,
    filing_date: filingDateObj,
    filing_text_encrypted: filingTextEncrypted,
    sql,
  });

  // If null, the row already exists (idempotent duplicate).
  if (!row) {
    // Return 200 with existing row id for idempotency.
    const existing = await sql<{ id: string }[]>`
      SELECT id FROM mkt_corporate_actions
      WHERE idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    return json({ id: existing[0]?.id ?? null, duplicate: true }, 200);
  }

  // ---------------------------------------------------------------------------
  // 5. Enqueue one ALERT_ENRICH task
  // ---------------------------------------------------------------------------

  const alertEnrichIdempotencyKey = `alert-enrich:${row.id}`;
  await enqueueTask({
    idempotency_key: alertEnrichIdempotencyKey,
    agent_type: TASK_TYPE_AGENT_MAP[TaskType.ALERT_ENRICH],
    job_type: TaskType.ALERT_ENRICH,
    payload: { corporate_action_id: row.id },
    created_by: 'edgar_ingest',
    sql, // Forward the appState sql pool so writes go to the correct DB (test isolation)
  });

  // ---------------------------------------------------------------------------
  // 6. Return 201
  // ---------------------------------------------------------------------------

  return json({ id: row.id }, 201);
}
