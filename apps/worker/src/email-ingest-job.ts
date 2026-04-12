/**
 * @file email-ingest-job.ts
 *
 * Email ingestion worker job type — "email_ingest".
 *
 * ## Status: dev-scout stub
 *
 * This file is a **no-op stub** created by the Phase 2 dev-scout (issue #25).
 * It defines the job-type constant, payload/result interfaces, and builder/
 * validator functions that will be wired into runner.ts in follow-on issues.
 * No real IMAP, PII-tokenisation, or embedding logic is executed here.
 *
 * ## Phase 2 design — Single-email end-to-end ingestion
 *
 * The production implementation wires this job type into the following spine:
 *
 *   1. IMAP fetch — one email is pulled from the test IMAP server using
 *      `imapflow` (reusing the ETL pattern from
 *      `calypso-distribution/packages/core/imap-etl-worker.ts`). The cron
 *      dispatcher inserts an `EMAIL_INGEST` task row; this worker claims it.
 *
 *   2. PII tokenisation — sender name, email address, and any free-text PII
 *      are replaced with stable per-tenant tokens via a call to
 *      `POST /internal/dictionary/tokenise` on the IdentityDictionary service.
 *      The dictionary pool (`dictionarySql` from `db`) is structurally
 *      isolated from the app pool — the worker only reaches it through the
 *      API layer using the delegated token from the task row.
 *
 *   3. API-mediated write — an `Email` entity is written via
 *      `POST /internal/ingestion/email` with the scoped delegated token.
 *      The worker DB role is read-only; this write is structurally impossible
 *      from the worker container without going through the API (WORKER-T-001).
 *
 *   4. Chunking — each Email is split into sentence-boundary-respecting chunks
 *      (max ~512 tokens) and stored as `CorpusChunk` entities, each carrying a
 *      `chunk_of` relation back to the source Email.
 *
 *   5. Embedding — each chunk is embedded via `POST /embed` on the internal
 *      Ollama service (dev) or the in-house Rust candle server (prod), storing
 *      a `float[768]` vector from `nomic-embed-text-v1.5` in the pgvector
 *      column on the CorpusChunk row. See `docs/technical/embedding.md`.
 *
 *   6. Read path — the worker-visible read returns only the tokenised,
 *      encrypted form through the `task_queue_view_email_ingest` SQL view
 *      (defined in `packages/db/schema.sql`) and the RLS-restricted
 *      `email_ingest` DB role.
 *
 * ## Integration points discovered during scout
 *
 * - IMAP test server: Greenmail container (`calypso-distribution/packages/db/
 *   imap-container.ts`) must be added to the test harness before follow-on
 *   issues can run their integration suite.
 *
 * - `POST /internal/dictionary/tokenise` does not yet exist in
 *   `apps/server/src/api/`. A follow-on issue must add it and wire it to
 *   `dictionarySql`.
 *
 * - `POST /internal/ingestion/email` stub lives at
 *   `apps/server/src/api/ingestion.ts` (created by this scout). The real
 *   implementation must add: field encryption via `FieldEncryptor` from
 *   `packages/core/encryption.ts`, entity-type validation against the entity-
 *   type registry, and RLS-compliant property graph writes.
 *
 * - `CorpusChunk` and `Email` entity types are declared in
 *   `packages/core/types.ts`. The entity-type registry rows (in
 *   `packages/db/entity-type-registry.ts`) must be seeded with schemas for
 *   both types before Phase 2 integration tests can run.
 *
 * - pgvector extension is not yet enabled in the schema (`packages/db/
 *   schema.sql`). A follow-on issue must add `CREATE EXTENSION IF NOT EXISTS
 *   vector;` and the embedding column with an HNSW index on `corpus_chunks`.
 *
 * - The embedding service abstraction (Ollama dev / candle prod) needs an
 *   environment variable flag (`EMBEDDING_SERVICE_URL`) and a thin client
 *   module — none exists yet.
 *
 * ## Security constraints (WORKER domain)
 *
 * - Worker DB role is read-only. All writes route through the API layer with
 *   the per-task delegated token (WORKER-T-001, WORKER-T-002).
 * - Payloads carry only opaque references — no raw email content, sender
 *   name, or PII in the task queue row (TQ-P-002).
 * - The delegated token is single-use and task-scoped (WORKER-T-005).
 *
 * ## Canonical docs
 *
 * - Implementation plan Phase 2: `docs/implementation-plan-v1.md`
 * - PRD §6 (Email ingestion): `docs/PRD.md`
 * - Embedding strategy: `docs/technical/embedding.md`
 * - DB architecture: `docs/technical/db-architecture.md`
 * - Worker blueprint: `calypso-blueprint/rules/blueprints/worker.yaml`
 * - Dictionary schema: `packages/db/dictionary-schema.sql`
 */

/** The job_type string identifying an email ingestion task. */
export const EMAIL_INGEST_JOB_TYPE = 'email_ingest' as const;

/**
 * Hard timeout for email ingestion tasks in milliseconds.
 *
 * Phase 2 follow-on: tune based on IMAP latency + chunking + embedding
 * benchmarks. The 5-minute default is conservative; a single email with
 * ~10 chunks should embed well under 60 seconds on CPU.
 */
export const EMAIL_INGEST_TIMEOUT_MS = 5 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/**
 * Payload shape for the `email_ingest` job type.
 *
 * Only opaque identifiers are permitted (TQ-P-002). The worker fetches raw
 * email content from the IMAP server at execution time; the queue row must
 * never carry raw message bodies, sender names, or any PII.
 *
 * ## Follow-on: real payload fields
 *
 * The production payload will carry:
 *
 * ```json
 * {
 *   "mailbox_ref":  "<opaque reference to the tenant IMAP credential bundle>",
 *   "uid":          "<IMAP UID of the message to fetch>",
 *   "tenant_ref":   "<opaque tenant identifier for RLS scoping>",
 *   "ingest_ref":   "<idempotency anchor — echoed in the result>"
 * }
 * ```
 *
 * `mailbox_ref` resolves to an IMAP credential bundle stored in the
 * worker-credentials table (`packages/db/worker-credentials.ts`), fetched at
 * execution time via the delegated token.  The raw IMAP password never appears
 * in the task queue.
 */
export interface EmailIngestPayload {
  /** Opaque reference to the tenant IMAP credential bundle. */
  mailbox_ref: string;
  /** IMAP UID of the message to fetch (string to avoid JSON integer overflow). */
  uid: string;
  /** Opaque tenant identifier for RLS scoping. */
  tenant_ref: string;
  /** Idempotency anchor echoed in the result for correlation. */
  ingest_ref: string;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Expected result shape for `email_ingest` tasks.
 *
 * ## Follow-on: real result fields
 *
 * The production result will carry:
 *
 * ```json
 * {
 *   "email_id":     "<entity id of the written Email row>",
 *   "chunk_ids":    ["<id>", ...],
 *   "chunk_count":  5,
 *   "ingest_ref":   "<echoed from payload>",
 *   "status":       "completed"
 * }
 * ```
 *
 * `chunk_ids` are the entity IDs of the `CorpusChunk` rows written during this
 * ingestion run. Each chunk carries a `chunk_of` relation back to `email_id`.
 * Embeddings are stored on each `CorpusChunk` entity in the pgvector column.
 */
export interface EmailIngestResult {
  /** Entity ID of the written Email row. */
  email_id: string;
  /** Entity IDs of all CorpusChunk rows written during this run. */
  chunk_ids: string[];
  /** Number of chunks produced from the email body. */
  chunk_count: number;
  /** Idempotency anchor echoed from the payload. */
  ingest_ref: string;
  /** Execution status. */
  status: 'completed' | 'failed';
  /** Additional vendor-specific fields forwarded as-is. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Builder / validator stubs
// ---------------------------------------------------------------------------

/**
 * Build the stdin payload sent to the ingestion CLI (or worker logic) for
 * an `email_ingest` task.
 *
 * Merges the task `id`, `job_type`, `agent_type`, and raw `payload` into a
 * single object so the execution unit has all context it needs.
 *
 * ## Dev-scout note
 *
 * This is a stub.  The real builder will resolve the `mailbox_ref` to a
 * Greenmail / IMAP connection spec and attach the delegated token so the
 * worker can call back to the API-mediated write path.
 */
export function buildEmailIngestPayload(
  taskId: string,
  agentType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: taskId,
    job_type: EMAIL_INGEST_JOB_TYPE,
    agent_type: agentType,
    ...payload,
  };
}

/**
 * Validate that a raw result object conforms to the expected `EmailIngestResult` shape.
 *
 * Throws if required fields are absent or have incorrect types.
 *
 * ## Dev-scout note
 *
 * This is a stub validator.  The real validator will additionally assert:
 * - `email_id` resolves to an existing entity in the app database.
 * - `chunk_ids` are non-empty and all resolve to `CorpusChunk` entities with
 *   embeddings populated.
 * - `ingest_ref` matches the payload anchor for idempotency verification.
 */
export function validateEmailIngestResult(raw: Record<string, unknown>): EmailIngestResult {
  if (typeof raw['email_id'] !== 'string') {
    throw new Error(
      `email_ingest result missing required "email_id" string. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  if (!Array.isArray(raw['chunk_ids'])) {
    throw new Error(
      `email_ingest result missing required "chunk_ids" array. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  if (typeof raw['chunk_count'] !== 'number') {
    throw new Error(
      `email_ingest result missing required "chunk_count" number. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  if (typeof raw['ingest_ref'] !== 'string') {
    throw new Error(
      `email_ingest result missing required "ingest_ref" string. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  return raw as EmailIngestResult;
}
