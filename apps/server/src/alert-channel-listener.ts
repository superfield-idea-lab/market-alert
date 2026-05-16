/**
 * @file alert-channel-listener.ts
 *
 * ## Phase 4 scout — Server-side alert LISTEN/NOTIFY → WebSocket bridge (issue #20)
 *
 * **Scout stub — no-op.** This module wires the `mkt_alert_deduplicated`
 * PostgreSQL LISTEN channel (packages/db/mkt-alert-channel.ts) to the
 * WebSocket push layer (apps/server/src/websocket.ts).
 *
 * The bridge is the hot path for the 1-second SLA (PRD §9):
 *   `mkt_alerts.state = Deduplicated`
 *     → pg_notify('mkt_alert_deduplicated', payload)
 *       → createAlertChannelListener callback
 *         → broadcastToTrader(trader_id, event, data)   ← this module
 *           → trader browser WebSocket receipt
 *
 * ## Integration surface (Phase 4 implementation checklist)
 *
 * 1. **apps/server/src/websocket.ts — WsClientData extension**
 *    Add `trader_id: string | null` to WsClientData so session routing can
 *    use it without an extra DB lookup:
 *    ```ts
 *    export interface WsClientData {
 *      isSuperadmin: boolean;
 *      trader_id: string | null;  // ← Phase 4 addition
 *    }
 *    ```
 *
 * 2. **apps/server/src/index.ts — upgrade handler**
 *    Extract `trader_id` from the validated JWT during WebSocket upgrade and
 *    pass it as `data.trader_id`. Non-trader sessions (superadmin, anonymous)
 *    set `trader_id: null`.
 *
 * 3. **broadcastToTrader helper**
 *    A new function in websocket.ts that routes a message only to WebSocket
 *    sessions where `ws.data.trader_id === trader_id`. Analogous to the
 *    existing `broadcastToAdmins` (superadmin filter).
 *
 * 4. **ALERT_NOTIFY task enqueue**
 *    After the WebSocket push, enqueue an `ALERT_NOTIFY` task for each
 *    enabled outbound channel (email/SMS/webhook gated by mkt_feature_flags).
 *    Idempotency key: `notify:<alert_id>:<channel>`. Fire-and-forget; the
 *    `Delivered` state is set on WS push completion, not after outbound delivery.
 *
 * 5. **apps/server/src/index.ts — startup**
 *    Call `startAlertChannelListener()` alongside the existing
 *    `startTaskQueueListener()` call on server boot. Register stop() on SIGTERM.
 *
 * ## Risks captured during scout
 *
 * - **Multi-pod fan-out**: each server pod holds one LISTEN connection. If
 *   the trader's WebSocket session lives on pod B but the NOTIFY fires on
 *   pod A's connection, the push is missed. ALB sticky sessions mitigate this
 *   for MVP. Redis pub/sub fan-out is the durable fix (Phase 5 scope).
 *
 * - **Back-pressure**: a burst of NOTIFY events (e.g. mass-dedup run) will
 *   call broadcastToTrader synchronously from the LISTEN callback. The Bun
 *   WebSocket send is non-blocking but the JS event loop is single-threaded.
 *   Phase 4 should add a bounded async queue if burst risk is real.
 *
 * @see packages/db/mkt-alert-channel.ts — LISTEN channel stub
 * @see apps/server/src/websocket.ts — WsClientData and broadcast helpers
 * @see apps/server/src/task-queue-listener.ts — analogous admin bridge
 */

import { createAlertChannelListener, type AlertChannelListenerHandle } from 'db/mkt-alert-channel';

export type { AlertChannelListenerHandle };

/**
 * **Phase 4 scout stub — no-op.**
 *
 * Starts the `mkt_alert_deduplicated` LISTEN connection and bridges each
 * notification to connected trader WebSocket sessions.
 *
 * In scout mode the underlying `createAlertChannelListener` is a no-op stub
 * (no real LISTEN connection is opened because the `mkt_alerts` table and
 * its NOTIFY trigger do not yet exist). The function compiles, starts without
 * error, and returns a handle whose `stop()` is a no-op.
 *
 * ## Phase 4 implementation body (replace the function body below)
 *
 * ```ts
 * export async function startAlertChannelListener(
 *   databaseUrl?: string,
 * ): Promise<AlertChannelListenerHandle> {
 *   const handle = await createAlertChannelListener(async (payload) => {
 *     // 1. Push to the matching trader WebSocket session (< 1 s SLA)
 *     broadcastToTrader(payload.trader_id, 'alert.deduplicated', {
 *       alert_id:   payload.alert_id,
 *       ticker:     payload.ticker,
 *       event_type: payload.event_type,
 *       ts:         payload.ts,
 *     });
 *     // 2. Enqueue ALERT_NOTIFY for outbound channels (fire-and-forget)
 *     await enqueueAlertNotifyTasks(payload.alert_id).catch((err) =>
 *       console.error('[alert-channel] enqueueAlertNotifyTasks failed:', err),
 *     );
 *   }, databaseUrl);
 *
 *   console.log('[alert-channel] Listening on "mkt_alert_deduplicated".');
 *   return handle;
 * }
 * ```
 *
 * @param databaseUrl   Optional override; defaults to DATABASE_URL env var.
 * @returns A handle with a `stop()` method.
 */
export async function startAlertChannelListener(
  databaseUrl?: string,
): Promise<AlertChannelListenerHandle> {
  // Scout stub: delegate to the no-op channel listener.
  // No broadcastToTrader or enqueueAlertNotifyTasks calls yet — those
  // helpers do not exist until Phase 4 implementation lands.
  const handle = await createAlertChannelListener((_payload) => {
    // no-op: Phase 4 implementation routes payload to broadcastToTrader + enqueue
  }, databaseUrl);

  console.log(
    '[alert-channel] Scout stub: mkt_alert_deduplicated listener registered (no-op until Phase 4 DDL).',
  );

  return handle;
}
