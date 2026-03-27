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
 * The LISTEN connection is managed by `createAdminChannelListener` in the
 * db package, which uses a dedicated single-connection postgres client
 * (the main pool must not be used for LISTEN).
 *
 * The returned handle exposes a `stop()` method to unlisten and close the
 * connection on graceful shutdown.
 */

import { createAdminChannelListener } from 'db/task-queue-worker';
import type { AdminChannelListenerHandle } from 'db/task-queue-worker';
import { broadcastToAdmins } from './websocket';

export type { AdminChannelListenerHandle };

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
): Promise<AdminChannelListenerHandle> {
  const handle = await createAdminChannelListener((payload) => {
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
  }, databaseUrl);

  console.log('[task-queue-listener] Listening on "task_queue_admin" for admin monitor events.');

  return handle;
}
