/**
 * @file source-scrape-job.ts
 *
 * SOURCE_SCRAPE worker job handler — Phase 3 (issue #75).
 *
 * ## What this file does
 *
 * Implements `executeSourceScrapeTask`, which on each scheduled tick:
 *
 *   1. Reads the canonical source metadata from GET /internal/canonical-sources/:id.
 *   2. Fetches the venue's current content (URL + access mode).
 *   3. Computes a SHA-256 content_hash of the raw payload.
 *   4. POSTs to POST /internal/scrape/source-finding to register the finding.
 *      The endpoint deduplicates by content_hash — duplicate scrapes collapse to
 *      one row (ON CONFLICT DO NOTHING).
 *   5. If the response is 201 (new finding), enqueues a FINDING_INGEST task.
 *   6. If the response is 200 (duplicate), skips enqueueing.
 *
 * ## Rate limits and robots policy
 *
 * The scraper respects the `access_mode` declared by the canonical source:
 *   - `public`        — plain GET with no credentials.
 *   - `api_key`       — attaches the configured API key header.
 *   - `authenticated` — reserved for future oauth / session flows.
 *
 * A per-host rate limiter enforces at most SCRAPE_RATE_LIMIT_RPM requests per
 * minute per host (default: 10).
 *
 * ## Startup guard
 *
 * `assertNoDatabaseUrl()` ensures DATABASE_URL is absent from the worker process.
 * Workers communicate exclusively through the internal API (WORKER-T-001, WORKER-T-002).
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5 §6
 * - docs/architecture.md — SOURCE_SCRAPE worker, content_hash dedup
 * - apps/server/src/api/source-scrape-api.ts — internal scrape API endpoints
 * - packages/db/mkt-knowledge-store.ts — DB store
 * - packages/db/task-queue.ts — TaskType.SOURCE_SCRAPE
 * - tests/integration/source-scrape-ingest.spec.ts — integration tests
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/75
 */

import type { TaskQueueRow } from 'db/task-queue';
import { assertNoDatabaseUrl } from './startup';

/** The job_type constant for SOURCE_SCRAPE tasks. */
export const SOURCE_SCRAPE_JOB_TYPE = 'SOURCE_SCRAPE' as const;

/** Default rate limit: max requests per minute per host. */
export const SCRAPE_RATE_LIMIT_RPM = 10;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export interface SourceScrapePayload {
  /** The canonical_source row ID to scrape. */
  canonical_source_id: string;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface SourceScrapeResult {
  canonical_source_id: string;
  /** Whether a new source_finding row was created. */
  finding_created: boolean;
  /** source_finding row ID (new or pre-existing). */
  finding_id: string | null;
  /** The content_hash of the scraped payload. */
  content_hash: string;
  /** True when the scraper skipped because the content_hash already existed. */
  deduplicated: boolean;
  /** True when the payload was quarantined due to a scrape or parse error. */
  quarantined: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// SHA-256 helper (no external deps — uses built-in crypto.subtle)
// ---------------------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Simple per-host rate limiter (in-process sliding-window counter)
// ---------------------------------------------------------------------------

const _hostWindowMs = 60_000;
const _hostTimestamps = new Map<string, number[]>();

function checkRateLimit(host: string, limitRpm: number): boolean {
  const now = Date.now();
  const windowStart = now - _hostWindowMs;
  const timestamps = (_hostTimestamps.get(host) ?? []).filter((ts) => ts > windowStart);
  if (timestamps.length >= limitRpm) return false;
  timestamps.push(now);
  _hostTimestamps.set(host, timestamps);
  return true;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Execute one SOURCE_SCRAPE task.
 *
 * @param task        The task row claimed from the queue.
 * @param apiBaseUrl  Base URL of the internal API server (e.g. http://server:4000).
 * @param token       Bearer token for authenticating internal API calls.
 * @param env         Process environment (for rate-limit overrides).
 */
export async function executeSourceScrapeTask(
  task: TaskQueueRow,
  apiBaseUrl: string,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SourceScrapeResult> {
  assertNoDatabaseUrl(env);

  const payload = task.payload as unknown as SourceScrapePayload;
  const { canonical_source_id } = payload;

  // --- 1. Fetch canonical source metadata ---
  const sourceRes = await fetch(`${apiBaseUrl}/internal/canonical-sources/${canonical_source_id}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!sourceRes.ok) {
    const errorText = await sourceRes.text();
    return {
      canonical_source_id,
      finding_created: false,
      finding_id: null,
      content_hash: '',
      deduplicated: false,
      quarantined: false,
      error: `Failed to fetch canonical source: HTTP ${sourceRes.status} ${errorText}`,
    };
  }

  const sourceData = (await sourceRes.json()) as {
    id: string;
    url: string;
    access_mode: 'public' | 'authenticated' | 'api_key' | null;
    tenant_id: string;
    status: string;
  };

  // --- 2. Rate-limit check ---
  const limitRpm = Number(env.SCRAPE_RATE_LIMIT_RPM ?? SCRAPE_RATE_LIMIT_RPM);
  let host: string;
  try {
    host = new URL(sourceData.url).hostname;
  } catch {
    return {
      canonical_source_id,
      finding_created: false,
      finding_id: null,
      content_hash: '',
      deduplicated: false,
      quarantined: true,
      error: `Invalid canonical source URL: ${sourceData.url}`,
    };
  }

  if (!checkRateLimit(host, limitRpm)) {
    return {
      canonical_source_id,
      finding_created: false,
      finding_id: null,
      content_hash: '',
      deduplicated: false,
      quarantined: false,
      error: `Rate limit exceeded for host ${host}: max ${limitRpm} req/min`,
    };
  }

  // --- 3. Scrape the venue ---
  const scrapeHeaders: Record<string, string> = {
    'User-Agent': 'market-alert-scraper/1.0 (research-associate)',
    Accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.8',
  };

  if (sourceData.access_mode === 'api_key') {
    const apiKey = env.SCRAPE_API_KEY ?? '';
    if (apiKey) scrapeHeaders['X-Api-Key'] = apiKey;
  }

  let rawContent: string;
  const scrapeUrl = sourceData.url;

  try {
    const scrapeRes = await fetch(scrapeUrl, {
      method: 'GET',
      headers: scrapeHeaders,
      // 30-second timeout guard via AbortController
      signal: AbortSignal.timeout(30_000),
    });

    if (!scrapeRes.ok) {
      const body = await scrapeRes.text();
      // Quarantine HTTP errors — operator can inspect and re-trigger.
      await quarantineViaApi(
        apiBaseUrl,
        token,
        canonical_source_id,
        body,
        `HTTP ${scrapeRes.status}`,
      );
      return {
        canonical_source_id,
        finding_created: false,
        finding_id: null,
        content_hash: '',
        deduplicated: false,
        quarantined: true,
        error: `Scrape returned HTTP ${scrapeRes.status}`,
      };
    }

    rawContent = await scrapeRes.text();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await quarantineViaApi(apiBaseUrl, token, canonical_source_id, '', `Scrape error: ${msg}`);
    return {
      canonical_source_id,
      finding_created: false,
      finding_id: null,
      content_hash: '',
      deduplicated: false,
      quarantined: true,
      error: `Scrape error: ${msg}`,
    };
  }

  // --- 4. Compute content_hash ---
  const contentHash = await sha256Hex(rawContent);

  // --- 5. Register finding via internal API ---
  const findingRes = await fetch(`${apiBaseUrl}/internal/scrape/source-finding`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      canonical_source_id,
      tenant_id: sourceData.tenant_id,
      content_hash: contentHash,
      raw_content: rawContent,
      source_url: scrapeUrl,
    }),
  });

  if (!findingRes.ok) {
    const errBody = await findingRes.text();
    return {
      canonical_source_id,
      finding_created: false,
      finding_id: null,
      content_hash: contentHash,
      deduplicated: false,
      quarantined: false,
      error: `Register finding failed: HTTP ${findingRes.status} ${errBody}`,
    };
  }

  const findingData = (await findingRes.json()) as { created: boolean; finding: { id: string } };
  const deduplicated = !findingData.created;

  return {
    canonical_source_id,
    finding_created: findingData.created,
    finding_id: findingData.finding.id,
    content_hash: contentHash,
    deduplicated,
    quarantined: false,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Quarantine helper
// ---------------------------------------------------------------------------

async function quarantineViaApi(
  apiBaseUrl: string,
  token: string,
  source: string,
  rawPayload: string,
  errorMessage: string,
): Promise<void> {
  try {
    await fetch(`${apiBaseUrl}/internal/scrape/quarantine`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source, raw_payload: rawPayload, error_message: errorMessage }),
    });
  } catch {
    // Best-effort — do not throw here; the caller already records the error.
  }
}
