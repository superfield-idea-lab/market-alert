/**
 * @file tests/unit/signal-notify.test.ts
 *
 * Unit tests — SIGNAL_NOTIFY outbound adapters and task-queue integration (issue #85).
 *
 * ## What this tests
 *
 * Tests that do not require a running server, database, or external service:
 *   - Email adapter: template rendering
 *   - SMS adapter: template rendering
 *   - Webhook adapter: HMAC signature computation, real-HTTP delivery
 *   - Task queue: SIGNAL_NOTIFY idempotency key builder
 *
 * ## No mocks
 *
 * TC-5 (webhook delivery) uses a real `node:http` server. No vi.fn, vi.mock,
 * or vi.spyOn anywhere in this file.
 *
 * @see packages/integrations/src/signal-notify/
 * @see packages/db/task-queue.ts
 * @see https://github.com/superfield-idea-lab/market-alert/issues/85
 */

import { describe, test, expect, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { buildSignalNotifyIdempotencyKey } from '../../packages/db/task-queue';
import {
  renderEmailBody,
  renderEmailHtml,
} from '../../packages/integrations/src/signal-notify/email-adapter';
import { renderSmsBody } from '../../packages/integrations/src/signal-notify/sms-adapter';
import {
  computeHmacSignature,
  sendWebhookNotification,
} from '../../packages/integrations/src/signal-notify/webhook-adapter';
import type { SignalNotifyPayload } from '../../packages/integrations/src/signal-notify/types';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const SIGNAL_PAYLOAD: SignalNotifyPayload = {
  signal_id: 'sig-test-001',
  ticker: 'AAPL',
  event_type: '8-K',
  rationale: 'Apple filed an 8-K disclosing a material event relevant to the thesis.',
  confidence: 0.87,
  ts: '2026-06-04T12:00:00.000Z',
  researcher_id: 'researcher-001',
};

// ---------------------------------------------------------------------------
// Email adapter
// ---------------------------------------------------------------------------

describe('email adapter', () => {
  test('renderEmailBody produces non-empty output containing the ticker', () => {
    const body = renderEmailBody(SIGNAL_PAYLOAD);
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('AAPL');
    expect(body).toContain('8-K');
    expect(body).toContain('87.0%');
    expect(body).toContain('sig-test-001');
  });

  test('renderEmailHtml contains ticker and event_type in HTML', () => {
    const html = renderEmailHtml(SIGNAL_PAYLOAD);
    expect(html).toContain('AAPL');
    expect(html).toContain('8-K');
    expect(html).toContain('<h2>');
    expect(html).toContain('sig-test-001');
  });
});

// ---------------------------------------------------------------------------
// SMS adapter
// ---------------------------------------------------------------------------

describe('sms adapter', () => {
  test('renderSmsBody contains ticker and is under 200 chars', () => {
    const body = renderSmsBody(SIGNAL_PAYLOAD);
    expect(body).toContain('AAPL');
    expect(body).toContain('8-K');
    expect(body.length).toBeLessThan(200);
  });

  test('renderSmsBody includes the short signal id prefix', () => {
    const body = renderSmsBody(SIGNAL_PAYLOAD);
    // Signal ID prefix (first 8 chars of sig-test-001)
    expect(body).toContain('sig-test');
  });
});

// ---------------------------------------------------------------------------
// Webhook adapter
// ---------------------------------------------------------------------------

describe('webhook adapter', () => {
  test('computeHmacSignature returns a 64-char hex string', async () => {
    const sig = await computeHmacSignature('test-body', 'test-secret');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  test('computeHmacSignature is deterministic for the same inputs', async () => {
    const sig1 = await computeHmacSignature('hello', 'secret');
    const sig2 = await computeHmacSignature('hello', 'secret');
    expect(sig1).toBe(sig2);
  });

  test('computeHmacSignature differs for different body inputs', async () => {
    const sig1 = await computeHmacSignature('body-a', 'secret');
    const sig2 = await computeHmacSignature('body-b', 'secret');
    expect(sig1).not.toBe(sig2);
  });

  // Real HTTP server test — TC-5 webhook delivery
  let stubServer: Server | null = null;

  afterAll(async () => {
    if (stubServer) {
      await new Promise<void>((resolve) => stubServer!.close(() => resolve()));
      stubServer = null;
    }
  });

  test('sendWebhookNotification delivers to a real local HTTP server', async () => {
    const received: { body: string; headers: Record<string, string> }[] = [];

    stubServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        received.push({
          body: raw,
          headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise<void>((resolve) => stubServer!.listen(0, '127.0.0.1', resolve));
    const addr = stubServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const result = await sendWebhookNotification(SIGNAL_PAYLOAD, {
      url: `http://127.0.0.1:${port}/hook`,
      secret: 'test-secret',
    });

    expect(result.ok).toBe(true);
    expect(result.channel).toBe('webhook');
    expect(result.statusCode).toBe(200);
    expect(received).toHaveLength(1);

    const req0 = received[0];
    // Verify the signature header is present and well-formed
    expect(req0.headers['x-superfield-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);

    // Verify the body is valid JSON containing the signal data
    const parsed = JSON.parse(req0.body) as SignalNotifyPayload;
    expect(parsed.signal_id).toBe('sig-test-001');
    expect(parsed.ticker).toBe('AAPL');
    expect(parsed.event_type).toBe('8-K');
    expect(parsed.confidence).toBe(0.87);
  });

  test('sendWebhookNotification returns ok: false on a server error', async () => {
    const errorServer = createServer((req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Service Unavailable');
    });

    await new Promise<void>((resolve) => errorServer.listen(0, '127.0.0.1', resolve));
    const addr = errorServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const result = await sendWebhookNotification(SIGNAL_PAYLOAD, {
      url: `http://127.0.0.1:${port}/hook`,
    });

    errorServer.close();
    expect(result.ok).toBe(false);
    expect(result.channel).toBe('webhook');
    expect(result.statusCode).toBe(503);
    expect(result.error).toContain('503');
  });
});

// ---------------------------------------------------------------------------
// Task queue: SIGNAL_NOTIFY idempotency key
// ---------------------------------------------------------------------------

describe('buildSignalNotifyIdempotencyKey', () => {
  test('produces notify:<signal_id>:<channel> format', () => {
    const key = buildSignalNotifyIdempotencyKey('sig-001', 'email');
    expect(key).toBe('notify:sig-001:email');
  });

  test('different channels produce different keys for the same signal', () => {
    const emailKey = buildSignalNotifyIdempotencyKey('sig-001', 'email');
    const smsKey = buildSignalNotifyIdempotencyKey('sig-001', 'sms');
    const webhookKey = buildSignalNotifyIdempotencyKey('sig-001', 'webhook');
    expect(emailKey).not.toBe(smsKey);
    expect(emailKey).not.toBe(webhookKey);
    expect(smsKey).not.toBe(webhookKey);
  });

  test('same signal + channel always produces the same key (idempotent)', () => {
    const key1 = buildSignalNotifyIdempotencyKey('sig-001', 'email');
    const key2 = buildSignalNotifyIdempotencyKey('sig-001', 'email');
    expect(key1).toBe(key2);
  });
});
