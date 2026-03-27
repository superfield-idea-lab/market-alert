/**
 * @file task-queue-listener
 *
 * Subscribes to the `task_queue_admin` PostgreSQL LISTEN/NOTIFY channel and
 * forwards task queue events to connected superadmin WebSocket clients.
 *
 * The DB triggers `trg_task_queue_notify` (INSERT) and
 * `trg_task_queue_admin_notify` (UPDATE) both publish JSON payloads to
 * `task_queue_admin`. This module receives those notifications and calls
 * `broadcastToAdmins` so the admin dashboard can update in real time.
 *
 * A dedicated single-connection postgres client is used for LISTEN because
 * the main pool multiplexes connections and must not be used for LISTEN.
 *
 * The returned handle exposes a `stop()` method to unlisten and close the
 * connection on graceful shutdown.
 */

import postgres from 'postgres';
import { resolveDatabaseUrls, buildSslOptions } from 'db';
import { broadcastToAdmins } from './websocket';

export interface TaskQueueListenerHandle {
  /** Stops listening and closes the dedicated connection. */
  stop(): Promise<void>;
}

/**
 * Starts the `task_queue_admin` LISTEN connection.
 *
 * Parses each notification payload as JSON and broadcasts the event to all
 * connected superadmin WebSocket clients via `broadcastToAdmins`.
 *
 * Malformed notification payloads are silently dropped with a warning.
 *
 * @param databaseUrl - Optional override; defaults to DATABASE_URL env var.
 * @returns A handle with a `stop()` method.
 */
export async function startTaskQueueListener(
  databaseUrl?: string,
): Promise<TaskQueueListenerHandle> {
  const url = databaseUrl ?? resolveDatabaseUrls().app;

  const listenSql = postgres(url, {
    max: 1,
    idle_timeout: 0,
    connect_timeout: 10,
    ssl: buildSslOptions(),
    connection: { client_min_messages: 'warning' },
  });

  const channel = 'task_queue_admin';

  const listenMeta = await listenSql.listen(channel, (payload) => {
    let parsed: { event: string; [key: string]: unknown };
    try {
      parsed = JSON.parse(payload) as typeof parsed;
    } catch {
      console.warn('[task-queue-listener] malformed notification payload, dropping:', payload);
      return;
    }

    const { event, ...data } = parsed;
    if (typeof event !== 'string') {
      console.warn('[task-queue-listener] notification missing event field, dropping:', payload);
      return;
    }

    broadcastToAdmins(event, data);
  });

  console.log(`[task-queue-listener] Listening on "${channel}" for admin monitor events.`);

  return {
    async stop() {
      try {
        await listenMeta.unlisten();
      } catch {
        // Best-effort unlisten; connection may already be closed.
      }
      await listenSql.end({ timeout: 5 });
      console.log('[task-queue-listener] Stopped.');
    },
  };
}
