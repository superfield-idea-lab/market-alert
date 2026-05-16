/**
 * @file alert-websocket-scout.spec.ts
 *
 * ## Phase 4 scout — WebSocket push from Deduplicated alert (issue #20)
 *
 * Integration tests that compile and pass today (scout mode) and define the
 * acceptance criteria for the full Phase 4 implementation.
 *
 * ## What these tests cover (scout-mode)
 *
 * 1. **WebSocket upgrade is rejected for unauthenticated sessions** (no valid
 *    cookie). This is already enforced by the server — the test verifies the
 *    existing gate holds and will not regress when Phase 4 extends WsClientData.
 *
 * 2. **ALERT_NOTIFY task enqueue stub** — verifies the ALERT_NOTIFY task type
 *    is registered in TASK_TYPE_AGENT_MAP (task-queue.ts, issue #5). The
 *    real enqueue test (task exists in task_queue after Deduplicated transition)
 *    is blocked on the mkt_alerts DDL (Phase 4 milestone).
 *
 * ## What is NOT tested here (Phase 4 follow-on, marked TODO)
 *
 * - Playwright E2E: seed alert → Deduplicated → assert WS push within 1 000 ms
 *   (merge gate for Phase 4 — requires mkt_alerts DDL + trigger)
 * - Playwright E2E: second trader session does not receive first trader's alert
 *   (RLS enforcement at the push layer)
 * - Integration: ALERT_NOTIFY task exists in task_queue after Deduplicated transition
 *   (requires mkt_alerts DDL)
 *
 * ## No mocks
 *
 * Real Postgres + real Bun server via the shared environment.ts helper.
 * No vi.fn, vi.mock, vi.spyOn, vi.stubGlobal. CLAUDE.md § Testing Standards.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startE2EServer, stopE2EServer, type E2EEnvironment } from './environment';
import { TaskType, TASK_TYPE_AGENT_MAP } from '../../packages/db/task-queue';

let env: E2EEnvironment;

beforeAll(async () => {
  env = await startE2EServer();
}, 60_000);

afterAll(async () => {
  await stopE2EServer(env);
});

// ---------------------------------------------------------------------------
// Helper: build ws:// URL from the test server base URL
// ---------------------------------------------------------------------------

function wsUrl(base: string, path = '/ws'): string {
  return base.replace(/^http/, 'ws') + path;
}

// ---------------------------------------------------------------------------
// 1. WebSocket upgrade — authentication gate
// ---------------------------------------------------------------------------

describe('WebSocket upgrade — authentication gate', () => {
  it('returns HTTP 401 when no session cookie is provided', async () => {
    // Attempt a WebSocket upgrade without any credentials.
    // The server validates the session cookie before upgrading; unauthenticated
    // requests must receive 401 and must not be upgraded.
    //
    // We use a raw HTTP request rather than the WebSocket API because:
    // (a) node's native WebSocket does not expose the pre-upgrade HTTP status, and
    // (b) the server returns a plain HTTP 401 JSON response (not an upgrade response)
    //     for unauthenticated attempts, so a regular fetch works fine.
    //
    // See apps/server/src/index.ts — the /ws handler calls getAuthenticatedUser
    // and returns 401 before server.upgrade() if the user is null.
    const res = await fetch(`${env.baseUrl}/ws`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });

    // The server must reject the upgrade with a 401.
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('does not return 401 when a valid session cookie is provided', async () => {
    // Obtain a test session cookie via the TEST_MODE backdoor.
    const sessionRes = await fetch(`${env.baseUrl}/api/test/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ws-auth-test-trader' }),
    });
    expect(sessionRes.ok).toBe(true);
    const setCookieHeader = sessionRes.headers.get('set-cookie') ?? '';
    const match = /superfield_auth=([^;]+)/.exec(setCookieHeader);
    const cookie = match ? `superfield_auth=${match[1]}` : '';
    expect(cookie).not.toBe('');

    // Attempt the upgrade with a valid cookie. We do not assert the WebSocket
    // upgrade succeeds (fetch does not speak WebSocket), but we do assert that
    // the server does NOT return 401. A 400 ("upgrade failed") or 101 (upgrade
    // ok) both indicate the auth gate passed.
    const res = await fetch(`${env.baseUrl}/ws`, {
      headers: {
        Cookie: cookie,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });

    // Must not be 401 (auth rejected). 400 is acceptable — fetch does not do
    // a real WebSocket handshake so the upgrade completion may fail at the
    // protocol level, but the auth gate must pass.
    expect(res.status).not.toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 2. ALERT_NOTIFY task type registration
// ---------------------------------------------------------------------------

describe('ALERT_NOTIFY task type — registration check', () => {
  /**
   * Verifies that ALERT_NOTIFY is in TASK_TYPE_AGENT_MAP before any Phase 4
   * DDL exists. The task type was added in issue #5 (Phase 0 scaffold).
   *
   * The real integration test (task enqueued after Deduplicated transition)
   * is a TODO below — blocked on mkt_alerts DDL.
   */
  it('ALERT_NOTIFY is registered in TASK_TYPE_AGENT_MAP with agent_type "notification"', () => {
    expect(TASK_TYPE_AGENT_MAP).toHaveProperty(TaskType.ALERT_NOTIFY);
    expect(TASK_TYPE_AGENT_MAP[TaskType.ALERT_NOTIFY]).toBe('notification');
  });

  it('ALERT_DEDUP is registered in TASK_TYPE_AGENT_MAP with agent_type "enrichment"', () => {
    // ALERT_DEDUP is the upstream task — its completion triggers the Deduplicated
    // state transition and the NOTIFY. Verify it's registered.
    expect(TASK_TYPE_AGENT_MAP).toHaveProperty(TaskType.ALERT_DEDUP);
    expect(TASK_TYPE_AGENT_MAP[TaskType.ALERT_DEDUP]).toBe('enrichment');
  });

  /**
   * TODO (Phase 4 implementation):
   *
   * Once mkt_alerts DDL is migrated and the trg_mkt_alert_deduplicated trigger
   * exists, add an integration test that:
   *
   * 1. Seeds a trader user and an alert in 'Enriched' state.
   * 2. Updates the alert state to 'Deduplicated' via the internal API.
   * 3. Queries task_queue for an ALERT_NOTIFY task with idempotency_key
   *    matching `notify:<alert_id>:<channel>`.
   * 4. Asserts the row is present within 500 ms (fire-and-forget enqueue).
   *
   * This test must use the real Postgres container (no mocks) and the
   * startE2EServer environment so the server-side alert-channel-listener
   * bridge is active.
   */
});

// ---------------------------------------------------------------------------
// 3. parseAlertDeduplicatedPayload — unit-level validation
// ---------------------------------------------------------------------------

describe('parseAlertDeduplicatedPayload', () => {
  /**
   * Inline the parser here so the unit tests compile without depending on
   * the real channel listener (which requires Postgres). The parser is a
   * pure function exported from packages/db/mkt-alert-channel.ts.
   */
  function parseAlertDeduplicatedPayload(raw: string): {
    alert_id: string;
    trader_id: string;
    ticker: string;
    event_type: string;
    ts: string;
  } | null {
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
    if (
      typeof obj !== 'object' ||
      obj === null ||
      typeof (obj as Record<string, unknown>).alert_id !== 'string' ||
      typeof (obj as Record<string, unknown>).trader_id !== 'string'
    ) {
      return null;
    }
    return obj as ReturnType<typeof parseAlertDeduplicatedPayload>;
  }

  it('parses a valid payload', () => {
    const raw = JSON.stringify({
      alert_id: 'uuid-abc',
      trader_id: 'trader-xyz',
      ticker: 'AAPL',
      event_type: '8-K',
      ts: '2026-05-16T00:00:00Z',
    });
    const result = parseAlertDeduplicatedPayload(raw);
    expect(result).not.toBeNull();
    expect(result!.alert_id).toBe('uuid-abc');
    expect(result!.trader_id).toBe('trader-xyz');
    expect(result!.ticker).toBe('AAPL');
  });

  it('returns null for malformed JSON', () => {
    expect(parseAlertDeduplicatedPayload('not-json')).toBeNull();
  });

  it('returns null when alert_id is missing', () => {
    const raw = JSON.stringify({ trader_id: 'trader-xyz' });
    expect(parseAlertDeduplicatedPayload(raw)).toBeNull();
  });

  it('returns null when trader_id is missing', () => {
    const raw = JSON.stringify({ alert_id: 'uuid-abc' });
    expect(parseAlertDeduplicatedPayload(raw)).toBeNull();
  });

  it('returns null for a non-object payload', () => {
    expect(parseAlertDeduplicatedPayload('"a string"')).toBeNull();
    expect(parseAlertDeduplicatedPayload('42')).toBeNull();
    expect(parseAlertDeduplicatedPayload('null')).toBeNull();
  });

  /**
   * TODO (Phase 4 implementation): replace inline parser with the import:
   * ```ts
   * import { parseAlertDeduplicatedPayload } from '../../packages/db/mkt-alert-channel';
   * ```
   * and remove the local definition above. The function signature and test
   * cases must remain identical.
   */
});

// ---------------------------------------------------------------------------
// 4. wsUrl helper — unit
// ---------------------------------------------------------------------------

describe('wsUrl', () => {
  it('converts http:// to ws://', () => {
    expect(wsUrl('http://localhost:31415')).toBe('ws://localhost:31415/ws');
  });

  it('converts https:// to wss://', () => {
    expect(wsUrl('https://example.com')).toBe('wss://example.com/ws');
  });

  it('accepts a custom path', () => {
    expect(wsUrl('http://localhost:31415', '/ws/alerts')).toBe('ws://localhost:31415/ws/alerts');
  });
});
