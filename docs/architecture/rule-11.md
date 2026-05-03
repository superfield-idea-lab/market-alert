# Rule 11: test — Testing Strategy

## Summary of the blueprint rule

The TEST blueprint asserts that tests are the only proof that software works and that
test suites must serve as executable specifications — especially in agent-built systems
where no single contributor carries institutional memory of original intent.

Core principle (TEST-P-001 `prefer-real-systems`): the order of preference is real
dependency first, recorded fixture from a real dependency second, and a narrowly-scoped
fake only when the boundary cannot be exercised credibly in automated tests. The burden
of proof is always on the fake.

Key threats the blueprint mitigates:

- **TEST-T-002 `test-validity`**: mock-based tests pass but real API behavior differs.
- **TEST-T-003 `fixture-accuracy`**: agent-generated fixtures reflect imagination, not
  the real API shape.
- **TEST-T-001 `environment-parity`**: tests pass on macOS but fail on Linux in production.
- **TEST-T-004 `browser-fidelity`**: tests pass in JSDOM but fail in real Chromium.
- **TEST-T-006 `merge-gating`**: CI allows merge despite failing tests.
- **TEST-T-007 `test-reliability`**: flaky tests are treated as bugs, never retried.
- **TEST-T-008 `test-first-discipline`**: stubs must precede features, not confirm them.

Design patterns required:

- **TEST-D-001 `golden-fixture-recording`**: build a fixture recorder that makes real
  HTTP calls via MSW v2 `passthrough()`, serializes request/response pairs to disk, and
  commits them. Replay mode returns fixture data through MSW handlers so the full
  `fetch()`/`Request`/`Headers`/`Response` code path executes in every test.
- **TEST-D-002 `suite-per-workflow-ci`**: one GitHub Actions workflow file per test suite;
  each is self-contained with its own install, setup, run, and report steps.
- **TEST-D-003 `local-ci-command-parity`**: canonical per-suite commands are identical
  locally and in CI. A local pass predicts a CI pass.
- **TEST-D-004 `headless-browser-testing`**: all browser tests run in real headless
  Chromium, not JSDOM or Happy DOM.
- **TEST-D-005 `separate-quality-gate`**: lint, format, and build verification live in a
  dedicated workflow; test-suite workflows run tests only.
- **TEST-D-006 `ledger-replay-recovery`**: dedicated tests prove the system can rebuild
  state from durable ledger facts. Covers genesis replay, checkpoint replay, backup
  restore, and materialized-state comparison.
- **TEST-D-008 `msw-http-interception`**: MSW v2 `setupServer` is the sole HTTP intercept
  layer. It patches `http.ClientRequest` and undici fetch internals at the transport layer
  so the real `fetch()` call executes before interception. No `vi.fn()`, `vi.mock()`, or
  global replacements.
- **TEST-A-002 `parallel-ci-suites`** (selected architecture): five separate CI workflows
  (quality gate + unit + API integration + component + E2E) run in parallel on separate
  runners. Merge gate requires all workflows to pass.
- **TEST-A-003 `fixture-refresh-pipeline`**: a scheduled CI job re-runs the recorder
  against live APIs, diffs against committed fixtures, alerts on schema drift, and commits
  updated fixtures.

Absolute checklist gate (TEST-C-018 `no-mocks`): grep for `vi.fn`, `vi.mock`,
`vi.spyOn`, `jest.fn`, or the bare word `mock` in test files must return zero results.

## TypeScript implementation specifics

Source: `/root/market-alert/blueprint/rules/implementations/ts/test-ts.yaml`

**Single test driver (IMPL-TEST-001)**: Vitest drives all TypeScript test categories —
unit, API integration, component, and E2E. Jest, Mocha, and standalone Playwright runners
are not permitted.

**Playwright as browser provider only (IMPL-TEST-002)**: Playwright is not run as a
top-level CLI tool. It supplies the headless Chromium engine to Vitest. Vitest owns
lifecycle, orchestration, and reporting.

**No JSDOM (IMPL-TEST-027)**: component tests must not run in JSDOM or Happy DOM. These
are DOM simulations; they lack layout, real event dispatch, and network behavior.

**Directory layout**:

| Suite           | Location             | Browser engine               |
| --------------- | -------------------- | ---------------------------- |
| Unit            | `/tests/unit`        | None (Bun runtime)           |
| API integration | `/tests/integration` | None (Bun runtime)           |
| React component | `/tests/component`   | Playwright headless Chromium |
| Full-page E2E   | `/tests/e2e`         | Playwright headless Chromium |

**Bun runtime owns infrastructure (IMPL-TEST-003)**: container startup, server processes,
fixture loading, and environment wiring all live in Bun-side Vitest hooks (`beforeAll`,
`afterAll`, setup files). Nothing is delegated to manual shell sessions or external
orchestration.

**No fixed database URLs (IMPL-TEST-017)**: integration and component suites receive
the database connection string from a dynamically allocated port chosen by the container
helper (IMPL-TEST-016). `DATABASE_URL` is never a hard-coded constant in test code.

**CI workflow files** (IMPL-TEST-008): five workflow files are required:

- `quality-gate.yml` — lint + format + build (IMPL-TEST-009)
- `test-unit.yml` — Vitest unit suite
- `test-api.yml` — Vitest API integration suite
- `test-component.yml` — Vitest + Playwright component suite
- `test-e2e.yml` — Vitest + Playwright E2E suite

Each test-suite workflow runs its canonical command only — no lint, format, or build
steps duplicated (IMPL-TEST-010). Merge is blocked unless the quality gate and all
required test workflows pass (IMPL-TEST-011).

**Golden fixture recorder** (IMPL-TEST-013): a Bun script reads runtime configuration,
calls real external services, writes response bodies and headers as JSON files under
`/tests/fixtures/`, and logs schema drift versus existing fixtures.

**Fixtures are files, not env vars** (IMPL-TEST-014 / IMPL-TEST-025): all replay data
lives under `/tests/fixtures/` or suite-specific fixture subdirectories. `.env` files
are configuration channels only.

**Key bought dependencies**:

- Vitest (IMPL-TEST-019) — mandatory TypeScript test driver
- Playwright (IMPL-TEST-020) — browser provider for component and E2E suites
- ESLint (IMPL-TEST-021) — linting in quality gate
- Prettier (IMPL-TEST-022) — formatting in quality gate

## Application to market-alert PRD/plan

### Test layers

**Unit tests** (`/tests/unit`): pure business logic with no external I/O.

- Alert state machine transitions (`Pending → Detected → Enriched → Deduplicated →
Delivered → Acknowledged → Archived`) — each valid and invalid transition asserted.
- Corporate Action state machine transitions (`Announced → Effective → Closed → Disputed`).
- Trade state machine transitions (`Proposed → Executed → Settled → Reconciled`).
- Terms extraction rule engine (regex/rule-based extractor for EDGAR XML/HTML text) with
  representative filing text slices from committed test strings.
- Deduplication key derivation: `(ticker, event_type, announced_at ± 24h)`.
- Idempotency key construction for EDGAR poll tasks:
  `edgar_poll:<form_type>:<accession_number>`.
- Task queue claim/retry/DLQ logic in `packages/db/task-queue.ts`.
- RLS policy rule unit assertions (rule correctness in isolation, not DB enforcement).
- Feature flag evaluation middleware.

**API integration tests** (`/tests/integration`): real Postgres, real HTTP server, MSW
v2 for external endpoints.

- EDGAR ingestion end-to-end: MSW v2 intercepts all `sec.gov` and `efts.sec.gov` calls
  with committed fixtures from `tests/fixtures/edgar/`. One ATOM feed replay produces one
  `CorporateAction` row with encrypted `filing_text` and one `ALERT_ENRICH` task in the
  queue. Zero live network calls.
- `POST /internal/ingestion/corporate-action` validates payload, writes entity, enqueues
  task — tested with the real API server and real Postgres.
- Alert enrichment pipeline: `ALERT_ENRICH` task claimed → enrichment worker
  (exercised via real API call) → `Alert` written in `Enriched` state → `ALERT_DEDUP`
  task queued → dedup produces a journal entry.
- Deduplication correctness: two alerts for the same `(ticker, event_type, announced_at
± 24h)` pair produce one merged alert with two `source_references`; dedup key
  uniqueness verified in Postgres.
- Deduplication idempotence: replaying the same pair of inputs twice produces exactly one
  merged alert row (no double-merge).
- RLS enforcement: Admin session cannot read a Trader's private alert note at the
  database layer, verified by a real query.
- Passkey registration and login round-trip against the real auth stack.
- Audit record written before sensitive read: a failed audit write must deny the read.
- Business journal ledger replay (genesis → materialized state) for a seeded
  `CorporateAction`.
- Backup restore: restore into a clean Postgres instance and replay journal entries to
  current state, asserting materialized state matches.

**Component tests** (`/tests/component`): real headless Chromium via Playwright provider.

- Alert feed renders enriched alert card with ticker, event type, deal terms summary,
  spread estimate, and timestamp.
- Alert detail view renders all `DealTerms` fields (including nulls shown as "unavailable"
  with the `extraction_confidence` badge).
- Acknowledge button transitions the alert status badge optimistically and calls
  `POST /api/alerts/:id/acknowledge`.
- Watchlist add/remove interaction updates the rendered watchlist.
- Disabled "Propose trade" CTA stub renders but is non-interactive when `trade_lifecycle`
  feature flag is false.
- Admin source toggle renders, calls the feature flag API, and reflects the updated
  on/off state.

**E2E tests** (`/tests/e2e`): full stack in k3d, real headless Chromium.

- Golden-path boot canary: start stack, hit `/health/live`, assert 200, tear down.
- WebSocket push within 1 second: seeded alert transitions to `Deduplicated`; connected
  trader session receives push and renders the alert within the latency budget. This test
  provides the latency budget assertion required by the sub-second delivery SLA.
- Cross-trader RLS isolation: second trader session cannot see first trader's alert detail
  or private notes.
- Trade proposal from alert CTA: Trader navigates from alert detail to trade form,
  pre-populated `alert_id` and `ticker` are correct.
- EDGAR ingestion toggle: Admin disables `edgar_ingest` flag; next poll cycle skips;
  health dashboard reflects inactive state.
- Full alert lifecycle happy path: ingestion fixture → enrichment → dedup → WebSocket
  delivery → trader acknowledge.

### Real Postgres in CI

Integration tests run against a real Postgres instance provisioned by testcontainers-node
inside Vitest `beforeAll`. The container is started on a random host port; the URL is
injected into the app process via environment variable set in the Bun-side setup hook.
The container is stopped in `afterAll`. No shared database state between test suites.

The test-pg-container workflow (`test-pg-container.yml`) is a fifth CI workflow (in
addition to unit, api, component, e2e) that validates the container provisioning sequence
independently.

E2E tests run against the full k3d cluster where Postgres is a cluster-internal service,
matching the production topology and satisfying `TEST-P-003 test-on-target`.

### Recorded EDGAR RSS/filings fixtures

The golden fixture recorder (Phase 0 deliverable) makes real HTTP calls to the EDGAR
ATOM feed endpoints using MSW v2 `passthrough()` mode, then serializes the full
request/response pairs to:

```
tests/fixtures/edgar/
  atom-8k.json         — ATOM feed response for form type 8-K
  atom-sc13d.json      — ATOM feed response for form type SC 13D
  atom-s4.json         — ATOM feed response for form type S-4
  atom-425.json        — ATOM feed response for form type 425
  atom-def14a.json     — ATOM feed response for form type DEF 14A
  filing-8k-sample.json — one complete filing document body
```

These files are committed to the repository. MSW v2 handlers for `sec.gov` and
`efts.sec.gov` return the committed fixture data in all automated test runs. Zero live
EDGAR calls occur during any test run.

A 30-day scheduled CI pipeline re-runs the recorder against the live EDGAR endpoints,
diffs against committed fixtures, alerts on schema drift, and opens a PR with updated
fixtures if changes are detected (TEST-A-003 `fixture-refresh-pipeline`).

Market data source fixtures for the delta-neutral impact calculation (Phase 3) follow
the same pattern under `tests/fixtures/market-data/` once the price feed provider is
selected.

### Deterministic time

The EDGAR ingestion worker uses `filed_at` timestamps from the EDGAR feed response. In
integration tests, the committed fixture contains real timestamps. Tests that exercise
time-dependent logic (e.g., `announced_at ± 24h` dedup window, settlement date cron
trigger, `CORP_ACTION_ADVANCE` scheduling) use Vitest's `vi.setSystemTime()` or pass
explicit `now` parameters rather than reading `Date.now()` directly inside business
logic, keeping functions pure and testable without mocking at the module level.

### Deduplication tests

Deduplication correctness is verified at two layers:

1. **Unit**: the dedup key derivation function is tested with representative `(ticker,
event_type, announced_at)` tuples, including boundary cases at exactly ±24 hours.
2. **Integration**: two enriched alerts representing the same corporate action from
   different EDGAR form types are submitted through the API. The test asserts one merged
   `Alert` row with both `source_references`, one dedup journal entry, and no duplicate
   `ALERT_NOTIFY` task enqueued.

Idempotency is tested separately: submitting the same pair of inputs twice (simulating
at-least-once delivery from the task queue) produces exactly one merged alert.

### Replay tests

Business journal replay tests run in the integration suite against real Postgres:

- **Genesis replay**: start from an empty materialized table, replay all journal entries
  for a seeded corporate action from the first `Announced` transition, assert the
  resulting state matches the live entity row.
- **Checkpoint replay**: replay from an intermediate journal entry (e.g., from
  `Effective`) and assert only the remaining transitions are applied.
- **Materialized-state comparison**: after replay, run a hash comparison between the
  replayed state and the live `mkt_app` row to detect divergence.
- **Point-in-time query**: supply an ISO 8601 timestamp that falls between two
  transitions; assert the reconstructed state matches the expected intermediate state.
- **Backup restore**: spin up a second Postgres container, restore a pg_dump of the
  seeded database, replay journal entries, assert materialized state matches the source.

### Latency budget tests

The sub-second delivery SLA (`< 1 second from event detection to trader notification`) is
enforced by an E2E test:

1. A seeded `Alert` is transitioned to `Deduplicated` via API in the test.
2. The test records the transition timestamp (from the API response).
3. A connected Playwright session listens for the WebSocket push event.
4. The test asserts the push is received and rendered within 1000 ms of the recorded
   transition timestamp.

If the assertion fails, the suite fails and the merge gate blocks. No flakiness tolerance
is permitted: if this test is intermittently slow, the performance regression is treated
as a bug.

## Recommended technologies and vendors

One pick per slot, honouring the no-mocks constraint throughout.

| Slot                | Pick                                                          | Rationale                                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test runner         | **Vitest**                                                    | Mandated by IMPL-TEST-001; native Bun support; watch mode; TypeScript-native; no configuration divergence across suites                                                                                                                      |
| HTTP interception   | **MSW v2** (`msw/node` with `setupServer`)                    | Mandated by TEST-D-008; intercepts at transport layer so real `fetch()` executes; supports passthrough for recording and handler return for replay; no `vi.mock` needed                                                                      |
| Real Postgres in CI | **testcontainers-node** (`@testcontainers/postgresql`)        | Provisions a real Postgres container on a random port inside the Vitest setup hook; no external docker-compose service to pre-start; container lifecycle owned by Bun-side `beforeAll`/`afterAll`; satisfies IMPL-TEST-016 and IMPL-TEST-017 |
| Fixture management  | **Bun script golden recorder** (`scripts/record-fixtures.ts`) | Reads config, calls real external services via MSW `passthrough()`, writes JSON files to `tests/fixtures/`; no third-party fixture framework; drift detection via JSON schema diff logged to stdout; 30-day scheduled CI refresh             |
| E2E tool            | **Playwright** (as Vitest browser provider)                   | Mandated by IMPL-TEST-002 and IMPL-TEST-020; real headless Chromium; no JSDOM; Vitest owns lifecycle; screenshots available for visual inspection                                                                                            |
| Coverage            | **Vitest coverage with v8 provider**                          | Built into Vitest; v8 provider uses native V8 coverage, no instrumentation overhead; reports to `coverage/` directory; 99% line coverage threshold enforced in CI as required by the twelve-check gate (`PROCESS-D-011`)                     |

## Gaps and conflicts

**PRD §9 "minimal audit logging for MVP" vs. TEST-D-006 `ledger-replay-recovery`**:
The PRD originally deferred audit, but the plan explicitly overrides this with blueprint
requirements. This is resolved: comprehensive audit and ledger replay tests are Phase 1
gates. No conflict remains in the plan, but implementation must not regress to the PRD's
original intent.

**Kubernetes / k3d vs. testcontainers boundary**: Integration tests use testcontainers-node
for Postgres (fast, self-contained), while E2E tests use the full k3d cluster (production-
topology match). This split satisfies `TEST-P-003 test-on-target` for both layers but
requires that the integration test Vitest setup and the k3d E2E setup share no state and
impose no ordering dependency on each other (TEST-P-005).

**Digital twin lifecycle test (TEST-C-016)**: The plan calls for an enrichment digital
twin sandbox in Phase 3 (sandboxed clone for enrichment workers before promotion to
production state). The twin lifecycle test (TEST-D-007 / TEST-C-016) must be added when
that infrastructure is implemented. This test is not yet in the plan's explicit test
deliverables and represents a gap that Phase 3 must close.

**Market data source fixture gap**: Phase 3 requires price data for delta-neutral impact
calculation, but the market data source is unresolved (plan open question). The fixture
recorder cannot be run until a source is selected. The integration test for enrichment
will remain incomplete until this is resolved. A stub fixture with plausible structure
should be committed as a placeholder to unblock test-first development.

**`vi.setSystemTime()` vs. no-mocks rule**: Using `vi.setSystemTime()` to control the
system clock in unit tests does not violate the no-mocks rule (it is not mocking a module
or function). However, it must not be used alongside `vi.mock()` or `vi.spyOn()` in the
same test file. Business logic that reads the clock must accept an injected `now` parameter
to keep unit tests pure without any Vitest time manipulation.

**TEST-C-016 twin lifecycle test infrastructure cost**: Twin lifecycle tests require
provisioning a sandboxed Postgres clone and verifying production state is unchanged.
This is operationally heavier than ordinary integration tests. These tests may extend
CI time beyond the five-minute target (TEST-C-020 `suites-under-five-minutes`). They
should be placed in a separate `test-twin.yml` workflow so they do not lengthen the
critical path of unit, integration, component, and E2E suites.

## Open questions

1. **Market data price feed provider**: Which free or contracted provider will supply
   real-time or delayed price data for delta-neutral impact calculation in Phase 3? The
   answer determines the fixture schema and the MSW handler for that endpoint. This must
   be resolved before the Phase 3 enrichment integration tests can be completed.

2. **EDGAR rate limit handling in fixture recorder**: The recorder calls
   `www.sec.gov` directly. EDGAR enforces a 10 requests/second per IP limit. The recorder
   script should add explicit rate limiting between calls; confirm whether CI runner IPs
   are shared (which could cause interference between parallel recorder jobs and other CI
   jobs hitting EDGAR).

3. **pg_dump / restore in testcontainers**: The backup restore test requires running
   `pg_dump` against the source container and restoring into a second container. Confirm
   that testcontainers-node supports two-container setups in a single Vitest workspace,
   or whether the backup restore test should be isolated in a dedicated Bun script run
   outside Vitest.

4. **99% line coverage threshold enforcement**: The twelve-check CI gate requires 99%
   line coverage. With the no-mocks rule, achieving 99% on code paths that interact with
   external services (EDGAR HTTP, database) requires integration tests to cover those
   paths. Confirm the coverage provider aggregates unit + integration + component + E2E
   coverage, or whether 99% is enforced per-suite.

5. **Schema drift alerting destination**: The 30-day fixture refresh pipeline must alert
   on schema drift. What channel receives the alert (GitHub issue, email, Slack webhook)?
   This must be configured before the first refresh run executes.
