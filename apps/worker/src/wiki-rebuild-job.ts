/**
 * @file wiki-rebuild-job.ts
 *
 * WIKI_REBUILD worker job handler — Phase 3 scout (issue #76).
 *
 * ## What this file does
 *
 * Implements `executeWikiRebuildTask`, which for one subject:
 *
 *   1. Reads all confirmed_facts for the subject via
 *      GET /internal/wiki-rebuild/facts?tenant_id=&subject_type=&subject_id=
 *   2. Reads all corpus_chunks supporting those facts via
 *      GET /internal/wiki-rebuild/chunks?tenant_id=&subject_type=&subject_id=
 *   3. Upserts a wiki_pages row and finds or creates a wiki_page_versions_mkt
 *      row at status `pending` (crash-resume: if a stalled version exists,
 *      the worker resumes from its current status rather than restarting).
 *   4. Advances through the pipeline stages in order:
 *        pending        → synthesise markdown body, encrypt, persist (content_written)
 *        content_written → embed body with pgvector, persist embedding (embedded)
 *        embedded       → flip currently_published_version_id, set indexed (indexed)
 *   5. For each supporting chunk/fact, inserts a `cites` edge via
 *      POST /internal/wiki-rebuild/cites.
 *   6. Returns a result summary.
 *
 * ## Crash-resume
 *
 * The status pipeline is crash-safe by design. Each stage is a separate atomic
 * write. If the pod crashes at any stage, the wiki_page_versions_mkt row is
 * left at its stalled status. The next re-scheduled WIKI_REBUILD task calls
 * `getStalledWikiPageVersion` and resumes from the next stage.
 *
 * Acceptance criterion AC-2: "A crashed rebuild resumes from the stalled stage,
 * not from scratch."
 *
 * ## Currently published pointer
 *
 * `wiki_pages.currently_published_version_id` is advanced to the new version
 * inside the same transaction that flips status to `indexed`. Readers always
 * follow the currently_published pointer; they never see a non-indexed version.
 *
 * Acceptance criterion AC-3: "Readers never follow a non-indexed version."
 *
 * ## Phase 3 synthesis (deterministic stub)
 *
 * The synthesis step in this scout is intentionally minimal — it concatenates
 * fact key-value pairs into a simple markdown table. LLM-backed synthesis is
 * deferred to a follow-on Phase 4 issue. The goal here is to validate the full
 * pipeline (facts/chunks → version → cites → published) end-to-end.
 *
 * ## Security
 *
 * Workers hold no database credentials (WORKER-T-001, WORKER-T-002). All reads
 * and writes are made through authenticated internal API calls. The delegated
 * token from the task row scopes access to the assigned subject only.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5 §6
 * - docs/architecture.md §"Wiki pages: full-snapshot versioning"
 * - docs/architecture.md §"Citations: first-class relation edges"
 * - packages/db/task-queue.ts — TaskType.WIKI_REBUILD
 * - packages/db/wiki-rebuild-store.ts — DB store (wiki_pages, wiki_page_versions_mkt, wiki_page_cites)
 * - apps/server/src/api/wiki-rebuild-api.ts — internal API endpoints
 * - tests/integration/wiki-rebuild.spec.ts — integration tests
 *
 * ## Integration points discovered during scout (issue #76)
 *
 * - FACT_EXTRACT workers (issue #75) must enqueue a WIKI_REBUILD task when a
 *   new fact is written for a subject. Task key format:
 *   `wiki_rebuild:<subject_type>:<subject_id>:fact_extract`
 * - The embedding step requires pgvector (guarded in mkt-schema.sql). When
 *   pgvector is unavailable (e.g. unit-test environments), the embedding step
 *   is skipped and the worker advances directly to `indexed` with a null
 *   embedding column.
 * - `wiki_page_versions_mkt` is distinct from the existing `wiki_page_versions`
 *   table used by the autolearn/draft-review workflow. A consolidation issue
 *   should evaluate merging these in a future phase.
 * - The `currently_published_version_id` update MUST be inside the same DB
 *   transaction as the status → indexed flip (see publishWikiPageVersion in
 *   packages/db/wiki-rebuild-store.ts).
 * - The internal API endpoints for this worker are:
 *     GET  /internal/wiki-rebuild/facts
 *     GET  /internal/wiki-rebuild/chunks
 *     POST /internal/wiki-rebuild/page-version
 *     POST /internal/wiki-rebuild/cites
 *     PATCH /internal/wiki-rebuild/page-version/:id/status
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/76
 */

import type { TaskQueueRow } from 'db/task-queue';
import { assertNoDatabaseUrl } from './startup';

/** The job_type constant for WIKI_REBUILD tasks. */
export const WIKI_REBUILD_JOB_TYPE = 'WIKI_REBUILD' as const;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/**
 * Payload for a WIKI_REBUILD task.
 *
 * Task key format: `wiki_rebuild:<subject_type>:<subject_id>:<trigger>`
 * Trigger values: scheduled | fact_extract | manual
 */
export interface WikiRebuildPayload {
  /** Entity type of the rebuild subject (e.g. 'company', 'sub_industry'). */
  subject_type: string;
  /** Entity ID of the rebuild subject. */
  subject_id: string;
  /** Tenant scope for the rebuild. */
  tenant_id: string;
  /**
   * What caused this rebuild to be enqueued.
   * 'fact_extract' — a new confirmed_fact was extracted for this subject.
   * 'scheduled'    — periodic scheduled rebuild (catch-all freshness pass).
   * 'manual'       — operator-triggered rebuild via admin panel.
   */
  trigger: 'fact_extract' | 'scheduled' | 'manual';
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface WikiRebuildResult {
  subject_type: string;
  subject_id: string;
  tenant_id: string;
  wiki_page_id: string | null;
  wiki_page_version_id: string | null;
  /** Final pipeline status reached in this run. */
  final_status: 'pending' | 'content_written' | 'embedded' | 'indexed' | null;
  facts_cited: number;
  chunks_cited: number;
  /** True when the worker resumed from a stalled version rather than starting fresh. */
  resumed_from_stall: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Phase 3 markdown synthesis (deterministic stub)
// ---------------------------------------------------------------------------

export interface SynthesisInput {
  subject_type: string;
  subject_id: string;
  facts: Array<{ attribute: string; value: string; confidence: number }>;
  chunk_count: number;
}

/**
 * Synthesise a minimal markdown body from facts and chunk metadata.
 *
 * Phase 3 stub: produces a simple markdown table of facts. LLM-backed
 * synthesis (narrative prose, inline citations) is deferred to Phase 4.
 *
 * The body is returned as plain UTF-8 text; encryption is handled by the
 * caller (API layer) before the ciphertext is stored.
 */
export function synthesiseMarkdown(input: SynthesisInput): string {
  const header = `# ${input.subject_type}: ${input.subject_id}\n\n`;
  const meta = `> Generated from ${input.facts.length} confirmed fact(s) and ${input.chunk_count} corpus chunk(s).\n\n`;

  if (input.facts.length === 0) {
    return `${header}${meta}_No facts available for this subject yet._\n`;
  }

  const tableHeader = `| Attribute | Value | Confidence |\n|-----------|-------|------------|\n`;
  const tableRows = input.facts
    .map((f) => `| ${f.attribute} | ${f.value} | ${(f.confidence * 100).toFixed(0)}% |`)
    .join('\n');

  return `${header}${meta}## Facts\n\n${tableHeader}${tableRows}\n`;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Execute one WIKI_REBUILD task.
 *
 * Stage progression (crash-resume):
 *   If a stalled wiki_page_versions_mkt row exists (status != indexed), the
 *   worker resumes from the next stage after the stalled one.
 *   Otherwise, a new `pending` version row is created and all stages run.
 *
 * @param task        The task row claimed from the queue.
 * @param apiBaseUrl  Base URL of the internal API server (e.g. http://server:4000).
 * @param token       Bearer token for authenticating internal API calls.
 * @param env         Process environment.
 */
export async function executeWikiRebuildTask(
  task: TaskQueueRow,
  apiBaseUrl: string,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WikiRebuildResult> {
  assertNoDatabaseUrl(env);

  const payload = task.payload as unknown as WikiRebuildPayload;
  const { subject_type, subject_id, tenant_id } = payload;

  const authHeaders = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // --- 1. Fetch confirmed_facts for the subject ---
  const factsRes = await fetch(
    `${apiBaseUrl}/internal/wiki-rebuild/facts?` +
      new URLSearchParams({ tenant_id, subject_type, subject_id }),
    { headers: authHeaders },
  );

  if (!factsRes.ok) {
    return {
      subject_type,
      subject_id,
      tenant_id,
      wiki_page_id: null,
      wiki_page_version_id: null,
      final_status: null,
      facts_cited: 0,
      chunks_cited: 0,
      resumed_from_stall: false,
      error: `Failed to fetch facts: HTTP ${factsRes.status}`,
    };
  }

  const factsData = (await factsRes.json()) as {
    facts: Array<{ id: string; attribute: string; value: string; confidence: number }>;
  };

  // --- 2. Fetch corpus_chunks for the subject ---
  const chunksRes = await fetch(
    `${apiBaseUrl}/internal/wiki-rebuild/chunks?` +
      new URLSearchParams({ tenant_id, subject_type, subject_id }),
    { headers: authHeaders },
  );

  if (!chunksRes.ok) {
    return {
      subject_type,
      subject_id,
      tenant_id,
      wiki_page_id: null,
      wiki_page_version_id: null,
      final_status: null,
      facts_cited: 0,
      chunks_cited: 0,
      resumed_from_stall: false,
      error: `Failed to fetch chunks: HTTP ${chunksRes.status}`,
    };
  }

  const chunksData = (await chunksRes.json()) as {
    chunks: Array<{ id: string; content: string }>;
  };

  // --- 3. Upsert wiki_page and find/create wiki_page_version ---
  const pageRes = await fetch(`${apiBaseUrl}/internal/wiki-rebuild/page-version`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ tenant_id, subject_type, subject_id }),
  });

  if (!pageRes.ok) {
    return {
      subject_type,
      subject_id,
      tenant_id,
      wiki_page_id: null,
      wiki_page_version_id: null,
      final_status: null,
      facts_cited: 0,
      chunks_cited: 0,
      resumed_from_stall: false,
      error: `Failed to create wiki page version: HTTP ${pageRes.status}`,
    };
  }

  const pageData = (await pageRes.json()) as {
    wiki_page_id: string;
    wiki_page_version_id: string;
    current_status: 'pending' | 'content_written' | 'embedded' | 'indexed';
    resumed_from_stall: boolean;
  };

  const { wiki_page_id, wiki_page_version_id, resumed_from_stall } = pageData;
  let currentStatus = pageData.current_status;

  // --- 4. Advance through pipeline stages ---

  // Stage: pending → content_written
  if (currentStatus === 'pending') {
    const body = synthesiseMarkdown({
      subject_type,
      subject_id,
      facts: factsData.facts,
      chunk_count: chunksData.chunks.length,
    });

    const contentRes = await fetch(
      `${apiBaseUrl}/internal/wiki-rebuild/page-version/${wiki_page_version_id}/status`,
      {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ status: 'content_written', body }),
      },
    );

    if (!contentRes.ok) {
      return {
        subject_type,
        subject_id,
        tenant_id,
        wiki_page_id,
        wiki_page_version_id,
        final_status: 'pending',
        facts_cited: 0,
        chunks_cited: 0,
        resumed_from_stall,
        error: `Failed to advance to content_written: HTTP ${contentRes.status}`,
      };
    }

    currentStatus = 'content_written';
  }

  // Stage: content_written → embedded
  if (currentStatus === 'content_written') {
    const embedRes = await fetch(
      `${apiBaseUrl}/internal/wiki-rebuild/page-version/${wiki_page_version_id}/status`,
      {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ status: 'embedded' }),
      },
    );

    if (!embedRes.ok) {
      return {
        subject_type,
        subject_id,
        tenant_id,
        wiki_page_id,
        wiki_page_version_id,
        final_status: 'content_written',
        facts_cited: 0,
        chunks_cited: 0,
        resumed_from_stall,
        error: `Failed to advance to embedded: HTTP ${embedRes.status}`,
      };
    }

    currentStatus = 'embedded';
  }

  // Stage: embedded → indexed (atomic flip of currently_published_version_id)
  if (currentStatus === 'embedded') {
    const indexRes = await fetch(
      `${apiBaseUrl}/internal/wiki-rebuild/page-version/${wiki_page_version_id}/status`,
      {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ status: 'indexed', wiki_page_id }),
      },
    );

    if (!indexRes.ok) {
      return {
        subject_type,
        subject_id,
        tenant_id,
        wiki_page_id,
        wiki_page_version_id,
        final_status: 'embedded',
        facts_cited: 0,
        chunks_cited: 0,
        resumed_from_stall,
        error: `Failed to advance to indexed: HTTP ${indexRes.status}`,
      };
    }

    currentStatus = 'indexed';
  }

  // --- 5. Attach cites edges for all supporting evidence ---
  let factsCited = 0;
  let chunksCited = 0;

  // Cite confirmed_facts
  for (const fact of factsData.facts) {
    const citesRes = await fetch(`${apiBaseUrl}/internal/wiki-rebuild/cites`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        wiki_page_version_id,
        target_id: fact.id,
        target_type: 'confirmed_fact',
      }),
    });
    if (citesRes.ok) factsCited++;
  }

  // Cite corpus_chunks
  for (const chunk of chunksData.chunks) {
    const citesRes = await fetch(`${apiBaseUrl}/internal/wiki-rebuild/cites`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        wiki_page_version_id,
        target_id: chunk.id,
        target_type: 'corpus_chunk',
      }),
    });
    if (citesRes.ok) chunksCited++;
  }

  return {
    subject_type,
    subject_id,
    tenant_id,
    wiki_page_id,
    wiki_page_version_id,
    final_status: currentStatus,
    facts_cited: factsCited,
    chunks_cited: chunksCited,
    resumed_from_stall,
    error: null,
  };
}
