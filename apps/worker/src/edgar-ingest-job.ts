/**
 * @file edgar-ingest-job.ts
 *
 * EDGAR_POLL worker job handler — Phase 2 implementation (issue #14).
 *
 * ## What this file does
 *
 * Implements the `executeEdgarIngestTask` function which:
 *
 *   1. Parses `task.payload` as `EdgarPollPayload`.
 *   2. Fetches the EDGAR 8-K ATOM feed from EDGAR_FEED_URL (intercepted by
 *      MSW v2 in CI — no live sec.gov calls in tests).
 *   3. Parses the ATOM XML response using Bun's native DOMParser.
 *   4. For each <entry> in the feed:
 *        a. Extracts accession_number, form_type, CIK, issuer_name, filing_date,
 *           and the raw entry XML string.
 *        b. Posts to `${apiBaseUrl}/internal/ingestion/corporate-action` with
 *           Authorization: Bearer ${EDGAR_TEST_TOKEN} (test-mode).
 *        c. On HTTP 201, increments stored_count.
 *        d. On HTTP 200 (idempotent duplicate), increments skipped_count.
 *        e. On HTTP 4xx/5xx, increments error_count.
 *   5. Returns an `EdgarIngestResult`.
 *
 * ## Startup guard: DATABASE_URL must not be set
 *
 * assertNoDatabaseUrl() in apps/worker/src/startup.ts checks that DATABASE_URL
 * is absent from the worker process. Workers must not hold the privileged DB URL.
 *
 * ## Integration points
 *
 * 1. `runner.ts` must import `EDGAR_INGEST_JOB_TYPE` and route tasks with
 *    `job_type === 'EDGAR_POLL'` to `executeEdgarIngestTask`.
 *
 * 2. The API_BASE_URL env var (already read by runner.ts) is used to construct
 *    the corporate-action ingestion URL.
 *
 * 3. The EDGAR_TEST_TOKEN env var (TEST_MODE=true only) carries the static
 *    Bearer token accepted by POST /internal/ingestion/corporate-action.
 *    In production this is replaced by a signed worker JWT (follow-on).
 *
 * 4. EDGAR_FEED_URL env var: override the default EDGAR search endpoint.
 *    Defaults to https://efts.sec.gov/LATEST/search-index. Tests override this
 *    to the MSW-intercepted URL or rely on MSW to intercept the default URL.
 *
 * ## XML parsing
 *
 * Uses Bun's native DOMParser to parse the ATOM XML. The EDGAR ATOM feed uses
 * the standard Atom 2005 namespace (http://www.w3.org/2005/Atom).
 *
 * Accession number normalisation:
 *   - ATOM <id> uses: urn:tag:sec.gov,2008:accession-number=0001234567-26-000001
 *   - We extract the part after "accession-number=".
 *
 * ## Risks
 *
 * 1. Bun DOMParser: tested in Bun >= 1.0; for Node.js environments use
 *    a polyfill (e.g. `jsdom`). The integration test runs under Bun.
 * 2. EDGAR rate limits: 10 req/s per IP. CI always uses MSW; production must
 *    respect the poll cadence.
 * 3. Worker token lifecycle: EDGAR_TEST_TOKEN is a static secret for Phase 2.
 *    Production must use single-use worker JWTs (follow-on issue).
 *
 * ## Canonical docs
 *
 * - docs/architecture.md — ingestion pipeline
 * - apps/worker/src/email-ingest-job.ts — worker job pattern reference
 * - apps/server/src/api/corporate-action-ingestion.ts — API endpoint
 * - tests/fixtures/edgar/msw-handler.ts — MSW intercept
 * - packages/db/task-queue.ts — TaskType.EDGAR_POLL, claimNextTask
 */

import type { TaskQueueRow } from 'db/task-queue';

/** The job_type constant for EDGAR_POLL tasks. */
export const EDGAR_INGEST_JOB_TYPE = 'EDGAR_POLL' as const;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/**
 * Payload shape for EDGAR_POLL tasks.
 *
 * Payload fields must be PII-free (TQ-P-002, TQ-C-004).
 * Only form type and poll window timestamps are included.
 */
export interface EdgarPollPayload {
  /** EDGAR form type to poll, e.g. '8-K'. */
  form_type: string;
  /** ISO-8601 UTC start of the poll window. */
  poll_window_start: string;
  /** ISO-8601 UTC end of the poll window. */
  poll_window_end: string;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Result returned by executeEdgarIngestTask after a successful poll cycle.
 */
export interface EdgarIngestResult {
  /** Number of CorporateAction rows created in this poll cycle. */
  stored_count: number;
  /** Number of entries skipped due to idempotency (already stored). */
  skipped_count: number;
  /** Number of entries that failed to ingest. */
  error_count: number;
  /** ISO-8601 UTC timestamp of the feed's <updated> element. */
  feed_updated_at: string | null;
}

// ---------------------------------------------------------------------------
// ATOM XML parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extracts text content between opening and closing XML tags.
 * Returns null if the tag is not found.
 */
function extractTagContent(xml: string, tag: string): string | null {
  const openTag = `<${tag}`;
  const closeTag = `</${tag}>`;
  const start = xml.indexOf(openTag);
  if (start === -1) return null;
  const contentStart = xml.indexOf('>', start) + 1;
  const end = xml.indexOf(closeTag, contentStart);
  if (end === -1) return null;
  return xml.slice(contentStart, end).trim();
}

/**
 * Extracts all <entry>...</entry> blocks from an ATOM feed string.
 */
function extractEntries(feedXml: string): string[] {
  const entries: string[] = [];
  let pos = 0;
  while (true) {
    const start = feedXml.indexOf('<entry>', pos);
    if (start === -1) break;
    const end = feedXml.indexOf('</entry>', start);
    if (end === -1) break;
    entries.push(feedXml.slice(start, end + '</entry>'.length));
    pos = end + '</entry>'.length;
  }
  return entries;
}

/**
 * Extracts the accession number from an EDGAR ATOM entry <id> element.
 *
 * EDGAR format: urn:tag:sec.gov,2008:accession-number=0001234567-26-000001
 * Returns: '0001234567-26-000001'
 */
function extractAccessionNumber(entryId: string): string | null {
  const match = entryId.match(/accession-number=([0-9-]+)/);
  return match ? match[1] : null;
}

/**
 * Extracts a category term by label attribute from an entry XML string.
 *
 * EDGAR uses <category term="value" label="label-name"/> for metadata.
 */
function extractCategory(entryXml: string, label: string): string | null {
  const re = new RegExp(`<category[^>]*?term="([^"]*)"[^>]*?label="${label}"[^>]*/?>`, 'i');
  const match = entryXml.match(re);
  if (match) return match[1];
  // Also try the reversed attribute order
  const re2 = new RegExp(`<category[^>]*?label="${label}"[^>]*?term="([^"]*)"[^>]*/?>`, 'i');
  const match2 = entryXml.match(re2);
  return match2 ? match2[1] : null;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Executes one EDGAR_POLL task cycle.
 *
 * Fetches the EDGAR ATOM feed, parses entries, and POSTs each entry to
 * POST /internal/ingestion/corporate-action. Returns the ingest result.
 *
 * @param task        The claimed task_queue row (contains payload).
 * @param apiBaseUrl  Base URL of the API server.
 *                    Defaults to API_BASE_URL env var.
 * @param workerToken Bearer token for the corporate-action endpoint.
 *                    Defaults to EDGAR_TEST_TOKEN env var (test-mode).
 */
export async function executeEdgarIngestTask(
  task: TaskQueueRow,
  apiBaseUrl: string = process.env.API_BASE_URL ?? '',
  workerToken: string = process.env.EDGAR_TEST_TOKEN ?? '',
): Promise<EdgarIngestResult> {
  const result: EdgarIngestResult = {
    stored_count: 0,
    skipped_count: 0,
    error_count: 0,
    feed_updated_at: null,
  };

  // ---------------------------------------------------------------------------
  // 1. Parse task payload
  // ---------------------------------------------------------------------------

  const payload = task.payload as Partial<EdgarPollPayload>;
  const formType = payload.form_type ?? '8-K';
  const pollWindowStart = payload.poll_window_start ?? '';
  const pollWindowEnd = payload.poll_window_end ?? '';

  // ---------------------------------------------------------------------------
  // 2. Build EDGAR ATOM feed URL
  // ---------------------------------------------------------------------------

  const edgarFeedBase = process.env.EDGAR_FEED_URL ?? 'https://efts.sec.gov/LATEST/search-index';

  const feedUrl = new URL(edgarFeedBase);
  feedUrl.searchParams.set('q', `"${formType}"`);
  feedUrl.searchParams.set('forms', formType);
  if (pollWindowStart) {
    feedUrl.searchParams.set('dateRange', 'custom');
    feedUrl.searchParams.set('startdt', pollWindowStart.split('T')[0]);
  }
  if (pollWindowEnd) {
    feedUrl.searchParams.set('enddt', pollWindowEnd.split('T')[0]);
  }

  // ---------------------------------------------------------------------------
  // 3. Fetch the ATOM feed (MSW-intercepted in CI)
  // ---------------------------------------------------------------------------

  let feedText: string;
  try {
    const response = await fetch(feedUrl.toString(), {
      headers: {
        'User-Agent': 'market-alert-edgar-ingest/1.0 (contact: ops@example.com)',
        Accept: 'application/atom+xml, application/xml',
      },
    });
    if (!response.ok) {
      throw new Error(`EDGAR feed returned HTTP ${response.status}`);
    }
    feedText = await response.text();
  } catch (err) {
    result.error_count++;
    console.error('[edgar-ingest] Failed to fetch EDGAR feed:', err);
    return result;
  }

  // ---------------------------------------------------------------------------
  // 4. Parse the ATOM XML (regex-based; no DOMParser required)
  // ---------------------------------------------------------------------------

  // Extract feed-level <updated>
  const feedUpdated = extractTagContent(feedText, 'updated');
  result.feed_updated_at = feedUpdated;

  // Extract <entry> blocks
  const entries = extractEntries(feedText);

  // ---------------------------------------------------------------------------
  // 5. Process each entry
  // ---------------------------------------------------------------------------

  for (const entryXml of entries) {
    try {
      // Extract entry fields from raw XML string
      const entryId = extractTagContent(entryXml, 'id') ?? '';
      const accession_number = extractAccessionNumber(entryId);
      if (!accession_number) {
        console.warn('[edgar-ingest] Skipping entry with unparseable id:', entryId);
        result.error_count++;
        continue;
      }

      const title = extractTagContent(entryXml, 'title') ?? '';
      const updatedText = extractTagContent(entryXml, 'updated') ?? new Date().toISOString();
      const issuer_name =
        extractCategory(entryXml, 'Issuer Name') ?? title.split('—')[0]?.trim() ?? null;
      const cik = extractCategory(entryXml, 'CIK') ?? '';
      const form_type_entry = extractCategory(entryXml, formType) ?? formType;

      // Use the raw entry XML as filing_text (surrogate for full document in scout)
      const filing_text = entryXml;

      // Build the ingest body
      const body = {
        accession_number,
        form_type: form_type_entry,
        cik,
        issuer_name,
        filing_date: updatedText,
        filing_text,
      };

      // POST to the corporate-action endpoint
      const ingestUrl = `${apiBaseUrl}/internal/ingestion/corporate-action`;
      const resp = await fetch(ingestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${workerToken}`,
        },
        body: JSON.stringify(body),
      });

      if (resp.status === 201) {
        result.stored_count++;
      } else if (resp.status === 200) {
        // Idempotent duplicate
        result.skipped_count++;
      } else {
        const errBody = await resp.text();
        console.error(
          `[edgar-ingest] POST to corporate-action returned ${resp.status}: ${errBody}`,
        );
        result.error_count++;
      }
    } catch (err) {
      console.error('[edgar-ingest] Error processing EDGAR entry:', err);
      result.error_count++;
    }
  }

  return result;
}
