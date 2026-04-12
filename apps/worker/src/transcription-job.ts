/**
 * @file transcription-job.ts
 *
 * Cluster-internal transcription worker job type — "transcription".
 *
 * ## Job type: transcription
 *
 * Handles transcription of long audio recordings that exceed the configured
 * threshold (default: 10 minutes).  The worker runs in a distroless container
 * with a Kubernetes NetworkPolicy that blocks all external egress — audio data
 * stays within the cluster trust boundary.
 *
 * The transcription worker receives an opaque `recording_ref` identifying the
 * audio upload, calls the transcription CLI binary (or its dev stub), and
 * POSTs the transcript to the API via the same delegated-token path used by all
 * other worker job types.
 *
 * ### Routing threshold
 *
 * The PWA recording flow checks the recording duration against
 * `TRANSCRIPTION_WORKER_THRESHOLD_SECONDS` (default: 600 = 10 min).
 * Recordings at or above the threshold are routed to this worker path.
 * Shorter recordings use the edge (direct) transcription path.
 *
 * ### Payload shape
 *
 * ```json
 * {
 *   "recording_ref":  "<opaque reference to the uploaded audio blob>",
 *   "duration_ref":   "<optional opaque reference to duration metadata>",
 *   "correlation_ref": "<optional opaque correlation tag for tracing>"
 * }
 * ```
 *
 * Payloads must contain only opaque identifiers (TQ-P-002).  Raw audio
 * bytes, filenames, or PII must never appear in the queue row.
 *
 * ### Result shape
 *
 * ```json
 * {
 *   "transcript":    "<transcribed text>",
 *   "recording_ref": "<echoed from payload>",
 *   "status":        "completed",
 *   "duration_ms":   1234
 * }
 * ```
 *
 * Blueprint reference: WORKER domain — cluster-internal transcription worker
 */

/** The job_type string identifying a long-recording transcription task. */
export const TRANSCRIPTION_JOB_TYPE = 'transcription' as const;

/** The agent_type for the transcription worker. */
export const TRANSCRIPTION_AGENT_TYPE = 'transcription' as const;

/**
 * Default threshold in seconds above which recordings are routed to the
 * cluster-internal worker path rather than the edge path.
 */
export const TRANSCRIPTION_WORKER_THRESHOLD_SECONDS = 600; // 10 minutes

/**
 * Hard timeout for transcription tasks.
 * Long recordings may take significant time to transcribe; cap at 30 minutes.
 */
export const TRANSCRIPTION_TIMEOUT_MS = 30 * 60 * 1_000;

/**
 * Payload shape for the `transcription` job type.
 *
 * Only opaque identifiers are permitted (TQ-P-002). Workers fetch data
 * through the API at execution time; the queue row must never carry raw content.
 */
export interface TranscriptionPayload {
  /** Opaque reference to the uploaded audio blob. Required. */
  recording_ref: string;
  /** Opaque reference to duration metadata. */
  duration_ref?: string;
  /** Opaque correlation tag for tracing. */
  correlation_ref?: string;
}

/**
 * Expected result shape returned by the transcription CLI for `transcription` tasks.
 */
export interface TranscriptionResult {
  /** The transcribed text from the audio recording. */
  transcript: string;
  /** Echoed recording reference from the payload. */
  recording_ref: string;
  /** Execution status. */
  status?: 'completed' | 'failed';
  /** Transcription wall-clock time in milliseconds. */
  duration_ms?: number;
  /** Whether the result was produced by the dev stub (local dev only). */
  stub?: boolean;
  /** Additional vendor-specific fields forwarded as-is. */
  [key: string]: unknown;
}

/**
 * Build the stdin payload sent to the transcription CLI for a `transcription` task.
 *
 * The task's `id`, `job_type`, `agent_type`, and `payload` fields are merged
 * into a single object so the CLI binary has all context it needs.
 */
export function buildTranscriptionCliPayload(
  taskId: string,
  agentType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: taskId,
    job_type: TRANSCRIPTION_JOB_TYPE,
    agent_type: agentType,
    ...payload,
  };
}

/**
 * Validate that a raw CLI result object conforms to the expected shape.
 *
 * Throws if the result is missing the required `transcript` string field or
 * the `recording_ref` echo field.
 */
export function validateTranscriptionResult(raw: Record<string, unknown>): TranscriptionResult {
  if (typeof raw['transcript'] !== 'string') {
    throw new Error(
      `Transcription CLI result is missing required "transcript" string field. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  if (typeof raw['recording_ref'] !== 'string') {
    throw new Error(
      `Transcription CLI result is missing required "recording_ref" string field. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  return raw as TranscriptionResult;
}
