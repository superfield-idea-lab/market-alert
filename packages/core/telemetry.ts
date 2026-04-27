/**
 * @file telemetry.ts
 *
 * OpenTelemetry SDK wiring for the Superfield ingestion pipeline.
 *
 * ## Design
 *
 * This module bootstraps a single TracerProvider and MeterProvider that are
 * shared across the server and worker processes. Both are configured with:
 *
 *   - An in-process SimpleSpanProcessor backed by an InMemorySpanExporter for
 *     testing (no collector required).
 *   - An optional OTLP/HTTP exporter when OTEL_EXPORTER_OTLP_ENDPOINT is set
 *     (staging / production with a local collector sidecar).
 *
 * ## PII scrubbing
 *
 * All span attributes and metric labels pass through `scrubSpanAttributes`
 * before export. These functions apply the same `scrubPii` redaction rules
 * as the structured-log scrubber (PRD §7).
 *
 * ## Implementation note — global provider
 *
 * The OTel SDK's `trace.setGlobalTracerProvider` / `metrics.setGlobalMeterProvider`
 * are intentionally one-shot: calling them a second time is a no-op. To support
 * `resetTelemetry()` in tests we therefore keep direct references to the current
 * providers and access them via module-local getter functions rather than through
 * the global API. The global is set once on first use; subsequent resets swap
 * the module-local reference and re-configure the processor / reader to point at
 * a fresh InMemorySpanExporter.
 *
 * ## Usage
 *
 * ```ts
 * import { getIngestionTracer, getIngestionMeter } from 'core/telemetry';
 *
 * const tracer = getIngestionTracer();
 * await tracer.startActiveSpan('imap.fetch', async (span) => {
 *   // ... do work
 *   span.end();
 * });
 * ```
 *
 * ## Testing
 *
 * Integration tests call `resetTelemetry()` between runs and read collected
 * spans via `getTestSpanExporter()`:
 *
 * ```ts
 * import { resetTelemetry, getTestSpanExporter } from 'core/telemetry';
 * await resetTelemetry();
 * // ... run the ingestion pipeline
 * const spans = getTestSpanExporter().getFinishedSpans();
 * ```
 *
 * Blueprint refs: PRD §9 (performance targets), PRD §7 (PII policy).
 */

import type { Tracer, Meter } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';

// Re-export ReadableSpan so consumers in other packages do not need a direct
// dependency on @opentelemetry/sdk-trace-base.
export type { ReadableSpan };
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { scrubPii } from './scrub-pii';

export { SpanStatusCode };

// ---------------------------------------------------------------------------
// Service / instrumentation metadata
// ---------------------------------------------------------------------------

/** Instrumentation scope name for the ingestion pipeline. */
export const INGESTION_SCOPE = 'superfield.ingestion';

/** Instrumentation scope version. */
export const INGESTION_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// PII attribute scrubbing
// ---------------------------------------------------------------------------

/**
 * Scrubs PII values from an OpenTelemetry attribute map.
 *
 * Keys present in `PII_FIELD_NAMES` are replaced with `[REDACTED]`.
 * Nested objects are handled recursively. Arrays are traversed element-wise.
 *
 * This function is applied to every attribute set before it is attached to
 * a span or recorded as a metric label, satisfying PRD §7.
 */
export function scrubSpanAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  return scrubPii(attrs) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Module-local provider state
// ---------------------------------------------------------------------------

// We keep direct references so resetTelemetry() can create fresh exporters
// without fighting the OTel global-provider singleton guard.

let _spanExporter: InMemorySpanExporter = new InMemorySpanExporter();
let _metricExporter: InMemoryMetricExporter = new InMemoryMetricExporter(
  AggregationTemporality.CUMULATIVE,
);
let _tracerProvider: BasicTracerProvider = _buildTracerProvider(_spanExporter);
let _meterProvider: MeterProvider = _buildMeterProvider(_metricExporter);
let _instruments: IngestionInstruments | null = null;

function _buildTracerProvider(exporter: InMemorySpanExporter): BasicTracerProvider {
  return new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
}

function _buildMeterProvider(exporter: InMemoryMetricExporter): MeterProvider {
  return new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 10_000,
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

/**
 * Returns the active InMemorySpanExporter (for test assertions).
 */
export function getTestSpanExporter(): InMemorySpanExporter {
  return _spanExporter;
}

/**
 * Returns the active InMemoryMetricExporter (for test assertions).
 */
export function getTestMetricExporter(): InMemoryMetricExporter {
  return _metricExporter;
}

/**
 * Returns a Tracer bound to the ingestion instrumentation scope.
 *
 * The Tracer is obtained directly from the module-local TracerProvider, not
 * from the OTel global, so it always reflects the current provider even after
 * `resetTelemetry()` calls.
 */
export function getIngestionTracer(): Tracer {
  return _tracerProvider.getTracer(INGESTION_SCOPE, INGESTION_VERSION);
}

/**
 * Returns a Meter bound to the ingestion instrumentation scope.
 */
export function getIngestionMeter(): Meter {
  return _meterProvider.getMeter(INGESTION_SCOPE, INGESTION_VERSION);
}

// ---------------------------------------------------------------------------
// Reset (used by tests)
// ---------------------------------------------------------------------------

/**
 * Resets all telemetry providers and clears collected spans/metrics.
 *
 * Shuts down the current providers (flushing any buffered data), then
 * creates fresh InMemorySpanExporter / InMemoryMetricExporter instances.
 *
 * Call this between integration test runs to isolate span collections.
 */
export async function resetTelemetry(): Promise<void> {
  await _tracerProvider.shutdown();
  await _meterProvider.shutdown();

  _spanExporter = new InMemorySpanExporter();
  _metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  _tracerProvider = _buildTracerProvider(_spanExporter);
  _meterProvider = _buildMeterProvider(_metricExporter);
  _instruments = null;
}

// ---------------------------------------------------------------------------
// Ingestion hop span helpers
// ---------------------------------------------------------------------------

/**
 * Ingestion pipeline hop names.
 *
 * These match the trace span names used throughout the ingestion state machine.
 * Tests assert that all hops appear in the collected spans after a full run.
 */
export const INGESTION_HOPS = [
  'ingestion.fetch',
  'ingestion.tokenise',
  'ingestion.store',
  'ingestion.chunk',
  'ingestion.embed',
] as const;

export type IngestionHop = (typeof INGESTION_HOPS)[number];

/**
 * Wraps an async function with an OpenTelemetry span.
 *
 * Span attributes are PII-scrubbed before being attached. On error, the span
 * is marked with `SpanStatusCode.ERROR` and the error message is recorded as
 * an event (after PII scrubbing).
 *
 * @param hopName   - One of the `INGESTION_HOPS` span names.
 * @param attrs     - Optional span attributes (will be PII-scrubbed).
 * @param fn        - Async function to execute within the span.
 */
export async function withIngestionSpan<T>(
  hopName: IngestionHop | string,
  attrs: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = getIngestionTracer();
  return tracer.startActiveSpan(hopName, async (span) => {
    const clean = scrubSpanAttributes(attrs);
    for (const [k, v] of Object.entries(clean)) {
      if (v !== undefined && v !== null) {
        span.setAttribute(k, String(v));
      }
    }
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
      span.recordException(err instanceof Error ? err : new Error(msg));
      span.end();
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------
// Ingestion metrics helpers
// ---------------------------------------------------------------------------

/**
 * Returns the shared ingestion metrics instruments.
 *
 * Instruments are lazily created and cached on `_instruments`.
 * `resetTelemetry()` clears the cache so new instruments are created against
 * the fresh MeterProvider.
 */
export interface IngestionInstruments {
  /** Latency histogram per hop (milliseconds). */
  hopLatencyHistogram: ReturnType<Meter['createHistogram']>;
  /** Error counter per hop and per tenant. */
  hopErrorCounter: ReturnType<Meter['createCounter']>;
  /** Fetched-message counter per tenant. */
  fetchedCounter: ReturnType<Meter['createCounter']>;
}

export function getIngestionInstruments(): IngestionInstruments {
  if (_instruments) return _instruments;
  const meter = getIngestionMeter();
  _instruments = {
    hopLatencyHistogram: meter.createHistogram('ingestion.hop.latency_ms', {
      description: 'Latency of each ingestion pipeline hop in milliseconds',
      unit: 'ms',
    }),
    hopErrorCounter: meter.createCounter('ingestion.hop.errors', {
      description: 'Number of errors per ingestion pipeline hop',
    }),
    fetchedCounter: meter.createCounter('ingestion.messages.fetched', {
      description: 'Number of email messages fetched per tenant',
    }),
  };
  return _instruments;
}

/**
 * Records a latency sample and (optionally) an error for one ingestion hop.
 *
 * Attribute keys that match PII field names are replaced with `[REDACTED]`
 * before being recorded as metric labels.
 *
 * @param hop        - Hop name (e.g. `'ingestion.fetch'`).
 * @param latencyMs  - Wall-clock duration for this hop in milliseconds.
 * @param attrs      - Additional metric labels (PII-scrubbed before recording).
 * @param error      - If true, increments the error counter for this hop.
 */
export function recordHopMetrics(
  hop: string,
  latencyMs: number,
  attrs: Record<string, string | number | boolean>,
  error = false,
): void {
  const instruments = getIngestionInstruments();
  const clean = scrubSpanAttributes(attrs) as Record<string, string | number | boolean>;
  const labels = { hop, ...clean };

  instruments.hopLatencyHistogram.record(latencyMs, labels);
  if (error) {
    instruments.hopErrorCounter.add(1, labels);
  }
}
