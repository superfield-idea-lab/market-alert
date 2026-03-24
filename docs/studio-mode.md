# Studio Mode

## Overview

Studio Mode is a local developer environment where Claude CLI is accessible through a browser chat window while the live Calypso application runs alongside it in an embedded iframe. Changes made by Claude are applied by hot-swapping compiled binaries into a running k3s cluster — the same cluster topology used in demo, staging, and production — without using a Vite dev server.

Studio Mode is started from the command line with `bun run studio` and serves everything from a single host. It is single-user by design: one developer, one browser, one Claude session. There is no authentication, no session persistence, and no multi-tenancy. Chat history lives in the Claude CLI session and is lost when the server stops.

---

## Problem Statement

Standard `bun dev` runs Calypso services as loosely coupled local processes with Vite HMR. This is fast for iteration but does not reflect how the application behaves in the real deployment environment. Container boundaries, service isolation, and the inter-service networking that governs demo, staging, and production are all absent.

Studio Mode closes that gap. It gives a developer full Claude CLI interaction in the browser while the application it is modifying runs inside an isolated cluster — the same isolation model as every other environment — with the modification loop fast enough to be interactive.

---

## Repository Layout

Studio Mode lives in its own repository and is included in this repository as a git submodule at `studio/`:

```
calypso-starter-ts/
  studio/          ← git submodule (studio mode repo)
  apps/
  packages/
  k8s/
  ...
```

The studio submodule contains the studio server, start scripts, and the kustomize overlay. It is versioned independently and pinned here at a specific commit. To initialize after cloning:

```bash
git submodule update --init studio
```

## Host Setup

The following must be present on the studio host before `bun run studio` is invoked:

- The Calypso git repository (working tree, with submodule initialized)
- `bun` and `k3s` (or `k3d`) installed and accessible on `PATH`
- `kubectl` accessible on `PATH`
- A running or startable k3s cluster

Studio Mode does not install dependencies. If prerequisites are absent the start script exits with a clear error.

---

## Architecture

Three things run on the host simultaneously:

```
┌──────────────────────────────────────────────────────────────────┐
│  Host (single exposed port: STUDIO_PORT)                         │
│                                                                  │
│  ┌───────────────────────────┐   ┌────────────────────────────┐ │
│  │  Studio Server            │   │  k3s Cluster               │ │
│  │  (bun, 0.0.0.0:7000)     │   │                            │ │
│  │                           │   │  ┌──────┐  ┌────────────┐ │ │
│  │  • browser UI  (/*)      │   │  │  db  │  │   api      │ │ │
│  │  • app proxy   (/app/)   │──►│  │      │  │            │ │ │
│  │  • api proxy   (/api/)   │──►│  └──────┘  └────────────┘ │ │
│  │  • Claude session          │   │  ┌────────────┐  ┌──────┐ │ │
│  │  • kubectl subprocesses   │──►│  │  web       │  │agents│ │ │
│  │  • SSE cluster events     │   │  │  (static)  │  │      │ │ │
│  └───────────────────────────┘   │  └────────────┘  └──────┘ │ │
│                                  └────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### Studio Server

A single Bun process that is the sole owner of both the Claude CLI subprocess and all `kubectl` subprocesses for the duration of a session. Nothing else on the host should invoke either `claude` or `kubectl` against the studio cluster while the server is running.

Responsibilities:

- Serves the browser interface (chat panel + iframe shell) on `0.0.0.0:STUDIO_PORT`
- Spawns Claude CLI headlessly with a session key, reusing the same session across turns so context is maintained by Claude without replay
- Reverse-proxies cluster HTTP endpoints (ClusterIP services) into the browser — the studio server is the sole ingress point for cluster traffic
- Owns all `kubectl` subprocesses — every cluster command (apply, rollout, delete pod, logs) is spawned by the studio server so stdout and stderr are captured and surfaced to the browser and log files
- Maintains a live view of cluster state via `kubectl get pods --watch` as a long-lived subprocess, pushing state transitions to the browser via server-sent events

The server binds on all interfaces (`0.0.0.0`) because development happens on a networked host. Calypso cluster services bind to localhost only and are not directly reachable from the network — the studio server is the sole ingress point. There is no application-level authentication. Security is a network-perimeter concern — the host is assumed to be on a trusted network behind a firewall, VPN, or private network. Studio Mode MUST NOT be exposed to untrusted networks.

### k3s Cluster

The cluster topology mirrors demo, staging, and production exactly: isolated containers for each service with the same networking and volume configuration. Services:

| Service  | Description                                                   |
| -------- | ------------------------------------------------------------- |
| `db`     | Postgres instance, seeded from the repo's canonical seed      |
| `api`    | The Calypso API server                                        |
| `web`    | Static web assets served by a lightweight HTTP server         |
| `agents` | Background task-queue workers (same as production agent pool) |

The difference from other environments: the cluster **does not pull finalized images from the GitHub container registry**. Instead, the studio kustomize overlay mounts the host's working tree into each container at a predictable path. The studio server builds binaries locally and writes them to the mounted volume. Container processes are then restarted to pick up the new binary — no image rebuild or registry round-trip required.

---

## Browser Interface

The browser connects to the studio server. The UI has two panels:

```
┌──────────────────────────────────────────────────┐
│                                                  │
│  ┌─────────────────┐  ┌─────────────────────┐   │
│  │  Claude Chat    │  │  Calypso App        │   │
│  │  (sidebar)      │  │  (iframe)           │   │
│  │                 │  │                     │   │
│  │  [messages]     │  │  host:STUDIO_PORT/  │   │
│  │                 │  │       app/          │   │
│  │  [input]        │  │                     │   │
│  └─────────────────┘  └─────────────────────┘   │
└──────────────────────────────────────────────────┘
```

**Left panel — Claude Chat**: Streams Claude CLI output in real time. The user types prompts here. Each message is sent to the Claude CLI session via its session key. Claude maintains conversation context across turns — the studio server does not replay history. Claude's response is streamed back to the browser via server-sent events.

**Right panel — Calypso App (iframe)**: The studio server reverse-proxies the cluster's `web` and `api` ClusterIP services so the host only needs to expose a single port. The iframe points at `STUDIO_PORT/app/` which the studio server proxies to the `web` service inside k3s. API requests from the app are proxied similarly under `STUDIO_PORT/api/`. Cluster services bind to localhost only — the studio server is the sole network-reachable ingress point. This avoids exposing NodePorts or additional listening ports on the host.

After a hot-swap the iframe displays a brief overlay:

```
⟳  Reloading — cluster is restarting…
```

The overlay disappears once the studio server confirms the cluster is healthy again. The iframe then refreshes to load the updated application.

---

## Hot-Swap Flow

When Claude makes a code change and the turn completes:

1. The studio server receives a hot-swap trigger (via the post-turn hook or manually from the browser UI).
2. The studio server runs `git diff --name-only` to determine which services are affected.
3. If migration files changed (`packages/core/drizzle/` or equivalent), the studio server runs the migration command (`bun run db:migrate`) before proceeding. Migration output is captured and streamed to the browser.
4. The studio server builds the affected binary or static asset bundle from the working tree. Build stdout and stderr are captured and streamed to the browser.
5. The built artifact is already visible inside the container via the shared volume mount — no copy step is needed.
6. The studio server deletes the affected pods (`kubectl delete pod -l app=<service>`). The deployment controller recreates them, and the new process starts from the updated binary on the volume.
7. The browser iframe shows the reloading overlay and the chat panel shows pod status transitions in real time.
8. Once all affected pods report Ready, the overlay clears and the iframe reloads.

Only the services whose source files changed are restarted. If only `apps/web` changed, only the `web` pod is cycled. If `apps/server` changed, only `api` is cycled.

### Error Handling

- **Build failure (step 4):** The build error is streamed to the browser chat panel. The cluster is untouched — the previous binary remains running. No automatic retry. The developer reads the error and prompts Claude to fix it.
- **Migration failure (step 3):** The migration error is streamed to the browser. Pod cycling does not proceed. The developer decides whether to fix the migration or roll it back.
- **CrashLoopBackOff after restart:** The cluster status stream surfaces the crash loop and container logs in the browser. There is no automatic rollback — the developer reads the logs and prompts Claude to fix the issue or reverts the change manually.
- **Pod restart timeout:** If a pod does not reach Ready within 60 seconds, the studio server logs a timeout warning to the browser. The overlay remains visible. The developer investigates via the cluster status stream.

### Cluster Status Stream

The studio server runs `kubectl get pods --watch` as a long-lived subprocess for the lifetime of the session. Pod state transitions (Pending, Running, Ready, CrashLoopBackOff, Error, etc.) are parsed and pushed to the browser via a server-sent events endpoint (`GET /studio/cluster/events`). The chat panel displays a persistent status indicator: healthy, restarting, or degraded.

---

## Claude CLI Integration

The studio server is the sole owner of Claude for the duration of the session. It invokes Claude headlessly with a session key that persists context across turns:

```
claude --dangerously-skip-permissions --session-key <key> -p "<message>"
```

Each turn reuses the same session key. Claude CLI maintains the full conversation context internally — the studio server sends only the new message for each turn, not the accumulated history. Claude's stdout is streamed to the browser chat panel in real time via server-sent events.

Conversation history is owned by the Claude CLI session. The session key is generated at studio server startup and is not persisted. When the server stops, the session is abandoned. There is no session resume across server restarts.

### Hooks

The studio server registers a post-turn hook with Claude CLI. After each turn completes, the hook:

1. Snapshots `git diff --name-only` against the pre-turn state.
2. Determines which cluster services are affected by the changed files.
3. Triggers the hot-swap flow for those services.

The hook runs synchronously — Claude's next turn does not begin until the hot-swap completes (or fails). This ensures the developer sees the result of each change before prompting again.

### Logging

All Claude CLI turns are logged to `STUDIO_LOG_DIR/YYYY-MM-DD.jsonl` on the host. The default log directory is `../studio-logs/` relative to the repository root. Each log entry includes:

- ISO timestamp
- The user message sent for this turn
- Claude's response for this turn
- Files changed in the turn
- Services restarted and restart duration

Logs are append-only. The log directory is outside the git working tree and is not committed.

---

## Cluster Isomorphism

The k3s cluster used in Studio Mode is defined by the same Kubernetes manifests used for demo, staging, and production. The studio-specific override is a kustomize overlay that lives in the studio submodule at `studio/k8s/overlay/`. It patches the base manifests to:

- Mount the host's working tree (build output directories) into each container as a volume so the running process can read locally-built binaries without an image rebuild
- Override each container's command to start from the binary on the mounted volume rather than the baked-in image binary
- Use base images that contain only the runtime (no application binary), since the binary comes from the volume

No other differences. Service names, networking, secrets structure, and the number and kind of deployments are identical to the other environment overlays.

---

## Starting Studio Mode

```bash
bun run studio
```

The start script (`scripts/studio-start.ts`) performs these steps in order:

1. Checks prerequisites (`bun`, `k3s`, `kubectl`).
2. Verifies the working tree is clean enough to build (warns on uncommitted changes, does not block).
3. Builds all service binaries and static assets from the working tree into the build output directories that the volume mounts expose.
4. Applies the studio kustomize overlay (`kubectl apply -k studio/k8s/overlay`).
5. Waits for all deployments to become healthy.
6. Starts the studio server (which spawns its `kubectl get pods --watch` subprocess and begins reverse-proxying cluster services).
7. Prints the studio URL and opens the browser if `STUDIO_OPEN_BROWSER` is set.

```
⬡ Studio Mode
  Studio:  http://0.0.0.0:7000
  App:     http://0.0.0.0:7000/app/
  API:     http://0.0.0.0:7000/api/
  Cluster: k3s studio overlay active
  Logs:    ../studio-logs/2026-03-24.jsonl
```

### Environment Variables

| Variable                 | Default          | Description                            |
| ------------------------ | ---------------- | -------------------------------------- |
| `STUDIO_PORT`            | `7000`           | Port the studio server listens on      |
| `STUDIO_LOG_DIR`         | `../studio-logs` | Directory for Claude response logs     |
| `STUDIO_OPEN_BROWSER`    | unset            | Set to `1` to auto-open the browser    |
| `STUDIO_CLUSTER_CONTEXT` | `default`        | kubectl context for the studio cluster |

---

## Stopping Studio Mode

`Ctrl+C` sends SIGINT to the studio server process. The server performs a graceful shutdown:

1. Stops accepting new browser connections and SSE subscriptions.
2. Sends SIGTERM to all child processes (Claude CLI, `kubectl` subprocesses) as a process group.
3. Waits up to 5 seconds for child processes to exit.
4. If any child process has not exited after 5 seconds, sends SIGKILL to the process group.
5. Closes the listening socket and exits.

The cluster continues running after the studio server stops — it is not torn down automatically.

To tear down the cluster:

```bash
bun run studio:down
```

This deletes the studio overlay resources from k3s but leaves the k3s daemon running.

---

## Key Files

Files in this repository:

| Path      | Purpose                                    |
| --------- | ------------------------------------------ |
| `studio/` | Git submodule — the studio mode repository |

Files in the studio submodule:

| Path (relative to `studio/`) | Purpose                                                                  |
| ---------------------------- | ------------------------------------------------------------------------ |
| `scripts/studio-start.ts`    | Start script — prerequisite checks, build, cluster apply, server start   |
| `scripts/studio-down.ts`     | Tear down the studio cluster overlay                                     |
| `k8s/overlay/`               | Kustomize overlay — volume mounts, command overrides, base image patches |
| `apps/server/`               | Studio server — browser UI, Claude subprocess, kubectl ownership, proxy  |
