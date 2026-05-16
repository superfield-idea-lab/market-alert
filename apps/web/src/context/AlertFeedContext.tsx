/**
 * @file AlertFeedContext.tsx
 *
 * ## Phase 4 scout — Trader alert feed React context (issue #20)
 *
 * **Scout stub — no-op.** Establishes the AlertFeedContext module boundary,
 * public API shape, and integration surface before Phase 4 wires in the
 * real WebSocket hook.
 *
 * ## Canonical docs
 * - docs/architecture.md § Frontend → "State management: React Context + useReducer"
 * - docs/architecture.md § Frontend → "The alert feed is a WebSocket hook
 *   updating a single AlertFeedContext."
 * - PRD §9 — sub-second alert delivery SLA
 *
 * ## Integration points discovered
 *
 * 1. **WebSocket URL**: The client connects to `GET /ws` (same upgrade endpoint
 *    as the existing admin WebSocket). The server routes `alert.deduplicated`
 *    events only to the session whose `trader_id` matches the alert owner.
 *    Non-trader sessions (superadmin) do not receive alert events.
 *
 * 2. **Event shape**: The server sends:
 *    ```json
 *    {
 *      "event": "alert.deduplicated",
 *      "data": {
 *        "alert_id":   "<uuid>",
 *        "ticker":     "AAPL",
 *        "event_type": "8-K",
 *        "ts":         "<ISO-8601>"
 *      }
 *    }
 *    ```
 *    The `useAlertFeed` hook (apps/web/src/hooks/use-alert-feed.ts) parses
 *    this and dispatches into the context reducer.
 *
 * 3. **Auth gate**: The WebSocket upgrade requires a valid session cookie.
 *    The context must not attempt to open a WebSocket before the user is
 *    authenticated (AuthContext.user must be non-null).
 *
 * 4. **Reconnect**: Native WebSocket auto-reconnect is not implemented by
 *    the browser; the hook must manage exponential-backoff reconnect logic.
 *    Missed events during reconnect are recoverable via GET /api/alerts
 *    (polling fallback, Phase 4 follow-on).
 *
 * ## State shape (Phase 4 implementation)
 *
 * ```ts
 * interface AlertFeedState {
 *   alerts: AlertItem[];
 *   status: 'connecting' | 'connected' | 'disconnected' | 'error';
 * }
 * ```
 *
 * Alerts are prepended (newest-first). The feed is bounded to MAX_FEED_SIZE
 * items to prevent unbounded memory growth in long-running sessions.
 *
 * @see apps/web/src/hooks/use-alert-feed.ts — WebSocket hook stub
 * @see apps/web/src/pages/trader.tsx — TraderPage (alert feed consumer)
 */

import React, { createContext, useContext } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One alert item in the trader feed.
 *
 * Phase 4 implementation: extend with full alert detail fields (spread,
 * enrichment data, corporate action link) once GET /api/alerts is wired.
 */
export interface AlertItem {
  /** UUID of the alert. */
  alert_id: string;
  /** Watchlist ticker symbol, e.g. "AAPL". */
  ticker: string;
  /** Filing event type, e.g. "8-K". */
  event_type: string;
  /** ISO-8601 timestamp when the alert reached Deduplicated state. */
  ts: string;
  /** WebSocket push receipt timestamp (client-side, for SLA measurement). */
  received_at: number;
}

/**
 * Shape of the value exposed by AlertFeedContext.
 *
 * Phase 4 implementation: extend with `status`, `reconnect()`, and
 * `acknowledge(alert_id)` (Phase 4 follow-on).
 */
export interface AlertFeedContextValue {
  /** Live alert feed, newest-first. Empty until the first WS push arrives. */
  alerts: AlertItem[];
  /** WebSocket connection status (scout: always 'disconnected'). */
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AlertFeedContext = createContext<AlertFeedContextValue>({
  alerts: [],
  status: 'disconnected',
});

AlertFeedContext.displayName = 'AlertFeedContext';

// ---------------------------------------------------------------------------
// Provider — Phase 4 scout stub
// ---------------------------------------------------------------------------

/**
 * **Phase 4 scout stub — no-op provider.**
 *
 * Wraps children with an AlertFeedContext that always returns an empty alert
 * list and `status: 'disconnected'`. No WebSocket connection is opened.
 *
 * Phase 4 implementation: replace the stub body with:
 * ```tsx
 * const { alerts, status } = useAlertFeed();
 * return (
 *   <AlertFeedContext.Provider value={{ alerts, status }}>
 *     {children}
 *   </AlertFeedContext.Provider>
 * );
 * ```
 *
 * The provider must be mounted inside AuthContext so `useAuth().user` is
 * accessible to `useAlertFeed`.
 */
export function AlertFeedProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  // Scout stub: static empty state. Phase 4 replaces with useAlertFeed().
  const value: AlertFeedContextValue = {
    alerts: [],
    status: 'disconnected',
  };

  return <AlertFeedContext.Provider value={value}>{children}</AlertFeedContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns the current alert feed value from AlertFeedContext.
 *
 * Must be called from a component that is a descendant of AlertFeedProvider.
 *
 * @throws {Error} if called outside of AlertFeedProvider.
 */
export function useAlertFeedContext(): AlertFeedContextValue {
  return useContext(AlertFeedContext);
}
