/**
 * @file SignalFeedContext.tsx
 *
 * ## Scout — Researcher signal feed React context (issue #84)
 *
 * **Scout stub — no-op.** Establishes the SignalFeedContext module boundary,
 * public API shape, and integration surface before the implementation wires
 * in the real WebSocket hook.
 *
 * ## Canonical docs
 * - docs/architecture.md § Frontend → "State management: React Context + useReducer"
 * - docs/architecture.md § Frontend → "The signal feed is a WebSocket hook
 *   updating a single SignalFeedContext."
 * - docs/prd.md §9 — sub-second signal delivery SLA
 * - docs/prd.md §5 — event evaluation and signal delivery to the researcher
 *
 * ## Integration points discovered
 *
 * 1. **WebSocket URL**: The client connects to `GET /ws` (same upgrade endpoint
 *    as the existing admin WebSocket). The server routes `signal.delivered`
 *    events only to the session whose `researcher_id` matches the signal owner.
 *    Non-researcher sessions (superadmin) do not receive signal events.
 *
 * 2. **Event shape**: The server sends:
 *    ```json
 *    {
 *      "event": "signal.delivered",
 *      "data": {
 *        "signal_id":   "<uuid>",
 *        "ticker":      "AAPL",
 *        "event_type":  "8-K",
 *        "rationale":   "<markdown>",
 *        "confidence":  0.92,
 *        "ts":          "<ISO-8601>"
 *      }
 *    }
 *    ```
 *    The `useSignalFeed` hook (apps/web/src/hooks/use-signal-feed.ts) parses
 *    this and dispatches into the context reducer.
 *
 * 3. **Auth gate**: The WebSocket upgrade requires a valid session cookie.
 *    The context must not attempt to open a WebSocket before the user is
 *    authenticated (AuthContext.user must be non-null).
 *
 * 4. **Reconnect**: Native WebSocket auto-reconnect is not implemented by
 *    the browser; the hook must manage exponential-backoff reconnect logic.
 *    Missed events during reconnect are recoverable via GET /api/signals
 *    polling (follow-on scope).
 *
 * 5. **Unauthenticated upgrade rejection**: The server returns HTTP 401 for
 *    unauthenticated WebSocket upgrade requests (enforced in apps/server/src/index.ts
 *    upgrade handler). The hook should surface `status: 'error'` on connection
 *    failure so the UI can show an appropriate message.
 *
 * ## State shape (implementation)
 *
 * ```ts
 * interface SignalFeedState {
 *   signals: SignalItem[];
 *   status: 'connecting' | 'connected' | 'disconnected' | 'error';
 * }
 * ```
 *
 * Signals are prepended (newest-first). The feed is bounded to MAX_FEED_SIZE
 * items to prevent unbounded memory growth in long-running sessions.
 *
 * @see apps/web/src/hooks/use-signal-feed.ts — WebSocket hook stub
 * @see apps/web/src/pages/trader.tsx — researcher page (signal feed consumer)
 * @see apps/server/src/signal-channel-listener.ts — server-side push bridge stub
 * @see https://github.com/superfield-idea-lab/market-alert/issues/84
 */

import React, { createContext, useContext } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One signal item in the researcher feed.
 *
 * Implementation: extend with full signal detail fields (wiki citations,
 * acknowledgement status) once GET /api/signals is wired.
 */
export interface SignalItem {
  /** UUID of the delivered signal. */
  signal_id: string;
  /** Watchlist ticker symbol, e.g. "AAPL". */
  ticker: string;
  /** Filing event type, e.g. "8-K". */
  event_type: string;
  /** Structured markdown rationale from the event-evaluator. */
  rationale: string;
  /** Composite confidence score (source_trust × extraction_certainty), in [0.0, 1.0]. */
  confidence: number;
  /** ISO-8601 timestamp when the signal reached Delivered state. */
  ts: string;
  /** WebSocket push receipt timestamp (client-side, for SLA measurement). */
  received_at: number;
}

/**
 * Shape of the value exposed by SignalFeedContext.
 */
export interface SignalFeedContextValue {
  /** Live signal feed, newest-first. Empty until the first WS push arrives. */
  signals: SignalItem[];
  /** WebSocket connection status (scout: always 'disconnected'). */
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const SignalFeedContext = createContext<SignalFeedContextValue>({
  signals: [],
  status: 'disconnected',
});

SignalFeedContext.displayName = 'SignalFeedContext';

// ---------------------------------------------------------------------------
// Provider — scout stub
// ---------------------------------------------------------------------------

/**
 * **Scout stub — no-op provider.**
 *
 * Wraps children with a SignalFeedContext that always returns an empty signal
 * list and `status: 'disconnected'`. No WebSocket connection is opened.
 *
 * Implementation: replace the stub body with:
 * ```tsx
 * const { signals, status } = useSignalFeed();
 * return (
 *   <SignalFeedContext.Provider value={{ signals, status }}>
 *     {children}
 *   </SignalFeedContext.Provider>
 * );
 * ```
 *
 * The provider must be mounted inside AuthContext so `useAuth().user` is
 * accessible to `useSignalFeed`.
 */
export function SignalFeedProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  // Scout stub: static empty state. Implementation replaces with useSignalFeed().
  const value: SignalFeedContextValue = {
    signals: [],
    status: 'disconnected',
  };

  return <SignalFeedContext.Provider value={value}>{children}</SignalFeedContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns the current signal feed value from SignalFeedContext.
 *
 * Must be called from a component that is a descendant of SignalFeedProvider.
 *
 * @throws {Error} if called outside of SignalFeedProvider.
 */
export function useSignalFeedContext(): SignalFeedContextValue {
  return useContext(SignalFeedContext);
}
