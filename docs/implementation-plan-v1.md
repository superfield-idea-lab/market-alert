# Implementation Plan v1 — Superfield KB

<!-- last-edited: 2026-04-11 -->
<!-- reviewed: docs/review/plan-review-2026-04-11.md -->

CONTEXT MAP
this ──implements─────▶ docs/PRD.md
this ──feeds──────────▶ GitHub "Implementation Plan" tracking issue
this ──references─────▶ calypso-blueprint/rules/blueprints/ (arch, auth, data, deploy, env, process, prune, task-queue, test, ux, worker)
this ──reuses─────────▶ ~/calypso-distribution (k3d cluster, task queue, IMAP ETL worker, GitHub workflows)
this ──references─────▶ calypso-blueprint/development/product-owner-interview.md
this ──references─────▶ docs/technical/db-architecture.md
this ──references─────▶ docs/technical/security.md
this ──references─────▶ docs/technical/embedding.md
this ──references─────▶ docs/technical/md-file-editing.md

---

## About this document

This is a **specification artifact**, not the live Plan. The authoritative
Plan for Calypso execution is the GitHub "Implementation Plan" tracking issue.
This document exists to propose the phase structure, dependency ordering,
scout-gating strategy, and blueprint-rule mapping **before** the Plan issue
and its child feature issues are created. Once the Plan issue exists, this
document is frozen as a historical record of the original plan; ongoing
ordering and status live only on the Plan issue per `calypso-replan`.

**Scope of v1.** The plan below covers the product surface described in the
v1 PRD: email + meeting-audio ingestion, autolearning wiki, annotation-thread
corrections, deepclean, CRM updates, BDM campaign analysis, records management
for regulated tenants, and the supporting security and operational substrate.
It does not include v2+ integrations (Google Drive, Slack, etc.) which are
listed as open questions in PRD §10.

---

## Planning principles

These constraints shape every phase below. They are extracted from
`calypso-blueprint/rules/blueprints/*.yaml` and the repository `CLAUDE.md`.

**Sequencing.**

- One phase at a time. One issue at a time. One branch = one worktree = one
  PR (PROCESS blueprint, feature-unit invariant).
- Each phase begins with exactly one **scout issue**. All other issues in the
  phase are gated behind the scout's merge (`calypso-replan` rule). The scout
  is the smallest end-to-end vertical slice that proves the phase's
  architectural assumptions before parallel-friendly work lands.
- Dependencies live only on the Plan issue, never in titles or issue bodies
  (`calypso-replan` rule). Phase/step/batch metadata is forbidden in titles.
- Infrastructure scaffolding must be complete before any feature work begins
  (PROCESS blueprint). Phase 0 cannot be skipped or interleaved.

**Security posture.**

- Postgres from the first commit; no embedded-DB-to-migrate-later path (DATA
  blueprint).
- **Four-pool** Postgres architecture from Phase 1: `kb_app`, `kb_audit`,
  `kb_analytics`, `kb_dictionary` — disjoint roles and key domains. The analytics
  tier is a structural separation (`DATA-D-006`), not just RLS on the app tier.
  The dictionary pool is orthogonal to analytics (`DATA-X-003`).
- RLS is restrictive, not permissive. Structural DB blocks replace
  application-layer filtering wherever possible (PRD §7, DATA blueprint).
- Worker DB role is read-only; all writes route through the API layer with
  short-lived scoped tokens (WORKER blueprint, PRD §8).
- No long-lived agent credentials. Max 24h TTL, single-use, task-scoped.
- **Task queue** (not ad-hoc cron): every worker phase claims tasks from a
  PostgreSQL task queue using `SELECT … FOR UPDATE SKIP LOCKED`. Cron is a
  _producer_ that inserts task rows; workers are _consumers_ that claim them.
  Reuse `calypso-distribution/packages/db/task-queue.ts` and the API endpoints
  in `apps/server/src/api/tasks.ts` (`TQ-D-001` through `TQ-D-006`).
- Passkey-only authentication from the first user-facing commit (AUTH
  blueprint); no password fallback.

**Testing.**

- Zero mocks in test files (`vi.fn`, `vi.mock`, `vi.spyOn`, `vi.stubGlobal`
  are banned — CLAUDE.md).
- Real dependencies → recorded fixtures → narrow fakes, in that order (TEST
  blueprint).
- MSW v2 for external HTTP; real `node:http` for local endpoints.
- Test stubs land in the scaffold phase; behaviour is encoded before code
  is written (TEST blueprint).
- Each suite self-contained; one CI workflow per suite; local commands match
  CI exactly.

**Architecture.**

- Strict client/server separation. Shared types only in `packages/core`
  (ARCH blueprint). No `packages/utils` junk drawer.
- No `any` in API contracts (ARCH-C-012). Strict TypeScript throughout.
- Workspace aliases for imports; no `../../../` deep relative paths.
- Every external dependency requires a documented buy-vs-build justification.
- **Dev environment = k3d** (not Docker Compose). Reuse
  `calypso-distribution/scripts/local-demo.ts` and `deploy/base/` manifests.
  `ENV-D-002`: dev/CI/prod use the same container topology. `ENV-X-009`: tests
  never run against a cluster database — integration tests use ephemeral k3d-local
  containers on randomised ports.
- **Twelve-check CI gate** (not nine): build, lint, format, unit, integration,
  e2e, coverage, checklist, depends-on, **issue-checklist**, **conflicts**,
  **single-issue**. Coverage threshold = 99% line coverage. All check names
  pre-registered before branch protection is enabled (`PROCESS-C-024`).
  Reuse `calypso-distribution/.github/workflows/` as the starting set.
- **Test suite time budget**: all four suites complete in under 5 minutes total
  in CI (`TEST-C-020`).
- **Feature flags table** (`PRUNE-D-002`): `feature_flags` DB table with
  evaluation middleware from Phase 0. All shipped-but-gated features (AssemblyAI
  path, etc.) are backed by DB rows, not config constants (`PRUNE-A-003`).

**Agent assignment (per user policy, 2026-04-10).**

| Work class                          | Model         | Effort |
| ----------------------------------- | ------------- | ------ |
| Feature specification & design      | Claude Opus   | Medium |
| Engineering development & code work | Claude Sonnet | Medium |
| Operational checks (GitHub, CI)     | Claude Haiku  | Medium |

Plan entries inherit these defaults unless explicitly overridden.

---

## Phase overview

| #   | Phase                           | Scout delivers                                                                        | Gates |
| --- | ------------------------------- | ------------------------------------------------------------------------------------- | ----- |
| 0   | Scaffolding & infrastructure    | Monorepo, CI pipeline, test harness, dev Postgres, deployable "hello" on k8s          | —     |
| 1   | Security foundation             | Property graph skeleton with RLS + field encryption + audit isolation + passkey login | 0     |
| 2   | Email ingestion & corpus store  | Single email end-to-end: IMAP → anonymise → store → chunk → embed                     | 1     |
| 3   | Autolearning worker             | Ephemeral pod reads one customer's ground truth and writes a draft WikiPageVersion    | 2     |
| 4   | Wiki web UX                     | Read-only wiki view with version history, draft indicator, and citation hover         | 3     |
| 5   | PWA & meeting transcription     | PWA shell + edge-path recording → transcript → ingestion → wiki update                | 1, 4  |
| 6   | Annotations & publication gate  | RM opens an annotation, agent responds, draft review UI, publication flow             | 4     |
| 7   | BDM campaign analysis           | Asset-manager tagging + RLS-enforced anonymised query path + summary 1-pager          | 3     |
| 8   | Records management & compliance | Retention policy engine, WORM mode, legal hold, e-discovery export                    | 1     |

Phases 5/6 and 7/8 can be drafted concurrently into issues but **executed
sequentially** per Plan ordering — no parallel execution (CLAUDE.md).

---

## Phase 0 — Scaffolding & infrastructure

**Goal.** A new commit on `main` can build, test, lint, migrate a dev
Postgres, and deploy a trivial service to a k3s cluster, all through CI
gates that will remain in place for the life of the project.

**Scout issue.** _Scaffold the monorepo and land a "hello" service behind
the full **twelve-check** CI gate._ The scout must produce: (a) the
`apps/server`, `apps/web`, `packages/core`, `tests/` skeleton per ARCH
blueprint; (b) a single `/health` endpoint (liveness + readiness + deep,
`DEPLOY-C-030/031/032`) and a single empty PWA route; (c) the CI pipeline
with build, lint, format, unit, integration, e2e, coverage, checklist,
depends-on, issue-checklist, conflicts, and single-issue checks wired and
failing closed — 99% coverage threshold; (d) local dev commands identical to
CI commands; (e) k3d cluster via `calypso-distribution/scripts/local-demo.ts`
(not Docker Compose — `ENV-D-002`).

**Follow-on issues (gated behind the scout).**

- **k3d dev cluster scaffold** — reuse `calypso-distribution/deploy/base/`
  manifests (api-server, worker, postgres, ingress). Replace Docker Compose.
  `pnpm dev` = `k3d cluster create && kubectl apply`. Ephemeral test DB
  containers on randomised ports for integration tests (`ENV-D-003`).
- **Task queue scaffold** — reuse `calypso-distribution/packages/db/task-queue.ts`
  and `apps/server/src/api/tasks.ts` (claim, complete, fail, heartbeat
  endpoints). Extend `TaskType` for autolearn, ingestion, transcription,
  correction, deepclean, bdm-summary. Per-type views, DLQ monitoring
  (`TQ-D-001` through `TQ-D-006`, `TQ-C-001/002/003`). Payload no-PII
  validator (`TQ-C-004`). Idempotency key enforcement (`TQ-C-005`).
- Property graph entity-type registry skeleton (empty registry, the
  insertion path, and the "adding an entity is data, not a schema
  change" invariant encoded in a test).
- Structured logger with PII scrubbing from the start (CLAUDE.md, AUTH
  blueprint — no raw PII in logs, ever). Dual log: chronological + uniques
  dedup (`DEPLOY-D-002`). Browser-to-server error forwarding (`DEPLOY-D-003`).
- **Trace-ID propagation browser→server→DB** (`DEPLOY-D-004`); one test per
  boundary hop including the browser side. Given a trace ID, all related
  log entries retrievable in one query (`DEPLOY-C-021`).
- k3s deployment manifests for server, web, worker image; image builds
  produce distroless-style containers (WORKER blueprint). Reuse
  `calypso-distribution/k8s/agent-worker.yaml` as the worker manifest
  baseline (includes NetworkPolicy blocking pod→DB direct access).
- Secrets abstraction layer (env-var shim in dev, KMS-backed in prod;
  abstraction from day one so no plaintext env vars ever ship).
- **Deployment audit record** (`deployments.jsonl`) — every deployment
  writes a structured JSON record with timestamp, operator, release tag,
  environment, outcome, image digest (`DEPLOY-D-006`, `DEPLOY-C-035`).
- **Design system skeleton** — color/type/space tokens, one button
  primitive, static catalog page, Playwright screenshot review loop. Serve
  via headless Chromium (`UX-D-004`, `UX-C-002`, `UX-X-005`). Service flow
  maps for Phases 4–8 land here as documentation (design, not code) so
  Phase 4 builds from an existing design system (`UX-D-001`, `UX-C-001`).
- **Feature flags table** — `feature_flags` table + evaluation middleware.
  AssemblyAI gate (Phase 5) is backed by a DB row from day one (`PRUNE-D-002`,
  `PRUNE-C-002`, avoids `PRUNE-A-003`).
- **Golden fixture recorder** — tool that records real HTTP request/response
  pairs to `tests/fixtures/`; scheduled 30-day refresh pipeline; schema drift
  alerts (`TEST-D-001`, `TEST-C-003/019/025`).
- Golden-path end-to-end test that boots the stack, hits `/health`, and
  tears down — the canary that every subsequent PR must keep green.

**Exit criteria.** CI is all-green on a PR that does nothing except touch
a comment. Dev onboarding is `git clone && pnpm install && pnpm dev` with
k3d. All twelve CI check names pre-registered in GitHub before branch
protection is enabled.

---

## Phase 1 — Security foundation

**Goal.** The data layer is RLS-restrictive, field-encrypted, auditable,
and unreachable except through authenticated sessions. No customer data
can be stored until this phase is merged.

**Scout issue.** _End-to-end vertical slice: passkey login → authenticated
API call → RLS-scoped read of a test entity → audit event written before
the read commits._ The scout must prove the full identity → session →
RLS-context → audit-first → encrypted-read chain works for a single
entity type. Nothing else in Phase 1 may land until this is merged.

**Follow-on issues.**

- Passkey registration + login (PRD §2, AUTH blueprint: FIDO2 only,
  SameSite=Strict cookies, HTTP-only, Secure). Passkey credential
  management already exists at `8d9bc1b`'s parent commits — verify
  reuse rather than rewrite.
- **Passkey key recovery flow** — recovery passphrase + second factor →
  re-enrollment of new passkey (no magic links, no password fallback).
  Recovery events notify all enrolled devices (`AUTH-D-007`,
  `AUTH-C-016/017`, avoids `AUTH-X-008`).
- **Token refresh rotation, progressive lockout, generic error messages** —
  each refresh produces a new token and invalidates the old (`AUTH-C-018`);
  failed auth attempts trigger progressive delays (`AUTH-C-024`); all auth
  errors are generic with no account-existence leakage (`AUTH-C-032`).
- **Four-pool Postgres architecture**: `kb_app`, `kb_audit`, `kb_analytics`,
  `kb_dictionary` — disjoint roles, disjoint key domains (PRD §7, DATA
  blueprint). The analytics pool starts empty; it will be populated in
  Phase 7. The dictionary pool holds `IdentityDictionary` under its own
  role and key domain. See `docs/technical/db-architecture.md` for the
  canonical three-database schema (app/audit/analytics); dictionary is the
  fourth isolation domain.
- **Auth incident response runbook** — four scenarios tested before customer
  data lands: signing key compromise, agent credential compromise, admin
  account compromise, mass session invalidation (`AUTH-C-030`). This is a
  Phase 1 deliverable; the SOC 2 evidence wrapper stays in Phase 8.
- **Business journal distinct from audit log** — the audit log is the access
  trail (auth events, reads, writes); the business journal is replay-able
  facts for consequential operations with compensation support. Ledger replay
  tests: genesis replay, checkpoint replay, materialized-state comparison
  (`DATA-D-004`, `DATA-C-026/027`, `TEST-D-006`, `TEST-C-014`).
- Field-level AES-256-GCM encryption for the sensitive fields
  enumerated in PRD §7 — corpus bodies, transcripts, CRM notes,
  customer names, customer interests, synthesised wiki content,
  every dictionary field. KMS-managed keys partitioned by
  sensitivity class.
- KMS abstraction landing real **HSM-backed** cloud-provider KMS in staging
  (AWS KMS or GCP KMS with HSM-backed root keys; HashiCorp Vault in HSM mode
  for on-prem). Key material never leaves KMS boundary. ≤90-day rotation.
  Resolves PRD §7 "Key management" requirement (`DATA-C-023`).
- Audit store: append-only, hash-chained, written on a role the
  application role cannot read or modify. Audit-before-read
  enforcement: a failed audit write denies the read.
- Restrictive RLS policies on every customer-scoped table. One
  policy test per role per table.
- `IdentityDictionary` table with its own role, its own key domain,
  and a re-identification API service that is the only holder of
  dictionary authority (PRD §2.5, §7).
- Four-pool property graph entity types: auth, CRM, ground truth,
  wiki, corpus chunks, identity tokens — all registered in the
  entity-type registry.
- JWT/session hardening: algorithm pinned at deploy (no header
  negotiation — AUTH blueprint AUTH-C-013), ES256, JTI revocation
  replay protection.
- CSRF double-submit for any cookie-authenticated mutation.
- M-of-N approval wiring for root-key material and bulk exports
  (AUTH blueprint — "no single-actor privileged operations").

**Exit criteria.** A BDM test session cannot read a customer row even
when it tries; the database, not the app, blocks it. An audit query
against any sensitive read returns a matching event. Key rotation can
be invoked end-to-end against a **HSM-backed** staging KMS. Auth incident
response runbook has been executed for all four scenarios against the
staging environment.

---

## Phase 2 — Email ingestion & corpus store

**Goal.** One real email, from a real IMAP mailbox, lands anonymised,
encrypted, chunked, and embedded in the database, and is visible to a
worker role only through the RLS-scoped view.

**Scout issue.** _Single-email end-to-end_: fetch one email from a test
IMAP account, strip PII to tokens, store it, chunk it, embed the chunks
through the embedding service, and assert every downstream read path
sees the anonymised form. No wiki update yet — this is purely the
ingestion substrate.

**Follow-on issues.**

- IMAP ingestion worker: reuse `calypso-distribution/packages/core/imap-etl-worker.ts`
  (two-phase landing + classify, PII encryption, `EtlStore` abstraction). The
  cron dispatcher inserts a task row into the task queue (`calypso-distribution/
apps/server/src/cron/imap-etl-dispatch.ts` pattern); the worker claims it via
  the HTTP task-queue API (`ApiEtlStore` pattern). Extend `TaskType` to include
  `EMAIL_INGEST`. Use Greenmail test container for integration tests
  (`calypso-distribution/packages/db/imap-container.ts`). PRD §6; schedule,
  retry, and failure handling via task queue stale-claim recovery.
- PII tokeniser: stable tokens, per-tenant salt, round-trip via the
  dictionary service. Test corpus: curated sample of realistic
  customer-interaction emails.
- `Email` entity write path via the API layer. Worker has read-only
  role; writes route through `POST /internal/ingestion/email` with a
  scoped token.
- `CorpusChunk` entity + chunking strategy (boundary: sentence +
  max-tokens). Each chunk carries a relation back to its source
  email.
- Embedding service: Ollama in dev, in-house Rust `candle` server in
  prod, both running `nomic-embed-text-v1.5` (PRD §6,
  `docs/technical/embedding.md`). Abstraction picked at boot.
- pgvector index on the embedding column. HNSW parameters in
  configuration, not hard-coded. Storage-layer encryption only,
  per PRD §7 "Embedding column threat model" — and the four
  compensating controls (audit, rate limit, no direct API exposure,
  per-tenant scoping) land with this issue.
- Ingestion state machine per PRD §4.1, including failure paths.
- Retention metadata written at ingestion time: `retention_class`
  and `legal_hold` fields populated with tenant-policy default
  (Phase 8 builds the policy engine; Phase 2 just writes the
  fields).

**Exit criteria.** A real IMAP account feeding real emails produces
queryable anonymised corpus chunks, with zero PII appearing in any
worker-visible view, verified by a fixture-based integration test.

---

## Phase 3 — Autolearning worker

**Goal.** An ephemeral Kubernetes pod, scoped to one (department,
customer) pair, can read ground truth, run Claude CLI against a
temp-filesystem view of the wiki, and write a **draft**
`WikiPageVersion` back through the API. The pod holds no long-lived
credentials.

**Scout issue.** _Minimal autolearn vertical slice_: single-customer
manual trigger, hardcoded scope, real Claude CLI, real Postgres write
through the API. Publication gate not yet wired — this scout produces
a draft that lands in `AWAITING_REVIEW` and is visible only through a
direct DB query, not yet through any UI. Proves the
worker-token-scoping and API-mediated-write invariants before anything
scales.

**Follow-on issues.**

- Kubernetes ephemeral pod spec: distroless, read-only root FS, no
  shell, service account bound to (dept, customer) scope (WORKER
  blueprint). Reuse `calypso-distribution/k8s/agent-worker.yaml` as
  the baseline manifest.
- **Worker NetworkPolicy** — `NetworkPolicy` blocking the worker pod from
  reaching the database port directly (`WORKER-C-006`). The
  `calypso-distribution/k8s/agent-worker.yaml` already enforces this:
  egress allows only api-server (port 80) and HTTPS (443) + DNS (53).
- **Worker egress restriction** — outbound connections restricted to declared
  vendor API hostnames only (Anthropic API). No other external egress
  (`WORKER-C-024`).
- Scoped worker token mint path: `POST /internal/worker/tokens`
  issues a single-use task-scoped token with pod-lifetime TTL.
  Consumed tokens are invalidated at pod terminate.
- Temp-filesystem stager: writes anonymised ground truth +
  current wiki markdown to `/tmp/` inside the pod; destroyed on
  terminate.
- **Claude CLI wrapper** — invokes the CLI via **array-form spawn**
  (never shell-string interpolation — `WORKER-C-007`, `WORKER-X-006`).
  Vendor CLI version pinned in Dockerfile; binary copied at build time,
  never downloaded at runtime (`WORKER-C-023`, avoids `WORKER-X-007`).
  Enforces hard timeout. Captures stdout/stderr and the diff between
  input and output wiki. Audit events store **input/output hashes**,
  not plaintext prompts/responses (`WORKER-C-018`, avoids `WORKER-X-008`).
- `POST /internal/wiki/versions` write endpoint; validates,
  authorises against the worker token scope, commits the new
  `WikiPageVersion` in `draft` state.
- **Cron scheduler for gardening runs** — cron is a _task producer_: it
  inserts an `AUTOLEARN` task row into the task queue every 15 minutes
  (default, tenant-overridable via `feature_flags` or a policy row — not a
  hard-coded constant). Workers claim from the queue (`TQ-D-005` wake via
  LISTEN/NOTIFY). PRD §4.3.
- **Autolearn digital twin sandbox mode** — autolearn pod requests a
  sandboxed twin containing only the relevant production-state slice.
  Sandbox execution cannot commit production state without a separate
  promotion step (`DATA-D-011`, `TEST-C-016`, `WORKER-D-006`,
  `WORKER-C-011/012`). Production-state unchanged is verified by test.
- Deepclean path (PRD §4.5): on-demand trigger, full-ground-truth
  fetch, always routes to `AWAITING_REVIEW` and always requires
  human approval regardless of materiality.
- State-machine test harness: every state transition in PRD §4.3
  is exercised by a real integration test against a real
  ephemeral pod in a kind-cluster CI environment (TEST blueprint
  — "test on target platform").
- Embedding of new draft versions; same path as Phase 2.
- Claim-citation coverage check (PRD §9 accuracy SLA): every
  autolearn draft is checked for the invariant that each factual
  claim cites at least one `CorpusChunk`. Violations mark the
  draft as P1 and block publication.

**Exit criteria.** A manually triggered autolearn run on a seeded
customer produces a draft `WikiPageVersion` with ≥ 99% claim-citation
coverage, verified by a real Claude CLI invocation in CI, and no
writes from the worker container's DB role appear anywhere.

---

## Phase 4 — Wiki web UX

**Goal.** RMs can see the published wiki for their customers, with
version history, the "N pending drafts" indicator, and citation hover
that reveals the source ground-truth snippet.

**Scout issue.** _Read-only rendered wiki for one customer_: markdown
render, version picker, source citation hover. Agent visibility metadata
(PRD §5.3) surfaces `created_by` and `source` on every version. No
annotations, no editing — those land after the scout.

**Follow-on issues.**

- Wiki render component in `apps/web`; markdown pipeline.
- Version history UI (PRD §5.2, §5.3).
- Draft indicator per PRD §5.5 — shows "N pending drafts" when
  the RM has approval authority.
- Citation hover: clicking a claim reveals the linked
  `CorpusChunk` and its source ground-truth entity, through the
  re-identification service so the RM sees the real
  sender/speaker name.
- RLS-enforced "my customers only" filter; test proves a second
  RM cannot fetch the first RM's wiki.
- PWA parity: the same wiki view works on the mobile PWA surface
  (PRD §5.1).
- Playwright e2e suite covering the happy path and the "wrong
  RM tries to access" path.

**Exit criteria.** An RM logs in, opens a seeded customer, sees a
rendered wiki with citation hovers and version history, all on real
headless Chromium (TEST blueprint — no JSDOM for browser tests).

---

## Phase 5 — PWA & meeting transcription

**Goal.** An RM records a meeting on the PWA, the audio is transcribed
on the edge path (default) or the worker path (long recordings), and
the transcript lands in the ingestion pipeline without raw audio ever
crossing the trust boundary.

**Scout issue.** _Edge-path end-to-end_: PWA records, transcribes
on-device, uploads transcript only, lands in Postgres tagged to a
customer, triggers autolearn. Proves the edge path and the
"no raw audio leaves the device" invariant before the worker path
or AssemblyAI legacy path are considered.

**Follow-on issues.**

- PWA shell hardening: manifest, service worker, install prompt
  (already partially in place at `feat/242`, `feat/250`).
- Audio recording component with background-preserve state per PRD
  §5.4.
- On-device transcription model (candidate: whisper.cpp WASM or a
  Web Speech API fallback; buy-vs-build decision documented per
  ARCH blueprint).
- Worker path: cluster-internal transcription worker for
  recordings longer than the edge-path threshold. Distroless, no
  external network egress at the container-network-policy level.
- `AudioRecording` + `Transcript` entity writes via the same
  API-mediated path as email.
- Speaker diarisation tags (`SPEAKER_A`, `SPEAKER_B`) propagated
  to the autolearning context.
- Tenant-configuration gate for the AssemblyAI legacy path (PRD
  §6, §4.2): available only to tenants explicitly opted in, blocked
  at the config layer for regulated tenants. Ship the gate; do
  not ship AssemblyAI as a default.
- State-machine tests for edge path, worker path, and failure
  transitions per PRD §4.2.

**Exit criteria.** A 3-minute PWA recording on the edge path shows up
as a transcript attached to a customer, triggers an autolearn draft,
and raw audio is proven by test to have never left the device. The
worker path handles a 30-minute recording end-to-end in staging.

---

## Phase 6 — Annotations & publication gate

**Goal.** RMs can correct the wiki by opening an annotation thread;
the agent responds; drafts are reviewed and published through the
UI; the hallucination-escalation counter works end-to-end.

**Scout issue.** _Single annotation thread end-to-end_: RM selects a
passage, opens a comment, agent responds via the Anthropic API,
annotation is resolved, a new published `WikiPageVersion` is written.
Publication gate for this corrective flow is wired inline because the
RM action itself is the explicit approval.

**Follow-on issues.**

- Inline annotation UI in the wiki view (Google-Docs-style
  anchored threads, PRD §5.2). Playwright e2e.
- Annotation state machine per PRD §4.4 including
  `AUTO_RESOLVED`, `DISMISSED`, `REOPENED`.
- Annotation agent: Anthropic API SDK call (not Claude CLI —
  shorter, interactive; PRD §6).
- Publication gate UI for the **autolearn** path: the draft
  review screen from Phase 3, now user-facing. Shows diff
  against current published version, materiality classification,
  approve/reject buttons, required for diffs above the
  configured threshold.
- Hallucination escalation counter (PRD §9): `DISMISSED`
  annotations increment a per-customer counter; three in 30
  days forces the next autolearn draft into explicit-approval
  mode regardless of materiality.
- Agent visibility labels on every agent-authored message in
  threads (PRD §5.3, UX blueprint — "no invisible agent
  participation").
- Audit events for every annotation creation, agent reply, and
  publication gate decision.

**Exit criteria.** An RM opens a wrong claim, argues with the agent,
accepts the corrected wording, and the next query returns the corrected
version. A parallel run with three dismissals forces the next autolearn
run into manual-approval mode.

---

## Phase 7 — BDM campaign analysis

**Goal.** A BDM selects an asset manager, receives a 1-pager of meeting
themes, and cannot — by any query, traversal, or side channel —
re-identify which customers those meetings came from.

**Scout issue.** _RLS boundary proof_: a BDM session attempts to read a
customer row, a wiki page, a ground-truth email, an identity-dictionary
entry, and traverse `has_ground_truth` relations. Every attempt is
blocked at the database layer. The scout ships the RLS policies and the
tests; the summary generation comes after.

**Follow-on issues.**

- `AssetManager` and `Fund` entity types; CRM admin UI for managing them.
- Tagging model: autolearning agent writes `discussed_in` relations from
  transcripts to `AssetManager` / `Fund` (PRD §4.7). Extends the Phase 3
  autolearn prompt.
- Restrictive RLS policies for BDM sessions per PRD §4.7: blocks on
  customers, wikis, ground-truth emails, customer interests,
  dictionary, and traversal relations that link transcripts to
  customers. The database layer enforces this; application-layer filtering
  is defense-in-depth.
- **Analytics tier population** — BDM campaign queries execute against
  `kb_analytics`, not `kb_app`. Phase 0 created the empty `kb_analytics`
  database; this issue populates it with pseudonymised session events and
  the anonymised chunk materialization that BDM queries need (`DATA-D-006`,
  `DATA-D-007`, `DATA-C-010/011`, avoids `DATA-X-003`). Session pseudonyms
  rotate per session via HMAC-SHA256; no direct read path back to `kb_app`.
- Campaign analysis view in `apps/web`: asset-manager/fund picker,
  query endpoint that returns anonymised chunks (queried from `kb_analytics`).
- Summary generation: Claude API call on anonymised chunks, structured
  1-pager output (themes, topics, sentiment, frequency). Fallback to
  raw chunk list on API failure per PRD §4.7.
- Audit events for every cross-customer BDM query, logging actor,
  asset manager, department, and timestamp (PRD §7 insider-abuse
  posture).
- Export path (CSV, optional PDF), itself audited.

**Exit criteria.** A penetration test from a BDM role cannot identify a
single client behind any meeting chunk, verified by an integration test
that tries every obvious and several non-obvious traversals.

---

## Phase 8 — Records management & compliance

**Goal.** Regulated tenants can operate the system without the product
becoming a compliance liability: retention is enforced, WORM mode is
available, legal holds work, and e-discovery export is a one-click
operation from the Compliance Officer role.

**Scout issue.** _Retention policy engine end-to-end_: tenant policy
declares "5 years MiFID II"; deletion of a `CorpusChunk` before the
floor is blocked at the database layer, not the application. One
tenant, one policy, one test.

**Follow-on issues.**

- Retention policy schema + tenant-scoped policy assignment (PRD §7a).
- Database-layer deletion block using restrictive policies; tests
  covering every ground-truth and synthetic entity type.
- WORM mode for ground-truth tables: once committed, no update, no
  delete, until retention expires. Required for MiFID II Art. 16(6)
  and SEC 17a-4(f) tenants.
- `LegalHold` entity + admin UI + four-eyes removal flow (PRD §7a).
- Retention scheduler: nightly job that hard-deletes entities past
  retention unless held.
- E-discovery export: bundle of ground truth + wiki versions +
  annotations + audit trail for a given scope, in a structured
  format, itself audited.
- Compliance Officer role (PRD §2): read-only access to audit, holds,
  retention status, and exports. Cannot read customer content.
  Restrictive RLS policies.
- SOC 2 Type II evidence capture: wire up the control evidence that
  the attestation auditor will require (access reviews, change logs,
  incident response runbook, backup verification).

**Exit criteria.** A compliance officer can place a legal hold, export
a customer's records for a date range, and verify that the hold blocks
retention deletion — all through the UI, all audited. The tenant
configuration screen can switch a tenant between "unregulated" and
"MiFID II" and the behaviour changes deterministically.

---

## Cross-cutting work

These items are not scout-eligible (they do not stand alone as a
vertical slice) but they must land with or before the phases that
depend on them. The Plan issue will attach each to the earliest phase
that needs it.

| Concern                                         | Lands with | Rationale                                                                                            |
| ----------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| Structured logging + PII scrub + dual log       | Phase 0    | Nothing can ever log PII; dual log (chronological + uniques) and browser error forwarding from start |
| Trace-ID propagation (browser → server → DB)    | Phase 0    | End-to-end from browser side; needed for debugging from the first real request                       |
| k3d cluster + task queue + design system        | Phase 0    | Foundation for all subsequent phases; Docker Compose not used                                        |
| mTLS service mesh (Linkerd) — issues #88        | Phase 1    | PRD §7 resolved requirement; must be in place before multi-service traffic                           |
| KMS integration (HSM-backed)                    | Phase 1    | Field-level encryption is a Phase 1 gate; KMS must be HSM-backed in staging                          |
| Rate limiting — issue #89                       | Phase 1    | Auth endpoints need it from first login; embedding column reads need it per PRD §7                   |
| Auth incident response runbook (four scenarios) | Phase 1    | Must predate any customer data; runbook for signing key compromise, agent cred, admin, mass revoke   |
| Observability (metrics, traces)                 | Phase 2    | Ingestion pipeline is the first thing with a latency SLA                                             |
| Backup + restore runbook                        | Phase 2    | As soon as customer data lands, a recovery path must exist                                           |
| SOC 2 evidence wrapper + incident runbook wrap  | Phase 8    | SOC 2 audit artifact; auth-scenario runbook already exists from Phase 1                              |

---

## Risks & mitigations

| Risk                                                       | Impact                                        | Mitigation                                                                                                                                 |
| ---------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude CLI wrapper in ephemeral pods is novel for the team | Phase 3 slips; autolearn state machine churns | Scout issue is deliberately minimal; prove the wrapper before building the gardening scheduler                                             |
| On-device transcription model quality on low-end PWAs      | Phase 5 edge path unusable on real devices    | Scout issue runs on a real mid-range Android in CI; fallback to worker path is part of the same phase, not a separate phase                |
| RLS policy authoring is error-prone                        | Silent data leaks                             | Every RLS policy has a dedicated integration test asserting the block; Phase 7 scout is an explicit RLS pen-test                           |
| Embedding column is the weakest encryption link            | Semantic leakage via inversion attack         | PRD §7 compensating controls are implemented in Phase 2 (audit, rate limit, no direct API exposure, per-tenant scoping), not deferred      |
| Claim-citation coverage SLA is unmeasurable                | Accuracy SLA is vapor                         | Phase 3 ships a deterministic check in the autolearn pipeline; drafts without citations fail the gate automatically                        |
| BDM re-identification via side channel                     | Regulatory failure                            | Phase 7 scout is a pen-test. The scout must fail the first attempt — if the first attempt passes, the test is not strong enough            |
| KMS misconfiguration                                       | Entire field-encryption story collapses       | Phase 1 lands against real staging KMS, not a local stub. Key rotation test runs in CI against staging                                     |
| AssemblyAI legacy path accidentally becomes the default    | Regulated tenant data leaks to US             | Phase 5 ships the tenant-config gate first, then the worker path, then (if ever) the AssemblyAI integration, with the gate as the enforcer |
| Scope creep from open questions (Slack, Drive)             | Plan becomes unachievable                     | v2 features explicitly excluded; open questions stay in PRD §10 until a Plan v2 is drafted                                                 |

---

## Open questions for the Product Owner

Not blocking issue creation, but must be resolved before the phase they
affect begins.

| Question                                              | Blocks  | Current proposed default                                                                          |
| ----------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| Gardening cron frequency                              | Phase 3 | 15 minutes, tenant-overridable via policy row (not a hard-coded constant)                         |
| Edge-path recording length threshold                  | Phase 5 | 10 minutes — above this, worker path is used                                                      |
| Materiality threshold for autolearn publication gate  | Phase 6 | "No new claims" — phrasing/citation edits auto-publish; anything adding a claim requires approval |
| SOC 2 attestation target date                         | Phase 8 | 12 months from Phase 0 merge                                                                      |
| Which cloud provider hosts v1 production              | Phase 1 | GCP (existing infra work at `feat/255`–`feat/265`)                                                |
| Tenant configuration UI — self-service or admin-only? | Phase 8 | Admin-only for v1                                                                                 |
| Differential privacy on analytics exports             | Phase 7 | Deferred to post-v1; Phase 7 ships pseudonymised session events and per-tenant scoping only       |

---

## Next steps

1. **Product Owner review** of this document. Lock the phase structure
   and the open-question defaults, or mark them as blocking.
2. **Create the GitHub "Implementation Plan" tracking issue** from the
   phase structure above, with each phase's scout as the first
   referenced issue.
3. **Create feature issues** (one per follow-on bullet above). Titles
   carry no phase/step metadata (`calypso-replan` rule). Bodies follow
   the standard feature-issue template.
4. **Attach dependencies** in the Plan issue only — never in individual
   issue bodies.
5. **Begin Phase 0** via `calypso-auto` or `calypso-develop`, starting
   with the Phase 0 scout issue. No work on later phases until the
   Phase 0 scout merges.
