/**
 * @file client-errors.ts
 *
 * POST /api/v1/client-errors
 *
 * Accepts a browser error payload forwarded from the web app and logs it with
 * the trace_id carried in the request (or the browser-supplied trace_id in the
 * payload body).
 *
 * The endpoint is unauthenticated — browser error events fire before and after
 * authentication, and requiring a session would silently drop pre-login errors.
 * Rate-limiting at the CDN / load-balancer layer is relied upon for abuse
 * mitigation.
 *
 * Blueprint ref: issue #9 acceptance criterion 5.
 */

import { log } from 'core';
import { extractTraceId } from 'core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowserErrorPayload {
  /** Error message string from the browser's Error.message. */
  message: string;
  /** Error stack trace (optional — may be absent in prod/minified bundles). */
  stack?: string;
  /** Browser-supplied trace ID (e.g. from tracedFetch session). */
  trace_id?: string;
  /** URL of the page where the error occurred. */
  url?: string;
  /** The component or module that emitted the error. */
  component?: string;
  /** Any additional structured context the browser wants to attach. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles POST /api/v1/client-errors.
 *
 * Returns 202 Accepted on success (the payload has been logged).
 * Returns 400 Bad Request if the body is not valid JSON with a `message` field.
 */
export async function handleClientErrorsRequest(req: Request): Promise<Response | null> {
  if (req.method !== 'POST') return null;

  // Extract the request-level trace ID (from X-Trace-Id / traceparent headers).
  const requestTraceId = extractTraceId(req);

  let payload: BrowserErrorPayload;
  try {
    const body = await req.json();
    if (typeof body !== 'object' || body === null || typeof body.message !== 'string') {
      return new Response(JSON.stringify({ error: 'Invalid payload: message field required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    payload = body as BrowserErrorPayload;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Prefer the trace ID from the payload body so that the browser error is
  // correlated to the originating page-load session trace, not just this HTTP
  // request's trace.
  const traceId =
    typeof payload.trace_id === 'string' && payload.trace_id ? payload.trace_id : requestTraceId;

  // Destructure trace_id out so it does not appear twice in the log entry.
  const { trace_id: _ignored, ...rest } = payload;

  log('error', `client-error: ${payload.message}`, {
    trace_id: traceId,
    service: process.env.SERVICE_NAME ?? 'server',
    ...rest,
  });

  return new Response(JSON.stringify({ ok: true }), {
    status: 202,
    headers: { 'Content-Type': 'application/json' },
  });
}
