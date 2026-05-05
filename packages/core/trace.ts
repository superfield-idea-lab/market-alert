/**
 * Trace ID propagation utilities.
 *
 * Browser: tracedFetch() generates one UUID per page load (the session trace
 * ID) and includes it as `X-Trace-Id: <session>-<index>` on every request.
 * Each request within the same page load shares a common prefix so server
 * logs can be correlated across concurrent requests while remaining distinct.
 *
 * Server: extractTraceId() reads the header from incoming requests and
 * generates a fresh UUID when the header is absent.
 */

/** Unique trace prefix for the current page load. */
let _sessionTraceId: string | null = null;
/** Monotonically-increasing request counter within the current page load. */
let _requestIndex = 0;

/**
 * Returns the session-level trace ID for the current page load.
 * Generates a new UUID on first call.
 */
export function getSessionTraceId(): string {
  if (_sessionTraceId === null) {
    _sessionTraceId = crypto.randomUUID();
  }
  return _sessionTraceId;
}

/**
 * Returns a per-request trace ID composed of the session prefix and a
 * monotonically-increasing index: `<session-uuid>-<n>`.
 *
 * Each call returns a fresh, unique ID so concurrent requests are
 * distinguishable while the shared prefix links them to the same page load.
 */
export function nextRequestTraceId(): string {
  const idx = ++_requestIndex;
  return `${getSessionTraceId()}-${idx}`;
}

/**
 * A `fetch` wrapper that attaches `X-Trace-Id` to every request.
 *
 * Usage: drop-in replacement for the global `fetch`.
 *
 * ```ts
 * import { tracedFetch } from 'core/trace';
 * const res = await tracedFetch('/api/tasks', { credentials: 'include' });
 * ```
 */
export async function tracedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const traceId = nextRequestTraceId();
  const headers = new Headers(init?.headers);
  headers.set('X-Trace-Id', traceId);
  return fetch(input, { ...init, headers });
}

/**
 * Extracts the trace ID from an incoming HTTP request.
 *
 * Resolution order:
 *   1. `traceparent` header (W3C Trace Context) — the trace-id segment is extracted.
 *   2. `X-Trace-Id` header — used as-is for backward compatibility.
 *   3. Fresh UUID generated when neither header is present.
 *
 * If the `X-Trace-Id` header is absent, a fresh UUID is generated so every
 * request is always traceable, even those originating outside the browser.
 */
export function extractTraceId(req: Request): string {
  const traceparent = req.headers.get('traceparent');
  if (traceparent) {
    const extracted = extractTraceIdFromTraceparent(traceparent);
    if (extracted) return extracted;
  }
  return req.headers.get('X-Trace-Id') ?? crypto.randomUUID();
}

/**
 * Parses a W3C `traceparent` header value and returns the trace-id segment.
 *
 * Format: `{version}-{trace-id}-{parent-id}-{trace-flags}`
 * Example: `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`
 *
 * Returns `null` if the header is malformed.
 */
export function extractTraceIdFromTraceparent(traceparent: string): string | null {
  const parts = traceparent.split('-');
  // Must have at least 4 dash-separated segments.
  if (parts.length < 4) return null;
  const traceId = parts[1];
  // Trace-id must be 32 lowercase hex characters and must not be all zeros.
  if (!/^[0-9a-f]{32}$/.test(traceId) || traceId === '0'.repeat(32)) return null;
  return traceId;
}

/**
 * Formats a trace ID as a W3C `traceparent` header value.
 *
 * The trace ID is padded/truncated to 32 hex chars (required by the spec).
 * A deterministic parent-id (zeros + "0001") is used when no span ID is supplied.
 * Sampled flag is always set to `01`.
 *
 * @param traceId  - Hex or UUID-format trace ID.
 * @param spanId   - Optional 16-char hex span ID. Defaults to `"0000000000000001"`.
 */
export function formatTraceparent(traceId: string, spanId = '0000000000000001'): string {
  // Normalise: strip hyphens (UUID format) and lowercase.
  const hex = traceId.replace(/-/g, '').toLowerCase().padEnd(32, '0').slice(0, 32);
  const sid = spanId.replace(/-/g, '').toLowerCase().padEnd(16, '0').slice(0, 16);
  return `00-${hex}-${sid}-01`;
}

/**
 * Returns a `fetch` wrapper bound to a specific trace ID.
 *
 * Intended for server-side use where the trace ID for the current request is
 * already known and should be propagated to every outbound HTTP call made
 * during that request's lifetime.
 *
 * ```ts
 * const tracedFetch = makeTracedFetch(traceId);
 * const res = await tracedFetch('https://internal-service/api', { method: 'GET' });
 * ```
 */
export function makeTracedFetch(
  traceId: string,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set('X-Trace-Id', traceId);
    return fetch(input, { ...init, headers });
  };
}

/**
 * Builds a structured log entry that always includes `trace_id`.
 *
 * @example
 * console.log(JSON.stringify(traceLog('info', traceId, { method: 'GET', path: '/api/tasks' })));
 */
export function traceLog(
  level: 'info' | 'warn' | 'error',
  traceId: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    level,
    ...fields,
    // trace_id is placed last so caller-supplied fields cannot shadow it.
    trace_id: traceId,
  };
}
