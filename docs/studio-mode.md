# Studio Mode

## Overview

Studio Mode is a local developer environment where Claude CLI is accessible through a browser chat window while the live Calypso application runs alongside it in an embedded iframe. Changes made by Claude are applied by hot-swapping compiled binaries into a running k3s cluster — the same cluster topology used in demo, staging, and production — without using a Vite dev server.

Studio Mode is started from the command line with `bun run studio` and serves everything from a single host.

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
- Docker or containerd available for container image builds
- A running or startable k3s cluster

Studio Mode does not install dependencies. If prerequisites are absent the start script exits with a clear error.

---

## Architecture

Three things run on the host simultaneously:

```
┌──────────────────────────────────────────────────────────────┐
│  Host                                                        │
│                                                              │
│  ┌─────────────────────────┐   ┌──────────────────────────┐ │
│  │  Studio Server          │   │  k3s Cluster             │ │
│  │  (bun, single process)  │   │                          │ │
│  │                         │   │  ┌──────┐  ┌──────────┐  │ │
│  │  • browser interface    │   │  │  db  │  │   api    │  │ │
│  │  • Claude CLI hooks     │◄──┼──│      │  │          │  │ │
│  │  • response logging     │   │  └──────┘  └──────────┘  │ │
│  │  • hot-swap command     │──►│  ┌──────────┐  ┌───────┐  │ │
│  │                         │   │  │  web     │  │agents │  │ │
│  └─────────────────────────┘   │  │  static  │  │       │  │ │
│                                │  └──────────┘  └───────┘  │ │
│                                └──────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### Studio Server

A single Bun process that:

- Serves the browser interface (chat panel + iframe shell)
- Provides a Claude CLI hook endpoint that captures `claude` subprocess output and streams it to the browser
- Owns all `kubectl` subprocesses — every cluster command (apply, rollout, cp, logs, status) is spawned by the studio server so its stdout and stderr are captured and made available to the browser and log files
- Maintains a live view of cluster state by polling deployment and pod status on a short interval and pushing updates to connected browsers via server-sent events

The studio server is the single process responsible for all cluster interaction. Nothing else on the host should invoke `kubectl` for the studio cluster during an active session. This ownership ensures that cluster events — rollouts, restarts, pod crashes, log output — are always captured and never lost to a fire-and-forget shell call.

### k3s Cluster

The cluster topology mirrors demo, staging, and production exactly: isolated containers for each service with the same networking and volume configuration. Services:

| Service  | Description                                              |
| -------- | -------------------------------------------------------- |
| `db`     | Postgres instance, seeded from the repo's canonical seed |
| `api`    | The Calypso API server                                   |
| `web`    | Static web assets served by a lightweight HTTP server    |
| `agents` | Background agent workers                                 |

The difference from other environments: the cluster **does not pull finalized images from the GitHub container registry**. Instead, the studio server builds binaries locally from the working tree and injects them into running containers, then restarts affected services.

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
│  │  [messages]     │  │  localhost:WEBAPP   │   │
│  │                 │  │                     │   │
│  │  [input]        │  │                     │   │
│  └─────────────────┘  └─────────────────────┘   │
└──────────────────────────────────────────────────┘
```

**Left panel — Claude Chat**: Streams Claude CLI output in real time. The user types prompts here. The studio server invokes `claude` as a subprocess with the appropriate flags and pipes stdout back to the browser via server-sent events.

**Right panel — Calypso App (iframe)**: Points at the `web` service running in the k3s cluster. After a hot-swap the iframe displays a brief overlay:

```
⟳  Reloading — cluster is restarting…
```

The overlay disappears once the studio server confirms the cluster is healthy again. The iframe then refreshes to load the updated application.

---

## Hot-Swap Flow

When Claude makes a code change and the turn completes:

1. The studio server receives a hot-swap trigger (via a Claude CLI post-turn hook or manually from the browser UI).
2. The studio server determines which services are affected from `git diff --name-only`.
3. The studio server builds the affected binary or static asset bundle from the working tree. Build stdout and stderr are captured and logged.
4. The studio server spawns `kubectl cp` to copy the binary into the running container. All subprocess output is captured.
5. The studio server spawns a rolling restart (`kubectl rollout restart deployment/<name>`) for each affected deployment. All subprocess output is captured.
6. The browser iframe shows the reloading overlay and the chat panel shows a live cluster status stream.
7. The studio server polls `kubectl rollout status` — as a owned subprocess — until all affected deployments report healthy. Poll output is streamed to the browser.
8. The overlay clears and the iframe reloads.

Only the services whose source files changed are restarted. If only `apps/web` changed, only the `web` deployment restarts. If `apps/server` changed, only `api` restarts. If a database migration ran, `api` restarts after the migration completes.

### Cluster Status Stream

The studio server maintains a continuous view of the cluster by running `kubectl get pods --watch` as a long-lived subprocess. Pod state transitions (Pending → Running → Ready, or CrashLoopBackOff, etc.) are parsed from its output and pushed to the browser via a server-sent events endpoint (`GET /studio/cluster/events`). The browser chat panel displays an unobtrusive status indicator showing whether all pods are healthy, restarting, or degraded.

---

## Claude CLI Integration

The studio server invokes `claude` as a subprocess:

```
claude --dangerously-skip-permissions -p "<prompt>"
```

Claude's stdout is streamed to the browser chat panel in real time.

### Hooks

The studio server registers a post-turn hook with Claude CLI. After each turn completes, the hook:

1. Inspects which files changed (via `git diff --name-only`).
2. Determines which cluster services are affected.
3. Triggers the hot-swap flow for those services.

### Logging

All Claude CLI invocations and responses are logged to `logs/studio/YYYY-MM-DD.jsonl` on the host. Each log entry includes:

- ISO timestamp
- The full prompt sent
- The full response received
- Files changed in the turn
- Services restarted and restart duration

Logs are append-only and written outside the git working tree by default (`../studio-logs/` relative to the repo root, configurable via `STUDIO_LOG_DIR`).

---

## Cluster Isomorphism

The k3s cluster used in Studio Mode is defined by the same Kubernetes manifests used for demo, staging, and production. The studio-specific override is a `kustomize` overlay at `k8s/overlays/studio/` that:

- Sets image references to local image names rather than registry tags
- Mounts the repo's working tree into containers at a predictable path for hot-swap access
- Configures `imagePullPolicy: Never` so k3s uses locally loaded images

No other differences. Service names, port assignments, secrets structure, and volume layout are identical to the other overlays.

---

## Starting Studio Mode

```bash
bun run studio
```

The start script (`scripts/studio-start.ts`) performs these steps in order:

1. Checks prerequisites (`bun`, `k3s`, `kubectl`, `docker` or `nerdctl`).
2. Verifies the working tree is on a clean-enough state to build (warns on uncommitted changes, does not block).
3. Builds all service images from the working tree.
4. Loads images into the k3s image store.
5. Applies the studio kustomize overlay (`kubectl apply -k k8s/overlays/studio`).
6. Waits for all deployments to become healthy.
7. Starts the studio server.
8. Prints the studio URL and opens the browser if `STUDIO_OPEN_BROWSER` is set.

```
⬡ Studio Mode
  App:     http://localhost:STUDIO_PORT
  Cluster: k3s studio overlay active
  Logs:    ../studio-logs/YYYY-MM-DD.jsonl
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

`Ctrl+C` on the studio server process is sufficient. The cluster continues running until explicitly torn down.

To tear down the cluster:

```bash
bun run studio:down
```

This deletes the studio overlay resources from k3s but leaves the k3s daemon running.

---

## Key Files

Files in this repository:

| Path                   | Purpose                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| `studio/`              | Git submodule — the studio mode repository                            |
| `k8s/overlays/studio/` | Kustomize overlay for studio mode cluster (may live in the submodule) |

Files in the studio submodule:

| Path (relative to `studio/`) | Purpose                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `scripts/studio-start.ts`    | Start script — prerequisite checks, image build, cluster apply, server start |
| `scripts/studio-down.ts`     | Tear down the studio cluster overlay                                         |
| `apps/server/`               | Studio server — browser interface, Claude CLI hooks, hot-swap coordinator    |
| `logs/`                      | Claude response logs (git-ignored)                                           |
