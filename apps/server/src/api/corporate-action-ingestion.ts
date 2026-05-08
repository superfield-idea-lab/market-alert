/**
 * @file corporate-action-ingestion.ts
 *
 * POST /internal/ingestion/corporate-action — API-mediated corporate action
 * write endpoint — Phase 2 dev-scout stub (issue #14).
 *
 * ## Status: dev-scout stub
 *
 * This file wires a named route into the server's request handler chain.
 * The handler currently returns HTTP 503 (Not Implemented) with a structured
 * stub body. No database writes occur.
 *
 * The stub exists so that:
 *   1. The route is registered and TypeScript-checked on every build.
 *   2. The edgar_ingest worker can call this endpoint in tests and receive a
 *      deterministic response (even before the real logic lands).
 *   3. Follow-on implementation issues have a clear, typed seam to fill in.
 *
 * ## Production design (follow-on implementation)
 *
 * The production handler must:
 *
 *   1. Authenticate the caller via the WORKER_TOKEN (delegated_token from the
 *      task_queue row). The token is verified via the internal worker token
 *      path (packages/db/worker-tokens.ts verifyWorkerToken).
 *
 *   2. Validate the request body against `CorporateActionIngestBody`.
 *
 *   3. Call `encryptField` (packages/core/encryption.ts) on `filing_text`
 *      with sensitivity class 'HIGH' and entity type 'corporate_action'.
 *      The 'corporate_action' entity type must first be added to
 *      ENTITY_SENSITIVITY_CLASS in packages/core/encryption.ts.
 *
 *   4. Call `insertCorporateAction` (packages/db/mkt-corporate-action.ts).
 *      ON CONFLICT DO NOTHING ensures idempotency.
 *
 *   5. Enqueue one ALERT_ENRICH task via `enqueueTask` with:
 *        - agent_type: TASK_TYPE_AGENT_MAP[TaskType.ALERT_ENRICH] = 'enrichment'
 *        - job_type:   TaskType.ALERT_ENRICH
 *        - payload:    { corporate_action_id: <new row UUID> }
 *        - idempotency_key: `alert-enrich:<corporate_action_id>`
 *
 *   6. Return HTTP 201 with the new CorporateAction row ID.
 *
 * ## Authentication seam discovered during scout
 *
 * The email ingestion endpoint (apps/server/src/api/ingestion.ts) uses a
 * single-use ingestion token (mintIngestionToken / verifyIngestionToken from
 * packages/db/ingestion-token.ts). That pattern does not fit the trading
 * worker model, where the worker holds a WORKER_TOKEN (packages/db/worker-tokens.ts).
 *
 * The follow-on implementation must use `verifyWorkerToken` for this endpoint.
 * The worker_tokens table and verify function already exist (issue #36 landed
 * these). The follow-on must:
 *   - Mint a WORKER_TOKEN scoped to 'corporate-action-ingest' before the
 *     edgar_ingest worker's claim loop.
 *   - Pass the token in the Authorization: Bearer <token> header.
 *   - Consume it on first successful call (single-use guarantee).
 *
 * ## Risks identified during scout
 *
 * 1. `encryptField` in packages/core/encryption.ts does not yet recognise
 *    'corporate_action' as an entity type. Adding it requires a change to
 *    packages/core/types.ts (EntityType union) and encryption.ts
 *    (ENTITY_SENSITIVITY_CLASS map). Both files compile cleanly today but will
 *    need updates before the real encrypt call can be made.
 *
 * 2. The ALERT_ENRICH task enqueue must use the assertNoPiiInPayload guard.
 *    The payload { corporate_action_id: uuid } is PII-free, but the guard
 *    should still be called explicitly for belt-and-suspenders compliance.
 *
 * 3. The route '/internal/ingestion/corporate-action' must be added to the
 *    server's fetch handler dispatch chain in apps/server/src/index.ts.
 *    The dispatch chain currently does not include this handler. The follow-on
 *    implementation issue must add the import and the dispatch call.
 *
 * ## Canonical docs
 *
 * - docs/architecture.md — ingestion pipeline, internal API conventions
 * - blueprint: worker.yaml § WORKER-P-001 (API-gateway sole writer)
 * - apps/server/src/api/ingestion.ts — email ingestion pattern reference
 * - packages/db/mkt-corporate-action.ts — CorporateAction schema stub
 * - packages/db/worker-tokens.ts — verifyWorkerToken
 * - packages/db/task-queue.ts — enqueueTask, TaskType.ALERT_ENRICH
 * - packages/core/encryption.ts — encryptField
 */

import type { AppState } from '../index';
import { makeJson } from '../lib/response';

// ---------------------------------------------------------------------------
// Request body type
// ---------------------------------------------------------------------------

/**
 * Body expected by POST /internal/ingestion/corporate-action.
 *
 * All fields are mandatory in the production implementation.
 * The filing_text field must be raw filing XML/text from the edgar_ingest
 * worker — it is encrypted at rest by this handler, not by the caller.
 *
 * DEV-SCOUT NOTE: the 'corporate_action' EntityType does not exist yet in
 * packages/core/types.ts. The follow-on implementation issue must add it
 * before the encrypt call can be typed correctly.
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
   * This field is encrypted at rest by the handler — the caller provides
   * plaintext; the handler returns ciphertext confirmation only.
   */
  filing_text: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles POST /internal/ingestion/corporate-action.
 *
 * Returns null for non-matching paths so the caller can chain handlers.
 *
 * DEV-SCOUT STUB: Returns HTTP 503 with a structured stub response.
 * The real implementation is gated on the follow-on Phase 2 issue.
 */
export async function handleCorporateActionIngestionRequest(
  req: Request,
  url: URL,
  _appState: AppState,
): Promise<Response | null> {
  if (req.method !== 'POST' || url.pathname !== '/internal/ingestion/corporate-action') {
    return null;
  }

  const corsHeaders = {};
  const json = makeJson(corsHeaders);

  // DEV-SCOUT STUB: parse the body for type-checking purposes and return
  // a deterministic 503 stub response. The real logic (auth, encrypt,
  // insert, enqueue) is implemented in the follow-on issue.
  let body: Partial<CorporateActionIngestBody>;
  try {
    body = (await req.json()) as Partial<CorporateActionIngestBody>;
  } catch (_err) {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  // Basic presence check — gives the integration test a 400 signal if the
  // caller omits a required field, even in stub mode.
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

  // DEV-SCOUT STUB — not yet implemented.
  return json(
    {
      stub: true,
      message:
        'POST /internal/ingestion/corporate-action is a dev-scout stub. ' +
        'Implement in the Phase 2 follow-on issue.',
      received: {
        accession_number: body.accession_number,
        form_type: body.form_type,
        cik: body.cik,
      },
    },
    503,
  );
}
