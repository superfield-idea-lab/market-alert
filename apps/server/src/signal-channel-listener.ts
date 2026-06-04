/**
 * @file signal-channel-listener.ts
 *
 * ## Scout — Server-side signal LISTEN/NOTIFY → WebSocket bridge (issue #84)
 *
 * **Scout stub — no-op.** This module wires the `signal_delivered`
 * PostgreSQL LISTEN channel (packages/db/signal-channel.ts) to the
 * WebSocket push layer (apps/server/src/websocket.ts).
 *
 * The bridge is the hot path for the sub-second SLA (PRD §9, architecture §7):
 *   `signals.status = Delivered`
 *     → pg_notify('signal_delivered', payload)
 *       → createSignalChannelListener callback
 *         → broadcastToResearcher(researcher_id, event, data)   ← this module
 *           → researcher browser WebSocket receipt
 *
 * ## Integration surface (implementation checklist)
 *
 * 1. **apps/server/src/websocket.ts — WsClientData extension**
 *    Add `researcher_id: string | null` to WsClientData so session routing can
 *    use it without an extra DB lookup:
 *    ```ts
 *    export interface WsClientData {
 *      isSuperadmin: boolean;
 *      researcher_id: string | null;  // ← implementation addition
 *    }
 *    ```
 *
 * 2. **apps/server/src/index.ts — upgrade handler**
 *    Extract `researcher_id` from the validated JWT during WebSocket upgrade and
 *    pass it as `data.researcher_id`. Non-researcher sessions (superadmin, anonymous)
 *    set `researcher_id: null`.
 *
 * 3. **broadcastToResearcher helper**
 *    A new function in websocket.ts that routes a message only to WebSocket
 *    sessions where `ws.data.researcher_id === researcher_id`. Analogous to the
 *    existing `broadcastToAdmins` (superadmin filter).
 *
 * 4. **apps/server/src/index.ts — startup**
 *    Call `startSignalChannelListener()` alongside the existing
 *    `startTaskQueueListener()` call on server boot. Register stop() on SIGTERM.
 *
 * 5. **Unauthenticated upgrade rejection**
 *    The existing upgrade handler at `GET /ws` validates the session cookie and
 *    returns HTTP 401 for unauthenticated requests. The implementation must
 *    verify this gate applies to all clients (not only admin sessions).
 *
 * ## Risks captured during scout
 *
 * - **Multi-pod fan-out**: each server pod holds one LISTEN connection. If
 *   the researcher's WebSocket session lives on pod B but the NOTIFY fires on
 *   pod A's connection, the push is missed. ALB sticky sessions mitigate this
 *   for MVP. Redis pub/sub fan-out is the durable fix (later phase scope).
 *   Captured in docs/architecture.md § Open questions.
 *
 * - **Reconnect missed-event gap**: Native WebSocket does not buffer events
 *   during disconnects. The researcher dashboard must fall back to
 *   GET /api/signals polling on reconnect to recover missed signals. This is
 *   a follow-on scope item for the SignalFeedContext implementation.
 *
 * - **`signals` DDL not yet finalised**: The `signal_delivered` NOTIFY trigger
 *   must be created atomically with the table migration. This stub references
 *   the channel name only; the trigger is a follow-on DDL item.
 *
 * @see packages/db/signal-channel.ts — LISTEN channel stub
 * @see apps/server/src/websocket.ts — WsClientData and broadcast helpers
 * @see apps/server/src/task-queue-listener.ts — analogous admin bridge (real implementation)
 * @see apps/server/src/alert-channel-listener.ts — analogous alert bridge (scout)
 * @see https://github.com/superfield-idea-lab/market-alert/issues/84
 */

import { createSignalChannelListener, type SignalChannelListenerHandle } from 'db/signal-channel';

export type { SignalChannelListenerHandle };

/**
 * **Scout stub — no-op.**
 *
 * Starts the `signal_delivered` LISTEN connection and bridges each notification
 * to connected researcher WebSocket sessions.
 *
 * In scout mode the underlying `createSignalChannelListener` is a no-op stub
 * (no real LISTEN connection is opened because the `signal_delivered` NOTIFY
 * trigger does not yet exist). The function compiles, starts without error, and
 * returns a handle whose `stop()` is a no-op.
 *
 * ## Implementation body (replace the function body below)
 *
 * ```ts
 * export async function startSignalChannelListener(
 *   databaseUrl?: string,
 * ): Promise<SignalChannelListenerHandle> {
 *   const handle = await createSignalChannelListener(async (payload) => {
 *     // Push to the matching researcher WebSocket session (< 1 s SLA)
 *     broadcastToResearcher(payload.researcher_id, 'signal.delivered', {
 *       signal_id:   payload.signal_id,
 *       ticker:      payload.ticker,
 *       event_type:  payload.event_type,
 *       rationale:   payload.rationale,
 *       confidence:  payload.confidence,
 *       ts:          payload.ts,
 *     });
 *   }, databaseUrl);
 *
 *   console.log('[signal-channel] Listening on "signal_delivered".');
 *   return handle;
 * }
 * ```
 *
 * Note: `broadcastToResearcher` must be added to websocket.ts before the body
 * above compiles. See integration surface item 3 above.
 *
 * @param databaseUrl   Optional override; defaults to DATABASE_URL env var.
 * @returns A handle with a `stop()` method.
 */
export async function startSignalChannelListener(
  databaseUrl?: string,
): Promise<SignalChannelListenerHandle> {
  // Scout stub: delegate to the no-op channel listener.
  // No broadcastToResearcher call yet — that helper does not exist until
  // the implementation adds it to websocket.ts.
  const handle = await createSignalChannelListener((_payload) => {
    // no-op: implementation routes payload to broadcastToResearcher
  }, databaseUrl);

  console.log(
    '[signal-channel] Scout stub: signal_delivered listener registered (no-op until implementation DDL).',
  );

  return handle;
}
