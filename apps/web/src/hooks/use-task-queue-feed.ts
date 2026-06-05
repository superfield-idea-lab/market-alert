/**
 * @file use-task-queue-feed.ts
 *
 * Real-time task queue feed hook for superadmin Agent Queue view (issue #115).
 *
 * Provides `useTaskQueueFeed` which:
 *   1. Fetches the current task queue snapshot via GET /api/tasks-queue on mount.
 *   2. Subscribes to the WebSocket connection at GET /ws, filtering for
 *      `task_queue.created` and `task_queue.updated` events broadcast by
 *      `broadcastToAdmins` (apps/server/src/websocket.ts).
 *   3. Inserts new tasks and updates existing task rows in-place without a
 *      full re-fetch.
 *   4. Reconnects with exponential backoff (100 ms → cap 5 000 ms) on close.
 *
 * Only mounted by superadmin users (enforced in App.tsx via user.isSuperadmin).
 *
 * ## Canonical docs
 * - docs/prd.md — superadmin task queue monitoring
 * - apps/server/src/task-queue-listener.ts — server-side push bridge
 * - apps/server/src/websocket.ts — broadcastToAdmins
 * - packages/db/schema.sql — trg_task_queue_notify / trg_task_queue_admin_notify
 *
 * @see apps/web/src/pages/agent-task-queue.tsx — consumer
 * @see https://github.com/superfield-idea-lab/market-alert/issues/115
 */

import { useEffect, useReducer } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskQueueStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'submitting'
  | 'completed'
  | 'failed'
  | 'dead';

export interface TaskQueueRow {
  id: string;
  agent_type: string;
  job_type: string;
  status: TaskQueueStatus;
  attempt: number;
  created_at: string;
  updated_at: string;
}

export type FeedStatus = 'idle' | 'loading' | 'connecting' | 'connected' | 'disconnected' | 'error';

export interface TaskQueueFeedState {
  tasks: TaskQueueRow[];
  status: FeedStatus;
  error: string | null;
}

// ---------------------------------------------------------------------------
// WebSocket task event — partial shape emitted by broadcastToAdmins
// ---------------------------------------------------------------------------

interface TaskQueueEvent {
  id: string;
  status: TaskQueueStatus;
  agent_type: string;
  job_type: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

type Action =
  | { type: 'SET_STATUS'; status: FeedStatus }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'LOAD_TASKS'; tasks: TaskQueueRow[] }
  | { type: 'UPSERT_TASK'; task: TaskQueueRow };

const MAX_TASKS = 200;

function reducer(state: TaskQueueFeedState, action: Action): TaskQueueFeedState {
  switch (action.type) {
    case 'SET_STATUS':
      return { ...state, status: action.status };
    case 'SET_ERROR':
      return { ...state, status: 'error', error: action.error };
    case 'LOAD_TASKS':
      return { ...state, tasks: action.tasks, status: 'connecting' };
    case 'UPSERT_TASK': {
      const idx = state.tasks.findIndex((t) => t.id === action.task.id);
      if (idx >= 0) {
        // Update in-place
        const updated = [...state.tasks];
        updated[idx] = action.task;
        return { ...state, tasks: updated };
      }
      // Insert at front, cap at MAX_TASKS
      return { ...state, tasks: [action.task, ...state.tasks].slice(0, MAX_TASKS) };
    }
    default:
      return state;
  }
}

const initialState: TaskQueueFeedState = {
  tasks: [],
  status: 'idle',
  error: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wsOrigin(): string {
  return window.location.origin.replace(/^http/, 'ws');
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Fetches the task queue snapshot and subscribes to live WebSocket updates.
 *
 * @returns Current feed state including tasks, connection status, and any error.
 */
export function useTaskQueueFeed(): TaskQueueFeedState {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    let stopped = false;
    let ws: WebSocket | undefined;
    let backoffMs = 100;

    // Step 1: fetch initial snapshot
    dispatch({ type: 'SET_STATUS', status: 'loading' });
    fetch('/api/tasks-queue', { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => String(res.status));
          dispatch({ type: 'SET_ERROR', error: `GET /api/tasks-queue failed: ${text}` });
          return;
        }
        const data = (await res.json()) as { tasks: TaskQueueRow[] };
        dispatch({ type: 'LOAD_TASKS', tasks: data.tasks });

        if (stopped) return;

        // Step 2: open WebSocket for live updates
        function connect() {
          if (stopped) return;
          ws = new WebSocket(`${wsOrigin()}/ws`);
          dispatch({ type: 'SET_STATUS', status: 'connecting' });

          ws.onopen = () => {
            if (stopped) {
              ws?.close();
              return;
            }
            dispatch({ type: 'SET_STATUS', status: 'connected' });
            backoffMs = 100;
          };

          ws.onclose = () => {
            if (stopped) return;
            dispatch({ type: 'SET_STATUS', status: 'disconnected' });
            const delay = Math.min((backoffMs *= 2), 5000);
            setTimeout(connect, delay);
          };

          ws.onerror = () => {
            // onclose fires after onerror — reconnect handled there
          };

          ws.onmessage = (evt) => {
            let parsed: { event: string; [key: string]: unknown };
            try {
              parsed = JSON.parse(evt.data as string) as typeof parsed;
            } catch {
              return;
            }
            if (parsed.event === 'task_queue.created' || parsed.event === 'task_queue.updated') {
              const d = parsed as unknown as TaskQueueEvent;
              dispatch({
                type: 'UPSERT_TASK',
                task: {
                  id: d.id,
                  agent_type: d.agent_type,
                  job_type: d.job_type,
                  status: d.status,
                  attempt: 0,
                  created_at: d.created_at,
                  updated_at: d.updated_at,
                },
              });
            }
          };
        }

        connect();
      })
      .catch((err: unknown) => {
        if (!stopped) {
          dispatch({
            type: 'SET_ERROR',
            error: err instanceof Error ? err.message : 'Network error',
          });
        }
      });

    return () => {
      stopped = true;
      ws?.close();
    };
  }, []);

  return state;
}
