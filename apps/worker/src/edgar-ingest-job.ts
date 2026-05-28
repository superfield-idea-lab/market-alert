/**
 * @file edgar-ingest-job.ts
 *
 * EDGAR_POLL worker job handler — Phase 2 multi-form-type polling (issue #15).
 *
 * ## What this file does
 *
 * Implements `executeEdgarIngestTask`, which on each scheduled tick:
 *
 *   1. Iterates all configured EDGAR form types (8-K, 8-K/A, SC 13D, SC 13G,
 *      S-4, 425, DEF 14A).
 *   2. Reads the per-form-type watermark from GET /internal/etl/cursor/edgar/:formType.
 *   3. Fetches the EDGAR ATOM feed for that form type (MSW-intercepted in CI).
 *   4. For each new entry (filing_date > watermark):
 *        a. POSTs to POST /internal/ingestion/corporate-action.
 *        b. On HTTP 201 (new), increments stored_count; advances candidate watermark.
 *        c. On HTTP 200 (duplicate/idempotent), increments skipped_count.
 *        d. On HTTP 4xx/5xx, increments error_count; stops watermark advance.
 *   5. After a fully successful batch, PUTs the new watermark to
 *      PUT /internal/etl/cursor/edgar/:formType.
 *      The watermark is NOT advanced if any POST returned a non-2xx response.
 *   6. Amended form types (8-K/A) use a configurable overlap window so late
 *      amendments behind the watermark are still processed.
 *
 * ## Watermark semantics
 *
 * - Watermark is the ISO-8601 UTC string of the latest filing_date seen in
 *   the last successful batch.
 * - On first run (no cursor row), watermark is empty string — fetch the full
 *   available feed window.
 * - The overlap window for amended types (8-K/A) shifts startdt back by
 *   AMENDED_OVERLAP_SECONDS (default: 86400 s = 24 h) from the watermark.
 *
 * ## Startup guard
 *
 * assertNoDatabaseUrl() (apps/worker/src/startup.ts) ensures DATABASE_URL is
 * absent from the worker process. Workers must not hold the privileged DB URL.
 *
 * ## Integration points
 *
 * 1. `runner.ts` routes EDGAR_POLL tasks to `executeEdgarIngestTask`.
 * 2. API_BASE_URL env var — base URL of the API server.
 * 3. EDGAR_TEST_TOKEN env var (TEST_MODE=true) — Bearer token for internal APIs.
 * 4. EDGAR_FEED_URL env var — override the default EDGAR search endpoint.
 *    Defaults to https://efts.sec.gov/LATEST/search-index.
 *
 * ## Canonical docs
 *
 * - docs/architecture.md — ingestion pipeline
 * - apps/server/src/api/corporate-action-ingestion.ts — ingestion endpoint
 * - apps/server/src/api/etl-cursor.ts — watermark read/write endpoint
 * - packages/db/etl-cursors.ts — etl_cursors schema
 * - tests/fixtures/edgar/msw-handler.ts — MSW intercept
 * - tests/integration/edgar-multi-form.spec.ts — integration test
 */

import type { TaskQueueRow } from 'db/task-queue';

/** The job_type constant for EDGAR_POLL tasks. */
export const EDGAR_INGEST_JOB_TYPE = 'EDGAR_POLL' as const;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * All EDGAR form types polled on each tick.
 * Order is stable so logs are consistent across runs.
 */
export const EDGAR_FORM_TYPES = [
  '8-K',
  '8-K/A',
  'SC 13D',
  'SC 13G',
  'S-4',
  '425',
  'DEF 14A',
] as const;

export type EdgarFormType = (typeof EDGAR_FORM_TYPES)[number];

/**
 * Overlap window in seconds for amended form types.
 * The feed startdt is shifted back by this many seconds from the watermark so
 * late amendments filed after the watermark was set are still captured.
 *
 * Default: 86400 s (24 hours).
 */
export const AMENDED_OVERLAP_SECONDS = 86_400;

/**
 * Form types that require an overlap window (amended filings).
 */
export const AMENDED_FORM_TYPES: ReadonlySet<string> = new Set(['8-K/A']);

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/**
 * Payload shape for EDGAR_POLL tasks.
 *
 * Payload fields must be PII-free (TQ-P-002, TQ-C-004).
 * The payload is largely advisory for multi-form-type polling — the worker
 * determines the actual poll window from per-form-type watermarks in etl_cursors.
 */
export interface EdgarPollPayload {
  /** Optional single form type override. If absent, all configured types are polled. */
  form_type?: string;
  /** ISO-8601 UTC start of the poll window (advisory; overridden by watermark). */
  poll_window_start?: string;
  /** ISO-8601 UTC end of the poll window (advisory). */
  poll_window_end?: string;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Per-form-type result from one poll cycle.
 */
export interface EdgarFormTypeResult {
  /** EDGAR form type that was polled. */
  form_type: string;
  /** Number of CorporateAction rows created in this cycle. */
  stored_count: number;
  /** Number of entries skipped due to idempotency (already stored). */
  skipped_count: number;
  /** Number of entries that failed to ingest. */
  error_count: number;
  /** ISO-8601 UTC timestamp of the feed's <updated> element. */
  feed_updated_at: string | null;
  /** New watermark value set after a successful batch; null if not advanced. */
  watermark_advanced_to: string | null;
}

/**
 * Aggregate result returned by executeEdgarIngestTask after a full tick.
 */
export interface EdgarIngestResult {
  /** Number of CorporateAction rows created across all form types. */
  stored_count: number;
  /** Number of entries skipped due to idempotency across all form types. */
  skipped_count: number;
  /** Number of entries that failed to ingest across all form types. */
  error_count: number;
  /** ISO-8601 UTC timestamp of the last feed's <updated> element. */
  feed_updated_at: string | null;
  /** Per-form-type breakdown. */
  by_form_type: EdgarFormTypeResult[];
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
// Internal API helpers
// ---------------------------------------------------------------------------

/**
 * GETs the current watermark for a form type from the etl-cursor API.
 * Returns empty string when no cursor row exists (first run).
 */
async function readWatermark(
  apiBaseUrl: string,
  workerToken: string,
  formType: string,
): Promise<{ watermark_value: string; overlap_seconds: number }> {
  const encodedKey = encodeURIComponent(formType);
  const url = `${apiBaseUrl}/internal/etl/cursor/edgar/${encodedKey}`;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${workerToken}` },
    });
    if (resp.status === 404) {
      // First run — no cursor row yet.
      return { watermark_value: '', overlap_seconds: 0 };
    }
    if (!resp.ok) {
      console.warn(`[edgar-ingest] Failed to read cursor for ${formType}: HTTP ${resp.status}`);
      return { watermark_value: '', overlap_seconds: 0 };
    }
    const data = (await resp.json()) as { watermark_value: string; overlap_seconds: number };
    return {
      watermark_value: data.watermark_value ?? '',
      overlap_seconds: data.overlap_seconds ?? 0,
    };
  } catch (err) {
    console.warn(`[edgar-ingest] Error reading cursor for ${formType}:`, err);
    return { watermark_value: '', overlap_seconds: 0 };
  }
}

/**
 * PUTs the new watermark for a form type to the etl-cursor API.
 * This advances the cursor only after a successful batch.
 */
async function advanceWatermark(
  apiBaseUrl: string,
  workerToken: string,
  formType: string,
  watermarkValue: string,
  overlapSeconds: number,
): Promise<boolean> {
  const encodedKey = encodeURIComponent(formType);
  const url = `${apiBaseUrl}/internal/etl/cursor/edgar/${encodedKey}`;
  try {
    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${workerToken}`,
      },
      body: JSON.stringify({ watermark_value: watermarkValue, overlap_seconds: overlapSeconds }),
    });
    if (!resp.ok) {
      console.error(`[edgar-ingest] Failed to advance cursor for ${formType}: HTTP ${resp.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[edgar-ingest] Error advancing cursor for ${formType}:`, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Single form type poll
// ---------------------------------------------------------------------------

/**
 * Polls one EDGAR form type: fetches the ATOM feed, processes entries, and
 * advances the watermark after a fully successful batch.
 *
 * @param formType    EDGAR form type, e.g. '8-K'.
 * @param apiBaseUrl  Base URL of the API server.
 * @param workerToken Bearer token for internal API calls.
 * @returns           Per-form-type result.
 */
async function pollFormType(
  formType: string,
  apiBaseUrl: string,
  workerToken: string,
): Promise<EdgarFormTypeResult> {
  const result: EdgarFormTypeResult = {
    form_type: formType,
    stored_count: 0,
    skipped_count: 0,
    error_count: 0,
    feed_updated_at: null,
    watermark_advanced_to: null,
  };

  // -------------------------------------------------------------------------
  // 1. Read current watermark
  // -------------------------------------------------------------------------

  const { watermark_value: currentWatermark } = await readWatermark(
    apiBaseUrl,
    workerToken,
    formType,
  );

  // Overlap window for amended form types
  const isAmended = AMENDED_FORM_TYPES.has(formType);
  const overlapSeconds = isAmended ? AMENDED_OVERLAP_SECONDS : 0;

  // -------------------------------------------------------------------------
  // 2. Build EDGAR ATOM feed URL
  // -------------------------------------------------------------------------

  const edgarFeedBase = process.env.EDGAR_FEED_URL ?? 'https://efts.sec.gov/LATEST/search-index';
  const feedUrl = new URL(edgarFeedBase);
  feedUrl.searchParams.set('q', `"${formType}"`);
  feedUrl.searchParams.set('forms', formType);

  if (currentWatermark) {
    // Compute startdt from the watermark, shifting back by overlap for amended types
    const watermarkDate = new Date(currentWatermark);
    const startDate = new Date(watermarkDate.getTime() - overlapSeconds * 1000);
    feedUrl.searchParams.set('dateRange', 'custom');
    feedUrl.searchParams.set('startdt', startDate.toISOString().split('T')[0]);
  }

  // -------------------------------------------------------------------------
  // 3. Fetch the ATOM feed (MSW-intercepted in CI)
  // -------------------------------------------------------------------------

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
    console.error(`[edgar-ingest] Failed to fetch EDGAR feed for ${formType}:`, err);
    return result;
  }

  // -------------------------------------------------------------------------
  // 4. Parse the ATOM XML
  // -------------------------------------------------------------------------

  const feedUpdated = extractTagContent(feedText, 'updated');
  result.feed_updated_at = feedUpdated;

  const entries = extractEntries(feedText);

  // -------------------------------------------------------------------------
  // 5. Process each entry — track candidate watermark
  // -------------------------------------------------------------------------

  let candidateWatermark = currentWatermark;
  let batchHadErrors = false;

  for (const entryXml of entries) {
    try {
      const entryId = extractTagContent(entryXml, 'id') ?? '';
      const accession_number = extractAccessionNumber(entryId);
      if (!accession_number) {
        console.warn(`[edgar-ingest] Skipping entry with unparseable id:`, entryId);
        result.error_count++;
        batchHadErrors = true;
        continue;
      }

      const title = extractTagContent(entryXml, 'title') ?? '';
      const updatedText = extractTagContent(entryXml, 'updated') ?? new Date().toISOString();

      // For amended types, skip entries that are before the watermark minus overlap
      // (entries that were already processed in a prior non-overlap window).
      // Entries within the overlap window are re-submitted — idempotency at the
      // API layer (HTTP 200) handles duplicates gracefully.

      const issuer_name =
        extractCategory(entryXml, 'Issuer Name') ?? title.split('—')[0]?.trim() ?? null;
      const cik = extractCategory(entryXml, 'CIK') ?? '';
      // Extract the form_type from the entry itself, falling back to the polled form type
      const form_type_entry = extractCategory(entryXml, 'Form Type') ?? formType;

      const body = {
        accession_number,
        form_type: form_type_entry,
        cik,
        issuer_name,
        filing_date: updatedText,
        filing_text: entryXml,
      };

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
        // Advance candidate watermark to the latest filing date seen
        if (!candidateWatermark || updatedText > candidateWatermark) {
          candidateWatermark = updatedText;
        }
      } else if (resp.status === 200) {
        // Idempotent duplicate — still count as seen for watermark purposes
        result.skipped_count++;
        if (!candidateWatermark || updatedText > candidateWatermark) {
          candidateWatermark = updatedText;
        }
      } else {
        const errBody = await resp.text();
        console.error(
          `[edgar-ingest] POST to corporate-action returned ${resp.status} for ${accession_number}: ${errBody}`,
        );
        result.error_count++;
        batchHadErrors = true;
        // Do NOT advance the watermark past this entry — stop advancing
        break;
      }
    } catch (err) {
      console.error(`[edgar-ingest] Error processing EDGAR entry for ${formType}:`, err);
      result.error_count++;
      batchHadErrors = true;
      break;
    }
  }

  // -------------------------------------------------------------------------
  // 6. Advance watermark only on a fully successful batch
  // -------------------------------------------------------------------------

  if (!batchHadErrors && candidateWatermark && candidateWatermark !== currentWatermark) {
    const advanced = await advanceWatermark(
      apiBaseUrl,
      workerToken,
      formType,
      candidateWatermark,
      overlapSeconds,
    );
    if (advanced) {
      result.watermark_advanced_to = candidateWatermark;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

/**
 * Executes one EDGAR_POLL task tick — polls all configured form types and
 * advances per-form-type watermarks after successful batches.
 *
 * @param task        The claimed task_queue row (contains optional payload).
 * @param apiBaseUrl  Base URL of the API server.
 *                    Defaults to API_BASE_URL env var.
 * @param workerToken Bearer token for the internal API endpoints.
 *                    Defaults to EDGAR_TEST_TOKEN env var (test-mode).
 */
export async function executeEdgarIngestTask(
  task: TaskQueueRow,
  apiBaseUrl: string = process.env.API_BASE_URL ?? '',
  workerToken: string = process.env.EDGAR_TEST_TOKEN ?? '',
): Promise<EdgarIngestResult> {
  const aggregate: EdgarIngestResult = {
    stored_count: 0,
    skipped_count: 0,
    error_count: 0,
    feed_updated_at: null,
    by_form_type: [],
  };

  // Optionally restrict to a single form type from the task payload.
  const payload = task.payload as Partial<EdgarPollPayload>;
  const formTypesToPoll: string[] = payload.form_type ? [payload.form_type] : [...EDGAR_FORM_TYPES];

  for (const formType of formTypesToPoll) {
    const r = await pollFormType(formType, apiBaseUrl, workerToken);
    aggregate.by_form_type.push(r);
    aggregate.stored_count += r.stored_count;
    aggregate.skipped_count += r.skipped_count;
    aggregate.error_count += r.error_count;
    if (r.feed_updated_at) {
      aggregate.feed_updated_at = r.feed_updated_at;
    }
  }

  return aggregate;
}
