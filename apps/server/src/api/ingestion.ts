/**
 * @file ingestion.ts
 *
 * Internal ingestion API — Phase 2 dev-scout stub.
 *
 * ## Status: dev-scout stub
 *
 * This file is a **no-op stub** created by the Phase 2 dev-scout (issue #25).
 * It exports a handler function that matches the routing convention used by
 * all other API modules (`handleXxxRequest`) and returns 501 Not Implemented
 * for all requests. This ensures the handler can be wired into the server
 * index without breaking existing routes, and follow-on issues can replace
 * the stub body without touching the routing layer.
 *
 * ## Endpoints (planned — not yet implemented)
 *
 * ### POST /internal/ingestion/email
 *
 * Accepts an `Email` entity write from the ingestion worker. The request must
 * carry a valid scoped delegated token issued for the `email_ingest` agent
 * type. The worker DB role is read-only; this is the only permitted write path
 * for email entities (WORKER-T-001).
 *
 * **Request body (planned):**
 * ```json
 * {
 *   "tenant_ref":       "<opaque tenant identifier>",
 *   "ingest_ref":       "<idempotency anchor from the task payload>",
 *   "subject_token":    "<PII-tokenised subject line>",
 *   "sender_token":     "<identity token from the dictionary service>",
 *   "body_tokenised":   "<email body with PII replaced by tokens>",
 *   "received_at":      "<ISO-8601 timestamp>",
 *   "retention_class":  "standard" | "legal_hold",
 *   "legal_hold":       false
 * }
 * ```
 *
 * **Notes:**
 * - `sender_token` is an opaque identity token produced by
 *   `POST /internal/dictionary/tokenise` (not yet implemented). The handler
 *   must validate that the token exists in `identity_tokens` before writing
 *   the entity row.
 * - `retention_class` and `legal_hold` must be populated at ingestion time
 *   with the tenant-policy default (Phase 8 builds the policy engine; Phase 2
 *   just writes the fields — see implementation plan Phase 2 follow-ons).
 * - The handler must apply field encryption via `FieldEncryptor` from
 *   `packages/core/encryption.ts` using the `corpus-key` domain before
 *   persisting the entity.
 *
 * **Response (planned):**
 * ```json
 * { "email_id": "<entity id of the written Email row>" }
 * ```
 *
 * ### POST /internal/ingestion/chunks
 *
 * Accepts a batch of `CorpusChunk` entity writes linked to an `Email` entity.
 * Each chunk carries the tokenised body fragment, the embedding vector, and a
 * `chunk_of` relation back to the source email.
 *
 * **Follow-on:** defined here as a doc comment only; implementation lands in
 * the CorpusChunk follow-on issue.
 *
 * ## Integration points discovered during scout
 *
 * - `POST /internal/dictionary/tokenise` (dictionary service) does not yet
 *   exist. The production handler must call this before writing the Email
 *   entity. It is a prerequisite for implementing the real handler body.
 *
 * - `FieldEncryptor` in `packages/core/encryption.ts` exists but the
 *   `corpus-key` KMS key domain is not yet provisioned. The follow-on issue
 *   must wire up the KMS abstraction layer (Phase 1 follow-on) before
 *   encrypted writes can work end-to-end.
 *
 * - Entity-type registry rows for `email` and `corpus_chunk` are declared in
 *   `packages/core/types.ts` but not yet seeded with schemas in
 *   `packages/db/entity-type-registry.ts`. The follow-on must add the seed.
 *
 * - The `internal/` path prefix is not yet routed in `apps/server/src/index.ts`.
 *   This handler must be imported and added to the routing chain there.
 *
 * - Auth for internal routes (worker scoped token validation) is separate from
 *   the user-facing session/passkey auth. A `validateScopedToken` helper must
 *   be added to `apps/server/src/auth/` before the real handler can enforce it.
 *
 * ## Canonical docs
 *
 * - Implementation plan Phase 2: `docs/implementation-plan-v1.md`
 * - PRD §7 (field encryption, sensitive entities): `docs/PRD.md`
 * - Worker blueprint: `calypso-blueprint/rules/blueprints/worker.yaml`
 * - Data blueprint: `calypso-blueprint/rules/blueprints/data.yaml`
 * - Entity types: `packages/core/types.ts`
 * - Encryption module: `packages/core/encryption.ts`
 * - Dictionary schema: `packages/db/dictionary-schema.sql`
 */

import type { AppState } from '../index';

/**
 * Handle requests to the `/internal/ingestion/` path family.
 *
 * ## Dev-scout stub
 *
 * Returns 501 Not Implemented for all requests. The stub allows the server
 * index to register this handler without breaking existing routes.
 *
 * Follow-on issues replace the body with real field-encrypted entity writes.
 *
 * @param _req       - The incoming HTTP request.
 * @param url        - The parsed request URL.
 * @param _appState  - The application state (db pools, config).
 * @returns Response | null — null if the path does not start with /internal/ingestion.
 */
export async function handleIngestionRequest(
  _req: Request,
  url: URL,
  _appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/internal/ingestion')) return null;

  // DEV-SCOUT STUB — no real ingestion logic yet.
  //
  // Follow-on: implement the real handler body described in the file-level
  // doc above. The stub returns 501 so that:
  //   1. Integration tests that call this endpoint can assert the stub is
  //      reachable (path routing is wired) and then skip or mark expected-fail.
  //   2. The routing layer in apps/server/src/index.ts can import this
  //      handler before the real implementation lands.
  //
  // Risks identified during scout:
  //   1. Internal token validation is not yet standardised across internal
  //      routes. A shared `validateScopedToken` helper should be extracted
  //      before implementing the real handler to avoid per-route divergence.
  //   2. The property-graph write path (INSERT INTO entities) lacks a
  //      transaction boundary for multi-entity writes (Email + CorpusChunks).
  //      The follow-on must wrap both writes in a single transaction.
  //   3. Idempotency: if a worker retries after a partial write, the handler
  //      must detect the existing `ingest_ref` and return the existing
  //      `email_id` without re-writing.
  return new Response(JSON.stringify({ error: 'Not Implemented', stub: true }), {
    status: 501,
    headers: { 'Content-Type': 'application/json' },
  });
}
