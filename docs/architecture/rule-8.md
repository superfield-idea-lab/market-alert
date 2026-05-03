# Rule 8: process — Process & Runtime

## Summary of the blueprint rule

The PROCESS blueprint defines a **state-machine-first development process** designed for agent-driven software delivery. Its core insight is that an AI agent has no memory between sessions, no tribal context, and no intuition about priority — so all of that must be made machine-readable and explicit.

The rule is organized around three interlocking ideas:

**Threats it mitigates.** The blueprint identifies ten structural threats to agent-driven development: no prior context (PROCESS-T-001), premature feature work (T-002), priority inversion (T-004), conflicting parallel plans (T-005), stale plans after commits (T-006), gate skipping (T-011), and merging without required CI checks (T-012). Each threat has a named mitigation in the principles and design patterns.

**Principles it enforces.** Key principles include:

- `commit-is-unit-of-progress` (PROCESS-P-001): every meaningful state change is a commit; uncommitted work is forfeit.
- `plans-are-living-documents` (PROCESS-P-002): the plan is updated at every commit.
- `state-machine-authorizes-progression` (PROCESS-P-003): agents do not self-attest completion; a YAML state machine and CLI own all state transitions.
- `next-action-always-explicit` (PROCESS-P-004): a `next-prompt.md` file contains a single self-contained instruction for the next action.
- `infrastructure-enforces-sequencing` (PROCESS-P-007): scaffold, CI, and test stubs must be complete before any feature work begins.
- `main-is-always-deployable` (PROCESS-P-009): twelve required CI checks must pass on every PR; no bypass actors, not even admins.

**Design patterns it mandates.** The blueprint specifies:

- `three-document-planning-loop` (PROCESS-D-001): PRD (repo file), Implementation Plan (GitHub Issue), and Next Prompt (untracked local file) as distinct artifacts with distinct owners.
- `superfield-yaml-workflow-definition` (PROCESS-D-003): a YAML state machine declares states, transitions, agent roles, and deterministic gates.
- `producer-validator-handoff` (PROCESS-D-004): producing agents and validating agents are separate roles; the same agent cannot attest its own work.
- `gate-groups-and-evidence` (PROCESS-D-006): gates are grouped into specification, implementation, validation, and merge-readiness concerns.
- `github-branch-protection-ruleset` (PROCESS-D-011): a GitHub ruleset with `bypass_actors: []` requiring twelve named status checks enforced from the first PR.
- `pr-depends-on-enforcement` (PROCESS-D-010), `pr-issue-completeness-gate` (PROCESS-D-013), `pr-conflict-visibility-gate` (PROCESS-D-014), `pr-single-issue-invariant` (PROCESS-D-015): individual GitHub Actions workflows enforcing each merge-safety rule.

**Architectures it describes.** Three architectures are provided: solo-agent loop (PROCESS-A-001), Superfield-orchestrated multi-agent (PROCESS-A-002), and human-in-the-loop gated (PROCESS-A-003). The market-alert system uses A-001 during early phases and can graduate to A-002 as features grow.

---

## TypeScript implementation specifics

The TypeScript implementation layer (IMPL-PROCESS) specifies how the process blueprint manifests in a Node/TS repository.

**Planning artifacts in practice.**

- `github-issues-based-planning` (IMPL-PROCESS-001): the Implementation Plan is a GitHub Issue with phase headings and feature issue links in `- [ ] #N Feature Name` checkbox format. Feature issues have four structured sections: Motivation, Features (checkboxes), Test Plan (checkboxes), and Stage.
- `implementation-plan-format` (IMPL-PROCESS-013): the plan issue is updated at every commit — new tasks are linked as discovered, and checkboxes are checked as features close.
- `feature-issue-next-action-encoding` (IMPL-PROCESS-014): reading the current Stage field and description of the selected feature issue replaces reading a `next-prompt` file in the TS workflow.

**Workflow and gate implementation.**

- `workflow-state-machine-definition` (IMPL-PROCESS-002): the Superfield YAML workflow lives at `agent-context/workflows/superfield-default-feature-workflow.yaml`. States include `new`, `prd-review`, `architecture-plan`, `scaffold-tdd`, `implementation`, `qa-validation`, `ready-for-review`, `done`, plus recovery states `waiting-for-human`, `blocked`, `aborted`.
- `feature-unit-invariant` (IMPL-PROCESS-003): one feature = one branch = one worktree = one PR. The CLI enforces this before any state can advance.
- `gate-groups` (IMPL-PROCESS-009): gates are grouped into specification, implementation, validation, and merge-readiness; each gate records task, owner role, status source, blocking behavior, and checklist label.
- `task-catalog` (IMPL-PROCESS-010): three task kinds — builtin (`doctor-clean`, `feature-unit-bound`, `workflow-files-present`, `test-matrix`, `main-compatibility`), agent (`pr-editor`, `documentation-merge`, `blueprint-review`), and human (`human-clarification`, `human-review-approval`).

**Scaffold checklist (IMPL-PROCESS-019).** Stage 0 scaffold must deliver: `git init` + `gh repo create`, `.github/workflows/` with all CI jobs, stub test suites (server unit, integration, browser unit, component, e2e), all tests running and failing (red), initial plan issue and next-prompt written. No feature work may begin until all of this is green.

**No runtime process dependencies** (IMPL-PROCESS-020): the PROCESS domain introduces zero runtime npm packages. All PROCESS-domain logic is tooling and CI, not application code.

**Documentation merge protocol** (IMPL-PROCESS-016/017/018): `.gitattributes` marks `*.md` files with `merge=binary` to prevent automatic line-level merges. The pre-commit hook scans staged docs for conflict markers. Agent-maintained documentation is resolved semantically (prefer newer, produce one coherent result).

**gh CLI as the GitHub control surface** (IMPL-PROCESS-007): all GitHub operations (issue updates, PR creation, branch state, merge) are performed exclusively via `gh`. No direct GitHub API calls from application code.

**Structured agent outcomes** (IMPL-PROCESS-006): agent tasks produce exactly one of three outcomes: `OK`, `NOK`, or `ABORTED`. These are the only valid values the orchestrator accepts.

---

## Application to market-alert PRD/plan

### Processes the application runs

The market-alert system runs five distinct process classes, each with its own role, scaling profile, and lifecycle:

| Process class           | Entry point                             | Trigger                         | Blueprint mandate                                               |
| ----------------------- | --------------------------------------- | ------------------------------- | --------------------------------------------------------------- |
| **HTTP API server**     | `apps/server`                           | Inbound HTTP/WebSocket          | API-mediated writes; no direct DB writes from workers           |
| **Ingestion poller**    | `apps/worker` / `edgar-ingest-job.ts`   | `EDGAR_POLL` task row claimed   | Cron inserts task; worker claims via `FOR UPDATE SKIP LOCKED`   |
| **Enrichment worker**   | `apps/worker` / `alert-enrich-job.ts`   | `ALERT_ENRICH` task row claimed | Calls API only; no DB credentials; egress to `api-server` only  |
| **Notification worker** | `apps/worker` (notification agent type) | `ALERT_NOTIFY` task row claimed | Feature-flag gated per channel; non-blocking on channel failure |
| **UI server (web app)** | `apps/web`                              | Inbound HTTP (Next.js or Vite)  | Static + SSR; authenticated via same session cookie as API      |

The scheduler worker (`CORP_ACTION_ADVANCE`, `TRADE_SETTLE`) is an additional process class that shares the worker pod with notification and is dispatched by `agent_type` from the task queue.

### Sub-second latency constraint

The PRD mandates sub-second detection-to-trader-notification latency (PRD §9). The plan wires this through the existing LISTEN/NOTIFY pattern:

1. Alert transitions to `Deduplicated` state — database write via `PATCH /internal/alerts/:id`.
2. `pg_notify` fires on `task_queue_notification` channel.
3. API server's LISTEN socket receives the notification and pushes to all connected trader WebSocket sessions with matching watchlist entries.
4. Simultaneously enqueues an `ALERT_NOTIFY` task for outbound channels (email, SMS, webhook).

The WebSocket push path bypasses the task queue for in-UI delivery (the queue is for outbound channels only). This is the only case where delivery does not wait for a worker to claim a task — it uses LISTEN/NOTIFY directly for latency. The plan specifies the Phase 4 scout must verify this path delivers within 1 second end-to-end in CI (Playwright e2e on real Chromium).

### Scaling per process class

| Process class       | Scale trigger                 | Mechanism      | Config                                                            |
| ------------------- | ----------------------------- | -------------- | ----------------------------------------------------------------- |
| HTTP API server     | Request rate / CPU            | Kubernetes HPA | Replicas: 2–N                                                     |
| Ingestion worker    | `EDGAR_POLL` task queue depth | Kubernetes HPA | `MAX_WORKER_CONCURRENCY` env var; alert at 80% throttle threshold |
| Enrichment worker   | `ALERT_ENRICH` queue depth    | Kubernetes HPA | Shared `enrichment` agent type with dedup                         |
| Notification worker | `ALERT_NOTIFY` queue depth    | Kubernetes HPA | Per-channel failure is non-blocking                               |
| UI server           | Request rate / CPU            | Kubernetes HPA | Stateless; can scale freely                                       |

The plan notes `MAX_WORKER_CONCURRENCY` is configurable via environment variable, not a hard-coded constant (conforming to `PRUNE-A-003`). Poll interval for the cron producer is likewise a feature flag row, not a constant.

### Lifecycle: start / health / shutdown

The Phase 0 scout delivers three health endpoints on the HTTP API server (from `DEPLOY-C-030/031/032`):

- `GET /health/live` — liveness probe: process is running and not deadlocked.
- `GET /health/ready` — readiness probe: DB connection pool established, task queue accessible, feature flags loaded.
- `GET /health/deep` — deep health: validates downstream dependencies (Postgres connectivity per pool, LISTEN channel subscribed).

Workers expose equivalent health signals via their Kubernetes deployment liveness/readiness probes.

Graceful shutdown is required for all worker processes: on `SIGTERM`, stop claiming new tasks, allow in-flight tasks to complete (or release the claim), close DB connections cleanly. The existing `apps/worker/src/runner.ts` `runWorkerLoop` pattern is the basis for this.

### Inter-process communication

All inter-process communication is explicit and mediated:

- **Worker → API**: workers call `POST /internal/...` endpoints with scoped short-lived delegated tokens (using the existing `worker-tokens.ts` pattern). No worker has database credentials.
- **API → DB**: HTTP API server holds the only database connections. Uses four Postgres pools: `mkt_app`, `mkt_audit`, `mkt_analytics`, `mkt_dictionary` with disjoint roles.
- **API → workers (task dispatch)**: API enqueues task rows; workers claim via `SELECT ... FOR UPDATE SKIP LOCKED`. LISTEN/NOTIFY channel (`task_queue_<agent_type>`) fires on insert for zero-poll wakeup.
- **DB → API (real-time push)**: `pg_notify` on alert state transitions triggers WebSocket push from the API server to trader sessions.
- **Inter-service mTLS**: all pod-to-pod traffic uses Linkerd mTLS with short-lived workload identities from Phase 1 onward.

---

## Recommended technologies and vendors

**Node runtime version.**
Node.js 22 LTS (current LTS as of 2026-05-01). Reasons: long-term support window aligns with the trading system's production lifespan; native `fetch`, `WebSocket` server support (`ws` or native), and `--experimental-strip-types` for TS execution without a build step are all stable in 22. Bun is excluded — the existing codebase uses `pnpm` workspaces and the blueprint's test infrastructure is built around Vitest and MSW, which have better-validated Node compatibility. Bun's `bun:test` diverges from Vitest and would require parallel test infrastructure.

**TypeScript runtime (development + CI).**
`tsx` (via `npx tsx` or as a devDependency). Reasons: `tsx` provides fast on-the-fly TS→JS transpilation using esbuild; it requires no `tsconfig` emit step for running scripts and workers in development; it is compatible with Node 22 and the existing `apps/worker/src/runner.ts` pattern. Production builds use `tsc --noEmit` for type-checking plus `esbuild` for bundling worker and server entry points to plain JS — the `tsx` runtime is not used in production containers.

**Process manager / orchestrator.**
Kubernetes (k3d in development, production cluster in staging/prod). The plan mandates `pnpm dev` = `k3d cluster create + kubectl apply` from Phase 0 (`ENV-D-002`); Docker Compose is explicitly excluded. Each process class runs as a separate Kubernetes Deployment with its own HPA. The orchestrator for the development agent workflow is the Superfield CLI (not a Node process manager like PM2 or forever — those have no role here). In-container process management uses the Node process directly (no `pm2` wrapper in Docker).

**Graceful-shutdown library.**
`terminus` (`@godaddy/terminus`). Reasons: `terminus` wraps the HTTP server with `/health/live` and `/health/ready` endpoints, handles `SIGTERM`/`SIGINT` graceful shutdown with a configurable `onSignal` hook, and integrates with the existing Express/Fastify server pattern. It handles the drain-before-close sequencing needed for Kubernetes rolling updates. For workers (which are not HTTP servers), a thin custom `SIGTERM` handler on `runWorkerLoop` is sufficient — `terminus` is only needed on the API server.

**Structured logging library.**
`pino`. Reasons: pino is the fastest JSON-line logger for Node.js; it emits newline-delimited JSON natively (compatible with the dual-log pattern required by `DEPLOY-D-002/003`); it has first-class support for child loggers with request-scoped trace IDs; the `pino-pretty` devDependency formats logs for local development without changing the production output path. The plan requires PII scrub on all log output — pino's `redact` configuration option strips nominated fields at serialization time, before any transport.

**Healthcheck pattern.**
Three-tier health endpoints on the HTTP API server: `GET /health/live` (process alive), `GET /health/ready` (DB + task queue + feature flags accessible), `GET /health/deep` (all four Postgres pools connected, LISTEN channel subscribed, KMS reachable). Kubernetes liveness probe points to `/health/live`; readiness probe to `/health/ready`. Workers expose health via the Kubernetes exec probe against a lightweight `node health-check.js` script that verifies the worker's DB claim channel is active. No external health-check SaaS is required — the three-tier pattern is implemented inline.

---

## Gaps and conflicts

**PRD §9 "minimal audit logging" vs. PROCESS-P-009 / DATA-D-004.**
The PRD intends to defer comprehensive audit to post-MVP. The blueprint's `main-is-always-deployable` principle and the DATA blueprint's `DATA-D-004` (append-only hash-chained audit store) require audit infrastructure from the first commit that touches market data. The plan resolves this by making Phase 1 (Security foundation) a hard gate before any market data can land — the PRD's intent is overridden. This is documented explicitly in the plan's "Critical conflicts" section and is not a gap in the plan, but it remains a potential friction point with the product owner.

**PROCESS-P-009 requires twelve CI checks; the PRD does not mention CI.**
The blueprint mandates twelve named status checks (`build`, `lint`, `format`, `unit`, `integration`, `e2e`, `coverage ≥99%`, `checklist`, `depends-on`, `issue-checklist`, `conflicts`, `single-issue`) with `bypass_actors: []`. The PRD is silent on CI requirements. The plan correctly mandates all twelve in Phase 0, but the 99% line coverage threshold is aggressive for a greenfield trading system. Test stubs must be committed before feature work begins and coverage must be maintained at every PR.

**Sub-second latency and the task queue model.**
`TQ-D-001` through `TQ-D-006` require all state changes to route through the task queue. The sub-second delivery SLA (PRD §9) conflicts with a naive interpretation of this rule: if the WebSocket push waited for an `ALERT_NOTIFY` task to be claimed and processed by a worker, the round-trip would exceed 1 second under load. The plan resolves this by splitting delivery into two paths: LISTEN/NOTIFY → WebSocket (in-band, sub-second) and `ALERT_NOTIFY` task → outbound channels (out-of-band, worker-mediated). This is architecturally correct but must be explicitly tested in the Phase 4 scout.

**Worker egress restrictions and enrichment.**
`WORKER-C-024` restricts enrichment worker egress to `api-server` only (no external network calls). In Phase 3, the delta-neutral impact calculation requires current price data from a market data source. If that source is external (a price feed API), the enrichment worker cannot call it directly — it must go through the API server, which acts as a proxy. The plan notes this as an open question (market data source unresolved) but the architectural constraint is firm: the worker cannot add egress exceptions without a blueprint variance.

**Twelve CI checks must be pre-registered before branch protection.**
PROCESS-D-011 and PROCESS-C-024 require all twelve check names to be pre-registered with GitHub (by running each workflow at least once via dummy PR or `workflow_dispatch`) before the branch protection ruleset is enabled. This is a sequencing dependency in Phase 0 that is easy to skip accidentally and cannot be fixed after the ruleset is active without temporarily disabling protection.

**No PROCESS blueprint rule governs WebSocket server lifecycle specifically.**
The blueprint's process rules focus on HTTP API lifecycle (three health endpoints, graceful shutdown) and worker lifecycle (claim/release, stale recovery). WebSocket server lifecycle — specifically, reconnect handling, heartbeat intervals, and how active sessions survive API pod restarts during rolling updates — is not addressed by any PROCESS rule. The plan specifies heartbeat + reconnect with exponential backoff but this is architectural judgment, not blueprint mandate.

---

## Open questions

1. **Rolling update session continuity.** During a Kubernetes rolling update of the API server, active WebSocket sessions connected to the old pod will be dropped. What is the acceptable reconnect window for traders? The plan specifies "reconnect with exponential backoff" but does not specify a maximum reconnect time or whether missed alerts should be re-queued and re-pushed on reconnect.

2. **Worker concurrency model per pod.** `MAX_WORKER_CONCURRENCY` is configurable, but the plan does not specify whether workers claim tasks sequentially or in parallel within a single pod. The existing `runWorkerLoop` pattern in `apps/worker/src/runner.ts` appears sequential (claim one task, process, repeat). Under high `EDGAR_POLL` volume, does each pod need a parallel claim loop, or does horizontal scaling (more pods) substitute?

3. **Cron producer placement.** The plan specifies that the cron inserts `EDGAR_POLL` task rows every 10 minutes. Which process runs the cron? The API server (a `setInterval`), a dedicated cron pod, or a Kubernetes CronJob? A Kubernetes CronJob is correct for `ENV-D-002` compliance (k3d-native, not a Node `setInterval`), but this choice affects the Phase 0 scaffold scope.

4. **Phase 0 CI coverage threshold during scaffolding.** The 99% line coverage gate is required from the first PR (PROCESS-P-009). Phase 0 lands only stub code and empty test files. How is coverage calculated against stub-only modules? Do stubs count as covered (they are not called)? Clarification needed before the Phase 0 scaffold PR is opened to avoid a gate failure on day one.

5. **Local development parity with k3d and LISTEN/NOTIFY.** `pnpm dev` boots a k3d cluster. For the WebSocket LISTEN/NOTIFY path, the developer's local API server must be subscribed to the Postgres NOTIFY channel from inside k3d. Does the API server process run inside k3d (via `kubectl apply`) or outside (via `node apps/server/src/index.ts`)? If outside, the LISTEN/NOTIFY channel crosses the k3d network boundary, which may require port-forwarding that is not documented in the current plan.
