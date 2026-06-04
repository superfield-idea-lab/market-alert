/**
 * @file signal-notify-job.ts
 *
 * SIGNAL_NOTIFY worker job — outbound multi-channel delivery (issue #85).
 *
 * ## What this file does
 *
 * Implements `executeSignalNotifyTask`, which for one delivered signal:
 *
 *   1. Fetches the signal data from GET /internal/signal-notify/signal?signal_id=<id>
 *   2. Reads the researcher's outbound channel preferences from
 *      GET /internal/signal-notify/channels?researcher_id=<id>
 *   3. Dispatches to the configured channels (email, SMS, webhook) via
 *      `packages/integrations/src/signal-notify/` adapters.
 *   4. Records delivery outcomes. Non-fatal failures are logged; the task
 *      queue retries on failure.
 *
 * ## Security
 *
 * Workers hold no database credentials (WORKER-T-001, WORKER-T-002). All reads
 * are through authenticated internal API calls using the delegated worker token.
 *
 * ## Outbound channels
 *
 * Three adapters (PRD §7, architecture §"Workers"):
 *   - `email`   — SMTP via email adapter (Resend-compatible)
 *   - `sms`     — Twilio Messages API via sms adapter
 *   - `webhook` — researcher-configured HTTPS endpoint via webhook adapter
 *
 * Channel dispatch is non-blocking: each adapter failure is logged and
 * returned as a result entry. The overall task succeeds as long as the
 * signal data was fetched; individual channel failures are retried by
 * re-enqueueing per-channel SIGNAL_NOTIFY tasks (architecture §"Workers").
 *
 * ## Watchlist scoping
 *
 * Signals are already scoped to the researcher's watchlist at creation time
 * (the signal's `researcher_id` is set by the EVENT_EVALUATE job). The notify
 * job delivers only to the researcher identified by `signal.researcher_id`.
 *
 * ## Canonical docs
 * - docs/prd.md §7 — outbound alerting: email, SMS, webhook
 * - docs/architecture.md §"Workers" — Signal delivery worker (SIGNAL_NOTIFY)
 * - packages/db/task-queue.ts — SIGNAL_NOTIFY task type + idempotency key
 * - packages/integrations/src/signal-notify/ — delivery adapters
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/85
 */

import type { TaskQueueRow } from 'db/task-queue';
import { assertNoDatabaseUrl } from './startup';
import type { SignalNotifyPayload, SignalNotifyResult } from 'integrations';
import { sendEmailNotification } from 'integrations/signal-notify/email-adapter';
import { sendSmsNotification } from 'integrations/signal-notify/sms-adapter';
import { sendWebhookNotification } from 'integrations/signal-notify/webhook-adapter';

/** The job_type constant for SIGNAL_NOTIFY tasks. */
export const SIGNAL_NOTIFY_JOB_TYPE = 'SIGNAL_NOTIFY' as const;

// ---------------------------------------------------------------------------
// Channel configuration types (returned by the server API)
// ---------------------------------------------------------------------------

/** Per-researcher outbound channel configuration. */
export interface ResearcherChannels {
  email?: {
    enabled: boolean;
    to: string;
  };
  sms?: {
    enabled: boolean;
    to: string;
  };
  webhook?: {
    enabled: boolean;
    url: string;
    secret?: string;
  };
}

// ---------------------------------------------------------------------------
// Task result
// ---------------------------------------------------------------------------

export interface SignalNotifyResult85 {
  signal_id: string;
  channels_dispatched: number;
  results: SignalNotifyResult[];
}

// ---------------------------------------------------------------------------
// Main job handler
// ---------------------------------------------------------------------------

/**
 * Executes one SIGNAL_NOTIFY task: fetches signal + channel config, dispatches
 * to all configured channels, and returns a delivery summary.
 *
 * @param task        The claimed task row from the queue.
 * @param apiBaseUrl  Base URL of the internal API server (e.g. http://localhost:3000).
 * @returns           Delivery result summary.
 */
export async function executeSignalNotifyTask(
  task: TaskQueueRow,
  apiBaseUrl: string,
): Promise<SignalNotifyResult85> {
  assertNoDatabaseUrl();

  const { signal_id, channel } = task.payload as { signal_id: string; channel?: string };

  if (!signal_id) {
    throw new Error('[signal-notify-job] Missing signal_id in task payload');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(task.delegated_token ? { Authorization: `Bearer ${task.delegated_token}` } : {}),
  };

  // ------------------------------------------------------------------
  // Step 1: Fetch signal data from the internal API.
  // ------------------------------------------------------------------
  const signalResp = await fetch(
    new URL(
      `/internal/signal-notify/signal?signal_id=${encodeURIComponent(signal_id)}`,
      apiBaseUrl,
    ).toString(),
    { headers },
  );

  if (!signalResp.ok) {
    throw new Error(
      `[signal-notify-job] Failed to fetch signal ${signal_id}: ` +
        `${signalResp.status} ${await signalResp.text().catch(() => '')}`,
    );
  }

  const signalBody = (await signalResp.json()) as { signal: SignalNotifyPayload };
  const payload = signalBody.signal;

  // ------------------------------------------------------------------
  // Step 2: Fetch researcher's outbound channel config.
  // ------------------------------------------------------------------
  const channelsResp = await fetch(
    new URL(
      `/internal/signal-notify/channels?researcher_id=${encodeURIComponent(payload.researcher_id)}`,
      apiBaseUrl,
    ).toString(),
    { headers },
  );

  let researcherChannels: ResearcherChannels = {};
  if (channelsResp.ok) {
    const channelsBody = (await channelsResp.json()) as { channels: ResearcherChannels };
    researcherChannels = channelsBody.channels;
  } else {
    console.warn(
      `[signal-notify-job] Could not fetch channel config for researcher ${payload.researcher_id}: ` +
        `${channelsResp.status}`,
    );
  }

  // ------------------------------------------------------------------
  // Step 3: Dispatch to configured channels.
  // ------------------------------------------------------------------
  const results: SignalNotifyResult[] = [];
  const smtpUrl = process.env.SMTP_URL ?? '';
  const smtpFrom = process.env.SMTP_FROM ?? 'alerts@superfield.io';
  const twilioApiBase = process.env.TWILIO_API_BASE ?? 'https://api.twilio.com';
  const twilioSid = process.env.TWILIO_ACCOUNT_SID ?? '';
  const twilioToken = process.env.TWILIO_AUTH_TOKEN ?? '';
  const twilioFrom = process.env.TWILIO_FROM ?? '';

  // Filter by channel if a specific channel is requested in the payload
  const targetChannel = channel ?? null;

  // Email
  if (
    (targetChannel === null || targetChannel === 'email') &&
    researcherChannels.email?.enabled &&
    researcherChannels.email.to &&
    smtpUrl
  ) {
    const emailResult = await sendEmailNotification(payload, {
      smtpUrl,
      from: smtpFrom,
      to: researcherChannels.email.to,
    });
    results.push(emailResult);
    if (!emailResult.ok) {
      console.warn(
        `[signal-notify-job] Email delivery failed for signal ${signal_id}: ${emailResult.error}`,
      );
    }
  }

  // SMS
  if (
    (targetChannel === null || targetChannel === 'sms') &&
    researcherChannels.sms?.enabled &&
    researcherChannels.sms.to &&
    twilioSid &&
    twilioToken
  ) {
    const smsResult = await sendSmsNotification(payload, {
      apiBaseUrl: twilioApiBase,
      accountSid: twilioSid,
      authToken: twilioToken,
      from: twilioFrom,
      to: researcherChannels.sms.to,
    });
    results.push(smsResult);
    if (!smsResult.ok) {
      console.warn(
        `[signal-notify-job] SMS delivery failed for signal ${signal_id}: ${smsResult.error}`,
      );
    }
  }

  // Webhook
  if (
    (targetChannel === null || targetChannel === 'webhook') &&
    researcherChannels.webhook?.enabled &&
    researcherChannels.webhook.url
  ) {
    const webhookResult = await sendWebhookNotification(payload, {
      url: researcherChannels.webhook.url,
      secret: researcherChannels.webhook.secret,
    });
    results.push(webhookResult);
    if (!webhookResult.ok) {
      console.warn(
        `[signal-notify-job] Webhook delivery failed for signal ${signal_id}: ${webhookResult.error}`,
      );
    }
  }

  console.log(
    `[signal-notify-job] Signal ${signal_id}: dispatched ${results.length} channel(s). ` +
      `ok=${results.filter((r) => r.ok).length}/${results.length}`,
  );

  return {
    signal_id,
    channels_dispatched: results.length,
    results,
  };
}
