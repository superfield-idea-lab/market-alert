/**
 * @file email-adapter.ts — packages/integrations/src/signal-notify
 *
 * Email delivery adapter for SIGNAL_NOTIFY (issue #85).
 *
 * Sends one signal notification email via an SMTP relay (Resend in production;
 * local smtp-stub in tests). The adapter is a pure async function — no singleton,
 * no module-level state — so it is safe to call concurrently.
 *
 * ## Transport
 *
 * Uses the native `fetch` API to post to the SMTP relay's `/email` endpoint
 * (Resend-compatible API shape). This avoids a Nodemailer dependency and keeps
 * the transport testable with a real `node:http` stub.
 *
 * ## No-mock policy
 *
 * Tests start a real `node:http` server that acts as a minimal SMTP relay stub
 * and returns deterministic JSON. No `vi.fn`, `vi.mock`, or `vi.spyOn`.
 *
 * ## Canonical docs
 * - docs/prd.md §7 — outbound alerting: email adapter
 * - docs/architecture.md §"Workers" — SIGNAL_NOTIFY signal delivery worker
 *
 * @see packages/integrations/src/signal-notify/types.ts
 * @see https://github.com/superfield-idea-lab/market-alert/issues/85
 */

import type { SignalNotifyPayload, EmailAdapterConfig, SignalNotifyResult } from './types';

// ---------------------------------------------------------------------------
// Template helpers
// ---------------------------------------------------------------------------

/**
 * Renders a plain-text email body for a delivered signal.
 * Exported so the integration test can verify the content without calling
 * the full adapter.
 */
export function renderEmailBody(payload: SignalNotifyPayload): string {
  const confidencePct = (payload.confidence * 100).toFixed(1);
  return [
    `Signal alert — ${payload.ticker} (${payload.event_type})`,
    '',
    `Confidence: ${confidencePct}%`,
    `Delivered: ${payload.ts}`,
    '',
    '--- Rationale ---',
    payload.rationale || '(no rationale)',
    '',
    `Signal ID: ${payload.signal_id}`,
  ].join('\n');
}

/**
 * Renders a minimal HTML email body for a delivered signal.
 */
export function renderEmailHtml(payload: SignalNotifyPayload): string {
  const confidencePct = (payload.confidence * 100).toFixed(1);
  const rationale = (payload.rationale || '(no rationale)').replace(/\n/g, '<br>');
  return `<h2>Signal alert — ${payload.ticker} (${payload.event_type})</h2>
<p><strong>Confidence:</strong> ${confidencePct}%<br>
<strong>Delivered:</strong> ${payload.ts}</p>
<h3>Rationale</h3>
<p>${rationale}</p>
<p><small>Signal ID: ${payload.signal_id}</small></p>`;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Sends a signal notification via email.
 *
 * Posts to the SMTP relay's REST endpoint (Resend API shape):
 *   POST <smtpUrl>/emails
 *   Authorization: Bearer <apiKey>  (extracted from smtpUrl userinfo)
 *   Body: { from, to, subject, text, html }
 *
 * Returns `ok: true` when the relay returns HTTP 2xx.
 * Returns `ok: false` with `error` set on any non-2xx or network failure.
 * Never throws — the caller (SIGNAL_NOTIFY worker) handles retry via the
 * durable task queue.
 */
export async function sendEmailNotification(
  payload: SignalNotifyPayload,
  config: EmailAdapterConfig,
): Promise<SignalNotifyResult> {
  const subject = `[Superfield] Signal — ${payload.ticker} ${payload.event_type}`;
  const text = renderEmailBody(payload);
  const html = renderEmailHtml(payload);

  // Parse optional API key from smtpUrl userinfo (smtp://apikey:@host)
  let apiKey = '';
  let baseUrl = config.smtpUrl;
  try {
    const parsed = new URL(config.smtpUrl);
    apiKey = parsed.username;
    // Reconstruct base URL without credentials for the REST call
    parsed.username = '';
    parsed.password = '';
    // Point at the Resend-compatible /emails endpoint
    parsed.protocol = parsed.protocol === 'smtps:' ? 'https:' : 'http:';
    baseUrl = parsed.toString().replace(/\/$/, '');
  } catch {
    // If not a valid URL, use as-is for direct HTTP endpoint
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  try {
    const res = await fetch(`${baseUrl}/emails`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ from: config.from, to: config.to, subject, text, html }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        channel: 'email',
        ok: false,
        statusCode: res.status,
        error: `SMTP relay returned ${res.status}: ${body.slice(0, 200)}`,
      };
    }

    return { channel: 'email', ok: true, statusCode: res.status };
  } catch (err) {
    return {
      channel: 'email',
      ok: false,
      error: `Email send failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
