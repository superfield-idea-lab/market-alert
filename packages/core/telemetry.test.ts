/**
 * @file telemetry.test.ts
 *
 * Unit tests for the OpenTelemetry telemetry module (issue #90).
 *
 * Tests the pure-function helpers (scrubSpanAttributes, withIngestionSpan,
 * recordHopMetrics) plus provider initialisation and reset semantics.
 *
 * No mocks. No vi.fn / vi.mock / vi.spyOn / vi.stubGlobal.
 * Uses real OTel SDK InMemorySpanExporter / InMemoryMetricExporter.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  scrubSpanAttributes,
  withIngestionSpan,
  recordHopMetrics,
  getIngestionTracer,
  getIngestionMeter,
  getTestSpanExporter,
  getTestMetricExporter,
  getIngestionInstruments,
  resetTelemetry,
  INGESTION_HOPS,
  INGESTION_SCOPE,
  INGESTION_VERSION,
} from './telemetry';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

beforeEach(async () => {
  await resetTelemetry();
});

// ---------------------------------------------------------------------------
// scrubSpanAttributes
// ---------------------------------------------------------------------------

describe('scrubSpanAttributes', () => {
  test('returns safe attributes unchanged', () => {
    const attrs = {
      'imap.host': 'imap.example.com',
      'batch.message_count': 5,
      hop: 'ingestion.fetch',
    };
    const result = scrubSpanAttributes(attrs);
    expect(result).toEqual(attrs);
  });

  test('redacts email PII field', () => {
    const result = scrubSpanAttributes({ email: 'alice@example.com', hop: 'ingestion.fetch' });
    expect(result['email']).toBe('[REDACTED]');
    expect(result['hop']).toBe('ingestion.fetch');
  });

  test('redacts password PII field', () => {
    const result = scrubSpanAttributes({ password: 'hunter2', host: 'imap.example.com' });
    expect(result['password']).toBe('[REDACTED]');
    expect(result['host']).toBe('imap.example.com');
  });

  test('redacts subject PII field', () => {
    const result = scrubSpanAttributes({ subject: 'Secret agenda' });
    expect(result['subject']).toBe('[REDACTED]');
  });

  test('redacts multiple PII fields in one call', () => {
    const result = scrubSpanAttributes({
      email: 'bob@example.com',
      password: 'p4ss',
      subject: 'Classified',
      'imap.host': 'imap.example.com',
    });
    expect(result['email']).toBe('[REDACTED]');
    expect(result['password']).toBe('[REDACTED]');
    expect(result['subject']).toBe('[REDACTED]');
    expect(result['imap.host']).toBe('imap.example.com');
  });

  test('handles empty attribute map', () => {
    expect(scrubSpanAttributes({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// withIngestionSpan
// ---------------------------------------------------------------------------

describe('withIngestionSpan', () => {
  test('creates a finished span with the given name', async () => {
    await withIngestionSpan('ingestion.fetch', { 'imap.mailbox': 'INBOX' }, async () => {});
    const spans = getTestSpanExporter().getFinishedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0].name).toBe('ingestion.fetch');
  });

  test('span status is OK on successful execution', async () => {
    await withIngestionSpan('ingestion.chunk', {}, async () => {});
    const spans = getTestSpanExporter().getFinishedSpans();
    expect(spans[0].status.code).toBe(1); // SpanStatusCode.OK
  });

  test('span status is ERROR when fn throws', async () => {
    await expect(
      withIngestionSpan('ingestion.embed', {}, async () => {
        throw new Error('embed failed');
      }),
    ).rejects.toThrow('embed failed');

    const spans = getTestSpanExporter().getFinishedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0].status.code).toBe(2); // SpanStatusCode.ERROR
    expect(spans[0].status.message).toBe('embed failed');
  });

  test('re-throws the original error', async () => {
    const originalErr = new Error('my specific error');
    await expect(
      withIngestionSpan('ingestion.tokenise', {}, async () => {
        throw originalErr;
      }),
    ).rejects.toThrow('my specific error');
  });

  test('PII attributes are scrubbed from the span', async () => {
    await withIngestionSpan(
      'ingestion.store',
      { email: 'pii@example.com', 'message.uid': 42 },
      async () => {},
    );
    const spans = getTestSpanExporter().getFinishedSpans();
    expect(spans[0].attributes['email']).toBe('[REDACTED]');
    expect(spans[0].attributes['message.uid']).toBe('42');
  });

  test('returns the result of fn', async () => {
    const val = await withIngestionSpan('ingestion.fetch', {}, async () => 'done');
    expect(val).toBe('done');
  });

  test('multiple calls accumulate spans', async () => {
    await withIngestionSpan('ingestion.fetch', {}, async () => {});
    await withIngestionSpan('ingestion.tokenise', {}, async () => {});
    await withIngestionSpan('ingestion.chunk', {}, async () => {});

    const spans = getTestSpanExporter().getFinishedSpans();
    const names = spans.map((s: ReadableSpan) => s.name);
    expect(names).toContain('ingestion.fetch');
    expect(names).toContain('ingestion.tokenise');
    expect(names).toContain('ingestion.chunk');
  });
});

// ---------------------------------------------------------------------------
// recordHopMetrics
// ---------------------------------------------------------------------------

describe('recordHopMetrics', () => {
  test('does not throw on a successful hop', () => {
    expect(() => recordHopMetrics('ingestion.fetch', 42, {}, false)).not.toThrow();
  });

  test('does not throw on an error hop', () => {
    expect(() => recordHopMetrics('ingestion.fetch', 42, {}, true)).not.toThrow();
  });

  test('accepts arbitrary attributes', () => {
    expect(() =>
      recordHopMetrics('ingestion.chunk', 100, { tenant: 'abc', batch_size: 10 }, false),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Provider initialisation
// ---------------------------------------------------------------------------

describe('provider initialisation', () => {
  test('getIngestionTracer returns a Tracer', () => {
    const tracer = getIngestionTracer();
    expect(tracer).toBeDefined();
    expect(typeof tracer.startActiveSpan).toBe('function');
  });

  test('getIngestionMeter returns a Meter', () => {
    const meter = getIngestionMeter();
    expect(meter).toBeDefined();
    expect(typeof meter.createHistogram).toBe('function');
    expect(typeof meter.createCounter).toBe('function');
  });

  test('getIngestionInstruments returns all three instruments', () => {
    const instruments = getIngestionInstruments();
    expect(instruments.hopLatencyHistogram).toBeDefined();
    expect(instruments.hopErrorCounter).toBeDefined();
    expect(instruments.fetchedCounter).toBeDefined();
  });

  test('getTestSpanExporter returns an exporter with getFinishedSpans()', () => {
    const exporter = getTestSpanExporter();
    expect(typeof exporter.getFinishedSpans).toBe('function');
    expect(Array.isArray(exporter.getFinishedSpans())).toBe(true);
  });

  test('getTestMetricExporter returns an exporter', () => {
    const exporter = getTestMetricExporter();
    expect(exporter).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// resetTelemetry
// ---------------------------------------------------------------------------

describe('resetTelemetry', () => {
  test('clears collected spans between resets', async () => {
    await withIngestionSpan('ingestion.fetch', {}, async () => {});
    expect(getTestSpanExporter().getFinishedSpans().length).toBeGreaterThan(0);

    await resetTelemetry();
    expect(getTestSpanExporter().getFinishedSpans().length).toBe(0);
  });

  test('new spans are collected after reset', async () => {
    await resetTelemetry();
    await withIngestionSpan('ingestion.embed', {}, async () => {});
    const spans = getTestSpanExporter().getFinishedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0].name).toBe('ingestion.embed');
  });
});

// ---------------------------------------------------------------------------
// INGESTION_HOPS constant
// ---------------------------------------------------------------------------

describe('INGESTION_HOPS', () => {
  test('contains all five hop names', () => {
    expect(INGESTION_HOPS).toContain('ingestion.fetch');
    expect(INGESTION_HOPS).toContain('ingestion.tokenise');
    expect(INGESTION_HOPS).toContain('ingestion.store');
    expect(INGESTION_HOPS).toContain('ingestion.chunk');
    expect(INGESTION_HOPS).toContain('ingestion.embed');
  });

  test('has exactly 5 entries', () => {
    expect(INGESTION_HOPS.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Scope constants
// ---------------------------------------------------------------------------

describe('scope constants', () => {
  test('INGESTION_SCOPE is calypso.ingestion', () => {
    expect(INGESTION_SCOPE).toBe('calypso.ingestion');
  });

  test('INGESTION_VERSION is 1.0.0', () => {
    expect(INGESTION_VERSION).toBe('1.0.0');
  });
});
