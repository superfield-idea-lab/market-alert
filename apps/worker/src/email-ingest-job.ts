/**
 * @file email-ingest-job.ts
 *
 * EMAIL_INGEST worker job handler.
 *
 * ## Job type: email_ingest
 *
 * The task is enqueued by `apps/server/src/cron/jobs/imap-etl-dispatch.ts`
 * on a configurable schedule (default: every 5 minutes). The worker claims
 * the task from the queue, connects to the configured IMAP mailbox via
 * `packages/core/imap-etl-worker.ts`, fetches new messages, and returns a
 * structured result.
 *
 * ## Two-phase model
 *
 * The core IMAP ETL worker uses a two-phase model:
 *   1. Landing — raw RFC 5322 bytes fetched from the IMAP server.
 *   2. Classify — mailparser extracts structured fields.
 *
 * The worker job handler is responsible for:
 *   - Resolving IMAP credentials from the worker credential bundle.
 *   - Calling `fetchNewMessages` with the correct `sinceUid` checkpoint.
 *   - Returning a result that includes the new checkpoint (`highestUid`) and
 *     counts of fetched / failed messages.
 *   - Propagating permanent errors so the task queue can mark the task dead
 *     without retrying.
 *
 * ## Retry behaviour
 *
 * Transient IMAP failures (network, TEMPFAIL) are surfaced as unhandled
 * errors from this handler. The task queue stale-claim recovery
 * (TQ-D-003) applies exponential backoff automatically.
 *
 * Permanent failures (auth, missing mailbox) are wrapped with
 * `permanent: true` by `fetchNewMessages` and propagated here so the
 * caller can mark the task status as 'dead' immediately.
 *
 * ## Payload shape
 *
 * ```json
 * {
 *   "mailbox_ref":  "<opaque reference to the IMAP mailbox configuration>",
 *   "since_uid":    0,
 *   "batch_size":   50
 * }
 * ```
 *
 * Only opaque identifiers and scalar parameters are permitted in the payload
 * (TQ-P-002). Credentials are never stored in the task queue row.
 *
 * ## Result shape
 *
 * ```json
 * {
 *   "status":        "completed",
 *   "fetched_count": 12,
 *   "failed_uids":   [],
 *   "highest_uid":   1042,
 *   "mailbox_ref":   "<echoed from payload>"
 * }
 * ```
 *
 * Blueprint refs: WORKER domain, TQ-D-001, TQ-P-002, PRD §6.
 */

import { fetchNewMessages } from 'core/imap-etl-worker';
import type { ImapConnectionConfig, LandedMessage } from 'core/imap-etl-worker';
import { getIngestionInstruments, recordHopMetrics } from 'core/telemetry';

/** The job_type string for the EMAIL_INGEST task type. */
export const EMAIL_INGEST_JOB_TYPE = 'email_ingest' as const;

/**
 * Environment variable names for IMAP credentials.
 *
 * In production these are injected by the Kubernetes secret mount.
 * In integration tests they are set to point at the Greenmail container.
 */
export const IMAP_ENV = {
  HOST: 'IMAP_HOST',
  PORT: 'IMAP_PORT',
  SECURE: 'IMAP_SECURE',
  USER: 'IMAP_USER',
  PASSWORD: 'IMAP_PASSWORD',
  TLS_REJECT_UNAUTHORIZED: 'IMAP_TLS_REJECT_UNAUTHORIZED',
} as const;

/**
 * Payload shape for the `email_ingest` job type.
 *
 * Only scalar parameters and opaque identifiers are permitted (TQ-P-002).
 */
export interface EmailIngestPayload {
  /** Opaque reference to the IMAP mailbox configuration (for correlation). */
  mailbox_ref: string;
  /**
   * Fetch messages with UIDs strictly greater than this value.
   * Defaults to 0 (fetch from the beginning).
   */
  since_uid?: number;
  /**
   * Maximum messages to fetch per run. Defaults to 50.
   */
  batch_size?: number;
}

/**
 * Result shape for the `email_ingest` job type.
 */
export interface EmailIngestResult {
  /** Execution status. */
  status: 'completed' | 'failed';
  /** Number of messages successfully fetched and classified. */
  fetched_count: number;
  /**
   * UIDs that failed to parse (permanent failures). The cron dispatcher
   * records these in the next task payload so they can be surfaced in
   * observability tooling.
   */
  failed_uids: number[];
  /**
   * The highest UID seen in this fetch. The cron dispatcher should persist
   * this and pass it as `since_uid` in the next task.
   */
  highest_uid: number;
  /** Echoed from payload for correlation. */
  mailbox_ref: string;
  /** Whether this is a permanent failure (auth, missing mailbox). */
  permanent?: boolean;
  /** Error message, present only when status='failed'. */
  error?: string;
  /** Additional fields forwarded as-is. */
  [key: string]: unknown;
}

/**
 * Resolve IMAP connection configuration from environment variables.
 *
 * Throws if any required variable is missing. The worker process exits on
 * startup if this throws (WORKER-C-002 pattern).
 */
export function resolveImapConfig(env: NodeJS.ProcessEnv): ImapConnectionConfig {
  const host = env[IMAP_ENV.HOST];
  const portStr = env[IMAP_ENV.PORT];
  const user = env[IMAP_ENV.USER];
  const password = env[IMAP_ENV.PASSWORD];

  if (!host) throw new Error(`Missing required environment variable: ${IMAP_ENV.HOST}`);
  if (!portStr) throw new Error(`Missing required environment variable: ${IMAP_ENV.PORT}`);
  if (!user) throw new Error(`Missing required environment variable: ${IMAP_ENV.USER}`);
  if (!password) throw new Error(`Missing required environment variable: ${IMAP_ENV.PASSWORD}`);

  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`${IMAP_ENV.PORT} must be a valid port number (1–65535), got: ${portStr}`);
  }

  const secure = env[IMAP_ENV.SECURE] !== 'false';

  // Allow TLS rejection to be disabled for integration tests against local
  // Greenmail containers that use self-signed certificates.
  const tlsRejectUnauthorized = env[IMAP_ENV.TLS_REJECT_UNAUTHORIZED] !== 'false';

  return { host, port, secure, user, password, tlsRejectUnauthorized };
}

/**
 * Build the task payload for an `email_ingest` task row.
 */
export function buildEmailIngestPayload(
  mailboxRef: string,
  sinceUid = 0,
  batchSize = 50,
): EmailIngestPayload {
  return {
    mailbox_ref: mailboxRef,
    since_uid: sinceUid,
    batch_size: batchSize,
  };
}

/**
 * Validate that a raw task result object conforms to the EmailIngestResult shape.
 *
 * Throws if required fields are absent or malformed.
 */
export function validateEmailIngestResult(raw: Record<string, unknown>): EmailIngestResult {
  if (typeof raw['fetched_count'] !== 'number') {
    throw new Error(
      `email_ingest result missing required "fetched_count" number. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  if (!Array.isArray(raw['failed_uids'])) {
    throw new Error(
      `email_ingest result missing required "failed_uids" array. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  if (typeof raw['highest_uid'] !== 'number') {
    throw new Error(
      `email_ingest result missing required "highest_uid" number. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  if (typeof raw['mailbox_ref'] !== 'string') {
    throw new Error(
      `email_ingest result missing required "mailbox_ref" string. Got: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  return raw as EmailIngestResult;
}

/**
 * Execute an `email_ingest` task.
 *
 * This is the primary entry point called by the worker runner when a task
 * with `job_type === EMAIL_INGEST_JOB_TYPE` is claimed.
 *
 * The caller is responsible for:
 *   - Passing the raw task payload (validated by `validateEmailIngestPayload`).
 *   - Handling the returned result (submit via API, update task status).
 *   - Treating a thrown error as a transient failure (stale-claim recovery
 *     will retry with backoff).
 *   - Treating a result with `permanent: true` as a permanent failure (mark
 *     task dead immediately without retrying).
 *
 * NOTE: This handler returns a result even for permanent failures so the
 * caller can record the failure reason before marking the task dead.
 * Only transient errors (network, TEMPFAIL) are thrown.
 *
 * @param payload  - The task payload from the task queue row.
 * @param env      - Process environment (injected for testability).
 */
export async function executeEmailIngestTask(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EmailIngestResult> {
  const mailboxRef =
    typeof payload['mailbox_ref'] === 'string' ? payload['mailbox_ref'] : 'default';
  const sinceUid = typeof payload['since_uid'] === 'number' ? payload['since_uid'] : 0;
  const batchSize = typeof payload['batch_size'] === 'number' ? payload['batch_size'] : 50;

  const config = resolveImapConfig(env);
  const instruments = getIngestionInstruments();
  const taskStart = Date.now();

  try {
    const result = await fetchNewMessages(config, {
      sinceUid,
      batchSize,
      mailbox: 'INBOX',
    });

    // Record the number of fetched messages (using mailbox_ref as a tenant-safe label).
    instruments.fetchedCounter.add(result.messages.length, {
      mailbox_ref: mailboxRef,
    });

    recordHopMetrics('ingestion.task', Date.now() - taskStart, { mailbox_ref: mailboxRef }, false);

    return {
      status: 'completed',
      fetched_count: result.messages.length,
      failed_uids: result.failedUids,
      highest_uid: result.highestUid,
      mailbox_ref: mailboxRef,
    };
  } catch (err) {
    const isPermanent =
      err instanceof Error && (err as Error & { permanent?: boolean }).permanent === true;

    if (isPermanent) {
      // Record error metric for permanent failures.
      recordHopMetrics('ingestion.task', Date.now() - taskStart, { mailbox_ref: mailboxRef }, true);

      // Return a permanent-failure result so the caller can mark task dead.
      return {
        status: 'failed',
        fetched_count: 0,
        failed_uids: [],
        highest_uid: sinceUid,
        mailbox_ref: mailboxRef,
        permanent: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Record error metric for transient failures too.
    recordHopMetrics('ingestion.task', Date.now() - taskStart, { mailbox_ref: mailboxRef }, true);

    // Transient error — rethrow so stale-claim recovery applies backoff.
    throw err;
  }
}

/**
 * Hook called by the worker runner after a successful `email_ingest` task.
 *
 * Currently a no-op placeholder. In follow-on issues this will:
 *   - Pass landed messages through the PII tokeniser (issue #27).
 *   - Write the `Email` entity via `POST /internal/ingestion/email` (issue #28).
 *   - Persist the `highestUid` checkpoint so the next cron dispatch picks up
 *     where this run left off.
 *
 * @param messages   - Messages returned by `fetchNewMessages`.
 * @param result     - The task result to be submitted.
 */
export async function onEmailsLanded(
  _messages: LandedMessage[],
  _result: EmailIngestResult,
): Promise<void> {
  // TODO(issue #27): pass messages through PII tokeniser.
  // TODO(issue #28): write Email entity via POST /internal/ingestion/email.
  // TODO: persist result.highest_uid as the next sinceUid checkpoint.
}
