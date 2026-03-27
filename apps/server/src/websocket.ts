/**
 * @file websocket
 * Manages connected WebSocket clients and provides fire-and-forget
 * broadcast helpers used by mutation handlers to push entity change events.
 *
 * Clients connect via `GET /ws`. The JWT is validated before the upgrade;
 * unauthenticated requests receive HTTP 401 and are not upgraded.
 *
 * Message format: `{"event": "task.created" | "task.updated" | "task.deleted", "data": {...}}`
 *
 * WebSocket upgrade data shape: `{ isSuperadmin: boolean }`
 * Task queue events are restricted to superadmin connections.
 */

import type { ServerWebSocket } from 'bun';

/** Per-connection data attached during the WebSocket upgrade. */
export interface WsClientData {
  isSuperadmin: boolean;
}

/** The set of all currently connected WebSocket clients. */
const clients = new Set<ServerWebSocket<WsClientData>>();

/**
 * Bun WebSocket lifecycle handler — attach to the `websocket` key on the
 * Bun.serve config object.
 */
export const websocketHandler = {
  open(ws: ServerWebSocket<WsClientData>): void {
    clients.add(ws);
  },
  close(ws: ServerWebSocket<WsClientData>): void {
    clients.delete(ws);
  },
  // Required by the Bun WebSocket handler interface.
  // Clients do not send messages in this protocol; incoming messages are dropped.
  message(ws: ServerWebSocket<WsClientData>, message: string | Buffer): void {
    void ws;
    void message;
  },
};

/**
 * Broadcasts an entity change event to all connected clients.
 * Fire-and-forget: does not block the calling HTTP response.
 *
 * @param event - The event type, e.g. `"task.created"`.
 * @param data  - The event payload.
 */
export function broadcast(event: string, data: unknown): void {
  if (clients.size === 0) return;
  const message = JSON.stringify({ event, data });
  for (const ws of clients) {
    try {
      ws.send(message);
    } catch {
      // Silently remove a client that failed to receive the message.
      clients.delete(ws);
    }
  }
}

/**
 * Broadcasts a task queue event to superadmin WebSocket clients only.
 * Non-superadmin connections do not receive task queue events.
 * Fire-and-forget: does not block the calling HTTP response.
 *
 * @param event - The event type, e.g. `"task_queue.updated"`.
 * @param data  - The event payload.
 */
export function broadcastToAdmins(event: string, data: unknown): void {
  if (clients.size === 0) return;
  const message = JSON.stringify({ event, data });
  for (const ws of clients) {
    if (!ws.data?.isSuperadmin) continue;
    try {
      ws.send(message);
    } catch {
      // Silently remove a client that failed to receive the message.
      clients.delete(ws);
    }
  }
}

/** Exposed for testing only. Returns the current connected-client count. */
export function connectedClientCount(): number {
  return clients.size;
}
