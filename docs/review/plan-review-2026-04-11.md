# Plan Review — 2026-04-11

<!-- reviewer: Claude Opus 4.6 (senior systems engineer audit) -->
<!-- source: docs/implementation-plan-v1.md -->
<!-- blueprint: calypso-blueprint/rules/blueprints/*.yaml (all 11 domains) -->
<!-- cross-checked: docs/PRD.md, docs/technical/db-architecture.md, ~/superfield-distribution -->

## Verdict

The plan is structurally sound. Scout-gating, phase ordering, passkey-first posture, and
worker-writes-via-API discipline are all correctly applied. Every finding below is a scope
omission or re-sequencing, not an architectural error.

**Six critical gaps** must be fixed before Phase 1 starts.
**Eighteen material gaps** must be fixed before v1 is blueprint-conformant.

---

## What the plan gets right

- Scout-gating correctly applied to every phase; Phase 1 scout ("passkey → session →
  RLS-context → audit-first → encrypted-read") and Phase 7 scout ("pen-test where the first
  attempt _must_ fail") are exemplary.
- Passkey-only, no password fallback, from the first user-facing commit. `AUTH-D-001`,
  `AUTH-X-001`.
- Postgres from first commit, no embedded-DB migration path. DATA blueprint vision.
- Worker DB role read-only; writes via API with scoped single-use tokens. `WORKER-D-001`,
  `WORKER-D-002`, `AUTH-D-003`, `AUTH-C-010`.
- Zero mocks; MSW v2; kind-cluster integration tests. `TEST-C-018`, `TEST-C-004`.
- PRD §7 compensating controls for embedding column land with Phase 2, not deferred.
- Phase 0 before features. `PROCESS-D-009`, avoids `PROCESS-X-002`.
- AssemblyAI legacy path shipped as a config gate first, default off.

---

## Critical gaps

### C1. Analytics tier missing — DATA blueprint broken

Plan's "three-pool" = app / audit / dictionary.
Blueprint (`DATA-D-006`, `DATA-C-001/002/010/011`) + `docs/technical/db-architecture.md` require
`kb_app` / `kb_audit` / `kb_analytics`. **These are not the same three.**

- `superfield-distribution/k8s/app.yaml` already declares `DATABASE_URL`,
  `AUDIT_DATABASE_URL`, `ANALYTICS_DATABASE_URL` — three distinct databases.
- The plan dropped analytics and substituted dictionary. Dictionary isolation is correct
  and necessary (PRD §7), but it is _orthogonal_ to the analytics tier, not a replacement.
- `DATA-X-003` (analytics-on-transactional-store) becomes structurally impossible to satisfy.
- Phase 7 BDM queries are currently planned against `kb_app` behind RLS. That is
  defense-in-depth, not aggregation-tier separation.

**Fix:** Change "three-pool" to **four-pool**: app, audit, analytics, dictionary.
Phase 0 scaffold creates all four databases with empty roles. Phase 7 populates the analytics
tier and queries from it.

### C2. Task queue absent entirely

`docs/technical/db-architecture.md` specifies a full task queue (atomic SKIP LOCKED claims,
LISTEN/NOTIFY, status lifecycle machine, per-type views, idempotency keys, dead-letter queue,
delegated-token per row). The plan only mentions "cron scheduler" and "scoped worker token" —
two leaves of the queue, not the queue.

`superfield-distribution` already has the full implementation:

- `packages/db/schema.sql` — task_queue table, partial indexes, per-type view
- `packages/db/task-queue.ts` — atomic claim logic, stale-claim recovery, heartbeat
- `apps/server/src/api/tasks.ts` — claim/complete/fail/heartbeat HTTP endpoints
- `apps/server/src/cron/imap-etl-dispatch.ts` — cron as a _task producer_, not a direct worker

This pattern applies to every worker phase: Phase 2 email ingestion, Phase 3 autolearn,
Phase 5 transcription worker, Phase 6 annotation agent, Phase 7 BDM summary.

Violated: `TQ-D-001` through `TQ-D-006`, `TQ-C-001` through `TQ-C-008`.

**Fix:** Add Phase 0 follow-on: _"task queue scaffold — reuse superfield-distribution
`packages/db/task-queue.ts`; extend `TaskType` for autolearn, ingestion, transcription,
correction, deepclean, bdm-summary; add per-type views; add DLQ monitoring"_.

### C3. Dev environment is Docker Compose; blueprint and superfield-distribution both use k3d

Phase 0 says "Dev Postgres via Docker Compose". Phase 3 then uses "kind-cluster CI environment".
Three different topologies (Docker Compose dev, kind CI, k3s prod).

`superfield-distribution` already uses **k3d** for local demo:

- `scripts/local-demo.ts` — k3d cluster creation with local registry
- `deploy/base/` — api-server, worker, postgres, static-web, ingress manifests
- `k8s/agent-worker.yaml` — agent worker NetworkPolicy (blocks direct DB)

`ENV-D-002` requires dev/CI/prod to be the same container topology. `ENV-X-009` says tests
against cluster database are an antipattern.

**Fix:** Phase 0 uses k3d from day one, reusing `superfield-distribution/scripts/local-demo.ts`
and `superfield-distribution/deploy/base/` manifests as the starting point. Remove Docker Compose.

### C4. CI gate is nine checks; blueprint requires twelve

Plan specifies nine checks: build, lint, format, unit, integration, e2e, coverage, checklist,
depends-on. `PROCESS-D-011` requires twelve: add `issue-checklist`, `conflicts`, `single-issue`.

`superfield-distribution` already has 14 GitHub workflows (test-unit, test-api, test-component,
test-e2e, test-pg-container, test-migration, test-host-init, quality-gate, release, deploy, ...).
The three additional required checks (`PROCESS-D-013`, `PROCESS-D-014`, `PROCESS-D-015`) are
not present and need to be added. Coverage threshold should be **99% line coverage**
(`PROCESS-C-027`). All check names must be pre-registered before branch protection is enabled
(`PROCESS-C-024`).

**Fix:** Issue #5 scope = twelve checks, not nine. Coverage threshold = 99%.

### C5. Incident response runbook sequenced wrong

Cross-cutting table places "Incident response runbook" at Phase 8 (SOC 2 evidence). `AUTH-C-030`
requires a tested auth-compromise runbook — four scenarios (signing key compromise, agent
credential compromise, admin account compromise, mass session invalidation) — **before customer
data lands**. That is Phase 1, not Phase 8.

Issue #92 ("docs: incident response runbook for SOC 2 evidence") is in the wrong phase.

**Fix:** Split into two issues. Auth runbook (four scenarios, tested) → Phase 1. SOC 2
wrapper stays in Phase 8.

### C6. Beauty is deferred to Phase 4 — UX antipattern (`UX-X-005`)

Phase 0 ships "a single empty PWA route" — which is the first demo and therefore the visual
quality anchor. No design system is mentioned anywhere in the plan.

Also missing: `UX-D-001` (service flow mapping before implementation), `UX-D-004` (unified
design system), `UX-C-002` (design system initialized), `UX-C-001` (service flow maps before
any implementation). Admin surfaces are scattered across Phase 7 (CRM admin), Phase 8 (tenant
config, compliance officer, legal hold) with no shared design system binding them.

**Fix:** Phase 0 follow-on: design system skeleton (color/type/space tokens, one primitive,
static catalog, Playwright screenshot review loop). Service flow maps for Phases 4–8 as
documentation artifacts in Phase 0 (design, not code).

---

## Material gaps

| #   | Gap                                                                  | Blueprint Rules                                 | Fix                                                                                                                 |
| --- | -------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| M1  | Digital twin / sandbox absent                                        | `DATA-D-011`, `TEST-C-016`, `WORKER-D-006`      | Add Phase 3 follow-on: autolearn runs against twin first; promotion requires separate authorization                 |
| M2  | Business journal vs audit log not distinguished                      | `DATA-D-004`, `DATA-C-026/027`                  | Phase 1: clarify or add journal; audit log is the access trail, journal is replay-able facts                        |
| M3  | Trace ID browser→server→DB (plan is server-only)                     | `DEPLOY-D-004`, `DEPLOY-C-007`                  | Extend Phase 0 trace-ID issue to include browser side                                                               |
| M4  | Dual log (chronological + uniques) + browser error forwarding absent | `DEPLOY-D-002/003`, `DEPLOY-C-008/010`          | Add to Phase 0 follow-ons                                                                                           |
| M5  | Single /health endpoint — blueprint requires three                   | `DEPLOY-C-030/031/032`, `DEPLOY-X-008`          | Phase 0: liveness + readiness + deep health checks                                                                  |
| M6  | Production deployment human-action gate not stated                   | `DEPLOY-D-005`, `DEPLOY-C-027`                  | State explicitly; `superfield-distribution/deploy.yml` already gates prod on Environment approval                   |
| M7  | Deployment audit record (`deployments.jsonl`) absent                 | `DEPLOY-D-006`, `DEPLOY-C-035`                  | Add to Phase 0                                                                                                      |
| M8  | Golden fixture recorder not specified                                | `TEST-D-001`, `TEST-C-003/019/025`              | Phase 0: golden fixture recording tool + 30-day refresh schedule                                                    |
| M9  | Test suite time budget not set                                       | `TEST-C-020`                                    | Phase 0: 5-minute total budget across four suites                                                                   |
| M10 | Worker network policy (pod→DB) not specified                         | `WORKER-C-006`                                  | Phase 3 scout: `NetworkPolicy` blocking worker pod → DB port; reuse `superfield-distribution/k8s/agent-worker.yaml` |
| M11 | Worker egress policy not specified                                   | `WORKER-C-024`                                  | Phase 3 scout: egress restricted to Anthropic API host only                                                         |
| M12 | Claude CLI array-form spawn not stated                               | `WORKER-C-007`, `WORKER-X-006`                  | Phase 3: explicit invariant — execFile/array-form spawn; vendor CLI version pinned in Dockerfile                    |
| M13 | Audit log: hashes not plaintext                                      | `WORKER-C-018`, `WORKER-X-008`                  | Phase 3: audit events store input/output hashes, not plaintext prompts/responses                                    |
| M14 | Auth key recovery flow absent                                        | `AUTH-D-007`, `AUTH-C-016/017`                  | Phase 1: passphrase + second factor → re-enrollment; recovery events notify enrolled devices                        |
| M15 | Token refresh rotation, progressive lockout, generic errors absent   | `AUTH-C-018/024/032`                            | Phase 1                                                                                                             |
| M16 | Feature flag scaffolding absent                                      | `PRUNE-D-002/003`, `PRUNE-C-002`, `PRUNE-A-003` | Phase 0: `feature_flags` table + evaluation middleware; AssemblyAI gate backed by DB row                            |
| M17 | Ledger replay tests                                                  | `TEST-D-006`, `TEST-C-014`                      | Phase 1 or 2: genesis replay, checkpoint replay, materialized-state comparison                                      |
| M18 | KMS HSM-backed not stated in plan (it is in PRD §7)                  | `DATA-C-023`                                    | Tighten Phase 1 exit criterion to "HSM-backed staging KMS"                                                          |

---

## superfield-distribution reuse opportunities

| Component                                             | Source in superfield-distribution                           | Target phase                      |
| ----------------------------------------------------- | ----------------------------------------------------------- | --------------------------------- |
| k3d cluster setup                                     | `scripts/local-demo.ts`, `deploy/base/`                     | Phase 0                           |
| k8s manifests (api-server, worker, postgres, ingress) | `deploy/base/*.yaml`                                        | Phase 0                           |
| Agent worker NetworkPolicy                            | `k8s/agent-worker.yaml`                                     | Phase 0 / Phase 3                 |
| Task queue (schema + claim logic + API endpoints)     | `packages/db/task-queue.ts`, `apps/server/src/api/tasks.ts` | Phase 0                           |
| IMAP ETL worker (two-phase: landing + classify)       | `packages/core/imap-etl-worker.ts`                          | Phase 2 (#26 already notes reuse) |
| IMAP test container (Greenmail)                       | `packages/db/imap-container.ts`                             | Phase 2                           |
| GitHub workflows (14 workflows)                       | `.github/workflows/`                                        | Phase 0                           |
| Host provisioning                                     | `scripts/init-host.sh`                                      | Phase 0                           |

---

## Internal consistency issues

1. `docs/technical/db-architecture.md` = three databases (app/analytics/audit).
   Plan = three pools (app/audit/dictionary). One must change before Phase 1.
2. Plan says "nine-check CI" but `superfield-replan` grades against twelve. Fix #5.
3. Phase 0 ships an empty PWA route (UX quality anchor) but no design system.
4. Phase 1 cross-cutting lists Linkerd mTLS but Phase 1 issue list does not include it.
   Issues #88 and #89 exist but are not clearly attached to Phase 1 in the Plan.
5. Issue #40 ("cron scheduler for autolearn") should be retitled — the cron is a task
   _producer_, not the scheduler. The task queue is the scheduler.

---

## New issues required (not yet in the Plan)

| Issue title                                                                        | Phase | Rationale                    |
| ---------------------------------------------------------------------------------- | ----- | ---------------------------- |
| feat: k3d dev cluster scaffold reusing superfield-distribution manifests           | 0     | C3 — replaces Docker Compose |
| feat: task queue scaffold reusing superfield-distribution implementation           | 0     | C2                           |
| feat: twelve-check CI gate with issue-checklist, conflicts, single-issue workflows | 0     | C4 (updates #5)              |
| feat: design system skeleton with tokens, one primitive, screenshot loop           | 0     | C6                           |
| feat: feature_flags table and evaluation middleware                                | 0     | M16                          |
| feat: golden fixture recorder with scheduled refresh                               | 0     | M8                           |
| feat: deployment audit record (deployments.jsonl)                                  | 0     | M7                           |
| feat: three-tier health checks (liveness, readiness, deep)                         | 0     | M5                           |
| feat: browser-to-server error forwarding and dual log architecture                 | 0     | M4                           |
| feat: auth incident response runbook — four scenarios, tested                      | 1     | C5 (supersedes #92 scope)    |
| feat: passkey key recovery flow with passphrase and re-enrollment                  | 1     | M14                          |
| feat: token refresh rotation, progressive lockout, generic error messages          | 1     | M15                          |
| feat: business journal distinct from audit log with ledger replay tests            | 1     | M2, M17                      |
| feat: worker network policy blocking pod-to-DB direct access                       | 3     | M10                          |
| feat: Claude CLI array-form spawn invariant and vendor version pin                 | 3     | M12                          |
| feat: autolearn digital twin sandbox mode with promotion boundary                  | 3     | M1                           |
| feat: analytics tier population for BDM campaign queries                           | 7     | C1                           |

---

## Issues to update (body change)

| Issue | Change                                                                                                     |
| ----- | ---------------------------------------------------------------------------------------------------------- |
| #5    | "nine-check CI gate" → "twelve-check CI gate"; reference superfield-distribution/`.github/workflows/`      |
| #6    | "docker compose stack" → "k3d cluster scaffold"; reference `superfield-distribution/scripts/local-demo.ts` |
| #15   | "three-pool" → "four-pool: app, audit, analytics, dictionary"                                              |
| #40   | Cron is a task-queue _producer_; retitle or update body to clarify                                         |
| #92   | Scope narrowed to SOC 2 evidence wrapper only; auth runbook moves to Phase 1                               |

---

## Recommended sequence of edits

1. Align `docs/implementation-plan-v1.md` to this review (done in same commit).
2. Update issues #5, #6, #15, #40, #92.
3. Create the seventeen new issues listed above.
4. Update Plan issue #3 body to include new issues at the correct phase positions.
5. Do not begin Phase 0 implementation until the Plan issue body is stable.
