# Running Demo Mode

This document describes the current Bun-driven local demo lifecycle in this repository.
It is intentionally narrow: it matches the scripts as written, not a proposed or idealized
environment.

## Commands

- `bun run dev` runs the full local demo flow:
  - `bun run scripts/dev-k3d.ts`
  - `bun run db:migrate`
  - `bun run scripts/dev-start.ts`
- `bun run demo` provisions or reuses a k3d cluster, bootstraps the in-cluster
  database, builds the current local release image, deploys it, waits for
  `/health/live`, and then offers an interactive rebuild/redeploy loop.
- `bun run demo:status` prints whether the demo cluster exists.
- `bun run demo:delete` tears down the demo cluster.
- `SUPERFIELD_DEMO_DB_PORT=<port> bun run demo` overrides the host-side Postgres
  load balancer port when `5432` is already occupied.
- `bun run dev:cluster` runs only the k3d bootstrap step.
- `bun run dev:cluster:status` prints whether the local k3d cluster exists.
- `bun run dev:cluster:delete` tears down the local k3d cluster.
- `bun run scripts/dev-start.ts` starts the app/web dev server against an already-running cluster.

## Cluster Bootstrap Lifecycle

`scripts/dev-k3d.ts` is a one-shot bootstrap script. It does not watch files and it does not
reconcile cluster changes after startup.

Execution order:

1. Check whether a k3d cluster named `superfield-dev` exists by parsing `k3d cluster list -o json`.
2. If `--status` is set, print `running` or `not found` and exit.
3. If `--delete` is set, delete the cluster if it exists and exit.
4. Otherwise, create the cluster if missing or reuse it if it already exists.
5. When creating the cluster, bind the load balancer ports `8080:80` and `5432:5432`.
6. Write kubeconfig to `.k3d-kubeconfig`.
7. Apply `k8s/dev/dev-secrets.yaml` and then `k8s/dev/postgres.yaml`.
8. Wait for `kubectl rollout status statefulset/superfield-dev-postgres -n default --timeout=120s`.
9. Print the kubeconfig path and the host-accessible Postgres endpoint on completion.

### What the bootstrap script does not do

- It does not build or load application images.
- It does not wait for any app, web, worker, or ingress resource.
- It does not probe an HTTP route.
- It does not provide a `--watch` or watcher mode.
- It does not delete or recreate resources automatically when files change.

## Local Dev Server

After the cluster is up, `bun run dev` runs `scripts/dev-start.ts`.

That script:

- uses the cluster database URL on `localhost:5432`
- starts the API server with Bun hot mode
- starts Vite in middleware mode so HMR shares the same HTTP server
- binds the web UI to the first free port at or above `5174`
- places the API server on the next port after the chosen web port

If `5174` is occupied, the script searches upward for the first free port and logs the
fallback port it selected.

## Demo vs Production

## Bun Demo Runtime

`scripts/demo.ts` is the cluster-backed Bun demo entry point for the latest local
application code. Its lifecycle is distinct from `bun run dev`:

1. Check whether a k3d cluster named `superfield-demo` already exists.
2. Create the cluster if missing and write kubeconfig to `.k3d-kubeconfig`.
   The host-side Postgres mapping defaults to `5432` and can be overridden with
   `SUPERFIELD_DEMO_DB_PORT`.
3. Apply `k8s/dev/dev-secrets.yaml` and `k8s/dev/postgres.yaml`.
4. Wait for `statefulset/superfield-dev-postgres` to roll out.
5. Run `packages/db/init-remote.ts` against the host-mapped Postgres instance.
6. Build `Dockerfile.release` from the current workspace and import the image into k3d.
7. Render demo secrets plus `k8s/app.yaml`, apply them, and wait for `deployment/superfield-app`.
8. Port-forward `deployment/superfield-app` to the local demo port and wait for `/health/live`.
9. In an interactive terminal, prompt for Enter-to-redeploy or `q` to quit.

`bun run demo --status` and `bun run demo --delete` only inspect or tear down the
demo cluster. They do not rebuild the image or apply manifests.

The local demo flow is k3d-based and uses the `k8s/dev/*` manifests:

- `superfield-dev-postgres`
- `superfield-dev-config`
- `.k3d-kubeconfig`
- host access to Postgres on `localhost:5432`

This is not the production deployment path.

Production-oriented manifests use the top-level `k8s/*.yaml` files, `superfield-secrets`,
and the deploy-time image/tag flow. Those manifests expect real secrets and do not rely
on the dev ConfigMap or the k3d bootstrap script.

## Readiness Scope

The only readiness gate in the bootstrap script is the Postgres StatefulSet rollout.

That means:

- Postgres must be ready before the script exits successfully.
- The script does not assert readiness for the application container or any ingress.
- The script does not validate the `8080` load balancer mapping during startup.
