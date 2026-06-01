# Rule 4: deploy — Deployment & Infrastructure

## Summary of the blueprint rule

The DEPLOY blueprint's central claim is that deployment complexity exists only to manage
the gap between development and production environments — and that gap can be eliminated
entirely by using the same containerized runtime everywhere. It mandates immutable,
distroless container images, a container orchestrator that restarts crashed processes
automatically, structured machine-readable logs, full-stack trace ID propagation, and a
completely scriptable (non-interactive) deploy pipeline.

The blueprint is organized around a threat model (13 threats), a set of principles that
mitigate them, and concrete design patterns, architectures, and checklists that verify
compliance. The key principles in priority order are:

- **DEPLOY-P-001 (containers-are-the-great-unifier)** — All processes run as immutable
  container images across every environment. The orchestrator provides automatic restart,
  health-gated rollout, and declarative configuration.
- **DEPLOY-P-003 / DEPLOY-D-002 (dual-log architecture)** — Two log surfaces: a
  chronological log (complete record) and a deduplicated `uniques.log` (diagnostic entry
  point). Both are structured and machine-readable.
- **DEPLOY-P-004 / DEPLOY-D-004 (trace-id-propagation)** — A single UUID v4 trace ID
  flows from browser through every API call, server handler, database query tag, and
  response header. One filter by trace ID reconstructs any workflow.
- **DEPLOY-P-005 (deployment-is-a-build-not-a-ceremony)** — Build, stop, start, verify.
  No SSH after initial bootstrap, no memorized commands.
- **DEPLOY-P-006 (releases-from-tagged-main-commits-only)** — Semver + 6-digit PR hash;
  all CI checks green before tagging.
- **DEPLOY-P-008 (rollouts-are-ordered-and-health-gated)** — Sequence: migrations → API
  server → worker → static web. Each phase proves health before the next begins. Failure
  triggers automatic eager rollback (DEPLOY-P-016) before any human is notified.
- **DEPLOY-P-011 (three-environment-promotion-model)** — demo (auto-rollout from dev
  branches), stage (auto-rollout from RC tags), production (human-triggered only per
  DEPLOY-P-012). Identical container images; only secrets and rollout triggers differ.
- **DEPLOY-P-013 (orchestration-service-has-kms)** — Cluster KMS seeded once via a
  one-time SSH bootstrap step. All secrets encrypted at rest; subsequent operations use
  the control API exclusively.
- **DEPLOY-P-015 (health-check-taxonomy)** — Four distinct health check types per
  workload: liveness (process alive, no dependency checks), readiness (ready to accept
  traffic), deep health (all transitive dependencies), and smoke (representative user flow
  end-to-end). Each serves a different consumer and triggers a different response.
- **DEPLOY-P-017 / DEPLOY-D-009 (migration-job-before-rollout)** — Migrations run as a
  Kubernetes Job that gates the rollout. A failed migration aborts before any app pod is
  updated. Migrations are forward-only; destructive down-migrations are never run as part
  of automated rollback.
- **DEPLOY-P-020 (control-plane-credentials-are-ephemeral-and-scoped)** — Every rollout
  actor mints short-lived, namespace-scoped credentials via the TokenRequest API.
  Static kubeconfigs and reusable bearer tokens are forbidden.
- **DEPLOY-D-006 / DEPLOY-D-008 (deployment-audit-fanout)** — Every deployment event
  writes a structured JSON record to `deployments.jsonl`, annotates the workload, and
  publishes a repository deployment event. Three durable surfaces.

Key antipatterns that are explicitly banned: hot-reloading dev servers (vite dev),
process babysitting in tmux, logging without rotation, dashboard-only observability,
manual deploy rituals, silent browser errors, delayed rollback, and single monolithic
health checks.

---

## TypeScript implementation specifics

The `deploy-ts.yaml` implementation layer prescribes the following concrete choices for
TypeScript/Bun projects:

**Container packaging (IMPL-DEPLOY-001 through IMPL-DEPLOY-004)**

- Multi-stage Dockerfile: `oven/bun:1` builder stage → `oven/bun:1-distroless` production
  stage. Only compiled output is copied into the final image. No shell, no package
  manager, no OS utilities in the production artifact.
- `bun install --frozen-lockfile` in the builder stage for deterministic dependency
  resolution.
- `bun build apps/server/index.ts --target bun --outfile dist/server.js` for a compiled
  single-file output.
- No systemd, PM2, or host-level process managers. The orchestrator owns process
  lifecycle entirely.

**Secrets (IMPL-DEPLOY-005 through IMPL-DEPLOY-006)**

- All secrets stored as scoped Kubernetes Secrets encrypted at rest by the cluster KMS.
- No `.env` files in any environment. Each workload (db, api, worker) mounts only its own
  Secret object.
- CI test credentials passed as inline environment variables in workflow definitions.

**Logging (IMPL-DEPLOY-007 through IMPL-DEPLOY-009)**

- Chronological structured log output goes to stdout; the container orchestrator
  (Kubernetes) captures it and aggregates at the cluster level.
- Deduplicated error categories written to `/var/log/superfield/uniques.log` with count
  and last-seen timestamp, persisted via volume mounts or a dedicated sidecar.
- Log rotation managed by the cluster log aggregation facility (Fluentd or Promtail), not
  application-level rotation.

**Browser error forwarding (IMPL-DEPLOY-010 through IMPL-DEPLOY-013)**

- `window.onerror` for synchronous errors.
- `window.onunhandledrejection` for promise rejections.
- React error boundaries for component-tree crashes.
- All captured errors POST to `/api/logs` with `{ traceId, error, stack, url, timestamp }`.
- Error forwarding client is a thin wrapper around `fetch`; no external library.

**Trace ID (IMPL-DEPLOY-014 through IMPL-DEPLOY-017)**

- UUID v4 generated in browser at the start of each user action (implemented internally,
  no library dependency).
- Sent as `X-Trace-Id` request header. Server middleware extracts it and attaches to all
  log entries. Returned as `X-Trace-Id` response header.

**Build and deploy (IMPL-DEPLOY-018 through IMPL-DEPLOY-020)**

- Browser assets: `bun build apps/web/index.tsx --outdir dist/web`
- Server image: `docker build -f apps/server/Dockerfile -t server:latest`
- Deploy: `kubectl apply -f k8s/deployments/server.yaml` (or Helm upgrade). Declarative,
  idempotent, non-interactive.

**Bootstrap and rollout hardening (IMPL-DEPLOY-025 through IMPL-DEPLOY-033)**

- `init-host.sh` creates dedicated non-root service accounts, locks password auth,
  installs approved admin keys, applies CIS Level 1 baseline hardening, and disables
  routine root login when complete.
- Rollout jobs mint short-lived namespace-scoped credentials via the Kubernetes
  TokenRequest API. The workflow validates expiry before proceeding.
- Non-production rollout workflows run from a self-hosted runner attached to the trusted
  deployment network (private VPC or mTLS boundary).
- Separate CI entrypoints for release publication and environment rollout. Production
  rollout uses a distinct human-invoked control-plane command.
- Each rollout writes the canonical `deployments.jsonl` record, annotates the workload,
  and publishes a repository deployment event.
- Rollback re-applies a prior approved image digest through the orchestration control
  plane without reverting Git history or running destructive schema downgrades.

---

## Application to market-alert PRD/plan

### Sub-second latency constraint (PRD §9)

The PRD's non-negotiable sub-second latency requirement — from event detection to trader
notification — has direct infrastructure implications. The critical path is:

```
EDGAR poll → corporate_action write → ALERT_ENRICH task → enrichment worker
→ ALERT_DEDUP task → pg_notify → WebSocket push → trader browser
```

Every hop in this chain must be within the same availability zone to avoid cross-region
round-trips. The plan wires sub-second delivery via LISTEN/NOTIFY + WebSocket (not
polling), which keeps the final delivery hop to a single Postgres notification plus a
WebSocket write. The database, API server, and WebSocket server must be co-located — all
in the same VPC, ideally in the same AZ, without a cross-region hop on the critical path.

**Region placement**: A single primary region (e.g., `us-east-1`) is appropriate for v1.
US equity corporate actions are overwhelmingly US-market events; EDGAR is hosted in the
US. A single-region deployment eliminates cross-region replication latency from the
critical path. Multi-region active-active for the delivery path is a v2 concern once
volume and geography warrant it.

**Networking**: The API server, worker fleet, and Postgres must communicate over a private
VPC subnet with no public internet traversal for internal traffic. The WebSocket server
listens on the same internal network; the load balancer terminates TLS externally and
proxies to the pod.

### Event replay (PRD §9, Plan Phase 7)

The plan resolves event replay correctly: it is not a standalone feature but a consequence
of routing all state changes through the task queue and the hash-chained business journal
in `mkt_audit`. The deployment infrastructure must ensure the `mkt_audit` pool is durably
backed (point-in-time recovery enabled, labeled pre-migration snapshots per
DEPLOY-P-017). The audit Postgres instance cannot be co-mingled with the `mkt_app` pool;
it requires a disjoint role and its own KMS key domain.

### Multi-channel delivery (Plan Phase 4)

The outbound notification worker dispatches to email, SMS, and webhook channels per trader
preference. Channel adapters are feature-flag-gated. This adds two deployment concerns:

1. The notification worker needs egress to external SMTP/SMS provider endpoints. Network
   policy must explicitly allow this egress while blocking all other external traffic from
   worker pods (WORKER-C-024 in the worker blueprint).
2. SMTP and SMS provider credentials are additional Kubernetes Secrets mounted only into
   the notification worker pod. They must not be visible to the enrichment or ingestion
   workers.

### Ingestion workers (Plan Phases 2–3)

The EDGAR ingestion worker runs on a cron-triggered cycle (every 10 minutes). The plan
calls for a Kubernetes HPA on the `edgar_ingest` worker deployment with queue depth as
the scale metric. This means the HPA requires a custom metrics adapter (e.g., KEDA
or Prometheus Adapter) reading task queue depth from Postgres. The migration Job pattern
(DEPLOY-D-009) must be wired before Phase 2 exits: `deploy.sh` applies the migration Job,
waits for `Complete`, then rolls out the app pods.

### Phase 0 requirements

The Phase 0 scaffold calls for `pnpm dev` = k3d cluster create + kubectl apply. This
means even local development uses the blueprint's containerized model from the first
commit. k3d runs Kubernetes in Docker on the developer host; the same manifests are
applied in CI and in production. No Docker Compose, ever. The three health endpoints
(`/health/live`, `/health/ready`, `/health/deep`) must land in the Phase 0 scout issue
before any feature work begins.

---

## Recommended technologies and vendors

### Cloud provider

**AWS (us-east-1)**

Justified by: EDGAR is hosted by the SEC in the eastern US; `us-east-1` minimizes
round-trip latency to the SEC's servers. AWS has the deepest managed Kubernetes (EKS)
support, the most mature RDS managed Postgres with PITR and labeled snapshots, and a
well-established HSM service (CloudHSM or KMS with HSM-backed CMKs) required for Phase 1
field encryption. The existing Superfield KB substrate appears to target AWS. Moving to a
different provider introduces migration risk without corresponding benefit at v1 scale.

### Compute platform

**Amazon EKS (Elastic Kubernetes Service)**

Justified by: The blueprint mandates a container orchestrator with automatic restart,
health-gated rolling updates, environment-isolated rollback, namespace-scoped isolation,
KMS integration, and a control API operable without SSH. EKS satisfies all of these
natively. EKS Fargate is considered and rejected for v1: Fargate does not support custom
metrics for HPA (required for task-queue-depth-based scaling of the ingestion worker) and
has higher cold-start latency. Standard EKS managed node groups with `t3.medium` or
`t3.large` nodes are the right tier: enough memory for Bun + Postgres connection pools,
cost-proportionate to v1 volume, and compatible with KEDA for custom metrics HPA.

Three namespaces within one EKS cluster: `market-alert-demo`, `market-alert-stage`,
`market-alert-prod`. Cluster control plane is private (no public API endpoint).

### Container runtime

**Bun (oven/bun:1-distroless)**

Mandated by the TypeScript implementation spec (IMPL-DEPLOY-001). Bun is the runtime for
server code and the build tool for client assets. The distroless production image
eliminates shell and package manager attack surface. The builder stage uses `oven/bun:1`;
the production image uses `oven/bun:1-distroless`. Image signing via Cosign with the
signing key in GitHub Actions secrets and the verification key provisioned into the EKS
cluster via an OPA Gatekeeper or Kyverno admission policy.

### IaC tool

**Terraform (HashiCorp, AWS provider) + Helm**

Justified by: Terraform manages the AWS-layer infrastructure (VPC, EKS cluster, RDS
instances, KMS keys, IAM roles, ECR repositories, CloudHSM cluster for Phase 1). Helm
manages the Kubernetes-layer application manifests (Deployments, Services, Ingress,
HorizontalPodAutoscalers, CronJobs). This split matches the boundary between infrastructure
provisioning (slow, rare, stateful) and workload rollout (frequent, fast, declarative).
Pulumi is a credible alternative but Terraform has wider operator familiarity and a
larger ecosystem of AWS modules. CDK for Terraform (CDKTF) is rejected as an additional
layer of indirection over standard Terraform HCL.

Terraform state stored in S3 with DynamoDB locking. One Terraform workspace per
environment (demo, stage, prod). Workspaces share module code but have independent state
files, enforcing DEPLOY-P-014 (rollbacks-are-environment-isolated) at the infrastructure
layer.

### Secrets manager

**AWS Secrets Manager → Kubernetes Secrets via External Secrets Operator (ESO)**

Justified by: The blueprint mandates Kubernetes Secrets encrypted at rest by the cluster
KMS (DEPLOY-P-009, DEPLOY-P-013). AWS Secrets Manager is the upstream authoritative
store; the External Secrets Operator syncs secrets into Kubernetes Secret objects on a
configurable rotation schedule. This satisfies the blueprint's requirement that secrets
are injected as environment variables at pod startup without being baked into images.
Each workload (api, worker, notification-worker, db-migrator) gets a distinct Kubernetes
Secret object with only the keys it needs. AWS KMS CMKs (HSM-backed in staging and prod,
software-backed in demo) encrypt the Kubernetes Secret objects at rest in etcd.

### Networking

**AWS ALB (Application Load Balancer) + AWS Certificate Manager (ACM) for TLS**

Justified by: ALB terminates TLS using ACM-managed certificates (automatic rotation,
no manual renewal). The AWS Load Balancer Controller provisions ALB from Kubernetes
Ingress resources — fully declarative. ALB supports WebSocket connections natively, which
is required for Phase 4 real-time delivery. NGINX Ingress Controller is an alternative
but adds an extra hop; ALB's native Kubernetes integration reduces operational surface.
Internal service-to-service traffic uses Kubernetes Services on a private VPC subnet;
no public routing for pod-to-pod calls. The EKS control plane API endpoint is private
(not publicly reachable) per DEPLOY-D-007 and DEPLOY-C-040.

mTLS for pod-to-pod traffic uses **Linkerd** (called out in the plan, Phase 1
cross-cutting work). Linkerd is lightweight (does not require sidecars with a large memory
footprint) and is fully compatible with EKS managed nodes.

### CI/CD

**GitHub Actions + KEDA (for HPA) + ECR (container registry)**

Justified by: The repository is already on GitHub, so GitHub Actions is the natural CI
substrate. ECR integrates with EKS IAM roles for service accounts
(IRSA) without static registry credentials — satisfying DEPLOY-P-013 (registry credential
provisioned at cluster init). GitHub Actions provides concurrency controls per environment
(enforcing DEPLOY-C-041 rollout-concurrency-serialized-per-environment). Separate
workflows for release publication (build, sign, push to ECR) and environment rollout
(demo, stage) with production rollout as a manual workflow trigger only
(DEPLOY-D-005, DEPLOY-P-012). Short-lived OIDC-based AWS credentials minted per workflow
run via `aws-actions/configure-aws-credentials` with `role-to-assume` — no static AWS
access keys in GitHub Secrets (satisfying DEPLOY-P-020 ephemeral credentials).

**KEDA** (Kubernetes Event-Driven Autoscaling) for HPA on Postgres task queue depth,
required by the plan's ingestion worker scaling requirement.

### Observability (logs/metrics/traces)

**Grafana Cloud (Loki for logs, Prometheus/Mimir for metrics, Tempo for traces)**

Justified by: Grafana Cloud offers a managed LGTM stack (Loki/Grafana/Tempo/Mimir) with
a generous free tier that fits v1 volume. Loki aggregates structured stdout logs from
the cluster (via Promtail or the Grafana Agent deployed as a DaemonSet), satisfying
IMPL-DEPLOY-009 (log-rotation-via-cluster). Tempo provides distributed tracing with trace
ID correlation — a direct match for DEPLOY-D-004 (trace-id-propagation). Mimir stores
Prometheus metrics for alert volume, queue depth, and delivery latency dashboards
(required by Plan Phase 5). The alternative, AWS-native stack (CloudWatch Logs + X-Ray +
CloudWatch Metrics), is operationally heavier and more expensive at any volume. Grafana
Cloud's unified query layer makes it easy to correlate a trace ID across logs and spans —
critical for diagnosing sub-second latency regressions.

Retention policy: 14 days for logs (DEPLOY-C-011), 13 months for metrics (regulatory
audit lookback), 7 days for traces.

### Error tracking

**Sentry (Team plan, self-hosted on EKS or Sentry.io SaaS)**

Justified by: The browser error forwarding pattern (DEPLOY-D-003) POSTs unhandled errors
to `/api/logs`. Sentry provides the deduplication, grouping, and alert-on-spike
capabilities that satisfy DEPLOY-C-010 (uniques-log-implemented) and DEPLOY-C-022
(browser-error-rate-tracked). Sentry's Bun/Node SDK integrates natively with the server.
The Sentry SaaS Team plan ($26/mo) is appropriate for v1 — no self-hosted operational
burden. At higher volume or stricter data residency requirements, self-hosted Sentry on
EKS (using the official Helm chart) is the migration path.

Note: The `uniques.log` file (IMPL-DEPLOY-008) is still implemented in the application
for agent-readable local diagnostics; Sentry is the human/alerting layer on top.

### On-call and paging

**PagerDuty (Professional plan)**

Justified by: PagerDuty integrates with Grafana Cloud alerting (both Alertmanager rules
and Grafana alert rules) and with Sentry. The plan's sub-second latency SLA requires an
on-call rotation with escalation policies — a delivery latency breach or a DLQ crossing
the threshold (10 dead tasks per agent type) must page a human within minutes. PagerDuty
Professional provides multi-level escalation, on-call schedules, and runbook links
attached to incidents. OpsGenie is a comparable alternative. AWS SNS + Lambda for
alerting is rejected as under-featured for the escalation and runbook requirements.

---

## Gaps and conflicts

**1. PRD §9 "minimal audit logging for MVP" vs. DEPLOY-D-006 + DATA blueprint**

The plan correctly resolves this: comprehensive audit is a Phase 1 gate, not post-MVP.
The deployment infrastructure must provision the `mkt_audit` Postgres pool with its own
KMS key domain from Phase 0, even if the pool is empty until Phase 1 lands. The
`deployments.jsonl` file (DEPLOY-C-035) must be written from the first deployment in
Phase 0.

**2. Sub-second latency SLA vs. shared-nothing worker architecture**

The plan routes all worker writes through the API layer (WORKER-D-001). This adds one
HTTP hop on the enrichment path. If the enrichment worker and API server are in the same
VPC (same AZ), this hop is ~0.5ms — negligible. If they are in different AZs or if the
API server is under load, this hop could add 2–5ms. The scout benchmark for Phase 4
must measure the full path including this hop. If the hop consistently contributes more
than ~10ms to the critical path, the enrichment worker should be collocated with the API
server (same pod, different process, communicating via loopback) for the notification
path only — while preserving the API-mediated write invariant.

**3. HPA on task queue depth requires KEDA**

Standard Kubernetes HPA supports CPU and memory metrics natively. Task queue depth is a
custom metric sourced from Postgres. This requires KEDA (Kubernetes Event-Driven
Autoscaling) with its PostgreSQL scaler, which runs as a separate controller in the
cluster. KEDA is not mentioned explicitly in the blueprint or plan; it must be added to
the Phase 0 infrastructure scaffold. KEDA's controller itself must satisfy the
non-root service account invariant (DEPLOY-C-038).

**4. WebSocket affinity and load balancer session stickiness**

Phase 4's WebSocket server requires that a connected trader's WebSocket connection
persists to the same pod — or that the LISTEN/NOTIFY fan-out is broadcast to all pods.
AWS ALB supports sticky sessions but not per-connection affinity at the Kubernetes layer
without additional configuration. The plan does not address this. Two options: (a)
broadcast pg_notify to all API server pods (each pod forwards to connected sessions for
that trader), or (b) use sticky sessions on the ALB target group for WebSocket connections.
Option (a) is more resilient to pod restarts; option (b) is simpler. This must be resolved
in the Phase 4 scout issue.

**5. DEPLOY-P-019 bootstrap-is-one-time-and-hardened vs. EKS managed control plane**

EKS manages the control plane nodes; the operator cannot SSH into them. The bootstrap
hardening requirement (init-host.sh, CIS Level 1, non-root service accounts) applies to
the data plane (worker) nodes, not the EKS control plane. EKS managed node groups run
worker nodes as EC2 instances that the operator can access via SSM Session Manager
(not SSH, satisfying the no-routine-SSH requirement). The `init-host.sh` bootstrap script
must be adapted to run as an EC2 user-data script on node group launch, not as an
interactive SSH session.

**6. Image signing admission policy**

The blueprint mandates image signing verification via admission policy (DEPLOY-P-018,
DEPLOY-C-036). EKS does not include an admission policy controller by default. Either
Kyverno or OPA Gatekeeper must be deployed as an additional controller. This must be
provisioned in Phase 0 before the first image is rolled out to production.

---

## Open questions

1. **WebSocket fan-out vs. sticky sessions**: Which approach for pg_notify → WebSocket
   delivery in a multi-pod API server? Fan-out (each pod subscribes to LISTEN/NOTIFY and
   forwards to locally connected traders) is preferred for resilience, but requires each
   pod to maintain a Postgres LISTEN connection. With HPA, pods scale in/out; this must
   be handled gracefully. Needs decision before the Phase 4 scout begins.

2. **Market data source for spread calculation (Phase 3)**: The plan flags this as an
   open question. The choice of market data provider determines whether an additional
   egress allow-list entry is needed in the worker network policy, and whether fixture
   recording is possible in CI. This must be resolved before Phase 3 begins.

3. **EKS Fargate reconsideration for demo environment**: Fargate could reduce the cost of
   the demo namespace (no idle node charges) but is incompatible with KEDA's PostgreSQL
   scaler. If the ingestion worker HPA is only required in stage and prod, Fargate for
   demo is viable. Needs a cost-benefit analysis before Phase 0 exits.

4. **Grafana Cloud data residency**: Grafana Cloud stores logs and traces outside the AWS
   account. If the hedge fund's compliance requirements prohibit structured log data
   (which may include alert content fragments) leaving the AWS account, the observability
   stack must move to self-hosted (Grafana OSS + Loki + Tempo on EKS) or to
   Amazon CloudWatch + X-Ray. This must be answered in Phase 0 before the logging
   infrastructure is wired.

5. **Sentry data residency for browser error payloads**: Browser errors forwarded via
   `/api/logs` are first written to the server log (in-cluster). If those server logs are
   shipped to Grafana Cloud Loki, the data residency question above applies. Sentry
   additionally receives error payloads directly from the browser (if the Sentry SDK is
   used client-side). Whether market-alert-related error context is safe to send to Sentry
   SaaS must be confirmed before the Sentry SDK is wired in Phase 0.

6. **KEDA scaler credential management**: KEDA's PostgreSQL scaler needs read access to
   the task queue table to compute queue depth. This credential must be a read-only
   Postgres role scoped to the task queue view, stored as a Kubernetes Secret encrypted
   by the cluster KMS. The scope and rotation policy for this credential must be
   documented before Phase 0 exits (DEPLOY-P-009, DEPLOY-C-003).
