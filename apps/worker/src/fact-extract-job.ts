/**
 * @file fact-extract-job.ts
 *
 * FACT_EXTRACT worker job handler — Phase 3 (issue #75).
 *
 * ## What this file does
 *
 * Implements `executeFactExtractTask`, which on each scheduled tick:
 *
 *   1. Reads the corpus_chunk row from GET /internal/scrape/corpus-chunk/:id.
 *   2. Extracts key-value facts from the chunk text using a deterministic
 *      pattern-matching extractor (no LLM call in Phase 3; LLM-backed extraction
 *      is a Phase 4 follow-on). The extractor looks for structured patterns like
 *      "CEO: <name>", "Revenue: <value>", "Ticker: <symbol>".
 *   3. For each extracted fact, POSTs to POST /internal/scrape/confirmed-fact.
 *      The endpoint handles the supersession chain when a contradicting fact is
 *      declared by the caller.
 *   4. Returns a result summary.
 *
 * ## Supersession
 *
 * When the extraction identifies that a new fact contradicts an existing one
 * (same subject_entity_id + attribute), the caller supplies the prior fact's ID
 * in `supersedes_fact_id`. The API layer chains the supersession without any
 * destructive edit (append-only constraint).
 *
 * ## Phase 3 extraction (deterministic)
 *
 * The extractor in this file uses regex patterns against plain text. It is
 * intentionally simple — the goal is to validate the full pipeline (scrape →
 * chunk → fact) end-to-end, not to achieve production-quality extraction. A
 * follow-on issue will plug in an LLM-backed extractor.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5 §6
 * - docs/architecture.md — FACT_EXTRACT worker, confirmed_fact supersession
 * - apps/server/src/api/source-scrape-api.ts — internal scrape API endpoints
 * - packages/db/mkt-knowledge-store.ts — DB store
 * - packages/db/task-queue.ts — TaskType.FACT_EXTRACT
 * - tests/integration/source-scrape-ingest.spec.ts — integration tests
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/75
 */

import type { TaskQueueRow } from 'db/task-queue';
import { assertNoDatabaseUrl } from './startup';

/** The job_type constant for FACT_EXTRACT tasks. */
export const FACT_EXTRACT_JOB_TYPE = 'FACT_EXTRACT' as const;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export interface FactExtractPayload {
  /** corpus_chunk row ID to extract facts from. */
  corpus_chunk_id: string;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface FactExtractResult {
  corpus_chunk_id: string;
  facts_extracted: number;
  fact_ids: string[];
  error: string | null;
}

// ---------------------------------------------------------------------------
// Deterministic fact extractor (Phase 3 pattern-based)
// ---------------------------------------------------------------------------

export interface ExtractedFact {
  attribute: string;
  value: string;
  /** Confidence [0, 1] — pattern-based extraction gives 0.7 fixed. */
  confidence: number;
}

/**
 * Extract key-value facts from plain text using regex patterns.
 *
 * Recognises lines matching: `Label: value` or `Label — value`
 * where Label is a known attribute keyword.
 *
 * Known attributes (case-insensitive):
 *   ceo, cfo, revenue, earnings, ticker, isin, cusip, outlook, rating
 *
 * Returns an array of { attribute, value, confidence } objects.
 * Returns empty array if no patterns match (not an error).
 */
export function extractFactsFromText(text: string): ExtractedFact[] {
  const KNOWN_ATTRIBUTES = [
    'ceo',
    'cfo',
    'coo',
    'revenue',
    'earnings',
    'net_income',
    'ebitda',
    'ticker',
    'isin',
    'cusip',
    'outlook',
    'rating',
    'recommendation',
    'price_target',
    'sector',
    'industry',
  ];

  const facts: ExtractedFact[] = [];

  for (const attr of KNOWN_ATTRIBUTES) {
    // Match patterns like "ceo: John Smith" or "CEO — Jane Doe" (case-insensitive)
    const re = new RegExp(`(?:^|\\n)\\s*${attr}\\s*[:\\-—]\\s*(.+?)\\s*(?:\\n|$)`, 'im');
    const match = text.match(re);
    if (match && match[1] && match[1].trim().length > 0) {
      facts.push({
        attribute: attr.toLowerCase(),
        value: match[1].trim(),
        confidence: 0.7,
      });
    }
  }

  return facts;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Execute one FACT_EXTRACT task.
 *
 * @param task        The task row claimed from the queue.
 * @param apiBaseUrl  Base URL of the internal API server (e.g. http://server:4000).
 * @param token       Bearer token for authenticating internal API calls.
 * @param env         Process environment.
 */
export async function executeFactExtractTask(
  task: TaskQueueRow,
  apiBaseUrl: string,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FactExtractResult> {
  assertNoDatabaseUrl(env);

  const payload = task.payload as FactExtractPayload;
  const { corpus_chunk_id } = payload;

  // --- 1. Fetch the corpus_chunk ---
  const chunkRes = await fetch(`${apiBaseUrl}/internal/scrape/corpus-chunk/${corpus_chunk_id}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!chunkRes.ok) {
    return {
      corpus_chunk_id,
      facts_extracted: 0,
      fact_ids: [],
      error: `Failed to fetch corpus_chunk: HTTP ${chunkRes.status}`,
    };
  }

  const chunk = (await chunkRes.json()) as {
    id: string;
    tenant_id: string;
    source_id: string;
    content: string;
    chunk_index: number;
  };

  // --- 2. Extract facts ---
  const extracted = extractFactsFromText(chunk.content);

  if (extracted.length === 0) {
    return {
      corpus_chunk_id,
      facts_extracted: 0,
      fact_ids: [],
      error: null,
    };
  }

  // --- 3. Persist each fact via internal API ---
  const factIds: string[] = [];

  for (const fact of extracted) {
    // Look up any existing current fact for the same subject + attribute.
    // For Phase 3 we use the canonical_source as a stand-in subject entity,
    // since we haven't resolved company entities from the text yet.
    const subjectEntityId = chunk.source_id;
    const subjectEntityType = 'canonical_source';

    const existingRes = await fetch(
      `${apiBaseUrl}/internal/scrape/confirmed-fact/current?tenant_id=${encodeURIComponent(chunk.tenant_id)}&subject_entity_id=${encodeURIComponent(subjectEntityId)}&attribute=${encodeURIComponent(fact.attribute)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    let supersedes_fact_id: string | null = null;
    if (existingRes.ok) {
      const existing = (await existingRes.json()) as { facts: Array<{ id: string }> };
      // Supersede the most recent current fact (head of chain).
      if (existing.facts.length > 0) {
        supersedes_fact_id = existing.facts[0].id;
      }
    }

    const factRes = await fetch(`${apiBaseUrl}/internal/scrape/confirmed-fact`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenant_id: chunk.tenant_id,
        corpus_chunk_id: chunk.id,
        subject_entity_id: subjectEntityId,
        subject_entity_type: subjectEntityType,
        attribute: fact.attribute,
        value: fact.value,
        confidence: fact.confidence,
        supersedes_fact_id,
      }),
    });

    if (!factRes.ok) {
      const errBody = await factRes.text();
      return {
        corpus_chunk_id,
        facts_extracted: factIds.length,
        fact_ids: factIds,
        error: `Failed to persist fact '${fact.attribute}': HTTP ${factRes.status} ${errBody}`,
      };
    }

    const factData = (await factRes.json()) as { fact: { id: string } };
    factIds.push(factData.fact.id);
  }

  return {
    corpus_chunk_id,
    facts_extracted: factIds.length,
    fact_ids: factIds,
    error: null,
  };
}
