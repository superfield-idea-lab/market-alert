/**
 * @file sms-adapter.ts — packages/integrations/src/signal-notify
 *
 * SMS delivery adapter for SIGNAL_NOTIFY (issue #85).
 *
 * Sends one SMS via the Twilio Messages API. The adapter is a pure async
 * function — no singleton, no module-level state — safe for concurrent use.
 *
 * ## Transport
 *
 * HTTP POST to https://api.twilio.com/2010-04-01/Accounts/<SID>/Messages.json
 * with HTTP Basic auth (accountSid:authToken) and form-encoded body.
 * `apiBaseUrl` is overridable so tests can target a real `node:http` stub.
 *
 * ## No-mock policy
 *
 * Tests start a real local HTTP server that acts as a Twilio API stub and
 * returns recorded JSON. No `vi.fn`, `vi.mock`, or `vi.spyOn`.
 *
 * ## Canonical docs
 * - docs/prd.md §7 — outbound alerting: SMS adapter
 * - docs/architecture.md §"Workers" — SIGNAL_NOTIFY signal delivery worker
 *
 * @see packages/integrations/src/signal-notify/types.ts
 * @see https://github.com/superfield-idea-lab/market-alert/issues/85
 */

import type { SignalNotifyPayload, SmsAdapterConfig, SignalNotifyResult } from './types';

// ---------------------------------------------------------------------------
// Template helper
// ---------------------------------------------------------------------------

/**
 * Renders a compact SMS body for a delivered signal.
 * Kept under 160 characters to fit one SMS segment where possible.
 * Exported so tests can verify the content independently.
 */
export function renderSmsBody(payload: SignalNotifyPayload): string {
  const confidencePct = (payload.confidence * 100).toFixed(0);
  return `[Superfield] ${payload.ticker} ${payload.event_type} — ${confidencePct}% confidence. Signal ${payload.signal_id.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Sends a signal notification via SMS (Twilio Messages API).
 *
 * POST <apiBaseUrl>/2010-04-01/Accounts/<SID>/Messages.json
 *   Authorization: Basic base64(accountSid:authToken)
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: From=<from>&To=<to>&Body=<message>
 *
 * Returns `ok: true` when Twilio returns HTTP 201.
 * Returns `ok: false` with `error` on non-2xx or network failure.
 * Never throws — the caller handles retry via the durable task queue.
 */
export async function sendSmsNotification(
  payload: SignalNotifyPayload,
  config: SmsAdapterConfig,
): Promise<SignalNotifyResult> {
  const body = renderSmsBody(payload);
  const credentials = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
  const url = `${config.apiBaseUrl}/2010-04-01/Accounts/${config.accountSid}/Messages.json`;

  const formBody = new URLSearchParams({
    From: config.from,
    To: config.to,
    Body: body,
  }).toString();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formBody,
    });

    if (!res.ok) {
      const respText = await res.text().catch(() => '');
      return {
        channel: 'sms',
        ok: false,
        statusCode: res.status,
        error: `Twilio returned ${res.status}: ${respText.slice(0, 200)}`,
      };
    }

    return { channel: 'sms', ok: true, statusCode: res.status };
  } catch (err) {
    return {
      channel: 'sms',
      ok: false,
      error: `SMS send failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
