/**
 * @file types.ts — packages/integrations/src/signal-notify
 *
 * Shared types for the SIGNAL_NOTIFY outbound delivery adapters (issue #85).
 *
 * ## Canonical docs
 * - docs/prd.md §4, §7 — outbound multi-channel delivery
 * - docs/architecture.md §"Workers" — Signal delivery worker (SIGNAL_NOTIFY)
 * - packages/db/task-queue.ts — SIGNAL_NOTIFY task type
 *
 * ## Channels
 *
 * Three adapters are specified (PRD §7):
 *   - `email`   — SMTP (Nodemailer-compatible transport; Resend in production)
 *   - `sms`     — HTTP (Twilio Messages API; mock-safe via real HTTP stub)
 *   - `webhook` — HTTP POST to researcher-configured URL
 *
 * Each adapter is a pure function: given a `SignalNotifyPayload` and channel-
 * specific config, it posts the delivery and returns `SignalNotifyResult`.
 *
 * ## No-mock policy
 *
 * Tests use real `node:http` servers for local endpoints (webhook adapter),
 * and recorded JSON fixtures for SMTP and Twilio responses (see
 * tests/fixtures/signal-notify/).
 *
 * @see packages/integrations/src/signal-notify/email-adapter.ts
 * @see packages/integrations/src/signal-notify/sms-adapter.ts
 * @see packages/integrations/src/signal-notify/webhook-adapter.ts
 * @see https://github.com/superfield-idea-lab/market-alert/issues/85
 */

// ---------------------------------------------------------------------------
// Shared payload
// ---------------------------------------------------------------------------

/**
 * Signal data passed to all outbound delivery adapters.
 *
 * Populated by the SIGNAL_NOTIFY worker from the GET /internal/signal-notify/signal
 * API endpoint. No PII fields — only structured signal metadata.
 */
export interface SignalNotifyPayload {
  /** UUID of the delivered signal. */
  signal_id: string;
  /** Watchlist ticker symbol (e.g. "AAPL"). */
  ticker: string;
  /** Event type derived from the market event (e.g. "8-K"). */
  event_type: string;
  /** Structured markdown rationale from the event-evaluator. */
  rationale: string;
  /** Composite confidence score (source_trust × extraction_certainty). */
  confidence: number;
  /** ISO-8601 timestamp when the signal reached Delivered state. */
  ts: string;
  /** UUID of the researcher receiving this notification. */
  researcher_id: string;
}

// ---------------------------------------------------------------------------
// Per-channel config
// ---------------------------------------------------------------------------

/**
 * Configuration for the email delivery adapter.
 *
 * In production, `smtpUrl` is sourced from SMTP_URL (AWS Secrets Manager).
 * In TEST_MODE, the adapter targets a local SMTP stub server.
 */
export interface EmailAdapterConfig {
  /** SMTP connection URL, e.g. smtp://user:pass@host:587 */
  smtpUrl: string;
  /** Sender address, e.g. "alerts@superfield.io" */
  from: string;
  /** Recipient email address for this researcher. */
  to: string;
}

/**
 * Configuration for the SMS delivery adapter.
 *
 * In production, credentials are sourced from TWILIO_ACCOUNT_SID and
 * TWILIO_AUTH_TOKEN (AWS Secrets Manager). In TEST_MODE, the adapter
 * targets a local HTTP stub server.
 */
export interface SmsAdapterConfig {
  /** Base URL for the Twilio Messages API (override for test stubs). */
  apiBaseUrl: string;
  /** Twilio account SID. */
  accountSid: string;
  /** Twilio auth token. */
  authToken: string;
  /** Twilio source phone number. */
  from: string;
  /** Researcher destination phone number. */
  to: string;
}

/**
 * Configuration for the webhook delivery adapter.
 *
 * The webhook URL is the researcher-configured endpoint. The adapter sends
 * a JSON POST with the `SignalNotifyPayload` as the body.
 */
export interface WebhookAdapterConfig {
  /** Researcher-configured HTTPS endpoint URL. */
  url: string;
  /** Optional HMAC-SHA256 secret for request signing (X-Superfield-Signature header). */
  secret?: string;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Outcome of one outbound delivery attempt.
 */
export interface SignalNotifyResult {
  /** The channel that was attempted. */
  channel: 'email' | 'sms' | 'webhook';
  /** True if the delivery was accepted by the downstream channel. */
  ok: boolean;
  /** HTTP status code or transport error code. */
  statusCode?: number;
  /** Error message, present only when ok is false. */
  error?: string;
}
