/**
 * @file webhook-adapter.ts — packages/integrations/src/signal-notify
 *
 * Webhook delivery adapter for SIGNAL_NOTIFY (issue #85).
 *
 * POSTs the signal payload as JSON to the researcher-configured webhook URL.
 * Optionally signs the request body with HMAC-SHA256 (X-Superfield-Signature header)
 * if a `secret` is configured.
 *
 * ## Transport
 *
 * HTTP POST to `config.url` with body `SignalNotifyPayload` serialised as JSON.
 * Request signing uses Web Crypto API (SubtleCrypto) — no native Node dependency.
 *
 * ## No-mock policy
 *
 * Tests start a real `node:http` server that records received requests and
 * returns 200 OK. No `vi.fn`, `vi.mock`, or `vi.spyOn`.
 *
 * ## Canonical docs
 * - docs/prd.md §7 — outbound alerting: webhook adapter
 * - docs/architecture.md §"Workers" — SIGNAL_NOTIFY signal delivery worker
 *
 * @see packages/integrations/src/signal-notify/types.ts
 * @see https://github.com/superfield-idea-lab/market-alert/issues/85
 */

import type { SignalNotifyPayload, WebhookAdapterConfig, SignalNotifyResult } from './types';

// ---------------------------------------------------------------------------
// HMAC signing
// ---------------------------------------------------------------------------

/**
 * Computes HMAC-SHA256 of `body` using `secret` and returns the hex digest.
 * Uses the Web Crypto API (available in Bun and browsers).
 * Exported for independent test verification.
 */
export async function computeHmacSignature(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(body);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Delivers a signal notification to a researcher-configured webhook endpoint.
 *
 * POST <config.url>
 *   Content-Type: application/json
 *   X-Superfield-Signature: sha256=<hmac>  (only when config.secret is set)
 *   Body: SignalNotifyPayload (JSON)
 *
 * Returns `ok: true` when the endpoint returns HTTP 2xx.
 * Returns `ok: false` with `error` on non-2xx or network failure.
 * Never throws — the caller handles retry via the durable task queue.
 */
export async function sendWebhookNotification(
  payload: SignalNotifyPayload,
  config: WebhookAdapterConfig,
): Promise<SignalNotifyResult> {
  const bodyJson = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Superfield-Signal-Notify/1.0',
  };

  if (config.secret) {
    const sig = await computeHmacSignature(bodyJson, config.secret);
    headers['X-Superfield-Signature'] = `sha256=${sig}`;
  }

  try {
    const res = await fetch(config.url, {
      method: 'POST',
      headers,
      body: bodyJson,
    });

    if (!res.ok) {
      const respText = await res.text().catch(() => '');
      return {
        channel: 'webhook',
        ok: false,
        statusCode: res.status,
        error: `Webhook endpoint returned ${res.status}: ${respText.slice(0, 200)}`,
      };
    }

    return { channel: 'webhook', ok: true, statusCode: res.status };
  } catch (err) {
    return {
      channel: 'webhook',
      ok: false,
      error: `Webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
