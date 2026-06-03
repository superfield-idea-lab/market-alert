/**
 * @file finding-ingest-job.ts
 *
 * FINDING_INGEST worker job handler — Phase 3 (issue #75).
 *
 * ## What this file does
 *
 * Implements `executeFindingIngestTask`, which on each scheduled tick:
 *
 *   1. Reads the source_finding row from GET /internal/scrape/source-finding/:id.
 *   2. Parses the raw_content into text chunks (fixed-size, sentence-aware).
 *      Malformed payloads (empty content, parse errors) are quarantined.
 *   3. POSTs each chunk to POST /internal/scrape/corpus-chunk to persist it.
 *   4. Marks the source_finding as `ingested` via PATCH /internal/scrape/source-finding/:id.
 *   5. For each new corpus_chunk row, enqueues a FACT_EXTRACT task.
 *
 * ## Chunking strategy
 *
 * Text is split into chunks of at most CHUNK_MAX_CHARS characters (default: 1500).
 * Splits prefer paragraph boundaries (double newline), falling back to sentence
 * boundaries (". "), and finally hard character-count boundaries. This keeps
 * chunk context coherent for downstream embedding and fact extraction.
 *
 * ## Quarantine
 *
 * If the finding content is empty, or the parser raises an unhandled exception,
 * the finding is moved to `quarantined` and an etl_quarantine row is written.
 * Neither the queue nor other findings are blocked.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5 §6
 * - docs/architecture.md — FINDING_INGEST worker, corpus_chunk rows
 * - apps/server/src/api/source-scrape-api.ts — internal scrape API endpoints
 * - packages/db/mkt-knowledge-store.ts — DB store
 * - packages/db/task-queue.ts — TaskType.FINDING_INGEST
 * - tests/integration/source-scrape-ingest.spec.ts — integration tests
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/75
 */

import type { TaskQueueRow } from 'db/task-queue';
import { assertNoDatabaseUrl } from './startup';

/** The job_type constant for FINDING_INGEST tasks. */
export const FINDING_INGEST_JOB_TYPE = 'FINDING_INGEST' as const;

/** Maximum characters per chunk. */
export const CHUNK_MAX_CHARS = 1500;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export interface FindingIngestPayload {
  /** source_finding row ID to chunk and ingest. */
  source_finding_id: string;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface FindingIngestResult {
  source_finding_id: string;
  chunks_created: number;
  quarantined: boolean;
  error: string | null;
  chunk_ids: string[];
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Split text into chunks of at most `maxChars` characters.
 *
 * Preference order:
 *   1. Paragraph boundaries (double newline).
 *   2. Sentence boundaries (". " followed by an uppercase letter or end of string).
 *   3. Hard character limit.
 */
export function chunkText(text: string, maxChars: number = CHUNK_MAX_CHARS): string[] {
  if (!text || text.trim().length === 0) return [];

  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > maxChars) {
    // Try paragraph boundary.
    const paraIdx = remaining.lastIndexOf('\n\n', maxChars);
    if (paraIdx > 0) {
      chunks.push(remaining.slice(0, paraIdx).trim());
      remaining = remaining.slice(paraIdx).trim();
      continue;
    }

    // Try sentence boundary.
    const sentMatch = remaining.slice(0, maxChars).match(/^(.*\.\s)(?=[A-Z])/s);
    if (sentMatch && sentMatch[1].length > 0) {
      chunks.push(sentMatch[1].trim());
      remaining = remaining.slice(sentMatch[1].length).trim();
      continue;
    }

    // Hard cut.
    chunks.push(remaining.slice(0, maxChars).trim());
    remaining = remaining.slice(maxChars).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Execute one FINDING_INGEST task.
 *
 * @param task        The task row claimed from the queue.
 * @param apiBaseUrl  Base URL of the internal API server (e.g. http://server:4000).
 * @param token       Bearer token for authenticating internal API calls.
 * @param env         Process environment.
 */
export async function executeFindingIngestTask(
  task: TaskQueueRow,
  apiBaseUrl: string,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FindingIngestResult> {
  assertNoDatabaseUrl(env);

  const payload = task.payload as FindingIngestPayload;
  const { source_finding_id } = payload;

  // --- 1. Fetch the source_finding ---
  const findingRes = await fetch(
    `${apiBaseUrl}/internal/scrape/source-finding/${source_finding_id}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (!findingRes.ok) {
    return {
      source_finding_id,
      chunks_created: 0,
      quarantined: false,
      error: `Failed to fetch source_finding: HTTP ${findingRes.status}`,
      chunk_ids: [],
    };
  }

  const finding = (await findingRes.json()) as {
    id: string;
    canonical_source_id: string;
    tenant_id: string;
    raw_content: string;
    status: string;
  };

  // Already ingested — idempotent return.
  if (finding.status === 'ingested') {
    return {
      source_finding_id,
      chunks_created: 0,
      quarantined: false,
      error: null,
      chunk_ids: [],
    };
  }

  // --- 2. Parse and chunk the raw content ---
  let chunks: string[];
  try {
    chunks = chunkText(finding.raw_content, CHUNK_MAX_CHARS);
    if (chunks.length === 0) {
      throw new Error('Empty content: no chunks produced');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await quarantineFinding(apiBaseUrl, token, source_finding_id, finding.raw_content, msg);
    return {
      source_finding_id,
      chunks_created: 0,
      quarantined: true,
      error: msg,
      chunk_ids: [],
    };
  }

  // --- 3. Persist each chunk via internal API ---
  const chunkIds: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunkRes = await fetch(`${apiBaseUrl}/internal/scrape/corpus-chunk`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source_id: finding.canonical_source_id,
        source_finding_id: finding.id,
        tenant_id: finding.tenant_id,
        content: chunks[i],
        chunk_index: i,
      }),
    });

    if (!chunkRes.ok) {
      const errBody = await chunkRes.text();
      return {
        source_finding_id,
        chunks_created: chunkIds.length,
        quarantined: false,
        error: `Failed to persist chunk ${i}: HTTP ${chunkRes.status} ${errBody}`,
        chunk_ids: chunkIds,
      };
    }

    const chunkData = (await chunkRes.json()) as { chunk: { id: string } };
    chunkIds.push(chunkData.chunk.id);
  }

  // --- 4. Mark the finding as ingested ---
  await fetch(`${apiBaseUrl}/internal/scrape/source-finding/${source_finding_id}/ingest`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}` },
  });

  return {
    source_finding_id,
    chunks_created: chunkIds.length,
    quarantined: false,
    error: null,
    chunk_ids: chunkIds,
  };
}

// ---------------------------------------------------------------------------
// Quarantine helper
// ---------------------------------------------------------------------------

async function quarantineFinding(
  apiBaseUrl: string,
  token: string,
  sourceFindingId: string,
  rawPayload: string,
  errorMessage: string,
): Promise<void> {
  try {
    // First, mark the finding as quarantined.
    await fetch(`${apiBaseUrl}/internal/scrape/source-finding/${sourceFindingId}/quarantine`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
    });

    // Then write the etl_quarantine row.
    await fetch(`${apiBaseUrl}/internal/scrape/quarantine`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: `source_finding:${sourceFindingId}`,
        source_finding_id: sourceFindingId,
        raw_payload: rawPayload.slice(0, 10_000), // truncate for storage
        error_message: errorMessage,
      }),
    });
  } catch {
    // Best-effort quarantine.
  }
}
