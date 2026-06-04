/**
 * @file use-signal-feed.ts
 *
 * ## Scout — Researcher signal feed WebSocket hook (issue #84)
 *
 * **Scout stub — no-op.** Establishes the `useSignalFeed` hook boundary and
 * the full integration surface for the `GET /ws` WebSocket connection that
 * delivers `signal.delivered` events to the researcher dashboard.
 *
 * ## Canonical docs
 * - docs/architecture.md § HTTP server → "WebSocket transport: Bun native Bun.serve"
 * - docs/architecture.md § Frontend → "The signal feed is a WebSocket hook
 *   updating a single SignalFeedContext."
 * - docs/prd.md §9 — sub-second SLA: ≤ 1 000 ms from Delivered state to browser receipt
 * - docs/prd.md §5 — direct delivery (confidence ≥ threshold) and Reviewer queue
 *
 * ## Integration points discovered
 *
 * 1. **Upgrade endpoint**: `GET /ws` (existing, apps/server/src/index.ts).
 *    The server validates the session cookie before upgrading. No bearer token
 *    or query-param workarounds needed — the cookie is sent automatically.
 *
 * 2. **Server event format**:
 *    ```json
 *    { "event": "signal.delivered", "data": { "signal_id": "...", "ticker": "...",
 *      "event_type": "...", "rationale": "...", "confidence": 0.92, "ts": "..." } }
 *    ```
 *    Other event types (task.created, task_queue.updated) may also arrive on
 *    the same connection; the hook must filter to `signal.delivered` only.
 *
 * 3. **Session routing**: The server pushes `signal.delivered` only to the
 *    WebSocket session whose `WsClientData.researcher_id` matches the signal's
 *    `researcher_id`. The hook receives only signals owned by the current user —
 *    no client-side filter is needed for correctness (RLS enforced server-side).
 *
 * 4. **Reconnect strategy**: Native WebSocket does not auto-reconnect.
 *    The implementation must implement exponential-backoff reconnect
 *    (suggested: 100 ms, 200 ms, 400 ms, cap 5 000 ms). The React effect
 *    cleanup must `ws.close()` on unmount to avoid ghost connections.
 *
 * 5. **SLA measurement**: The hook should record `received_at = Date.now()`
 *    immediately on message receipt (before any state update) so the
 *    Playwright E2E test can measure the end-to-end latency. The `SignalItem`
 *    type in SignalFeedContext.tsx includes `received_at` for this purpose.
 *
 * 6. **Bounded feed**: Cap the in-memory signal list at MAX_FEED_SIZE (suggested:
 *    100) to prevent memory growth in long-running researcher sessions.
 *
 * 7. **Unauthenticated upgrade rejection**: If the server returns HTTP 401
 *    during the WebSocket handshake, the hook should set `status: 'error'`
 *    and not retry (the user must re-authenticate).
 *
 * ## Implementation sketch
 *
 * ```ts
 * export function useSignalFeed(): SignalFeedContextValue {
 *   const { user } = useAuth();
 *   const [state, dispatch] = useReducer(signalFeedReducer, initialState);
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
 *         if (msg.event === 'signal.delivered') {
 *           dispatch({ type: 'ADD_SIGNAL', signal: { ...msg.data, received_at } });
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
 * @see apps/web/src/context/SignalFeedContext.tsx — consumer
 * @see apps/server/src/signal-channel-listener.ts — server-side push bridge stub
 * @see apps/server/src/websocket.ts — WsClientData.researcher_id (must be added)
 * @see apps/web/src/hooks/use-alert-feed.ts — analogous alert feed hook (issue #20)
 * @see https://github.com/superfield-idea-lab/market-alert/issues/84
 */

import type { SignalFeedContextValue, SignalItem } from '../context/SignalFeedContext';

// ---------------------------------------------------------------------------
// Scout stub
// ---------------------------------------------------------------------------

/**
 * **Scout stub — no-op.**
 *
 * Returns an empty feed with `status: 'disconnected'`. No WebSocket connection
 * is opened. The hook compiles and passes type-checking without a running server.
 *
 * Implementation: replace this stub with the real WebSocket effect
 * described in the integration sketch above.
 */
export function useSignalFeed(): SignalFeedContextValue {
  // Scout stub: static empty state.
  // Implementation opens a WebSocket to GET /ws, filters
  // 'signal.delivered' events, and dispatches into a useReducer.
  const signals: SignalItem[] = [];
  const status: SignalFeedContextValue['status'] = 'disconnected';
  return { signals, status };
}
