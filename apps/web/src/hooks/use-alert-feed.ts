/**
 * @file use-alert-feed.ts
 *
 * ## Phase 4 scout — Trader alert feed WebSocket hook (issue #20)
 *
 * **Scout stub — no-op.** Establishes the `useAlertFeed` hook boundary and
 * the full integration surface for the `GET /ws` WebSocket connection that
 * delivers `alert.deduplicated` events to the trader dashboard.
 *
 * ## Canonical docs
 * - docs/architecture.md § HTTP server → "WebSocket transport: Bun native Bun.serve"
 * - docs/architecture.md § Frontend → "The alert feed is a WebSocket hook
 *   updating a single AlertFeedContext."
 * - PRD §9 — sub-second SLA: ≤ 1 000 ms from Deduplicated state to browser receipt
 *
 * ## Integration points discovered
 *
 * 1. **Upgrade endpoint**: `GET /ws` (existing, apps/server/src/index.ts).
 *    The server validates the session cookie before upgrading. No bearer token
 *    or query-param workarounds needed — the cookie is sent automatically.
 *
 * 2. **Server event format**:
 *    ```json
 *    { "event": "alert.deduplicated", "data": { "alert_id": "...", "ticker": "...", "event_type": "...", "ts": "..." } }
 *    ```
 *    Other event types (task.created, task_queue.updated) may also arrive on
 *    the same connection; the hook must filter to `alert.deduplicated` only.
 *
 * 3. **Session routing**: The server pushes `alert.deduplicated` only to the
 *    WebSocket session whose `WsClientData.trader_id` matches the alert's
 *    `trader_id`. The hook receives only alerts owned by the current user —
 *    no client-side filter is needed for correctness (RLS enforced server-side).
 *
 * 4. **Reconnect strategy**: Native WebSocket does not auto-reconnect.
 *    Phase 4 implementation must implement exponential-backoff reconnect
 *    (suggested: 100 ms, 200 ms, 400 ms, cap 5 000 ms). The React effect
 *    cleanup must `ws.close()` on unmount to avoid ghost connections.
 *
 * 5. **SLA measurement**: The hook should record `received_at = Date.now()`
 *    immediately on message receipt (before any state update) so the
 *    Playwright E2E test can measure the end-to-end latency. The `AlertItem`
 *    type in AlertFeedContext.tsx includes `received_at` for this purpose.
 *
 * 6. **Bounded feed**: Cap the in-memory alert list at MAX_FEED_SIZE (suggested:
 *    100) to prevent memory growth in long-running trader sessions.
 *
 * ## Phase 4 implementation sketch
 *
 * ```ts
 * export function useAlertFeed(): AlertFeedState {
 *   const { user } = useAuth();
 *   const [state, dispatch] = useReducer(alertFeedReducer, initialState);
 *
 *   useEffect(() => {
 *     if (!user) return;                            // not authenticated
 *     let ws: WebSocket;
 *     let backoffMs = 100;
 *     let stopped = false;
 *
 *     function connect() {
 *       ws = new WebSocket(`${wsOrigin()}/ws`);
 *       dispatch({ type: 'SET_STATUS', status: 'connecting' });
 *       ws.onopen = () => { dispatch({ type: 'SET_STATUS', status: 'connected' }); backoffMs = 100; };
 *       ws.onclose = () => {
 *         dispatch({ type: 'SET_STATUS', status: 'disconnected' });
 *         if (!stopped) setTimeout(connect, Math.min(backoffMs *= 2, 5000));
 *       };
 *       ws.onmessage = (evt) => {
 *         const received_at = Date.now();
 *         const msg = JSON.parse(evt.data as string);
 *         if (msg.event === 'alert.deduplicated') {
 *           dispatch({ type: 'ADD_ALERT', alert: { ...msg.data, received_at } });
 *         }
 *       };
 *     }
 *
 *     connect();
 *     return () => { stopped = true; ws?.close(); };
 *   }, [user]);
 *
 *   return state;
 * }
 * ```
 *
 * @see apps/web/src/context/AlertFeedContext.tsx — consumer
 * @see apps/server/src/alert-channel-listener.ts — server-side push bridge
 * @see apps/server/src/websocket.ts — WsClientData.trader_id (must be added)
 */

import type { AlertFeedContextValue, AlertItem } from '../context/AlertFeedContext';

// ---------------------------------------------------------------------------
// Scout stub
// ---------------------------------------------------------------------------

/**
 * **Phase 4 scout stub — no-op.**
 *
 * Returns an empty feed with `status: 'disconnected'`. No WebSocket connection
 * is opened. The hook compiles and passes type-checking without a running server.
 *
 * Phase 4 implementation: replace this stub with the real WebSocket effect
 * described in the integration sketch above.
 */
export function useAlertFeed(): AlertFeedContextValue {
  // Scout stub: static empty state.
  // Phase 4 implementation opens a WebSocket to GET /ws, filters
  // 'alert.deduplicated' events, and dispatches into a useReducer.
  const alerts: AlertItem[] = [];
  const status: AlertFeedContextValue['status'] = 'disconnected';
  return { alerts, status };
}
