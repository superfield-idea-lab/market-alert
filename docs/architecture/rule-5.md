# Rule 5: env — Environment Configuration

## Summary of the blueprint rule

The ENV blueprint enforces a single central principle: **prototype is production** (ENV-P-001). The container topology that runs on day one — frontend, worker, and database — is the same topology in every subsequent environment. There is no separate demo mode, no environment-specific code paths, and no configuration branches (ENV-X-005).

The blueprint organises constraints into three layers:

**Structural constraints on containers.** Three purpose-built container types, each with exactly one role and only the capabilities that role requires (ENV-D-002, ENV-P-002). The frontend container serves pre-built, tagged release bundles only — no build tooling, no VCS credentials (ENV-P-003, ENV-X-003). The worker container runs AI task daemons with no shell and writes only via the API (ENV-P-004). The database container is distroless, no shell, no direct agent access (ENV-X-004).

**Structural constraints on the development environment.** Coding assistants (Claude Code, Gemini CLI, Codex) run on the cloud host, not on a local laptop (ENV-P-004, ENV-X-001). The developer's IDE connects via SSH to that cloud host; the local device is a viewport (ENV-D-005, ENV-X-002). Container orchestration is enforced from the first day; Docker Compose is not an acceptable development substrate.

**Structural constraints on credential lifecycle.** The host initialisation sequence (ENV-D-007) follows a strict ten-step order. Secrets are derived from a mnemonic via HMAC-SHA256 and written to Kubernetes Secrets. The mnemonic and admin credentials are unset from shell memory before any child process runs (ENV-T-011). The admin database URL lives only in an ephemeral Kubernetes Secret that is deleted after the db-init Job completes (ENV-D-008, ENV-T-012). Long-lived Secrets contain only least-privilege role passwords, never the derivation root.

**Test isolation.** Every test that needs a database gets a fresh ephemeral container on a randomised port, spun up by the test runner and torn down unconditionally in a `finally` block (ENV-D-003, ENV-P-005). The cluster database is unreachable from the host at the network layer via Kubernetes network policy (ENV-C-017). Tests never connect to the cluster database (ENV-X-009).

**Release integrity.** Every artifact served by the frontend has passed CI and carries an immutable image digest (ENV-D-001). The orchestrator owns the full release lifecycle: rolling update, readiness probe, automatic rollback on probe failure (ENV-D-006). Serving from `main` branch or bypassing CI for a demo are both explicit antipatterns (ENV-X-007, ENV-X-008).

---

## TypeScript implementation specifics

The TS implementation layer (env-ts.yaml) specifies the exact host toolchain for this stack:

| Tool                | Role                                           | Justification                                                                                          |
| ------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Bun**             | Runtime, bundler, test runner, package manager | Replaces Node + npm + webpack + jest in a single binary (IMPL-ENV-004, IMPL-ENV-010)                   |
| **gh (GitHub CLI)** | GitHub API integration with auth               | Authenticated via `gh auth login -p https -w`; DIY alternative is fragile (IMPL-ENV-002, IMPL-ENV-011) |
| **git**             | Version control                                | Required host dependency (IMPL-ENV-001)                                                                |
| **tmux**            | Terminal session persistence                   | Survives SSH disconnects; decades of stability justifies buy over DIY (IMPL-ENV-003, IMPL-ENV-009)     |
| **Agent CLI**       | AI coding assistant on host                    | Claude Code, Cursor server, or Gemini CLI; runs on cloud host, not locally (IMPL-ENV-005)              |
| **Playwright**      | Headless Chromium e2e testing                  | OS dependencies installed via `bunx playwright install-deps` (IMPL-ENV-006, IMPL-ENV-012)              |

The dev server binds to **port 31415** (IMPL-ENV-008). This is the project-wide convention and must be open on the host firewall.

At session start, the agent reads all files in `agent-context/` before any development work begins (IMPL-ENV-007). This is a checklist gate, not a convention.

The container orchestrator for development is **k3d** (k3s in Docker). `pnpm dev` creates the k3d cluster and applies all manifests. Docker Compose is explicitly disallowed (ENV-D-002 applied in the plan). The same manifests are used in the k3d dev cluster and in the production k3s cluster — prototype-is-production applies to the manifest layer, not just the image layer.

---

## Application to market-alert PRD/plan

### Environment topology

The market-alert system requires the following container specialisation within the ENV-D-002 three-container model:

**Frontend container** (`apps/web`): serves the trader dashboard, alert feed, admin panel, and PWA. No build tooling. Tagged release artifacts only. Readiness probe required (DEPLOY-C-031 referenced in plan Phase 0).

**Worker container** (`apps/worker`): hosts multiple agent types under a single worker deployment, each gated by `agent_type`:

- `edgar_ingest` — EDGAR RSS/ATOM poll worker
- `enrichment` — alert enrichment and deduplication
- `notification` — outbound email/SMS/webhook dispatch
- `scheduler` — corporate action state advance, trade settlement

**Database container**: distroless PostgreSQL. Four logical pools — `mkt_app`, `mkt_audit`, `mkt_analytics`, `mkt_dictionary` — running on disjoint Postgres roles. The four pools map directly to the DATA blueprint's requirements but operate in the same container instance in v1 (single-node cluster per ENV-A-001).

**API server** (`apps/server`): runs on the cloud host OS as a Bun process, not in a container, consistent with ENV-P-004 (worker daemon vs. host-resident service). In practice for k3d dev the API server is a pod; the ENV blueprint is silent on where the API process lives relative to the k3s boundary — the key constraint is that it writes to the database only through its own data layer, not that it is or is not containerised.

### Environment variables by service boundary

Each service boundary has a distinct environment variable scope. No service receives variables it does not own.

**API server (`apps/server`)**

| Variable                       | Description                                              | Source at runtime                   |
| ------------------------------ | -------------------------------------------------------- | ----------------------------------- |
| `DATABASE_URL`                 | `mkt_app` role connection URL                            | k8s Secret `superfield-api-secrets` |
| `AUDIT_DATABASE_URL`           | `mkt_audit` role connection URL                          | k8s Secret `superfield-api-secrets` |
| `ANALYTICS_DATABASE_URL`       | `mkt_analytics` role connection URL                      | k8s Secret `superfield-api-secrets` |
| `DICTIONARY_DATABASE_URL`      | `mkt_dictionary` role connection URL                     | k8s Secret `superfield-api-secrets` |
| `JWT_SECRET` / `JWT_ALGORITHM` | Session signing key; algorithm pinned to ES256           | k8s Secret                          |
| `KMS_KEY_ID`                   | Active KMS key for field-level AES-256-GCM encryption    | k8s Secret                          |
| `PORT`                         | API listen port                                          | ConfigMap                           |
| `RELEASE_TAG`                  | Git SHA of deployed build; exposed in `/health` response | CI-injected at deploy time          |
| `LOG_LEVEL`                    | Structured logger verbosity                              | ConfigMap                           |
| `RATE_LIMIT_*`                 | Rate limit thresholds for auth + API endpoints           | ConfigMap                           |

**Worker (`apps/worker`)**

| Variable                      | Description                               | Source at runtime                                |
| ----------------------------- | ----------------------------------------- | ------------------------------------------------ |
| `WORKER_API_BASE_URL`         | Internal API server endpoint              | ConfigMap                                        |
| `WORKER_TOKEN`                | Delegated scoped token for API writes     | k8s Secret                                       |
| `AGENT_TYPE`                  | Declares which agent type this pod runs   | Pod spec env                                     |
| `MAX_WORKER_CONCURRENCY`      | Configurable concurrency per worker type  | ConfigMap / feature flag                         |
| `EDGAR_POLL_INTERVAL_SECONDS` | Polling cadence; not a hardcoded constant | Feature flag row in DB, surfaced as env fallback |
| `LOG_LEVEL`                   | Structured logger verbosity               | ConfigMap                                        |

Workers have **no `DATABASE_URL`**. All reads and writes route through `WORKER_API_BASE_URL`. This is the `WORKER-D-001` invariant, enforced by absent credentials.

**Frontend (`apps/web`)**

| Variable            | Description               | Source at runtime                                     |
| ------------------- | ------------------------- | ----------------------------------------------------- |
| `VITE_API_BASE_URL` | Public API origin         | ConfigMap (baked into release artifact at build time) |
| `VITE_WS_URL`       | WebSocket endpoint        | ConfigMap (baked into release artifact at build time) |
| `RELEASE_TAG`       | Git SHA for cache-busting | CI-injected at build time                             |

Frontend environment variables are **baked into the release artifact at build time on the host**. The frontend container receives no runtime env injection — consistent with ENV-D-001 (immutable release artifact). Dynamic config at runtime is served via a `/api/config` endpoint, not via env.

**Test environment**

| Variable            | Description                                      | Value                         |
| ------------------- | ------------------------------------------------ | ----------------------------- |
| `TEST_DATABASE_URL` | Points to ephemeral container on randomised port | Set by test runner at startup |
| `TEST_PORT`         | Randomised port for ephemeral DB                 | Set by test runner at startup |

The test runner never reads `DATABASE_URL` from the host environment. The ephemeral container is started programmatically and its port is passed to the test suite. If `DATABASE_URL` is accidentally set in the test environment, the test suite must fail with an explicit error, not silently use it.

### Multiple environments

The plan specifies two logical environments: **dev** (k3d on the cloud host) and **production** (k3s single-node per ENV-A-001). The blueprint forbids environment-specific configuration branches (ENV-X-005), so the distinction between dev and production is expressed only in:

1. **Kubernetes Secret values** — dev uses derived-password Secrets from `init-host.sh`; production uses the same script with production credentials.
2. **KMS key IDs** — dev uses an HSM-backed staging KMS key; production uses the production KMS key.
3. **Feature flags** — `edgar_ingest` flag is off by default in both environments. Admin enables it in production explicitly.
4. **`RELEASE_TAG`** — CI injects the git SHA at deploy time in both environments.

There is no `NODE_ENV=development` branch in application code. There is no `if (process.env.NODE_ENV === 'production')` guard anywhere in the codebase.

### Credential lifecycle for market-alert

The `init-host.sh` ten-step sequence (ENV-D-007) applies directly:

1. Collect deployment mnemonic, admin Postgres URL, optional integration tokens (market data API key).
2. Validate remote Postgres connectivity.
3. Install k3s.
4. Derive `mkt_app`, `mkt_audit`, `mkt_analytics`, `mkt_dictionary` role passwords via HMAC-SHA256(mnemonic, label).
5. Write `superfield-api-secrets` (derived role URLs, JWT secret, KMS key ID).
6. Write temporary `superfield-db-init-secret` (admin URL + derived role passwords for db-init Job).
7. Unset mnemonic and admin password from shell memory. Market data API key is unset here too if it was passed as an env var.
8. Apply db-init Job; wait for completion. The Job creates the four Postgres roles, databases, tables, and RLS policies.
9. Delete `superfield-db-init-secret`.
10. Firewall, log dirs, environment marker.

Market data API keys and outbound notification provider keys (SMTP, SMS, webhook signing secret) are written to `superfield-api-secrets` at step 5 and exposed only to the API server pod. Workers never see provider credentials — they call the API, which dispatches outbound notifications.

---

## Recommended technologies and vendors

### Config validation library

**Pick: [Zod](https://zod.dev/) with a `validateEnv()` call at process startup.**

Zod is already the idiomatic TypeScript schema validator in the Bun/TypeScript ecosystem. A single `z.object({...}).parse(process.env)` call at process startup fails fast with a typed error if any required variable is missing or malformed. This gives compile-time types for env variables throughout the codebase without a separate codegen step. Alternatives like `envalid` or `t3-env` add abstraction over Zod without meaningful benefit for this project's scale.

Implementation: create `packages/core/src/env.ts` that exports typed env objects for each service boundary. Each service imports only its own env object. This enforces the boundary scoping described above at the import level.

### Secret management vendor

**Pick: [AWS Secrets Manager](https://aws.amazon.com/secrets-manager/) with Kubernetes External Secrets Operator (ESO).**

AWS Secrets Manager is the appropriate choice because:

- The plan already mandates an HSM-backed KMS in Phase 1 (`DATA-C-023`). AWS KMS integrates directly with Secrets Manager for envelope encryption, avoiding a separate vendor relationship.
- ESO syncs Secrets Manager values into native Kubernetes Secrets, which the blueprint's k8s Secret model (`superfield-api-secrets`, `superfield-db-secrets`) already uses. No application code changes; the Secret values arrive as env vars via the existing k8s mechanism.
- Automatic rotation integrates with the ≤90-day key rotation requirement (Phase 1).
- The alternative (Doppler) adds a third-party runtime dependency in the hot path. SOPS requires in-repo encrypted secrets, which complicates the init-host.sh key derivation model. GCP Secrets Manager requires GCP infrastructure when AWS is already chosen for KMS.

### .env workflow

**Pick: `.env.local` for local developer overrides only, never committed; all other configuration through Kubernetes Secrets and ConfigMaps.**

No dotenv-vault, no Doppler sidecar, no SOPS. The reason: the blueprint's init-host.sh sequence writes all long-lived secrets directly to Kubernetes Secrets at cluster init time. The application reads them as pod environment variables. There is no `.env` file in the running system. During development on the cloud host (`pnpm dev` + k3d), the developer runs `kubectl apply` against k3d using the same manifests as production — secrets land in k3d Secrets, not in a `.env` file.

`.env.local` is permitted only for the case where a developer needs to override a specific variable during local iteration (e.g., setting `LOG_LEVEL=debug`). It is gitignored and never committed. `.env.local` values are not loaded in CI.

### Env-specific config strategy

**Pick: Kubernetes ConfigMaps for non-secret config, gated by feature flags in the database for runtime toggles.**

Environment differences (dev vs. production) are expressed as different ConfigMap values in the respective k3d / k3s clusters, not as code branches. Feature flags in the `feature_flags` database table govern runtime behavior changes (source enable/disable, channel enable/disable, poll interval). This satisfies both ENV-X-005 (no environment-specific config branches in code) and PRUNE-D-002 (feature gates backed by DB rows). The ConfigMap approach means the same application binary runs identically in both environments; only the injected values differ.

---

## Gaps and conflicts

**Gap 1: Frontend env-var injection model not fully specified in the blueprint.**
The blueprint's ENV-D-001 requires immutable release artifacts but does not specify how dynamic API base URLs are communicated to the frontend at runtime. The recommended approach (bake at build time via `VITE_API_BASE_URL`, serve dynamic config via `/api/config`) diverges from a naive `.env` approach and must be made explicit in the scaffold.

**Gap 2: Market data API key lifecycle.**
The plan names a market data source in Phase 3 as open (no vendor selected). The credential lifecycle for a commercial market data vendor (Bloomberg, Refinitiv) is not covered by the blueprint's init-host.sh sequence. When a vendor is selected, its API key must be integrated into the Secrets Manager rotation policy and the init-host.sh step 5 write. This is not blocking Phase 0 but must be resolved before Phase 3 exits.

**Gap 3: Multi-environment KMS key topology.**
The blueprint requires HSM-backed KMS in staging (Phase 1, `DATA-C-023`). The plan mentions a dev k3d cluster and a production k3s cluster but does not specify whether there is a dedicated staging environment. If staging = production in v1 (single-node per ENV-A-001), the HSM-backed KMS requirement applies to that single environment. The distinction between dev (k3d, non-HSM) and staging/production (k3s, HSM-backed) must be documented before the Phase 1 KMS integration issue is created.

**Gap 4: Worker egress credentials for outbound notification channels.**
The notification worker dispatches email, SMS, and webhook calls. In the blueprint's worker model, workers have no external credentials — they call the API only. But outbound notification dispatch (SMTP, SMS provider) requires provider credentials. Resolution: the notification worker calls `POST /internal/notify/:channel` on the API server; the API server holds the provider credentials and makes the outbound call. This keeps `WORKER_TOKEN` as the only credential the worker container sees, consistent with `WORKER-C-024` (egress to API server only).

**Conflict 1: EDGAR rate limiting vs. HPA scaling.**
The plan configures an HPA on EDGAR poll queue depth. However, EDGAR enforces a 10 req/sec per IP rate limit. Scaling the worker horizontally to reduce queue depth may push the combined poll rate above the EDGAR limit if all replicas poll independently. Resolution: the EDGAR poller must use a single-writer pattern — only one `edgar_ingest` replica polls; others are hot standbys that claim already-fetched tasks for parsing. HPA should scale on `ALERT_ENRICH` queue depth (downstream of parsing), not on `EDGAR_POLL` queue depth.

---

## Open questions

1. **Is the staging environment a separate k3s cluster or is production also staging in v1?** The ENV-A-001 single-node architecture makes sense for solo development, but the Phase 1 HSM-backed KMS requirement implies a hardened environment distinct from the developer's k3d instance. The answer determines whether one or two `init-host.sh` invocations are needed before Phase 1 exits.

2. **How is the market data API key rotated if the vendor does not support AWS Secrets Manager native rotation?** Most commercial market data vendors provide static API keys without rotation support. The workaround (manual rotation with a Lambda rotation function that calls the vendor API) needs to be scoped before Phase 3 begins.

3. **Should the `deployments.jsonl` audit record (DEPLOY-D-006) live in the Kubernetes cluster's persistent volume or in a separate S3-backed store?** The blueprint requires it to survive cluster reprovision (ENV-T-006: state durability). A file on the host filesystem satisfies durability only if it is backed up; S3 is simpler to defend.

4. **When vendor sources (Bloomberg, DealReporter) are enabled in v2, does each vendor get a dedicated worker deployment or do they share the `edgar_ingest` worker pool?** The answer affects whether `AGENT_TYPE` is a per-vendor discriminator or a per-pipeline-stage discriminator. Deciding the pattern now avoids a manifest refactor in v2.

5. **What is the expected cadence of k3d cluster teardown and reprovision during development?** The blueprint's `ENV-C-019` (idempotent provisioning) and `ENV-C-020` (reprovision from scratch) are checklist gates. Knowing whether developers reprovision daily or rarely determines how heavily the `init-host.sh` sequence needs to be tested during Phase 0 scaffolding.
