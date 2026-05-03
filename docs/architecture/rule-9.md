# Rule 9: prune — Prune & Lifecycle Cleanup

## Summary of the blueprint rule

The PRUNE blueprint frames feature deletion as a disciplined, analytics-driven pipeline
rather than an ad-hoc housekeeping task. Its core insight is that dead code has concrete
costs: test surface, dependency coupling, security attack surface, and agent cognitive
load. The blueprint mandates a four-stage state machine before any feature is removed.

**Four-stage pipeline (PRUNE-P-003, PRUNE-AR-001):**

1. **Signal collection** — an analytics agent queries all instrumented surfaces over a
   configurable lookback window (default 90 days) and emits a machine-readable YAML
   candidate report. A feature must be unobserved across all applicable dimensions (UI
   clicks, API call counts, role-gated access) before it can be listed. Dormant-by-design
   features annotated with `# DORMANT_BY_DESIGN` are excluded.
2. **Deprecation notice + flag creation** — a `feature_flags` database row is inserted
   (`state=deprecated_notice`, `scheduled_disable_at=now+notice_period`). In-product
   notices are added at all feature touch points. The feature remains fully functional.
   Notice must run for at least one full release cycle (minimum 30 days) before disable.
3. **Flag flip to disabled** — a background job evaluates `scheduled_disable_at` and
   flips the flag to `disabled`. `disabled_at` and `removal_eligible_at` are set.
   A 48-hour monitoring window follows, watching for user-reported errors.
4. **Code removal** — only after `removal_eligible_at` passes with no escalations may a
   PR be opened. The PR removes all code paths, tests, and notice UI behind the flag; the
   `feature_flags` row is archived (not deleted) to preserve the audit trail.

**Key principles:** flags are database rows, not code constants (PRUNE-P-005); every
user-visible surface must emit analytics events (PRUNE-P-006); agents annotate dormant
features at implementation time (PRUNE-P-002); corroborating multi-dimensional evidence
is required before any pipeline entry (PRUNE-P-001); skipping the silence period between
disable and code removal is an explicit antipattern (PRUNE-A-004).

**Key threats guarded against:** false-positive pruning of infrequently-used but critical
features (PRUNE-T-001), silent removal without user notice (PRUNE-T-002), flags left
permanently disabled without code removal (PRUNE-T-003), analytics blind spots causing
"untracked" to be mistaken for "unused" (PRUNE-T-004), and rollback unavailability after
premature code removal (PRUNE-T-005).

---

## TypeScript implementation specifics

There is no `prune-ts.yaml`. The following maps blueprint principles to the TypeScript
toolchain used by this project.

**Feature flag table and middleware.** The `feature_flags` Postgres table (PRUNE-D-003)
is already required by Phase 0. In TypeScript, flag evaluation middleware lives in
`apps/server/src/middleware/feature-flag.ts`. The middleware reads the flag table with a
short TTL in-process cache (e.g., 30 seconds via a simple `Map` with expiry timestamps
or a lightweight `lru-cache` entry). The scheduled disable job is a `FEATURE_FLAG_EXPIRE`
task type in the existing task queue, evaluated by the scheduler worker on each deployment
or at a configurable cron interval — not a separate cron process.

**Dormant-by-design annotations.** The structured comment block from PRUNE-D-004 must
appear in TypeScript source as a block comment adjacent to the feature entry point (route
handler, React component root, or capability guard):

```typescript
/*
 * DORMANT_BY_DESIGN
 * depends_on: trade_lifecycle
 * reason: "Propose trade" CTA stub hidden until Phase 6 ships
 * reviewed_at: 2026-05-01
 */
```

A custom ESLint rule or a simple `grep`-based CI script can scan for stale
`reviewed_at` dates (older than 6 months) and emit warnings in the signal report.

**Dead-code and dependency detection.** In a TypeScript monorepo, the primary tools are:

- **knip** — analyzes exports, re-exports, and entry points across workspaces to find
  unused code. Integrates with `pnpm` workspaces. Run in CI as a non-blocking warning
  in early phases, promoted to a blocking check post-Phase 3.
- **depcheck** — scans `package.json` dependencies against actual `import` statements to
  find unused npm packages.
  These tools surface candidates for the signal report but cannot replace analytics
  telemetry: knip identifies structurally unreferenced code, not behaviourally unused
  features. Both are inputs to stage 1, not substitutes for it.

**Analytics instrumentation.** Every API route in `apps/server` and every user-triggered
action in `apps/web` emits a structured usage event to the analytics pipeline. In
TypeScript this means a lightweight `trackUsage(surface: string, actor: UserId)` call
that enqueues an event to `mkt_analytics` asynchronously, never on the hot path. The
requirement from PRUNE-P-006 that absent instrumentation is a compliance violation (not a
zero-usage signal) is enforced by a CI checklist check that cross-references route
definitions against the analytics event registry.

**Silence period enforcement.** The `removal_eligible_at` column is computed in SQL as
`disabled_at + INTERVAL '30 days'`. A PR gate script (analogous to the existing
`depends-on` CI check) queries the `feature_flags` table and blocks code removal PRs for
flags where `removal_eligible_at > now()`.

---

## Application to market-alert PRD/plan

**Alert retention — Archived state (PRD §6).**
The PRD's Alert lifecycle ends at `Archived`. The `Archived` state is the system's
retention trigger: alerts auto-advance to `Archived` after a configurable retention
period (default: 90 days post-`Acknowledged`, or 30 days post-`Delivered` if never
acknowledged). Archived alerts are written to cold object storage (see Technologies
below) and purged from `mkt_app`. The `retention_class` field on `CorporateAction`
(established in Phase 2) governs which retention window applies. The archival job is a
`ALERT_ARCHIVE` task type in the scheduler worker, enqueued by a nightly cron producer.
This lands in **Phase 3** when the Alert state machine is first implemented, with the
archive worker following in **Phase 5** alongside the Admin panel's bulk export path.

**Event replay log retention.**
The business journal (`DATA-D-004`) is the replay substrate for Phase 7. Journal entries
must be retained for the full compliance window (minimum 7 years for SEC-regulated
entities, per PRD §9 regulatory constraint). Journal rows are never deleted; they are
candidates for cold-tier migration after 2 years of inactivity. The Phase 7 structured
export (`GET /api/replay/corporate-actions/:id`) is the mechanism by which compliance
exports are generated — export events themselves are audited. Retention policy is written
as a `retention_class='journal'` row in the feature flags–adjacent `retention_policies`
table introduced in Phase 1.

**Audit log retention.**
The audit store (append-only, hash-chained, `mkt_audit` pool) is governed by a separate
`retention_class='audit'` policy. For SEC-regulated entities the minimum retention
horizon is 7 years. Audit rows are never soft-deleted; after the retention window they
are cryptographically sealed and moved to cold storage, with only the hash-chain root
retained in `mkt_audit` for chain verification. This is introduced in **Phase 1** as
part of the audit store setup, with cold migration tooling following in **Phase 7**.

**Dead branches and feature-flag cleanup.**
The plan seeds five v1 feature flags in Phase 0: `edgar_ingest`, `alert_notify_email`,
`alert_notify_sms`, `alert_notify_webhook`, `trade_lifecycle`. The `trade_lifecycle`
flag is explicitly a pruning-pipeline candidate: it is inserted `state=disabled` in
Phase 0, flipped to `enabled` when Phase 6 exits (PRUNE-D-002 compliance — the Phase 4
CTA stub is the DORMANT_BY_DESIGN use case). Future vendor flags (Bloomberg,
DealReporter, etc.) follow the same pattern. Each flag row must have `scheduled_disable_at`
set at creation time or within 30 days; a flag with no scheduled disable is a PRUNE-T-003
violation and is flagged by the CI checklist.

**Unused dependency hygiene.**
`depcheck` and `knip` run in CI from Phase 0 as non-blocking warnings. They are promoted
to blocking in **Phase 5**, after the core feature set stabilises. Any npm package
appearing in `depcheck` output that has been unused for 90+ days (measured from the last
`package-lock.json` change that added it) enters the pruning pipeline at stage 1. Vendor
adapter packages for unlicensed sources (Bloomberg SDK, etc.) must not be added to
`package.json` until the source is licensed — they are gated by feature flags at the
code level, not by npm install.

---

## Recommended technologies and vendors

| Slot                                         | Pick                                                         | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retention scheduler / cron mechanism         | **Existing task queue (`scheduler` worker + cron producer)** | The plan already mandates a task queue for all scheduled work (TQ-D-001). Adding a dedicated cron library would violate that constraint. `ALERT_ARCHIVE` and `FEATURE_FLAG_EXPIRE` are new task types in the scheduler worker; the cron producer inserts them on a nightly schedule. No additional vendor needed.                                                                                                                                                                      |
| Dead-code detection                          | **knip**                                                     | Knip understands pnpm workspaces, TypeScript project references, and re-exports natively. It is more accurate than `ts-prune` (unmaintained) for monorepos and complements `depcheck` for package-level hygiene. Run via `pnpm knip` in CI.                                                                                                                                                                                                                                            |
| Data archival target (cold object storage)   | **AWS S3 with S3 Glacier Instant Retrieval storage class**   | S3 is already the natural complement to a Postgres-on-Kubernetes deployment. Glacier Instant Retrieval provides millisecond access for compliance retrieval requests at a fraction of S3 Standard cost. Archived alert payloads and sealed audit chain segments are written as gzip-compressed NDJSON objects with a deterministic key scheme (`alerts/{year}/{month}/{alert_id}.ndjson.gz`).                                                                                          |
| Retention policy enforcement for PII / audit | **Postgres row-level TTL via the scheduler worker**          | Rather than a separate data lifecycle SaaS, retention policy enforcement is a `RETENTION_EXPIRE` task type checked nightly by the scheduler worker. The `retention_policies` table holds class-specific windows (e.g., `audit: 7y`, `alert: 90d`). The worker queries `mkt_app` for rows past their retention window and either archives to S3 or seals in `mkt_audit`. This keeps the enforcement path observable, auditable, and test-covered without an external vendor dependency. |

---

## Gaps and conflicts

1. **PRD §9 "minimal audit logging for MVP" vs. PRUNE-P-006 "every surface is
   instrumented".** The plan already resolves the audit gap in favour of the blueprint.
   However, the PRD does not specify analytics instrumentation at all. The pruning
   pipeline depends on telemetry from day one (PRUNE-C-001). Analytics instrumentation
   must be treated as a Phase 0/1 requirement alongside the `mkt_analytics` pool
   introduction, not deferred to later phases.

2. **`trade_lifecycle` flag as a DORMANT_BY_DESIGN stub.** The plan describes a disabled
   flag in Phase 0 that enables in Phase 6. This is correct PRUNE-P-002 usage, but the
   annotation must be added to the Phase 4 CTA stub component at implementation time.
   If the annotation is omitted, the Phase 0 signal report will incorrectly flag the
   stub as a pruning candidate on day one.

3. **No analytics event registry defined.** The plan instruments the system with
   structured logging (Phase 0) and `mkt_analytics` (Phase 7) but does not define a
   canonical event registry. Without a registry, PRUNE-P-006's requirement that absent
   instrumentation is a compliance violation cannot be enforced by CI. A lightweight
   `packages/core/analytics-events.ts` registry should be introduced in Phase 0.

4. **Vendor feature flags have no scheduled disable date.** The plan seeds flags for
   unlicensed vendor sources with no `scheduled_disable_at`. Per PRUNE-T-003, flags left
   indefinitely without a disable schedule accumulate as dead code behind permanent false
   flags. Each vendor flag should have a review date (at minimum) set at creation, with
   a CI check blocking rows where `scheduled_disable_at IS NULL AND created_at < now() - INTERVAL '30 days'`.

5. **knip integration with the existing twelve-check CI gate.** The plan defines twelve
   specific CI checks (Phase 0) but does not include a dead-code or unused-dependency
   check. Adding `knip` and `depcheck` as a thirteenth check after Phase 3 requires
   updating the pre-registered check names in GitHub branch protection — a low-risk
   but explicit action.

---

## Open questions

1. **Retention window for `Acknowledged` alerts.** The PRD mandates system auto-archival
   after a retention period but does not specify the window. Is 90 days post-Acknowledged
   the correct default, or does the fund's compliance policy impose a shorter or longer
   window? This must be confirmed before Phase 3 implements the Alert state machine.

2. **Regulatory minimum retention for SEC-regulated hedge funds.** The plan assumes a
   7-year minimum for audit and journal records based on general SEC Rule 17a-4
   guidance. Does the specific fund entity class (RIA, broker-dealer, etc.) impose a
   different window? Legal confirmation required before Phase 1 introduces retention
   policy rows.

3. **Cold storage access latency for compliance exports.** The Phase 7 structured export
   targets S3 Glacier Instant Retrieval. If the compliance team requires exports within
   minutes (not the ~12-hour Glacier Flexible window), Instant Retrieval is the right
   tier. If sub-hour is insufficient, Standard S3 with a lifecycle transition after
   180 days is the safer default. Confirm with the compliance team before Phase 7.

4. **Analytics lookback window for v1 pruning cycles.** The blueprint default is 90 days.
   For an early-stage system where many features will be newly deployed and have no
   meaningful usage history, a 90-day lookback will produce no pruning candidates for the
   first 90 days. Should the first pruning cycle be scheduled no earlier than 120 days
   post-Phase 4 launch, and who is the designated product owner for sign-off?

5. **knip false positives in the monorepo.** The existing codebase (`main`) is described
   as a mature Superfield KB implementation. Running `knip` before the trading system
   features land may generate false positives for KB-specific exports that are entry
   points from outside the analysed workspace. Should `knip` be configured with an
   explicit include list limited to new trading system packages, or run against the full
   monorepo with a suppression list for known KB entry points?
