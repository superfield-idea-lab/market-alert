# Rule 1: arch — Architecture

## Summary of the blueprint rule

`arch.yaml` makes the codebase legible to agents who arrive without verbal
context. It treats structure as a contract enforced by build pipelines, not by
discipline. Key obligations:

- **Physical runtime separation (`ARCH-P-001`, `ARCH-D-001`).** Server and
  client live in distinct top-level directories with distinct entry points and
  build configurations. A browser import that resolves to a server module must
  fail at build time, not at runtime. Shared utility duplication is preferred
  over a shared-runtime utils package.
- **Directory tree as architecture diagram (`ARCH-P-002`, `ARCH-A-001`).** The
  fixed layout (`/apps/web`, `/apps/server`, `/packages/core`, `/packages/ui`,
  `/packages/services`, `/packages/integrations`, `/tests`, `/docs`) must let
  any new agent locate deployable units, contracts, business logic, and tests
  in seconds.
- **Dependencies are liabilities (`ARCH-P-003`, `ARCH-D-002`).** A two-question
  Buy/DIY test gates every new package: (1) infeasible to build internally?
  (2) mature, minimal, well-maintained? Both must be yes. Decisions are written
  to `docs/dependencies.md` (`ARCH-C-005`, `ARCH-C-014`).
- **Types shared, logic not (`ARCH-P-004`, `ARCH-D-004`).** API
  request/response types live in a single canonical module imported by both
  sides. Business logic is never shared across the client/server boundary.
  Integration tests assert that real responses match the contracts
  (`ARCH-C-011`).
- **Simplicity over cleverness (`ARCH-P-005`).** Boring, obvious structure
  beats auto-generated barrels, dynamic resolution, or ad-hoc microservice
  splits (`ARCH-X-004`).
- **Threats to neutralize.** Server code in browser bundle (`ARCH-T-001`),
  browser code on server (`ARCH-T-002`), shared-types drift (`ARCH-T-004`),
  trivial dependency creep (`ARCH-T-005`), unbounded package creation
  (`ARCH-T-007`), API contract drift (`ARCH-T-008`).
- **Architecture pick.** Single-product, ≤3-agent context maps to
  `ARCH-A-001` monorepo-collocated-packages, not `ARCH-A-002` multi-app or
  `ARCH-A-003` polyrepo.
- **Antipatterns to avoid.** `/packages/utils` junk drawer (`ARCH-X-001`),
  deep relative import paths (`ARCH-X-002`), server imports leaking into the
  client bundle (`ARCH-X-003`), premature microservices (`ARCH-X-004`).

## TypeScript implementation specifics

`arch-ts.yaml` (IMPL-ARCH) pins the stack hard:

- **Language.** TypeScript only. No plain `.js` files anywhere
  (`IMPL-ARCH-001`).
- **Runtime and build tool.** Bun is both the server runtime and the build
  tool for all packages. No Node.js (`IMPL-ARCH-002`).
- **UI framework.** React (latest stable). No Vue, Svelte, Solid, etc.
  (`IMPL-ARCH-003`).
- **Styling.** Tailwind CSS, vanilla, no pre/postprocessors. No CSS-in-JS, no
  Sass, no CSS Modules (`IMPL-ARCH-004`).
- **State.** React hooks plus minimal context. No Redux, Zustand, MobX, Jotai
  (`IMPL-ARCH-005`).
- **Testing.** Vitest for unit (`/tests/unit`), Playwright for E2E
  (`/tests/e2e`) (`IMPL-ARCH-006`, `IMPL-ARCH-007`).
- **API style.** REST. GraphQL/WebSockets/Protobuf are excluded unless the
  product demands massive concurrency or sub-second real-time
  (`IMPL-ARCH-008`, `IMPL-ARCH-013`, `IMPL-ARCH-015`).
- **Layout.** Fixed `/apps/web`, `/apps/server`, `/packages/{ui, core,
services, integrations}`, `/tests/{unit,integration,e2e}`, `/docs`
  (`IMPL-ARCH-009`).
- **Build separation.** `/apps/web` ships browser-only; `/apps/server` ships
  a Bun binary. No shared `tsconfig.json`, no shared build step
  (`IMPL-ARCH-010`, `IMPL-ARCH-011`, `IMPL-ARCH-012`, `IMPL-ARCH-026`).
- **Contracts.** All API I/O types live as universal TS types in
  `/packages/core`; both sides import from there
  (`IMPL-ARCH-014`, `IMPL-ARCH-024`). Contracts are versioned and tested
  against production responses (`IMPL-ARCH-016`).
- **Service categories.** Ingestion + integration REST clients in
  `/packages/services` and `/packages/integrations`; business logic and
  domain types in `/packages/core`; shared UI in `/packages/ui` with
  app-specific shells in `/apps/web`; auth as middleware in `/apps/server`
  (`IMPL-ARCH-017` through `IMPL-ARCH-021`).
- **Dependency policy.** Buy SDKs and engines (Stripe, Playwright); DIY
  utilities (`date-fns`, small components). Every dependency justified in
  `docs/dependencies.md` (`IMPL-ARCH-022`, `IMPL-ARCH-023`,
  `IMPL-ARCH-025`).

## Application to market-alert PRD/plan

The PRD describes an event-driven arbitrage alert platform with two user roles
(Trader, Admin — PRD §3), an Alert/CorporateAction/Trade entity model
(PRD §6), real-time push delivery (PRD §2, §9), and several integration
surfaces (PRD §7). Mapping this onto `arch.yaml`:

- **Monorepo layout (Phase 0 scout, plan §"Phase 0").** The plan's scout
  issue explicitly creates `apps/server`, `apps/web`, `apps/worker`,
  `packages/core`, and a `tests/` skeleton "per ARCH blueprint" — this is
  `ARCH-A-001` with one extra app: `apps/worker`. The worker app is justified
  by `WORKER-D-001` (workers are deployable units distinct from the API
  server) and does not violate `ARCH-D-003` because its responsibility
  (claiming task queue rows and calling `POST /internal/...` endpoints) is
  disjoint from `apps/server` (handling end-user HTTP).
- **Strict runtime separation.** `/apps/web` (Trader dashboard, Admin panel,
  alert detail view, Phase 4–6) must never import worker or server code. The
  Phase 1 passkey reuse note ("Reuse existing `apps/server/src/auth/`")
  confirms auth lives in `apps/server` middleware (`IMPL-ARCH-021`).
- **Shared contracts (`ARCH-D-004`, `IMPL-ARCH-014`).** PRD §6 entities
  (Alert, CorporateAction, Trade) and the Phase 2 normalised entity schema
  (§"Normalised CorporateAction entity") must live in `/packages/core` as
  TypeScript types. The plan's `POST /internal/ingestion/corporate-action`,
  `POST /internal/alerts`, `POST /api/alerts/:id/acknowledge`, the trade
  endpoints, and the Phase 7 `GET /api/replay/...` endpoints must all consume
  these shared types from a single source. The Phase 4 WebSocket payload
  schema is also a contract and belongs in `/packages/core`.
- **Ingestion + integrations placement (`IMPL-ARCH-017`,
  `IMPL-ARCH-020`).** The EDGAR ATOM client (Phase 2), the SMTP/SMS/webhook
  channel adapters (Phase 4 outbound delivery), and the eventual market data
  source (Phase 3 delta-neutral) each go in either `/packages/services`
  (REST clients we own) or `/packages/integrations` (third-party SDK
  wrappers). The MSW v2 fixture handlers under `tests/fixtures/edgar/` and
  `tests/fixtures/vendor/` (Phase 0, Phase 2) are the corresponding test
  doubles.
- **Core logic placement (`IMPL-ARCH-018`).** Terms extraction, the
  deduplication engine, delta-neutral impact calculation, the Alert/CA/Trade
  state machines, and the business journal replay logic (Phases 3, 6, 7) are
  all `/packages/core`. The enrichment worker in `apps/worker` should call
  into `/packages/core` for these algorithms; the worker container itself is
  thin runtime glue.
- **Real-time exception (`IMPL-ARCH-008`, `IMPL-ARCH-015`).** The PRD's
  sub-second SLA (PRD §2, §9, §"Performance") meets the carve-out for
  WebSockets. The Phase 4 LISTEN/NOTIFY → WebSocket push path is the only
  sanctioned non-REST surface; everything else (Phase 4 acknowledge, Phase 5
  admin actions, Phase 6 trade lifecycle, Phase 7 replay) stays REST.
- **CI separation (`ARCH-C-006`, `IMPL-ARCH-012`).** The plan's
  twelve-check CI gate (Phase 0) must run separate build steps for web,
  server, and worker. The "no single build step exceeds 30s" check
  (`ARCH-C-015`) is implicit in Phase 0's exit criteria.
- **Dependency justification (`ARCH-C-005`, `IMPL-ARCH-023`).** The plan
  selects several packages whose Buy/DIY rationale must be written down:
  Bun (runtime), React, Tailwind, Vitest, Playwright, MSW v2, the WebAuthn
  library used by `apps/server/src/auth/`, the SMTP adapter, the SMS
  provider, the XML/ATOM parser used by the EDGAR worker, Linkerd
  (service mesh, Phase 1). `docs/dependencies.md` is a Phase 0 deliverable
  even though the plan does not currently name it.

## Recommended technologies and vendors

Opinionated picks. Each is the single answer for this app.

- **Package manager + workspaces: pnpm.** The plan already uses
  `pnpm install` and `pnpm dev` (Phase 0 exit criteria, "Dev onboarding").
  Pnpm's strict, content-addressed `node_modules` layout makes
  `ARCH-X-002`-style import-path acrobatics painful and catches phantom
  dependencies, which directly serves the dependency-minimalism principle.
- **Runtime: Bun ≥ 1.1 for `apps/server` and `apps/worker`.** Mandated by
  `IMPL-ARCH-002`. The fast cold start helps the Phase 4 sub-second alert
  push path; the built-in Postgres client and bundler reduce the dependency
  surface (`ARCH-P-003`).
- **Bundler for `apps/web`: Vite + `@vitejs/plugin-react`.** Vite is the
  React community standard with the smallest legible config; it pairs with
  Vitest (mandated by `IMPL-ARCH-006`) sharing one transform pipeline,
  reducing duplicated build config (`IMPL-ARCH-026`). It compiles to a
  pure browser bundle, which is exactly what `IMPL-ARCH-010` requires.
- **HTTP framework on `apps/server`: Hono on Bun.** Hono is a thin,
  type-first router with first-class Bun support and minimal transitive
  deps (satisfies `ARCH-T-006`, `ARCH-P-003`). It exposes typed handlers
  that consume `/packages/core` request/response types directly, matching
  `ARCH-D-004`.
- **API contract format: TypeScript types + Zod schemas in
  `/packages/core`.** Zod is the only runtime validation library small
  enough to justify (`ARCH-D-002`); it produces both static types and
  runtime parsers from one definition, which lets the server validate
  ingress (`POST /internal/ingestion/corporate-action`) and the integration
  tests assert that real EDGAR-shaped responses still parse — directly
  serving `ARCH-C-011`, `ARCH-C-019`, `IMPL-ARCH-016`.
- **WebSocket transport: Bun's native `Bun.serve` WebSocket upgrade path.**
  Avoids adding `ws` or Socket.IO. Justified by the carve-out in
  `IMPL-ARCH-015` for the Phase 4 sub-second SLA.
- **UI framework: React 18.x.** Mandated by `IMPL-ARCH-003`.
- **Styling: Tailwind CSS 3.x, vanilla.** Mandated by `IMPL-ARCH-004`.
  The Phase 0 design system skeleton (tokens + one button primitive)
  fits the `/packages/ui` slot.
- **State management: React hooks + a single typed `AlertFeedContext`.**
  Per `IMPL-ARCH-005`. The WebSocket feed updates a context provider; no
  Redux/Zustand.
- **Server-side data fetching for Trader UI: native `fetch` against typed
  REST endpoints, with `swr` only if revalidation patterns justify it.**
  Default to native fetch to minimize deps (`ARCH-P-003`).
- **Unit test runner: Vitest** (`IMPL-ARCH-006`).
- **E2E runner: Playwright on real headless Chromium**
  (`IMPL-ARCH-007`). The Phase 4 e2e ("alert pushed within 1 s") and the
  RLS-cross-trader e2e are the canonical tests.
- **HTTP fixture interception: MSW v2.** Already specified in the plan
  ("Vendor fixture recording", Phase 0) and named in CLAUDE.md testing
  standards.
- **EDGAR ATOM parsing: `fast-xml-parser`.** Pure-TS, zero native deps,
  small footprint — passes the Buy test (`IMPL-ARCH-022`) for parsing
  EDGAR's stable ATOM dialect (Phase 2). Writing an ATOM parser from
  scratch fails the "infeasible internally?" test only marginally; pick
  `fast-xml-parser` because EDGAR's quirks (CDATA, mixed namespaces) make
  a hand-rolled parser a tarpit.
- **Auth: WebAuthn / FIDO2 via `@simplewebauthn/server` and
  `@simplewebauthn/browser`.** AUTH blueprint requires passkey-only
  (Phase 1). SimpleWebAuthn is the minimal, well-maintained primitive
  that passes `IMPL-ARCH-022` Buy criteria.
- **Postgres driver: `postgres` (porsager/postgres).** Lightweight
  TypeScript-first client, supports `LISTEN/NOTIFY` natively (Phase 4).
  No ORM — the plan already writes raw SQL (`packages/db/schema.sql`,
  `packages/db/task-queue.ts`). Avoids Prisma's transitive footprint
  (`ARCH-T-006`).
- **Outbound channels (Phase 4): Postmark for email, Twilio for SMS,
  native `fetch` + HMAC for webhooks.** Postmark and Twilio are the
  smallest, most-maintained adapters in their categories and cleanly fit
  `/packages/integrations`. The webhook adapter is DIY (signed-HMAC POST
  is trivial — `ARCH-D-002`).
- **Service mesh: Linkerd.** Plan §"Cross-cutting work" already names it;
  smaller and more legible than Istio (`ARCH-P-005`).
- **Dev cluster: k3d.** Mandated by `ENV-D-002` and the plan's Phase 0.

## Gaps and conflicts

- **`apps/worker` is not in the canonical `ARCH-A-001` listing.** The
  blueprint diagram lists `/apps/web` and `/apps/server` only. The plan
  introduces `apps/worker` (Phase 0 scout) on the basis of `WORKER-D-001`.
  This is a defensible expansion under `ARCH-D-003` ("expand the structure
  deliberately"), but `docs/architecture.md` (the synthesis target) must
  document `apps/worker` as a fourth top-level deployable with its own
  responsibility statement to satisfy `ARCH-C-017` and `ARCH-C-020`.
- **`/packages/db` exists but is not in the blueprint listing.** The plan
  references `packages/db/task-queue.ts` and `packages/db/schema.sql`
  (Phase 0). The blueprint allows `/packages/services` for "API clients
  and external adapters" but does not name a DB package. Either fold
  `packages/db` into `packages/core` (preferred — schema and task-queue
  primitives are domain logic) or document `packages/db` as a deliberate
  expansion with a non-overlapping responsibility statement.
- **GraphQL/WebSocket carve-out documentation.** `IMPL-ARCH-015` requires
  GraphQL/WS to be excluded "unless the product demands ... sub-second
  real-time". The PRD's sub-second SLA satisfies this, but the
  justification must be written into `docs/architecture.md` so a future
  agent does not delete the WebSocket path as an antipattern.
- **`docs/dependencies.md` not in the plan.** `ARCH-C-005`, `ARCH-C-014`,
  `IMPL-ARCH-023` all require this file. The plan never mentions it. It
  should be a Phase 0 deliverable alongside the design system and CI gate.
- **Shared utility duplication policy unspecified.** The plan does not
  state how it handles cases like a date formatter needed in both
  `apps/web` and `apps/server`. `ARCH-D-001` mandates duplication over a
  shared-runtime utils package. This must be made explicit so agents do
  not create a `/packages/utils` junk drawer (`ARCH-X-001`).
- **Mobile PWA surface (Phase 4 "PWA parity").** PWA support implies a
  service worker living in `apps/web` — fine — but the plan does not
  call out where service-worker assets and offline strategies live. Worth
  one paragraph in synthesis.
- **`packages/integrations` vs `packages/services` boundary.** The
  blueprint distinguishes "API clients and external adapters"
  (`/packages/services`) from "third-party SDK wrappers"
  (`/packages/integrations`). The plan does not state which channel
  adapters (Postmark, Twilio, webhook signer) go where. Recommendation:
  Postmark and Twilio in `/packages/integrations` (vendor SDK wrappers),
  EDGAR ATOM client in `/packages/services` (we own the HTTP shape).
- **CI build-time SLA (`ARCH-C-015`, 30s/step).** Plan does not mention
  this constraint. Bun's bundle and Vite both meet it easily, but it
  should be a CI-gate assertion.

## Open questions

- Does the parent agent want `apps/worker` formalized as a fourth
  canonical app, or folded into `apps/server` as an additional entry
  point? (Recommendation: keep separate — different scaling profile and
  different network egress policy under `WORKER-C-024`.)
- Is `packages/db` a deliberate fifth package, or should the schema and
  task-queue primitives move under `packages/core/db`?
  (Recommendation: move under `packages/core/db` to keep the canonical
  five-package list intact.)
- Should Zod-based contracts be the single source of truth for both API
  validation and TypeScript types, or should we maintain hand-written
  TS types and validate separately?
  (Recommendation: Zod-as-source — `z.infer` gives the static type, one
  artifact per contract.)
- Is Hono on Bun acceptable, or does the team prefer Bun's native
  `Bun.serve` router with hand-written typed handlers?
  (Recommendation: Hono — better ergonomics, trivially small, good
  Bun integration.)
- Does the WebSocket transport need a fallback (e.g. SSE) for traders
  behind corporate proxies that block WebSockets?
  (Out of scope for v1 unless PRD §"Open questions" answers it.)
- Where do market-data SDKs (Phase 3 delta-neutral) land —
  `/packages/integrations` (likely) or `/packages/services`?
