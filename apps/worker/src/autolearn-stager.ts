/**
 * @file autolearn-stager.ts
 *
 * Temporary filesystem stager for autolearn pod input.
 *
 * At pod startup the stager fetches anonymised ground truth and the current
 * wiki markdown for a scoped (dept, customer) pair and writes them into a
 * working directory under /tmp/.  When the pod terminates the directory is
 * destroyed with it (ephemeral; no caching across pods).
 *
 * ## Security posture
 *
 * - Only anonymised/tokenised content is written to disk; raw PII never passes
 *   through this module (PRD §7, DATA blueprint).
 * - Content is fetched from the API using a short-lived delegated token
 *   (WORKER-T-005).
 * - The staging directory is created with mode 0o700 (owner access only).
 * - The directory path is derived from a random UUID so sibling pods cannot
 *   predict or collide on the path.
 * - No caching: each pod fetches fresh content at startup; there is no
 *   cross-pod persistence surface.
 *
 * ## Directory layout
 *
 * ```
 * /tmp/superfield-autolearn-<uuid>/
 *   ground-truth.json   — anonymised ground truth (tokenised, never raw PII)
 *   wiki.md             — current wiki markdown for the dept/customer scope
 * ```
 *
 * ## Fail-closed contract
 *
 * If either fetch fails, `stageAutolearnInput` throws.  Callers MUST propagate
 * the error and call `process.exit(1)` so the pod does not start in a degraded
 * state.
 *
 * ## Cleanup
 *
 * `cleanupStagingDir` removes the staging directory.  In production the pod
 * termination destroys /tmp automatically; `cleanupStagingDir` is provided for
 * orderly shutdown hooks in tests and for any pre-termination logic.
 *
 * Blueprint reference: WORKER domain — autolearn pod stager
 */

import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { TranscriptSegment } from 'core';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base directory under which all staging directories are created. */
export const STAGING_BASE_DIR = '/tmp';

/** Prefix for the per-run staging directory name. */
export const STAGING_DIR_PREFIX = 'superfield-autolearn-';

/** Filename for the anonymised ground-truth content file. */
export const GROUND_TRUTH_FILENAME = 'ground-truth.json';

/** Filename for the wiki markdown content file. */
export const WIKI_FILENAME = 'wiki.md';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Scope identifying a (dept, customer) pair for which content is staged.
 */
export interface AutolearnScope {
  /** Department identifier (opaque token, never a PII value). */
  dept: string;
  /** Customer identifier (opaque token, never a PII value). */
  customer: string;
}

/**
 * The result of a successful staging run.
 */
export interface StagingResult {
  /** Absolute path to the staging directory under /tmp/. */
  stagingDir: string;
  /** Absolute path to the ground-truth file. */
  groundTruthPath: string;
  /** Absolute path to the wiki markdown file. */
  wikiPath: string;
}

/**
 * Anonymised ground truth response from the API.
 *
 * Content is tokenised — no raw PII values appear in any field.
 */
export interface GroundTruthContent {
  /** Opaque scope token echoed from the request. */
  scope_ref: string;
  /** Array of anonymised ground-truth records. */
  records: GroundTruthRecord[];
  /** ISO-8601 timestamp of the snapshot. */
  fetched_at: string;
}

/**
 * A single anonymised ground-truth record.
 *
 * All identifying fields contain opaque tokens, not raw PII.
 * Transcript records may carry `segments` with per-segment speaker labels
 * (issue #59).
 */
export interface GroundTruthRecord {
  /** Opaque identifier for this record. */
  id: string;
  /**
   * Per-segment speaker diarisation, present when the record comes from a
   * transcript entity that was ingested with diarisation data.
   *
   * Labels are opaque (SPEAKER_A, SPEAKER_B, …) — never real names.
   */
  segments?: TranscriptSegment[];
  /** Anonymised / tokenised content fields. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a fetch to the autolearn API fails. */
export class AutolearnFetchError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly statusCode: number | null,
    cause?: Error,
  ) {
    super(
      statusCode !== null
        ? `Autolearn API fetch failed — ${endpoint} returned HTTP ${statusCode}`
        : `Autolearn API fetch failed — ${endpoint}: ${cause?.message ?? 'network error'}`,
    );
    this.name = 'AutolearnFetchError';
    if (cause) this.cause = cause;
  }
}

/** Thrown when the response body from the autolearn API cannot be parsed. */
export class AutolearnParseError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly rawBody: string,
    cause?: Error,
  ) {
    super(`Autolearn API response from ${endpoint} is not valid JSON: ${rawBody.slice(0, 200)}`);
    this.name = 'AutolearnParseError';
    if (cause) this.cause = cause;
  }
}

/** Thrown when the staging directory cannot be created or written. */
export class StagingWriteError extends Error {
  constructor(
    public readonly path: string,
    cause?: Error,
  ) {
    super(`Failed to write staging file "${path}": ${cause?.message ?? 'unknown error'}`);
    this.name = 'StagingWriteError';
    if (cause) this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Internal fetch helpers
// ---------------------------------------------------------------------------

/**
 * Build the URL for the anonymised ground-truth endpoint.
 *
 * When `fullGroundTruth` is true the `full=true` query parameter is appended,
 * signalling the API to return the entire corpus for the scope rather than an
 * incremental diff.  Deepclean runs always pass `fullGroundTruth: true`
 * (PRD §4.5, issue #41).
 *
 * @param apiBaseUrl     - Base URL of the Superfield API server (no trailing slash).
 * @param scope          - The (dept, customer) scope to fetch.
 * @param fullGroundTruth - When true, include `full=true` in the query string.
 */
export function buildGroundTruthUrl(
  apiBaseUrl: string,
  scope: AutolearnScope,
  fullGroundTruth = false,
): string {
  const url = new URL(`${apiBaseUrl}/api/autolearn/ground-truth`);
  url.searchParams.set('dept', scope.dept);
  url.searchParams.set('customer', scope.customer);
  if (fullGroundTruth) {
    url.searchParams.set('full', 'true');
  }
  return url.toString();
}

/**
 * Build the URL for the wiki markdown endpoint.
 *
 * @param apiBaseUrl - Base URL of the Superfield API server (no trailing slash).
 * @param scope      - The (dept, customer) scope to fetch.
 */
export function buildWikiUrl(apiBaseUrl: string, scope: AutolearnScope): string {
  const url = new URL(`${apiBaseUrl}/api/autolearn/wiki`);
  url.searchParams.set('dept', scope.dept);
  url.searchParams.set('customer', scope.customer);
  return url.toString();
}

/**
 * Fetch the anonymised ground truth for the given scope.
 *
 * @param apiBaseUrl      - Base URL of the Superfield API server.
 * @param scope           - The (dept, customer) scope to fetch.
 * @param delegatedToken  - Short-lived token authorising the fetch.
 * @param fullGroundTruth - When true, fetches the full corpus (deepclean mode).
 * @returns Parsed JSON body as a plain object.
 * @throws {AutolearnFetchError}  On non-2xx HTTP status or network error.
 * @throws {AutolearnParseError}  On invalid JSON response body.
 */
export async function fetchGroundTruth(
  apiBaseUrl: string,
  scope: AutolearnScope,
  delegatedToken: string,
  fullGroundTruth = false,
): Promise<GroundTruthContent> {
  const endpoint = buildGroundTruthUrl(apiBaseUrl, scope, fullGroundTruth);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${delegatedToken}` },
    });
  } catch (err) {
    throw new AutolearnFetchError(endpoint, null, err instanceof Error ? err : undefined);
  }

  if (!response.ok) {
    throw new AutolearnFetchError(endpoint, response.status);
  }

  const rawBody = await response.text().catch(() => '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (err) {
    throw new AutolearnParseError(endpoint, rawBody, err instanceof Error ? err : undefined);
  }

  return parsed as GroundTruthContent;
}

/**
 * Fetch the current wiki markdown for the given scope.
 *
 * @param apiBaseUrl     - Base URL of the Superfield API server.
 * @param scope          - The (dept, customer) scope to fetch.
 * @param delegatedToken - Short-lived token authorising the fetch.
 * @returns Wiki markdown as a raw string.
 * @throws {AutolearnFetchError}  On non-2xx HTTP status or network error.
 */
export async function fetchWikiMarkdown(
  apiBaseUrl: string,
  scope: AutolearnScope,
  delegatedToken: string,
): Promise<string> {
  const endpoint = buildWikiUrl(apiBaseUrl, scope);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${delegatedToken}` },
    });
  } catch (err) {
    throw new AutolearnFetchError(endpoint, null, err instanceof Error ? err : undefined);
  }

  if (!response.ok) {
    throw new AutolearnFetchError(endpoint, response.status);
  }

  return response.text();
}

// ---------------------------------------------------------------------------
// Staging directory helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh staging directory under STAGING_BASE_DIR.
 *
 * The directory name includes a random UUID to prevent path collisions between
 * concurrent pods and to make the path unpredictable.
 *
 * @returns Absolute path to the newly created directory.
 * @throws {StagingWriteError} If the directory cannot be created.
 */
export async function createStagingDir(): Promise<string> {
  const dirName = `${STAGING_DIR_PREFIX}${randomUUID()}`;
  const stagingDir = join(STAGING_BASE_DIR, dirName);

  try {
    await mkdir(stagingDir, { recursive: false, mode: 0o700 });
  } catch (err) {
    throw new StagingWriteError(stagingDir, err instanceof Error ? err : undefined);
  }

  return stagingDir;
}

/**
 * Write content to a file within the staging directory.
 *
 * @param filePath - Absolute path to the target file.
 * @param content  - String content to write.
 * @throws {StagingWriteError} If the file cannot be written.
 */
export async function writeStagingFile(filePath: string, content: string): Promise<void> {
  try {
    await writeFile(filePath, content, { mode: 0o600 });
  } catch (err) {
    throw new StagingWriteError(filePath, err instanceof Error ? err : undefined);
  }
}

/**
 * Remove the staging directory and all its contents.
 *
 * Safe to call even if the directory does not exist (idempotent).
 * In production this is called from a graceful shutdown hook; /tmp is wiped
 * when the pod terminates regardless.
 *
 * @param stagingDir - Absolute path to the staging directory to remove.
 */
export async function cleanupStagingDir(stagingDir: string): Promise<void> {
  await rm(stagingDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Speaker-label serialisation helpers (issue #59)
// ---------------------------------------------------------------------------

/**
 * Serialize a single `TranscriptSegment` as a plain-text dialogue line.
 *
 * Format: `[SPEAKER_X] <text>`
 *
 * This compact format is both human-readable and LLM-friendly.  The label is
 * always an opaque identifier — no real names are produced.
 */
export function segmentToDialogueLine(segment: TranscriptSegment): string {
  return `[${segment.speaker}] ${segment.text}`;
}

/**
 * Convert an array of transcript segments into a dialogue-formatted string.
 *
 * Segments are emitted in order, one line per segment.  Speaker label changes
 * are preserved so the LLM can attribute each claim to an opaque speaker.
 *
 * Returns an empty string when `segments` is empty or undefined.
 */
export function segmentsToDialogue(segments: TranscriptSegment[] | undefined): string {
  if (!segments || segments.length === 0) return '';
  return segments.map(segmentToDialogueLine).join('\n');
}

/**
 * Enrich a `GroundTruthContent` payload for staging by adding a
 * `dialogue` field to every record that carries transcript segments.
 *
 * The `dialogue` field is a pre-rendered string of the form:
 * ```
 * [SPEAKER_A] Hello, how can I help?
 * [SPEAKER_B] I need to renew my policy.
 * ```
 *
 * This lets the Claude CLI consume speaker-attributed content without having
 * to reconstruct dialogue from raw segment arrays.
 *
 * Records without a `segments` array are passed through unchanged.
 *
 * Issue #59: autolearn staged content must include speaker labels.
 */
export function formatGroundTruthForStaging(content: GroundTruthContent): GroundTruthContent {
  const enrichedRecords = content.records.map((record) => {
    if (!record.segments || record.segments.length === 0) return record;
    return {
      ...record,
      dialogue: segmentsToDialogue(record.segments),
    };
  });
  return { ...content, records: enrichedRecords };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface StageAutolearnInputOptions {
  /** Base URL of the Superfield API server. */
  apiBaseUrl: string;
  /** The (dept, customer) scope to stage. */
  scope: AutolearnScope;
  /** Short-lived delegated token for API authorisation. */
  delegatedToken: string;
  /**
   * When true the stager fetches the full ground-truth corpus for the scope
   * rather than an incremental snapshot.  Always set to true for deepclean
   * runs (PRD §4.5, issue #41).  Defaults to false (incremental, gardening).
   */
  fullGroundTruth?: boolean;
}

/**
 * Stage anonymised ground truth and wiki markdown for the autolearn pod.
 *
 * 1. Creates a new ephemeral directory under /tmp/.
 * 2. Fetches anonymised ground truth from the API and writes it as JSON.
 * 3. Fetches wiki markdown from the API and writes it as a .md file.
 * 4. Returns the staging result containing all paths.
 *
 * If either fetch or any write fails the error is propagated; no partial
 * staging directory is left behind (the caller should call `cleanupStagingDir`
 * in an error handler or rely on pod termination to wipe /tmp/).
 *
 * @throws {AutolearnFetchError}  A fetch to the API failed.
 * @throws {AutolearnParseError}  A response body could not be parsed.
 * @throws {StagingWriteError}    A file or directory could not be written.
 */
export async function stageAutolearnInput(
  options: StageAutolearnInputOptions,
): Promise<StagingResult> {
  const { apiBaseUrl, scope, delegatedToken, fullGroundTruth = false } = options;

  if (fullGroundTruth) {
    console.log(
      `[autolearn-stager] deepclean mode: fetching FULL ground truth for dept="${scope.dept}" customer="${scope.customer}"`,
    );
  }

  // 1. Create staging directory.
  const stagingDir = await createStagingDir();

  // 2. Fetch both content sources in parallel to minimise startup latency.
  //    Any failure is propagated to the caller; no retry is attempted here so
  //    the pod fails loudly and restarts fresh.
  const [groundTruth, wikiMarkdown] = await Promise.all([
    fetchGroundTruth(apiBaseUrl, scope, delegatedToken, fullGroundTruth),
    fetchWikiMarkdown(apiBaseUrl, scope, delegatedToken),
  ]);

  // 3. Write to staging directory.
  const groundTruthPath = join(stagingDir, GROUND_TRUTH_FILENAME);
  const wikiPath = join(stagingDir, WIKI_FILENAME);

  // Enrich ground truth with dialogue-formatted speaker labels (issue #59).
  const enrichedGroundTruth = formatGroundTruthForStaging(groundTruth);
  await writeStagingFile(groundTruthPath, JSON.stringify(enrichedGroundTruth, null, 2));
  await writeStagingFile(wikiPath, wikiMarkdown);

  console.log(
    `[autolearn-stager] Staged content for dept="${scope.dept}" customer="${scope.customer}" → ${stagingDir}`,
  );

  return { stagingDir, groundTruthPath, wikiPath };
}
