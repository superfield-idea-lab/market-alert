/**
 * @file autolearn-job.ts
 *
 * Autolearn worker job type — "autolearn_wiki_draft".
 *
 * ## Scout stub (Phase 3)
 *
 * This file is a **no-op stub** for the dev-scout issue that proves the
 * autolearn vertical slice shape: job type constant, payload/result types,
 * and the CLI payload builder and result validator are defined and compile.
 * No runtime behaviour is changed; the stub registers the job type so that
 * Phase 3 follow-on issues can wire it into the runner without a second
 * refactor.
 *
 * ## Job type: autolearn_wiki_draft
 *
 * An ephemeral pod scoped to one (department, customer) pair:
 *   1. Mints a scoped single-use worker token.
 *   2. Stages anonymised ground truth + current wiki markdown under /tmp/.
 *   3. Invokes the real Claude CLI against the staged files.
 *   4. POSTs the resulting new wiki version to POST /internal/wiki/versions.
 *   5. The new WikiPageVersion lands in AWAITING_REVIEW.
 *
 * ### Payload shape
 *
 * ```json
 * {
 *   "ground_truth_ref": "<opaque ref to staged anonymised ground truth>",
 *   "wiki_ref":         "<opaque ref to current wiki markdown snapshot>",
 *   "department_ref":   "<opaque ref to the scoped department>",
 *   "customer_ref":     "<opaque ref to the scoped customer>"
 * }
 * ```
 *
 * Payloads must contain only opaque identifiers (TQ-P-002). Workers fetch
 * data through the API at execution time; the queue row must never carry raw
 * content, PII, or secrets.
 *
 * ### Result shape
 *
 * ```json
 * {
 *   "wiki_version_ref": "<opaque ref to the written WikiPageVersion>",
 *   "status":           "completed",
 *   "customer_ref":     "<echoed from payload>"
 * }
 * ```
 *
 * ### Manual trigger
 *
 * The job is enqueued manually (Phase 3 scout) via a direct API call:
 *
 * ```http
 * POST /api/tasks-queue
 * Content-Type: application/json
 *
 * {
 *   "idempotency_key": "autolearn-<customer_ref>-<timestamp>",
 *   "agent_type":      "autolearn",
 *   "job_type":        "autolearn_wiki_draft",
 *   "payload": {
 *     "ground_truth_ref": "gt_abc123",
 *     "wiki_ref":         "wiki_def456",
 *     "department_ref":   "dept_ghi789",
 *     "customer_ref":     "cust_jkl012"
 *   }
 * }
 * ```
 *
 * Blueprint references:
 * - WORKER domain — ephemeral pod, scoped token, API-mediated write
 * - PRD §4.3 — autolearning worker state machine
 * - Implementation plan Phase 3 — scout issue
 */

/** The job_type string identifying an autolearn wiki draft task. */
export const AUTOLEARN_JOB_TYPE = 'autolearn_wiki_draft' as const;

/**
 * Hard timeout for an autolearn run in milliseconds (15 minutes).
 *
 * Claude CLI may need to process a large ground-truth corpus and produce a
 * complete wiki revision; the timeout is generous but bounded so the pod
 * cannot be held indefinitely.
 */
export const AUTOLEARN_TIMEOUT_MS = 15 * 60 * 1_000;

/**
 * Payload shape for the `autolearn_wiki_draft` job type.
 *
 * Only opaque identifiers are permitted (TQ-P-002). The pod fetches the
 * actual content through the API at execution time using the delegated token.
 */
export interface AutolearnPayload {
  /** Opaque reference to the staged anonymised ground truth. Required. */
  ground_truth_ref: string;
  /** Opaque reference to the current wiki markdown snapshot. Required. */
  wiki_ref: string;
  /** Opaque reference to the scoped department. Required. */
  department_ref: string;
  /** Opaque reference to the scoped customer. Required. */
  customer_ref: string;
}

/**
 * An entity identifier observed in a transcript for `discussed_in` tagging.
 *
 * The agent emits one entry per AssetManager or Fund entity it identifies in
 * the transcript corpus. Only the entity `id` (as stored in the `entities`
 * table) is required; the `type` discriminator is included to let the
 * relation-write endpoint verify the entity is of an expected kind.
 *
 * Phase 7 queries group campaign interactions by these tagged entities.
 */
export interface DiscussedInRef {
  /** Entity id from the `entities` table (e.g. "asset_manager-<uuid>"). */
  entity_id: string;
  /** Entity type — must be "asset_manager" or "fund". */
  entity_type: 'asset_manager' | 'fund';
}

/**
 * Expected result shape returned by the Claude CLI for `autolearn_wiki_draft`
 * tasks.
 */
export interface AutolearnResult {
  /** Opaque reference to the written WikiPageVersion row. */
  wiki_version_ref: string;
  /** Execution status. */
  status: 'completed' | 'failed';
  /** Echoed customer_ref from the payload for correlation. */
  customer_ref: string;
  /**
   * AssetManager and Fund entities observed in the transcript corpus.
   *
   * When present and non-empty the worker must write `discussed_in` relations
   * for each entry via POST /internal/relations. Omitted or empty means no
   * tagging was possible (entity not found, ambiguous match, etc.).
   *
   * Phase 7 BDM campaign analysis depends on these relations existing in the
   * graph. See issue #72.
   */
  discussed_in?: DiscussedInRef[];
  /** Whether the result was produced by the dev stub (local dev only). */
  stub?: boolean;
  /** Additional vendor-specific fields forwarded as-is. */
  [key: string]: unknown;
}

/**
 * Claude CLI prompt stub for the autolearn wiki draft job.
 *
 * The real prompt will instruct Claude to read staged ground truth files
 * from /tmp/, compare them to the current wiki markdown, synthesise an
 * updated wiki, and write the result to stdout as JSON. For the scout
 * this is a minimal placeholder that encodes the structural invariants
 * without implementing the full synthesis logic.
 *
 * Blueprint: WORKER-C-018 — audit events store input/output hashes, not
 * plaintext prompts/responses.
 */
export const AUTOLEARN_PROMPT_STUB = `You are an autolearning wiki agent. You have been given anonymised ground truth files and the current wiki for a customer.

Synthesise an updated wiki markdown document that:
- Incorporates new information from the ground truth
- Cites each factual claim with its source ground-truth reference
- Preserves accurate existing content
- Removes outdated claims

Additionally, identify any AssetManager or Fund entities mentioned or discussed in the transcript corpus.
For each entity you can match against the provided entity list, emit a "discussed_in" entry with its entity_id and entity_type.
Only emit entities that appear in the provided entity list — do not invent entity ids.
If no entities are found or no entity list is provided, omit the "discussed_in" field.

Return a JSON object with:
{
  "wiki_version_ref": "<opaque reference assigned by the staging layer>",
  "status": "completed",
  "customer_ref": "<echoed from input>",
  "discussed_in": [
    { "entity_id": "<id from entity list>", "entity_type": "asset_manager" },
    { "entity_id": "<id from entity list>", "entity_type": "fund" }
  ]
}

The "discussed_in" field is optional — omit it when no matching entities are found.

Perform read-only analysis of source files only. Write only to stdout.`;

/**
 * Build the stdin payload sent to the Claude CLI for an `autolearn_wiki_draft`
 * task.
 *
 * Merges task metadata with the job payload and embeds the autolearn prompt so
 * the CLI binary has all the context it needs. Array-form spawn is enforced by
 * the caller (WORKER-C-007).
 */
export function buildAutolearnCliPayload(
  taskId: string,
  agentType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: taskId,
    job_type: AUTOLEARN_JOB_TYPE,
    agent_type: agentType,
    prompt: AUTOLEARN_PROMPT_STUB,
    ...payload,
  };
}

/**
 * Validate that a raw CLI result object conforms to the AutolearnResult shape.
 *
 * Throws if the result is missing required fields.
 */
export function validateAutolearnResult(raw: Record<string, unknown>): AutolearnResult {
  if (typeof raw['wiki_version_ref'] !== 'string') {
    throw new Error(
      `Autolearn result is missing required "wiki_version_ref" string. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }

  if (typeof raw['customer_ref'] !== 'string') {
    throw new Error(
      `Autolearn result is missing required "customer_ref" string. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }

  return raw as AutolearnResult;
}
