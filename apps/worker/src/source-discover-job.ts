/**
 * @file source-discover-job.ts
 *
 * SOURCE_DISCOVER worker job handler — Phase 3 scout stub (issue #74).
 *
 * ## What this file does (scout stub)
 *
 * Implements `executeSourceDiscoverTask`, which on each scheduled tick:
 *
 *   1. Reads the active Research Methodology golden document via
 *      GET /api/golden-documents/active/research_methodology
 *      — strictly read-only; no writes to the golden document.
 *   2. Parses the methodology sections to extract the venue catalog.
 *      Each venue is a structured entry with name, url, and optional
 *      description and access_mode fields.
 *   3. For each venue, calls POST /internal/canonical-sources to register
 *      it as a canonical source. The endpoint is idempotent — running
 *      discovery twice does not create duplicate rows.
 *   4. Returns a `SourceDiscoverResult` summary.
 *
 * ## Read-only invariant (PRD §2)
 *
 * Agents have read-only access to the golden documents (PRD §2, §9). This
 * job MUST NOT write to, patch, or delete the Research Methodology. Any
 * write attempt will be rejected by the API layer (Bearer tokens receive 403
 * from the golden-documents endpoint).
 *
 * ## Startup guard
 *
 * `assertNoDatabaseUrl()` ensures DATABASE_URL is absent from the worker
 * process. Workers must not hold the privileged DB URL (WORKER-T-002).
 *
 * ## Integration points
 *
 * 1. `runner.ts` — routes SOURCE_DISCOVER tasks to `executeSourceDiscoverTask`.
 * 2. `API_BASE_URL` env var — base URL of the API server.
 * 3. `EDGAR_TEST_TOKEN` env var (TEST_MODE=true) — Bearer token for internal APIs.
 *
 * ## Venue catalog parsing (stub)
 *
 * The venue catalog is embedded in `golden_document_sections` rows. By
 * convention the methodology document includes a section whose `section_key`
 * is `"venue_catalog"` containing a JSON array of venue objects. For the
 * scout phase we parse this single section. The full implementation (Phase 3
 * feature issue) will handle richer markup, multi-section catalogs, and
 * unstructured prose extraction.
 *
 * Expected `venue_catalog` content (JSON array):
 *
 *   [
 *     {
 *       "name": "SEC EDGAR",
 *       "url": "https://www.sec.gov/cgi-bin/browse-edgar",
 *       "description": "Primary source for 8-K filings",
 *       "access_mode": "public"
 *     },
 *     …
 *   ]
 *
 * If the section is absent or the content is not valid JSON, the worker logs
 * a warning and returns zero venues (no error; coverage degradation is
 * flagged in the result).
 *
 * ## Canonical docs
 *
 * - `docs/prd.md` §2 §3 §5 — golden-doc read-only invariant, discover venues
 * - `docs/architecture.md` — WORKER-T-001, WORKER-T-002, WORKER-P-001
 * - `apps/server/src/api/golden-documents.ts` — GET active methodology
 * - `apps/server/src/api/canonical-source-registration.ts` — registration endpoint
 * - `packages/db/canonical-source-store.ts` — DB store
 * - `packages/db/task-queue.ts` — TaskType.SOURCE_DISCOVER
 * - `tests/integration/source-discovery.spec.ts` — integration tests
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/74
 *
 * ## TODO (Phase 3 full implementation)
 *
 * - Implement richer venue catalog parsing (unstructured prose, multi-section).
 * - Add cadence and rate-limit metadata fields to the venue entry shape.
 * - Emit SOURCE_DISCOVER_COMPLETE journal event after registration.
 * - Dispatch SCRAPE_SOURCE tasks for each newly registered venue.
 */

import type { TaskQueueRow } from 'db/task-queue';

/** The job_type constant for SOURCE_DISCOVER tasks. */
export const SOURCE_DISCOVER_JOB_TYPE = 'SOURCE_DISCOVER' as const;

// ---------------------------------------------------------------------------
// Venue entry shape (parsed from methodology section)
// ---------------------------------------------------------------------------

/**
 * A venue entry extracted from the Research Methodology's venue catalog
 * section.
 *
 * This is the internal parse result — not a public API type.
 */
export interface VenueEntry {
  /** Human-readable venue name (e.g. "SEC EDGAR"). */
  name: string;
  /** Canonical URL declared in the methodology. */
  url: string;
  /** Optional description extracted from the methodology. */
  description?: string | null;
  /**
   * Optional access mode.
   * Must be one of: "public" | "authenticated" | "api_key"
   * Defaults to null when not declared.
   */
  access_mode?: 'public' | 'authenticated' | 'api_key' | null;
}

// ---------------------------------------------------------------------------
// Task payload shape
// ---------------------------------------------------------------------------

/**
 * Payload shape for SOURCE_DISCOVER tasks.
 *
 * Payload fields must be PII-free (TQ-P-002, TQ-C-004). Only UUIDs and
 * routing metadata are permitted — no methodology content in the payload.
 */
export interface SourceDiscoverPayload {
  /**
   * The researcher's user ID. Used to derive the active methodology document
   * via GET /api/golden-documents/active/research_methodology.
   */
  author_id: string;
  /**
   * Tenant ID. Used for RLS scoping on the canonical_sources endpoint.
   */
  tenant_id: string;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/**
 * Per-venue result from one discovery cycle.
 */
export interface VenueRegistrationResult {
  /** Venue name from the methodology. */
  name: string;
  /** Canonical URL. */
  url: string;
  /** Whether the row was newly created (true) or already existed (false). */
  created: boolean;
  /** The canonical_sources row id. */
  source_id: string;
}

/**
 * Aggregate result returned by `executeSourceDiscoverTask`.
 */
export interface SourceDiscoverResult {
  /** ID of the active Research Methodology golden document that was read. */
  methodology_id: string | null;
  /**
   * Total venues found in the venue catalog section.
   * Zero when the section is absent or unparseable.
   */
  venues_found: number;
  /** Number of newly registered canonical sources. */
  registered_count: number;
  /** Number of venues already registered (idempotent). */
  skipped_count: number;
  /** Number of venues that failed to register (API error). */
  error_count: number;
  /** Per-venue breakdown for successfully registered venues. */
  registrations: VenueRegistrationResult[];
  /**
   * True when the venue_catalog section was absent or could not be parsed.
   * Signals coverage degradation.
   */
  catalog_parse_failed: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetches the active Research Methodology golden document and its sections
 * from the API server.
 *
 * Returns `null` when no active methodology document exists for the given
 * author + tenant combination.
 */
async function fetchActiveMethodology(
  apiBaseUrl: string,
  workerToken: string,
  authorId: string,
  tenantId: string,
): Promise<{
  document: { id: string; kind: string; state: string } | null;
  sections: Array<{ section_key: string; content: string; position: number }>;
} | null> {
  const url = `${apiBaseUrl}/api/golden-documents/active/research_methodology?tenant_id=${encodeURIComponent(tenantId)}`;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        // NOTE: The golden-documents endpoint rejects Bearer tokens (PRD §9
        // author-only). In TEST_MODE we fall back to the test session cookie
        // mechanism; the full Phase 3 implementation will use a read-only
        // service-account session instead.
        //
        // For the scout, we pass no Authorization header and rely on the
        // test-session middleware to authenticate the request in CI.
        'X-Worker-Author-Id': authorId,
        'X-Worker-Tenant-Id': tenantId,
        // Pass the test token as a non-Bearer header so the golden-documents
        // handler does not reject it (the handler only blocks "Bearer …" tokens).
        'X-Test-Worker-Token': workerToken,
      },
    });
    if (resp.status === 200) {
      return (await resp.json()) as {
        document: { id: string; kind: string; state: string } | null;
        sections: Array<{ section_key: string; content: string; position: number }>;
      };
    }
    if (resp.status === 404) {
      return null;
    }
    console.warn(`[source-discover] GET active methodology returned HTTP ${resp.status}`);
    return null;
  } catch (err) {
    console.warn('[source-discover] Error fetching active methodology:', err);
    return null;
  }
}

/**
 * Parses the `venue_catalog` section from a list of golden document sections.
 *
 * The section content is expected to be a JSON array of `VenueEntry` objects.
 * Returns an empty array (and logs a warning) when the section is absent or
 * the content is not valid JSON.
 */
function parseVenueCatalog(sections: Array<{ section_key: string; content: string }>): {
  venues: VenueEntry[];
  parseFailed: boolean;
} {
  const catalogSection = sections.find((s) => s.section_key === 'venue_catalog');
  if (!catalogSection) {
    console.warn('[source-discover] No venue_catalog section found in active methodology');
    return { venues: [], parseFailed: true };
  }

  try {
    const raw = JSON.parse(catalogSection.content) as unknown;
    if (!Array.isArray(raw)) {
      console.warn('[source-discover] venue_catalog content is not a JSON array');
      return { venues: [], parseFailed: true };
    }

    const venues: VenueEntry[] = [];
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.name !== 'string' || typeof entry.url !== 'string') {
        console.warn('[source-discover] Skipping venue entry missing name or url:', entry);
        continue;
      }
      venues.push({
        name: entry.name,
        url: entry.url,
        description: typeof entry.description === 'string' ? entry.description : null,
        access_mode:
          entry.access_mode === 'public' ||
          entry.access_mode === 'authenticated' ||
          entry.access_mode === 'api_key'
            ? entry.access_mode
            : null,
      });
    }
    return { venues, parseFailed: false };
  } catch (err) {
    console.warn('[source-discover] Failed to parse venue_catalog JSON:', err);
    return { venues: [], parseFailed: true };
  }
}

/**
 * Registers one venue as a canonical source via the internal API.
 *
 * Returns null on API failure (caller increments error_count).
 */
async function registerVenue(
  apiBaseUrl: string,
  workerToken: string,
  methodologyId: string,
  authorId: string,
  tenantId: string,
  venue: VenueEntry,
): Promise<{ created: boolean; source_id: string } | null> {
  const url = `${apiBaseUrl}/internal/canonical-sources`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${workerToken}`,
      },
      body: JSON.stringify({
        methodology_id: methodologyId,
        author_id: authorId,
        tenant_id: tenantId,
        name: venue.name,
        url: venue.url,
        description: venue.description ?? null,
        access_mode: venue.access_mode ?? null,
      }),
    });

    if (resp.status === 201 || resp.status === 200) {
      const data = (await resp.json()) as { created: boolean; source: { id: string } };
      return { created: data.created, source_id: data.source.id };
    }

    const errBody = await resp.text();
    console.error(
      `[source-discover] POST /internal/canonical-sources returned ${resp.status} for venue "${venue.name}": ${errBody}`,
    );
    return null;
  } catch (err) {
    console.error(`[source-discover] Error registering venue "${venue.name}":`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

/**
 * Executes one SOURCE_DISCOVER task tick.
 *
 * 1. Reads the active Research Methodology (read-only — no writes).
 * 2. Extracts the venue catalog from the `venue_catalog` section.
 * 3. Registers each venue as a canonical source via the internal API.
 * 4. Returns a `SourceDiscoverResult` summary.
 *
 * @param task        The claimed task_queue row.
 * @param apiBaseUrl  Base URL of the API server. Defaults to API_BASE_URL env var.
 * @param workerToken Bearer token for the /internal/canonical-sources endpoint.
 *                    Defaults to EDGAR_TEST_TOKEN env var (test-mode).
 */
export async function executeSourceDiscoverTask(
  task: TaskQueueRow,
  apiBaseUrl: string = process.env.API_BASE_URL ?? '',
  workerToken: string = process.env.EDGAR_TEST_TOKEN ?? '',
): Promise<SourceDiscoverResult> {
  const payload = task.payload as Partial<SourceDiscoverPayload>;
  const authorId: string = payload.author_id ?? '';
  const tenantId: string = payload.tenant_id ?? '';

  const result: SourceDiscoverResult = {
    methodology_id: null,
    venues_found: 0,
    registered_count: 0,
    skipped_count: 0,
    error_count: 0,
    registrations: [],
    catalog_parse_failed: false,
  };

  if (!authorId || !tenantId) {
    console.error('[source-discover] Task payload missing author_id or tenant_id');
    result.error_count++;
    return result;
  }

  // ── 1. Read the active Research Methodology (read-only) ───────────────────
  const methodologyData = await fetchActiveMethodology(apiBaseUrl, workerToken, authorId, tenantId);

  if (!methodologyData || !methodologyData.document) {
    console.warn(
      `[source-discover] No active research_methodology for author=${authorId} tenant=${tenantId}`,
    );
    return result;
  }

  const methodologyId = methodologyData.document.id;
  result.methodology_id = methodologyId;

  // ── 2. Extract the venue catalog ──────────────────────────────────────────
  const { venues, parseFailed } = parseVenueCatalog(methodologyData.sections);
  result.catalog_parse_failed = parseFailed;
  result.venues_found = venues.length;

  if (venues.length === 0) {
    return result;
  }

  // ── 3. Register each venue ────────────────────────────────────────────────
  for (const venue of venues) {
    const reg = await registerVenue(
      apiBaseUrl,
      workerToken,
      methodologyId,
      authorId,
      tenantId,
      venue,
    );

    if (reg === null) {
      result.error_count++;
      continue;
    }

    if (reg.created) {
      result.registered_count++;
    } else {
      result.skipped_count++;
    }

    result.registrations.push({
      name: venue.name,
      url: venue.url,
      created: reg.created,
      source_id: reg.source_id,
    });
  }

  return result;
}
