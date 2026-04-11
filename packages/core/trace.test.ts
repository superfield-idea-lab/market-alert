import { describe, expect, test } from 'vitest';

// Import module-level state accessors for isolation.
// We re-import fresh instances by resetting the module between tests where needed.
// Since we cannot do module resets easily in Vitest without explicit mocking, we
// test the stateless helpers directly and test the stateful helpers carefully.

import {
  getSessionTraceId,
  nextRequestTraceId,
  tracedFetch,
  extractTraceId,
  traceLog,
  makeTracedFetch,
} from './trace';

// ---------------------------------------------------------------------------
// extractTraceId
// ---------------------------------------------------------------------------

describe('extractTraceId', () => {
  test('returns X-Trace-Id header when present', () => {
    const req = new Request('http://localhost/', {
      headers: { 'X-Trace-Id': 'test-trace-123' },
    });
    expect(extractTraceId(req)).toBe('test-trace-123');
  });

  test('generates a UUID when header is absent', () => {
    const req = new Request('http://localhost/');
    const id = extractTraceId(req);
    // UUID v4 format: 8-4-4-4-12 hex characters
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test('generates a different UUID on each call when header is absent', () => {
    const req1 = new Request('http://localhost/');
    const req2 = new Request('http://localhost/');
    expect(extractTraceId(req1)).not.toBe(extractTraceId(req2));
  });
});

// ---------------------------------------------------------------------------
// traceLog
// ---------------------------------------------------------------------------

describe('traceLog', () => {
  test('includes ts, level, and trace_id fields', () => {
    const entry = traceLog('info', 'my-trace-id', { method: 'GET', path: '/api/tasks' });
    expect(entry.ts).toBeTruthy();
    expect(entry.level).toBe('info');
    expect(entry.trace_id).toBe('my-trace-id');
  });

  test('merges additional fields', () => {
    const entry = traceLog('error', 'tid-1', { status: 500, duration_ms: 123 });
    expect(entry.status).toBe(500);
    expect(entry.duration_ms).toBe(123);
  });

  test('ts is a valid ISO 8601 timestamp', () => {
    const entry = traceLog('warn', 'tid-2', {});
    expect(new Date(entry.ts as string).toISOString()).toBe(entry.ts);
  });

  test('extra fields do not overwrite core fields', () => {
    // If caller passes trace_id, it should be overwritten by the positional arg.
    const entry = traceLog('info', 'canonical-id', { trace_id: 'wrong-id' });
    // trace_id from positional argument should take precedence (spread order)
    expect(entry.trace_id).toBe('canonical-id');
  });
});

// ---------------------------------------------------------------------------
// getSessionTraceId — stable within a module load
// ---------------------------------------------------------------------------

describe('getSessionTraceId', () => {
  test('returns the same ID on repeated calls', () => {
    const id1 = getSessionTraceId();
    const id2 = getSessionTraceId();
    expect(id1).toBe(id2);
  });

  test('returns a UUID-format string', () => {
    const id = getSessionTraceId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

// ---------------------------------------------------------------------------
// nextRequestTraceId — monotonically increasing
// ---------------------------------------------------------------------------

describe('nextRequestTraceId', () => {
  test('includes the session trace ID prefix', () => {
    const sessionId = getSessionTraceId();
    const reqId = nextRequestTraceId();
    expect(reqId.startsWith(sessionId)).toBe(true);
  });

  test('each call produces a unique ID', () => {
    const id1 = nextRequestTraceId();
    const id2 = nextRequestTraceId();
    expect(id1).not.toBe(id2);
  });

  test('IDs share the same session prefix', () => {
    const sessionId = getSessionTraceId();
    const id1 = nextRequestTraceId();
    const id2 = nextRequestTraceId();
    const prefix1 = id1.slice(0, sessionId.length);
    const prefix2 = id2.slice(0, sessionId.length);
    expect(prefix1).toBe(sessionId);
    expect(prefix2).toBe(sessionId);
  });

  test('format is <session-uuid>-<n>', () => {
    const sessionId = getSessionTraceId();
    const id = nextRequestTraceId();
    // After the session UUID there should be a dash and a positive integer
    const suffix = id.slice(sessionId.length);
    expect(suffix).toMatch(/^-\d+$/);
  });
});

// ---------------------------------------------------------------------------
// tracedFetch — attaches X-Trace-Id header
// ---------------------------------------------------------------------------

describe('tracedFetch', () => {
  test('sets X-Trace-Id on the outgoing request', async () => {
    let capturedHeader: string | null = null;

    // Override global fetch for this test using a type-cast so we can intercept
    // calls without implementing the full fetch interface (preconnect etc.).
    const originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedHeader = new Headers(init?.headers).get('X-Trace-Id');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    try {
      await tracedFetch('http://localhost/api/tasks', { credentials: 'include' });
      expect(capturedHeader).toBeTruthy();
      // Should be a session-id + index composite
      expect(capturedHeader).toContain('-');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does not overwrite headers provided by caller', async () => {
    const captured: { headers: Headers | null } = { headers: null };

    const originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      captured.headers = new Headers(init?.headers);
      return new Response('ok', { status: 200 });
    };

    try {
      await tracedFetch('http://localhost/', {
        headers: { 'Content-Type': 'application/json' },
      });
      expect(captured.headers?.get('Content-Type')).toBe('application/json');
      expect(captured.headers?.get('X-Trace-Id')).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// makeTracedFetch — server-side traced fetch bound to a specific trace ID
// ---------------------------------------------------------------------------

describe('makeTracedFetch', () => {
  test('sets X-Trace-Id to the provided trace ID', async () => {
    let capturedHeader: string | null = null;

    const originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedHeader = new Headers(init?.headers).get('X-Trace-Id');
      return new Response('ok', { status: 200 });
    };

    try {
      const tracedFetchForRequest = makeTracedFetch('server-trace-abc-123');
      await tracedFetchForRequest('http://localhost/api/internal');
      expect(capturedHeader).toBe('server-trace-abc-123');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('different calls with different trace IDs produce different headers', async () => {
    const captured: string[] = [];

    const originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const id = new Headers(init?.headers).get('X-Trace-Id');
      if (id) captured.push(id);
      return new Response('ok', { status: 200 });
    };

    try {
      const fetchA = makeTracedFetch('trace-aaa');
      const fetchB = makeTracedFetch('trace-bbb');
      await fetchA('http://localhost/');
      await fetchB('http://localhost/');
      expect(captured).toEqual(['trace-aaa', 'trace-bbb']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('preserves caller-supplied headers', async () => {
    const captured: { headers: Headers | null } = { headers: null };

    const originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      captured.headers = new Headers(init?.headers);
      return new Response('ok', { status: 200 });
    };

    try {
      const tracedFetchForRequest = makeTracedFetch('trace-xyz');
      await tracedFetchForRequest('http://localhost/', {
        headers: { Authorization: 'Bearer token123' },
      });
      expect(captured.headers?.get('Authorization')).toBe('Bearer token123');
      expect(captured.headers?.get('X-Trace-Id')).toBe('trace-xyz');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
