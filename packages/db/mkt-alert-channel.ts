/**
 * @file mkt-alert-channel.ts
 *
 * ## Phase 4 scout — Alert LISTEN/NOTIFY channel (issue #20)
 *
 * Stub-only integration pass. This module establishes the seam between
 * PostgreSQL LISTEN/NOTIFY and the WebSocket push path described in:
 *   - docs/architecture.md § WebSocket transport
 *   - docs/plan.md § Phase 4
 *   - PRD §9 — sub-second alert delivery SLA
 *
 * ## Canonical integration points
 *
 * The Phase 4 implementation will:
 *   1. Add a `mkt_alert_deduplicated` NOTIFY trigger to the `mkt_alerts` table
 *      (DDL lives in packages/db/mkt-schema.sql). The trigger fires on
 *      `UPDATE ... SET state = 'Deduplicated'` and emits:
 *        pg_notify('mkt_alert_deduplicated', json_build_object(
 *          'alert_id', NEW.id,
 *          'trader_id', NEW.trader_id,
 *          'ticker',    NEW.ticker,
 *          'event_type', NEW.event_type,
 *          'ts', CURRENT_TIMESTAMP
 *        )::text)
 *   2. Create a dedicated single-connection postgres client in `apps/server`
 *      that subscribes to `mkt_alert_deduplicated` — separate from the mkt_app
 *      pool because a pooled connection may not hold LISTEN state reliably
 *      (blueprint rule, same as createAdminChannelListener in task-queue-worker.ts).
 *   3. Forward each notification to connected WebSocket sessions whose
 *      `trader_id` matches `notification.trader_id` (RLS: traders cannot see
 *      other traders' alerts; enforced at the push level, not only at REST).
 *   4. Simultaneously enqueue an ALERT_NOTIFY task for outbound channels
 *      (email, SMS, webhook) — fire-and-forget, does not block the WS push.
 *
 * ## Risks discovered during scout
 *
 * - **Multi-replica fan-out gap**: Each `apps/server` pod holds its own
 *   LISTEN connection. In a multi-replica deployment, the NOTIFY lands on
 *   exactly one pod. If the trader's WebSocket session is on a different pod,
 *   the alert is not pushed. Mitigations: ALB sticky sessions (provisioned,
 *   see k8s/server-ingress.yaml) or a Redis pub/sub fan-out layer. The 1-second
 *   SLA passes in single-pod dev/test. Multi-pod fan-out is deferred to Phase 5.
 *   Captured in docs/architecture.md § Open questions item 3.
 *
 * - **mkt_alerts table does not exist yet**: The DDL (`mkt_alerts`, `mkt_watchlist`,
 *   `mkt_alert_state` enum) is a Phase 4 deliverable. This scout checks for the
 *   channel name only; the NOTIFY trigger must be created atomically with the
 *   table in the schema migration.
 *
 * - **WsClientData must carry trader_id**: The existing `WsClientData` interface
 *   in apps/server/src/websocket.ts has `{ isSuperadmin: boolean }`. Phase 4 must
 *   extend it with `trader_id: string | null` so the server can route push
 *   notifications to the right session without an extra DB lookup per notify.
 *   Downstream issue scope: apps/server/src/websocket.ts, apps/server/src/index.ts
 *   (upgrade handler must extract trader_id from the session JWT).
 *
 * - **ALERT_NOTIFY idempotency key**: notify:<alert_id>:<channel> — the channel
 *   dimension means one task per outbound channel per alert. See task-queue.ts
 *   TASK_TYPE_AGENT_MAP for the registered task type.
 *
 * ## Not implemented here (Phase 4 follow-on)
 *
 * - Real mkt_alerts DDL / migration
 * - Watchlist schema (mkt_watchlist) and RLS policies
 * - Playwright E2E test (merge gate for Phase 4)
 * - Full trader auth session middleware
 *
 * @see packages/db/task-queue-worker.ts — createAdminChannelListener (analogous LISTEN seam)
 * @see apps/server/src/alert-channel-listener.ts — server-side bridge stub
 * @see apps/server/src/websocket.ts — WsClientData (must be extended in Phase 4)
 */

import postgres from 'postgres';
import { resolveDatabaseUrls, buildSslOptions } from './index';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Shape of the JSON payload emitted by the `mkt_alert_deduplicated` NOTIFY
 * trigger when an alert transitions to Deduplicated state.
 *
 * Phase 4 implementation: the DDL trigger must produce exactly this shape.
 * Any field addition is a backward-compatible extension; removals are breaking.
 */
export interface AlertDeduplicatedPayload {
  /** UUID of the deduplicated alert row. */
  alert_id: string;
  /** UUID of the trader who owns this alert (used for WebSocket session routing). */
  trader_id: string;
  /** Watchlist ticker symbol, e.g. "AAPL". */
  ticker: string;
  /** Filing event type, e.g. "8-K", "10-Q". */
  event_type: string;
  /** ISO-8601 timestamp when the alert reached Deduplicated state. */
  ts: string;
}

/**
 * Callback invoked for each valid notification on the `mkt_alert_deduplicated`
 * channel. Malformed payloads are dropped before the callback is called.
 */
export type AlertDeduplicatedCallback = (payload: AlertDeduplicatedPayload) => void;

/**
 * Handle returned by {@link createAlertChannelListener}.
 * Mirrors the AdminChannelListenerHandle interface in task-queue-worker.ts.
 */
export interface AlertChannelListenerHandle {
  /** Unlistens from the channel and closes the dedicated connection. */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Scout stub — no-op implementation
// ---------------------------------------------------------------------------

/**
 * **Phase 4 scout stub — no-op.**
 *
 * Establishes the public API seam for the `mkt_alert_deduplicated` LISTEN
 * channel. The function signature, interface types, and channel name are
 * production-final; the implementation is intentionally a no-op until the
 * `mkt_alerts` table and its NOTIFY trigger exist.
 *
 * Calling this stub returns a handle whose `stop()` is a no-op. The
 * `onNotify` callback is never invoked.
 *
 * ## When to promote to real implementation
 *
 * Replace this stub once:
 *   1. `mkt_alerts` DDL is migrated (mkt-schema.sql, Phase 4 milestone).
 *   2. The `mkt_alert_deduplicated` NOTIFY trigger is present in the schema.
 *   3. apps/server/src/alert-channel-listener.ts calls this function.
 *
 * The real implementation should follow createAdminChannelListener verbatim,
 * substituting `mkt_alert_deduplicated` for `task_queue_admin` and parsing
 * the payload as {@link AlertDeduplicatedPayload}.
 *
 * @param onNotify      Callback invoked with parsed alert payload.
 * @param databaseUrl   Optional override; defaults to DATABASE_URL env var.
 *
 * @returns A handle with a `stop()` method (no-op in scout mode).
 */
export async function createAlertChannelListener(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onNotify: AlertDeduplicatedCallback,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  databaseUrl?: string,
): Promise<AlertChannelListenerHandle> {
  // Scout stub: do not open a real LISTEN connection because the
  // `mkt_alert_deduplicated` channel and its trigger do not exist yet.
  // Phase 4 implementation replaces the body below with:
  //
  //   const url = databaseUrl ?? resolveDatabaseUrls().app;
  //   const listenSql = createListenConnection(url);
  //   const listenMeta = await listenSql.listen('mkt_alert_deduplicated', (raw) => {
  //     let parsed: AlertDeduplicatedPayload;
  //     try {
  //       parsed = JSON.parse(raw) as AlertDeduplicatedPayload;
  //     } catch {
  //       console.warn('[alert-channel] malformed payload, dropping:', raw);
  //       return;
  //     }
  //     onNotify(parsed);
  //   });
  //   return {
  //     async stop() {
  //       try { await listenMeta.unlisten(); } catch {}
  //       await listenSql.end({ timeout: 5 });
  //     },
  //   };

  // Suppress unused-import lint errors: resolveDatabaseUrls and buildSslOptions
  // are referenced here to keep the import live so the Phase 4 swap-in is
  // a single-line diff rather than requiring new imports.
  void resolveDatabaseUrls;
  void buildSslOptions;
  void postgres;

  return {
    async stop(): Promise<void> {
      // no-op in scout mode
    },
  };
}

/**
 * Parses a raw NOTIFY payload string as an {@link AlertDeduplicatedPayload}.
 *
 * Returns `null` for any payload that cannot be parsed or does not contain
 * the mandatory `alert_id` and `trader_id` fields.
 *
 * Extracted as a pure function so it can be unit-tested without a live
 * PostgreSQL connection.
 *
 * @param raw  The raw string received from pg_notify.
 */
export function parseAlertDeduplicatedPayload(raw: string): AlertDeduplicatedPayload | null {
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
  return obj as AlertDeduplicatedPayload;
}
