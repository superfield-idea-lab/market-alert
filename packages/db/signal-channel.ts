/**
 * @file signal-channel.ts
 *
 * ## Phase scout — Signal LISTEN/NOTIFY channel (issue #84)
 *
 * Stub-only integration pass. This module establishes the seam between
 * PostgreSQL LISTEN/NOTIFY and the WebSocket push path described in:
 *   - docs/architecture.md § WebSocket transport
 *   - docs/architecture.md §"Signal routing" — "Delivered" state transition
 *   - docs/prd.md §9 — sub-second alert delivery SLA
 *   - docs/implementation-plan.md § Signal delivery phase
 *
 * ## Behaviour
 *
 * A signal entering `Delivered` state triggers a `pg_notify('signal_delivered', payload)`
 * event. The server holds one persistent LISTEN connection on this channel and
 * forwards each notification over the authenticated WebSocket to the researcher
 * dashboard, which renders the signal live.
 *
 * ## Canonical integration points
 *
 * The implementation will:
 *   1. Add a `signal_delivered` NOTIFY trigger to the `signals` table
 *      (DDL lives in packages/db/mkt-schema.sql or signal-store.ts). The trigger
 *      fires on `UPDATE ... SET status = 'Delivered'` and emits:
 *        pg_notify('signal_delivered', json_build_object(
 *          'signal_id',     NEW.id,
 *          'researcher_id', NEW.researcher_id,
 *          'tenant_id',     NEW.tenant_id,
 *          'ticker',        NEW.ticker,
 *          'event_type',    NEW.event_type,
 *          'rationale',     NEW.rationale,
 *          'confidence',    NEW.confidence,
 *          'ts',            CURRENT_TIMESTAMP
 *        )::text)
 *   2. Create a dedicated single-connection postgres client in `apps/server`
 *      that subscribes to `signal_delivered` — separate from the mkt_app pool
 *      because a pooled connection may not hold LISTEN state reliably
 *      (blueprint rule, same as createAdminChannelListener in task-queue-worker.ts).
 *   3. Forward each notification to connected WebSocket sessions whose
 *      `WsClientData.researcher_id` matches `notification.researcher_id`
 *      (RLS: researchers cannot see other researchers' signals; enforced at
 *      push level, not only at REST).
 *   4. The WebSocket upgrade handler in apps/server/src/index.ts must extract
 *      `researcher_id` from the session JWT and attach it to `WsClientData`.
 *
 * ## Risks discovered during scout
 *
 * - **Multi-replica fan-out gap**: Each `apps/server` pod holds its own
 *   LISTEN connection. In a multi-replica deployment, the NOTIFY lands on
 *   exactly one pod. If the researcher's WebSocket session is on a different
 *   pod, the signal is not pushed. Mitigations: ALB sticky sessions (provisioned,
 *   see k8s/server-ingress.yaml) or a Redis pub/sub fan-out layer. The 1-second
 *   SLA passes in single-pod dev/test. Multi-pod fan-out is deferred to a later
 *   phase. See docs/architecture.md § Open questions.
 *
 * - **`signals` table DDL not yet finalised**: The trigger DDL must be added
 *   atomically with the `signal_delivered` channel name in the schema migration.
 *   This scout checks for the channel name only.
 *
 * - **`WsClientData` must carry `researcher_id`**: The existing `WsClientData`
 *   interface in apps/server/src/websocket.ts has `{ isSuperadmin: boolean }`.
 *   The implementation must extend it with `researcher_id: string | null` so
 *   the server can route push notifications without an extra DB lookup per notify.
 *   Downstream scope: apps/server/src/websocket.ts, apps/server/src/index.ts
 *   (upgrade handler must extract researcher_id from the session JWT).
 *
 * - **Reconnect missed-event gap**: Native WebSocket does not buffer events
 *   during disconnects. The researcher dashboard must fall back to GET /api/signals
 *   polling on reconnect to recover missed signals. This is a follow-on scope item.
 *
 * - **Unauthenticated upgrade rejection**: The WebSocket upgrade at `GET /ws`
 *   already validates the session cookie (see apps/server/src/index.ts upgrade
 *   handler). The implementation must confirm that unauthenticated upgrades return
 *   HTTP 401 rather than being silently ignored.
 *
 * ## Not implemented here (follow-on implementation issues)
 *
 * - Real `signal_delivered` DDL trigger / migration
 * - `WsClientData.researcher_id` field and upgrade handler update
 * - `broadcastToResearcher` helper in websocket.ts
 * - `SignalFeedContext` provider wired to `useSignalFeed` hook
 * - Playwright E2E test for sub-second SLA (merge gate)
 *
 * @see packages/db/mkt-alert-channel.ts — analogous alert channel stub (issue #20)
 * @see packages/db/task-queue-worker.ts — createAdminChannelListener (analogous LISTEN seam)
 * @see apps/server/src/signal-channel-listener.ts — server-side bridge stub
 * @see apps/server/src/websocket.ts — WsClientData (must be extended in implementation)
 * @see https://github.com/superfield-idea-lab/market-alert/issues/84
 */

import postgres from 'postgres';
import { resolveDatabaseUrls, buildSslOptions } from './index';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Shape of the JSON payload emitted by the `signal_delivered` NOTIFY trigger
 * when a signal transitions to Delivered state.
 *
 * Implementation: the DDL trigger must produce exactly this shape.
 * Any field addition is a backward-compatible extension; removals are breaking.
 */
export interface SignalDeliveredPayload {
  /** UUID of the delivered signal row. */
  signal_id: string;
  /** UUID of the researcher who owns this signal (used for WebSocket session routing). */
  researcher_id: string;
  /** UUID of the tenant. */
  tenant_id: string;
  /** Watchlist ticker symbol, e.g. "AAPL". */
  ticker: string;
  /** Filing event type, e.g. "8-K". */
  event_type: string;
  /** Structured markdown rationale generated by the event-evaluator. */
  rationale: string;
  /** Composite confidence score (source_trust × extraction_certainty), in [0.0, 1.0]. */
  confidence: number;
  /** ISO-8601 timestamp when the signal reached Delivered state. */
  ts: string;
}

/**
 * Callback invoked for each valid notification on the `signal_delivered` channel.
 * Malformed payloads are dropped before the callback is called.
 */
export type SignalDeliveredCallback = (payload: SignalDeliveredPayload) => void;

/**
 * Handle returned by {@link createSignalChannelListener}.
 * Mirrors the AdminChannelListenerHandle interface in task-queue-worker.ts.
 */
export interface SignalChannelListenerHandle {
  /** Unlistens from the channel and closes the dedicated connection. */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Scout stub — no-op implementation
// ---------------------------------------------------------------------------

/**
 * **Scout stub — no-op.**
 *
 * Establishes the public API seam for the `signal_delivered` LISTEN channel.
 * The function signature, interface types, and channel name are production-final;
 * the implementation is intentionally a no-op until the `signals` table NOTIFY
 * trigger exists.
 *
 * Calling this stub returns a handle whose `stop()` is a no-op. The
 * `onNotify` callback is never invoked.
 *
 * ## When to promote to real implementation
 *
 * Replace this stub once:
 *   1. The `signal_delivered` NOTIFY trigger is present in the schema.
 *   2. `WsClientData` carries `researcher_id` (websocket.ts).
 *   3. `broadcastToResearcher(researcher_id, event, data)` is implemented in websocket.ts.
 *   4. apps/server/src/signal-channel-listener.ts calls this function.
 *
 * The real implementation should follow createAdminChannelListener verbatim,
 * substituting `signal_delivered` for `task_queue_admin` and parsing the
 * payload as {@link SignalDeliveredPayload}.
 *
 * @param onNotify      Callback invoked with parsed signal payload.
 * @param databaseUrl   Optional override; defaults to DATABASE_URL env var.
 *
 * @returns A handle with a `stop()` method (no-op in scout mode).
 */
export async function createSignalChannelListener(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onNotify: SignalDeliveredCallback,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  databaseUrl?: string,
): Promise<SignalChannelListenerHandle> {
  // Scout stub: do not open a real LISTEN connection because the
  // `signal_delivered` channel and its trigger do not exist yet.
  // Implementation replaces the body below with:
  //
  //   const url = databaseUrl ?? resolveDatabaseUrls().app;
  //   const listenSql = postgres(url, { max: 1, ssl: buildSslOptions(url) });
  //   const listenMeta = await listenSql.listen('signal_delivered', (raw) => {
  //     let parsed: SignalDeliveredPayload;
  //     try {
  //       parsed = JSON.parse(raw) as SignalDeliveredPayload;
  //     } catch {
  //       console.warn('[signal-channel] malformed payload, dropping:', raw);
  //       return;
  //     }
  //     if (!parsed.signal_id || !parsed.researcher_id) {
  //       console.warn('[signal-channel] payload missing required fields, dropping:', raw);
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
  // are referenced here to keep the import live so the implementation swap-in is
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
 * Parses a raw NOTIFY payload string as a {@link SignalDeliveredPayload}.
 *
 * Returns `null` for any payload that cannot be parsed or does not contain
 * the mandatory `signal_id` and `researcher_id` fields.
 *
 * Extracted as a pure function so it can be unit-tested without a live
 * PostgreSQL connection.
 *
 * @param raw  The raw string received from pg_notify.
 */
export function parseSignalDeliveredPayload(raw: string): SignalDeliveredPayload | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof obj !== 'object' ||
    obj === null ||
    typeof (obj as Record<string, unknown>).signal_id !== 'string' ||
    typeof (obj as Record<string, unknown>).researcher_id !== 'string'
  ) {
    return null;
  }
  return obj as SignalDeliveredPayload;
}
