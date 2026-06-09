/**
 * @file canonical-source-registration.ts
 *
 * POST /internal/canonical-sources — API-mediated canonical source registration
 * endpoint — Phase 3 scout stub (issue #74).
 *
 * ## What this file does (stub)
 *
 * This is a no-op stub that defines the request/response types and the handler
 * signature for the canonical-source registration endpoint. The full scraping
 * and verification pipeline is a Phase 3 feature issue.
 *
 * The stub:
 *   - Defines `RegisterCanonicalSourceBody` and `RegisterCanonicalSourceResponse`
 *     (the contract that the source-discovery worker depends on).
 *   - Implements `handleCanonicalSourceRegistrationRequest` which validates
 *     the Bearer token, parses the body, delegates to
 *     `registerCanonicalSource` in `packages/db/canonical-source-store.ts`,
 *     and returns 201 (new) or 200 (idempotent duplicate).
 *   - Does NOT yet apply RLS context (pending researcher-scoping policy on
 *     `canonical_sources`).
 *
 * ## Security model
 *
 * Bearer token must match the static EDGAR_TEST_TOKEN in TEST_MODE (same
 * approach as `corporate-action-ingestion.ts`). Production will require a
 * properly signed worker token (follow-on hardening issue).
 *
 * ## Route contract
 *
 *   POST /internal/canonical-sources
 *     Authorization: Bearer <worker-token>
 *     Content-Type: application/json
 *     Body: RegisterCanonicalSourceBody
 *   →  201 { id, status: "pending", … }  (newly registered)
 *   →  200 { id, status: <current>, … }  (idempotent duplicate)
 *   →  400 { error: "…" }               (missing required fields)
 *   →  401 { error: "…" }               (missing or invalid token)
 *
 * ## Canonical docs
 *
 * - `docs/prd.md` §3 §5  — discover and register canonical venues
 * - `docs/architecture.md` — WORKER-T-001, WORKER-P-001
 * - `packages/db/canonical-source-store.ts` — DB access layer
 * - `packages/db/mkt-canonical-sources.sql` — DDL
 * - `apps/worker/src/source-discover-job.ts` — caller (discovery worker)
 * - `tests/integration/source-discovery.spec.ts` — integration tests
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/74
 *
 * ## TODO (Phase 3 full implementation)
 *
 * - Replace test-mode static token with proper JWT worker token verification.
 * - Add RLS context wrapping for researcher-scoped isolation.
 * - Validate that `methodology_id` references an active `research_methodology`
 *   golden document before accepting the registration.
 * - Emit a journal event on registration.
 */

import type { AppState } from '../index';
import { makeJson } from '../lib/response';
import {
  registerCanonicalSource,
  type RegisterCanonicalSourceInput,
  type CanonicalSourceRow,
} from 'db/canonical-source-store';
import { getDefaultTopicIdForTenant } from 'db/research-topics-store';

// ---------------------------------------------------------------------------
// Request body shape
// ---------------------------------------------------------------------------

/**
 * Body expected by POST /internal/canonical-sources.
 *
 * All fields are mandatory except `description` and `access_mode`. The
 * discovery worker extracts these from the active Research Methodology
 * golden document sections.
 *
 * ## PII constraint (TQ-P-002)
 *
 * This payload carries venue metadata (URLs, names) — no PII. The `name`
 * and `url` come directly from the researcher-authored methodology, which
 * is never auto-populated from market data.
 */
export interface RegisterCanonicalSourceBody {
  /**
   * ID of the `research_methodology` golden document from which this venue
   * was extracted.
   */
  methodology_id: string;
  /** Researcher who owns the methodology (used for RLS scoping). */
  author_id: string;
  /** Tenant the source belongs to. */
  tenant_id: string;
  /** Human-readable venue name (e.g. "SEC EDGAR"). */
  name: string;
  /** Canonical URL for the venue (e.g. "https://www.sec.gov/cgi-bin/browse-edgar"). */
  url: string;
  /** Optional description extracted from the methodology. */
  description?: string | null;
  /**
   * Optional access mode declared in the methodology.
   * One of: "public" | "authenticated" | "api_key"
   */
  access_mode?: 'public' | 'authenticated' | 'api_key' | null;
}

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

/**
 * Response body for POST /internal/canonical-sources.
 */
export interface RegisterCanonicalSourceResponse {
  /** Whether the row was newly created (201) or already existed (200). */
  created: boolean;
  /** The canonical source row (new or existing). */
  source: CanonicalSourceRow;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates the required fields in a RegisterCanonicalSourceBody.
 *
 * Returns an error message string when validation fails, or null on success.
 */
function validateRegisterBody(body: Partial<RegisterCanonicalSourceBody>): string | null {
  if (!body.methodology_id || typeof body.methodology_id !== 'string') {
    return 'methodology_id is required and must be a string';
  }
  if (!body.author_id || typeof body.author_id !== 'string') {
    return 'author_id is required and must be a string';
  }
  if (!body.tenant_id || typeof body.tenant_id !== 'string') {
    return 'tenant_id is required and must be a string';
  }
  if (!body.name || typeof body.name !== 'string') {
    return 'name is required and must be a string';
  }
  if (!body.url || typeof body.url !== 'string') {
    return 'url is required and must be a string';
  }
  if (
    body.access_mode !== undefined &&
    body.access_mode !== null &&
    !['public', 'authenticated', 'api_key'].includes(body.access_mode)
  ) {
    return 'access_mode must be one of: public, authenticated, api_key';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle POST /internal/canonical-sources.
 *
 * Returns `null` when the request path does not match so the caller can
 * fall through to the next handler.
 *
 * ## Stub note (issue #74)
 *
 * This handler is intentionally minimal for the scout phase. The token check
 * uses TEST_MODE static secret (same as the EDGAR ingest endpoint). The full
 * implementation will replace the static secret with proper JWT verification.
 */
export async function handleCanonicalSourceRegistrationRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (url.pathname !== '/internal/canonical-sources') return null;
  if (req.method !== 'POST') return null;

  const { sql } = appState;
  const json = makeJson({});

  // ── Bearer token check ────────────────────────────────────────────────────
  //
  // In TEST_MODE a static secret is accepted (same pattern as the EDGAR
  // ingestion endpoint). Production will require a signed worker JWT.
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'Unauthorized — Bearer token required' }, 401);
  }
  const token = authHeader.slice('Bearer '.length).trim();

  const testMode = process.env.TEST_MODE === 'true';
  const expectedToken = process.env.EDGAR_TEST_TOKEN ?? '';

  if (testMode) {
    if (!expectedToken || token !== expectedToken) {
      return json({ error: 'Unauthorized — invalid test token' }, 401);
    }
  } else {
    // TODO (Phase 3 full implementation): verify signed worker JWT.
    // For now, non-test-mode requests are rejected with 501 to make the
    // missing implementation visible rather than silently permissive.
    return json(
      { error: 'Not implemented — production token verification is a Phase 3 follow-on' },
      501,
    );
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: Partial<RegisterCanonicalSourceBody>;
  try {
    body = (await req.json()) as Partial<RegisterCanonicalSourceBody>;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const validationError = validateRegisterBody(body);
  if (validationError) {
    return json({ error: validationError }, 400);
  }

  // Resolve the tenant's Default research topic so new canonical sources are
  // automatically scoped to it (issue #121). Falls back to null when no Default
  // topic has been created yet (e.g. a brand-new tenant whose migration hasn't
  // run — the column is nullable so the insert still succeeds).
  const defaultTopicId = await getDefaultTopicIdForTenant(sql, body.tenant_id!);

  const input: RegisterCanonicalSourceInput = {
    methodology_id: body.methodology_id!,
    author_id: body.author_id!,
    tenant_id: body.tenant_id!,
    name: body.name!,
    url: body.url!,
    description: body.description ?? null,
    access_mode: body.access_mode ?? null,
    topic_id: defaultTopicId,
  };

  // ── Persist via DB store ──────────────────────────────────────────────────
  //
  // registerCanonicalSource uses ON CONFLICT DO NOTHING — a pre-existing row
  // (same methodology_id + url) is returned unchanged.

  // Check if the row pre-existed by querying before insert.
  // This is a two-step read-then-write pattern acceptable for scout phase.
  // A production implementation can use a RETURNING clause extension.
  const existingRows = await sql<{ id: string }[]>`
    SELECT id FROM canonical_sources
    WHERE methodology_id = ${input.methodology_id}
      AND url            = ${input.url}
  `;
  const preExisted = existingRows.length > 0;

  const source = await registerCanonicalSource(sql, input);

  const response: RegisterCanonicalSourceResponse = {
    created: !preExisted,
    source,
  };

  return json(response, preExisted ? 200 : 201);
}
