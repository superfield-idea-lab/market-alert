# Running Demo Mode

This document describes the current Bun-driven local demo lifecycle in this repository.
It is intentionally narrow: it matches the scripts as written, not a proposed or idealized
environment.

## Commands

- `bun run dev` runs the full local demo flow:
  - `bun run scripts/dev-k3d.ts`
  - `bun run db:migrate`
  - `bun run scripts/dev-start.ts`
- `bun run dev:cluster` runs only the k3d bootstrap step.
- `bun run dev:cluster:status` prints whether the local k3d cluster exists.
- `bun run dev:cluster:delete` tears down the local k3d cluster.
- `bun run scripts/dev-start.ts` starts the app/web dev server against an already-running cluster.

## Cluster Bootstrap Lifecycle

`scripts/dev-k3d.ts` is a one-shot bootstrap script. It does not watch files and it does not
reconcile cluster changes after startup.

Execution order:

1. Check whether a k3d cluster named `calypso-dev` exists by parsing `k3d cluster list -o json`.
2. If `--status` is set, print `running` or `not found` and exit.
3. If `--delete` is set, delete the cluster if it exists and exit.
4. Otherwise, create the cluster if missing or reuse it if it already exists.
5. When creating the cluster, bind the load balancer ports `8080:80` and `5432:5432`.
6. Write kubeconfig to `.k3d-kubeconfig`.
7. Apply `k8s/dev/dev-secrets.yaml` and then `k8s/dev/postgres.yaml`.
8. Wait for `kubectl rollout status statefulset/calypso-dev-postgres -n default --timeout=120s`.
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

The local demo flow is k3d-based and uses the `k8s/dev/*` manifests:

- `calypso-dev-postgres`
- `calypso-dev-config`
- `.k3d-kubeconfig`
- host access to Postgres on `localhost:5432`

This is not the production deployment path.

Production-oriented manifests use the top-level `k8s/*.yaml` files, `calypso-secrets`,
and the deploy-time image/tag flow. Those manifests expect real secrets and do not rely
on the dev ConfigMap or the k3d bootstrap script.

## Readiness Scope

The only readiness gate in the bootstrap script is the Postgres StatefulSet rollout.

That means:

- Postgres must be ready before the script exits successfully.
- The script does not assert readiness for the application container or any ingress.
- The script does not validate the `8080` load balancer mapping during startup.
