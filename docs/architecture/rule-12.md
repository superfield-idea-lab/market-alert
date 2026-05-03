# Rule 12: ux — User Experience / Frontend

## Summary of the blueprint rule

The UX blueprint (domain `UX`) governs all interface surfaces produced for a Superfield
application. Its central thesis is that **service delivery precedes surface design**: the
sequence of states a user moves through to accomplish a goal must be mapped as a state
machine before any screen is designed or any component is written. Screens are derived
artifacts of that service design, not inputs to it.

Key principles enforced by the blueprint:

- **UX-P-001 service-delivery-precedes-surface-design** — Define entry, intermediate, and
  terminal states with annotated transitions before any visual work begins.
- **UX-P-002 one-obvious-path-per-task** — For every user goal, exactly one primary path
  exists. Ambiguity about which path to take is a design defect.
- **UX-P-003 medium-appropriate-interface-per-user-type** — Human end-users get a visual
  interface; admins get a purpose-built operational interface; AI agents get a structured,
  machine-readable API. Each actor type receives the interface appropriate to their medium.
- **UX-P-004 beauty-is-functional-requirement** — Visual polish is evaluated at every
  milestone. An ugly early version sets a stakeholder anchor that is nearly impossible to
  reverse.
- **UX-P-005 agent-presence-explicit-and-bounded** — Any agent operating on a user account
  declares its presence, scope, and action log in a form the account holder can review.
- **UX-P-006 specifications-describe-needs-not-implementations** — UX specs describe user
  states and transitions; they do not name React components, Tailwind classes, or routing
  libraries.

The governance model is a **five-gate compliance framework DAG** (UX-A-004):

| Gate | Name                     | Output artifact                 |
| ---- | ------------------------ | ------------------------------- |
| 1    | User Contract Clarity    | `user-contracts.json`           |
| 2    | IA Integrity             | `information-architecture.json` |
| 3    | Design System Compliance | `design-system-binding.json`    |
| 4    | Data Feasibility         | `data-availability.json`        |
| 5    | Edge-Case Coverage       | `edge-case-coverage.json`       |

Gate 1 is the anchor; Gates 2 and 4 depend on it; Gate 5 depends on Gates 1, 2, and 4;
Gate 3 is dependency-free. The framework produces per-view **contract specs**, which
produce the **implementation**. Verification is orthogonal CI tooling (headless Playwright,
axe-core, ARIA snapshots, visual regression) that emits `ux-conformance-report.json`.

Additional structural rules:

- **UX-D-001** — Service flow maps are the authoritative UX specification.
- **UX-D-004** — A single design system governs all surfaces including Admin.
- **UX-D-005** — Progressive disclosure: default view shows only what the primary task
  requires; advanced options are accessible on explicit intent.
- **UX-D-009/UX-D-033** — Every approved flow is backed by a machine-readable
  `state-matrix.json` contract; CI fails on missing states, dead ends, or unreachable
  critical actions.
- **UX-D-018** — Every view's source directory co-locates its canonical artifacts
  (`*.view.json`, `*.state-matrix.json`, conformance reports, visual-regression baselines).
- **UX-D-019** — The view's source module imports its spec JSON at build time; a missing
  spec import fails the build.

Antipatterns explicitly prohibited:

- Storybook or any GUI-dependent tooling (UX-T-007, IMPL-UX-015).
- Spec fields that name a React component or Tailwind class (UX-P-006, IMPL-UX-014).
- Admin operations requiring database or terminal access (UX-C-014).
- Invisible agent presence on user accounts (UX-T-005, UX-P-005).

---

## TypeScript implementation specifics

The TypeScript implementation layer (domain `IMPL-UX`) translates blueprint rules into
concrete package boundaries and buy/DIY decisions.

### Monorepo surface layout (IMPL-UX-001)

```
packages/
  ui/
    design-system/    # shared tokens + primitives
    end-user/         # trader-facing components
    admin/            # admin-facing components
  services/
    capability-api/   # typed Capability interface definitions
apps/
  web/               # trader web app (end-user surface)
  admin/             # admin web app
  agent-sdk/         # agent-native structured SDK
  server/
    api/             # API server
    agent-router/    # agent-facing route layer
```

Each actor type (`end-user | admin | agent` — IMPL-UX-003 `ActorType`) maps to a distinct
app consuming shared packages.

### Core TypeScript interfaces

| Interface               | Purpose                                                                                   | Blueprint rule |
| ----------------------- | ----------------------------------------------------------------------------------------- | -------------- |
| `Capability`            | Atomic UX + access-control unit; carries `allowedActors` and `requiredScopes`             | IMPL-UX-002    |
| `ActorType`             | `'end-user' \| 'admin' \| 'agent'` union; gates surface routing                           | IMPL-UX-003    |
| `AgentPresence`         | Declares agent identity, account binding, authorized scopes, grant/last-active timestamps | IMPL-UX-004    |
| `AgentActionRecord`     | Logs every agent operation with outcome (`success \| rejected \| failed`)                 | IMPL-UX-005    |
| `ServiceFlowState`      | Models one state in the service flow machine: id, label, availableTransitions             | IMPL-UX-006    |
| `ServiceFlowTransition` | Models one transition: id, trigger, targetStateId, requiredCapability                     | IMPL-UX-007    |

### Buy vs. DIY decisions

| Slot                            | Decision                                                   | Rationale                                                                    |
| ------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| UI component model              | **React** (buy — IMPL-UX-008)                              | No viable DIY alternative for browser rendering                              |
| Design tokens / utility classes | **Tailwind CSS** (buy — IMPL-UX-009)                       | DIY CSS at scale is unmaintainable                                           |
| Design token generator          | **DIY** (IMPL-UX-010)                                      | JSON file; no external package needed                                        |
| Agent SDK HTTP client           | **DIY** (IMPL-UX-011)                                      | Thin typed wrapper over native `fetch`; under 50 lines                       |
| Component docs                  | **DIY static build** (IMPL-UX-012)                         | No Storybook; static markdown or auto-generated HTML from the build pipeline |
| Form state                      | **DIY React `useState` + controlled inputs** (IMPL-UX-013) | No form library at Superfield scale                                          |

### CI conformance gates (TypeScript-specific)

| Gate                                                                         | Rule        | Merge-blocking?                           |
| ---------------------------------------------------------------------------- | ----------- | ----------------------------------------- |
| Accessibility (ARIA snapshot + axe-core)                                     | IMPL-UX-022 | Yes                                       |
| DOM/CSS design-token + layout conformance                                    | IMPL-UX-023 | Yes                                       |
| Flow graph (routes vs. approved state graph)                                 | IMPL-UX-024 | Yes                                       |
| Targeted visual regression (headless Playwright baselines)                   | IMPL-UX-025 | Yes                                       |
| Performance / rendering sanity (no hydration failures, no blank first paint) | IMPL-UX-026 | Yes                                       |
| Saliency scoring                                                             | IMPL-UX-027 | Warning only (until threshold calibrated) |
| Screenshot layout parsing                                                    | IMPL-UX-028 | Warning only                              |
| Model-assisted UX lint                                                       | IMPL-UX-029 | Warning only                              |
| Synthetic walkthrough quality                                                | IMPL-UX-030 | Warning only                              |

All CI verification is headless Playwright on hosted Linux — no display server, no
Storybook, no visual diff tools that require a live browser (IMPL-UX-015).

UX governance canonical artifacts are stored as JSON under `docs/technical/ux-governance/`
(IMPL-UX-016). Markdown, Mermaid, HTML, and SVG outputs are derived and never edited as
source of truth. The `ux-conformance-report.json` emitted by CI includes a `soft_signals`
section separate from blocking hard checks (IMPL-UX-032).

---

## Application to market-alert PRD/plan

### User roles and surface mapping

The PRD (§3) defines two human roles and an implicit agent role:

| Actor                        | ActorType  | Surface                                                                          |
| ---------------------------- | ---------- | -------------------------------------------------------------------------------- |
| Trader                       | `end-user` | `apps/web` — alert feed, detail view, watchlist, trade history                   |
| Admin                        | `admin`    | `apps/admin` — source configuration, alert override, health metrics, audit trail |
| Enrichment/ingestion workers | `agent`    | Internal API routes (`/internal/...`) + `apps/agent-sdk`                         |

Both human roles authenticate exclusively via FIDO2 passkey (no passwords, no magic links —
AUTH blueprint). RLS at the Postgres layer enforces that a Trader can only see alerts for
their own watchlist tickers and cannot read another Trader's private notes (plan Phase 4).

### Alert lifecycle and service flow maps (PRD §6)

The alert state machine — `Pending → Detected → Enriched → Deduplicated → Delivered →
Acknowledged → Archived` — must be formalized as a `ServiceFlowState` graph and committed
to `docs/technical/ux-governance/` **before Phase 4 implementation begins** (UX-D-001,
UX-C-001). The plan already calls for service flow maps to land in Phase 0 as documentation
for all seven subsequent phases.

Key trader-facing transitions and their UI contracts:

| Transition                 | Trigger                       | UI feedback                                                                    |
| -------------------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| `Delivered → Acknowledged` | Trader taps "Acknowledge"     | Optimistic UI update; rollback on `POST /api/alerts/:id/acknowledge` failure   |
| `Delivered` (push)         | WebSocket message from server | Alert card appears at top of feed; badge on page title                         |
| Alert detail opened        | Trader taps alert card        | Full enriched detail view: deal terms, spread estimate, SEC excerpt, citations |

The **"Propose trade from alert" CTA** (plan Phase 4) must be declared as a `ServiceFlowTransition`
from the alert detail view to the trade-proposal form. The plan stubs this button with
`disabled` in Phase 4 and gates it behind the `trade_lifecycle` feature flag until Phase 6
ships. This is a service flow state (button visible but inactive) that must be covered in
the `state-matrix.json` for the alert detail view — it cannot be left as an undeclared
element (UX-D-014 interaction inventory).

### Admin surface (PRD §3, §4)

The Admin surface covers:

- **Vendor source configuration** — toggle EDGAR ingestion on/off; future multi-vendor
  toggles without code changes (backed by `feature_flags` table rows).
- **Alert override / suppression** — mark false-positive alerts as `suppressed` with a
  reason; optionally suppress all future alerts matching the same `(ticker, event_type)`
  pattern.
- **System health metrics** — per-source ingestion rate, circuit breaker state, queue
  depth, last-seen-event timestamp (from `mkt_analytics`, not `mkt_app` direct queries).
- **Audit trail view** — read-only, paginated, exportable. The audit export action is
  itself an audit event.

Per UX-C-014, all Admin operations must be completable from the Admin UI with no database
or terminal access required.

### Real-time alert delivery transport (PRD §9, plan Phase 4)

The plan resolves the real-time transport question explicitly: **WebSocket push triggered by
`pg_notify` / `LISTEN/NOTIFY`**. The `ALERT_NOTIFY` task worker fires on alert
`Deduplicated` transition; the WebSocket server receives the Postgres notification and
pushes to all connected trader sessions whose watchlist includes the alert ticker.

Latency target is sub-second from DB write to client receipt (PRD §9, plan Phase 4 scout).
SSE is not used — the WebSocket model is already established in the existing Superfield KB
substrate and is required by the plan's real-time delivery architecture.

Outbound channels (email, SMS, per-trader webhook) are dispatched asynchronously via the
`ALERT_NOTIFY` task queue; channel failures are non-blocking to the WebSocket push (plan
Phase 4, outbound notification delivery).

### Trade lifecycle UI linkage (PRD §5, plan Phase 6)

The full Trade state machine — `Proposed → Executed → Settled → Reconciled` — requires a
**trader-facing trade history view** (plan Phase 6) and an **Admin trade oversight view**.
Each trade is linked to its originating alert via `alert_id`. The `ServiceFlowTransition`
from alert detail → trade proposal must be declared in the service flow map before Phase 6
begins; the Phase 4 disabled stub is a conformant placeholder that satisfies the
interaction inventory gate.

---

## Recommended technologies and vendors

One pick per slot, consistent with blueprint buy/DIY decisions and plan constraints.

| Slot                        | Pick                                                                        | Rationale                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Frontend framework**      | **Next.js (App Router)**                                                    | React is a blueprint buy decision (IMPL-UX-008); Next.js App Router provides SSR/RSC for initial page load performance, file-system routing that maps cleanly to the single-path navigation pattern, and built-in API routes for the BFF layer. Alternatives (Remix, SvelteKit) are not React and would violate IMPL-UX-008.                              |
| **Routing**                 | **Next.js App Router file-system routing**                                  | Included in Next.js; no separate router library. One route = one view = one `state-matrix.json` entry — directly supports UX-D-009.                                                                                                                                                                                                                       |
| **State management**        | **React Context + `useReducer`** (DIY)                                      | The plan's trader dashboard is a single-screen alert feed with WebSocket push; no global client state store (Redux, Zustand) is warranted. Alert list state is owned by the WebSocket hook; server data is owned by TanStack Query. Complexity budget (UX-D-012) favors the lightest viable option.                                                       |
| **Server-data fetching**    | **TanStack Query v5**                                                       | Handles loading / empty / error / success states explicitly — all four are required by the `state-matrix.json` contract (IMPL-UX-033). Provides stale-while-revalidate, background refetch, and optimistic mutation support for the acknowledge action. RSC alone cannot manage the real-time WebSocket feed; a client-side cache layer is required.      |
| **Realtime transport**      | **WebSocket (native `ws` on server, native browser `WebSocket` on client)** | Mandated by the plan: LISTEN/NOTIFY-triggered WebSocket push is the delivery mechanism for sub-second alert delivery. No Pusher or third-party relay — the WebSocket server lives in `apps/server` and is authenticated on upgrade via the same cookie/JWT as HTTP.                                                                                       |
| **UI component library**    | **shadcn/ui**                                                               | Headless, copy-owned components built on Radix UI primitives. No runtime dependency on a versioned component library that could drift; components live in `packages/ui/design-system/` under full project control. Tailwind tokens apply directly (IMPL-UX-009). Satisfies the static component docs requirement (IMPL-UX-012) because source is in-repo. |
| **Forms**                   | **DIY React `useState` + controlled inputs** (IMPL-UX-013)                  | Blueprint mandates this explicitly. The watchlist management form and trade proposal form are simple enough that no form library is warranted.                                                                                                                                                                                                            |
| **Alert list / data table** | **TanStack Table v8**                                                       | The alert feed requires sorting (newest first), client-side filtering by event type / spread threshold / date range (plan Phase 4), and column-level control. TanStack Table is headless, rendering is owned by the project's design system components, and it integrates naturally with TanStack Query.                                                  |

---

## Gaps and conflicts

**1. Service flow maps not yet produced for Phase 4/5/6 views.**
The plan states that service flow maps for all seven phases land in Phase 0 as documentation.
Until those maps exist in `docs/technical/ux-governance/` as canonical JSON artifacts
(IMPL-UX-016), the Phase 4 Playwright e2e suite cannot be written against a validated
`state-matrix.json`, and the flow-graph CI gate (IMPL-UX-024) has no contract to compare
against. This is not a conflict with the plan — the plan explicitly requires them — but it
is a delivery dependency that must be satisfied before any Phase 4 UI code is written.

**2. PRD §9 "basic UI" undersells the blueprint's UX governance requirements.**
The PRD describes the UI surface as "basic UI required for viewing, acknowledging, and
filtering alerts." The UX blueprint requires a full five-gate compliance framework, per-view
`state-matrix.json` contracts, canonical governance JSON artifacts, and CI conformance
reporting. This is not a conflict (the plan has already resolved it by treating UX-D-001
and UX-D-004 as Phase 0 gates), but the scope delta is significant: the UI is not a
bolted-on concern.

**3. Disabled "Propose trade" CTA in Phase 4 must be declared in the interaction inventory.**
Per UX-D-014, every interactive element (including a disabled button) must appear in the
view's interaction inventory with its affordance kind and the user goal it serves. The plan
specifies the button is "displayed as a disabled stub." This stub must be declared as a
`button` affordance with `disabled` state in the alert detail view spec; omitting it would
cause the interaction-inventory CI gate to fail on the mismatch between declared and
rendered elements.

**4. Admin surface is a distinct app but must share the design system.**
The plan places `apps/admin` as a separate application (IMPL-UX-001). UX-D-004
(unified-design-system-across-user-types) and UX-C-004 require it to draw from
`packages/ui/design-system/`. The Admin layout and navigation may diverge from the trader
web app (the blueprint permits this when workflows are fundamentally different), but the
token system, typography, spacing, and primitive components must be shared.

**5. Outbound channel preferences are a trader-facing UX surface not modeled in the plan's
UI sections.**
The plan's Phase 4 follow-on issues specify per-trader outbound channel preferences
(email, SMS, webhook), but the plan's UI sections focus on the alert feed and detail view.
A settings page for outbound channel preferences must be declared as a view with its own
`state-matrix.json` entry, user contract (Gate 1), and data feasibility mapping (Gate 4)
covering the encrypted per-trader webhook secret.

---

## Open questions

**Q1. Which reading pattern applies to the alert feed view?**
The UX blueprint (UX-D-011) requires each view to declare a reading pattern from a
controlled set (F-pattern, Z-pattern, layer-cake, centered-hero, modal-focus). A
time-sorted alert list is most naturally an **F-pattern** (users scan the left edge for
tickers, then read rightward for event type and spread), but the decision must be declared
in the view spec and enforced in CI.

**Q2. What is the density budget for the alert card?**
UX-D-012 (information-density-budget) requires numeric caps on interactive elements, text
blocks, and above-fold element count. An alert card showing ticker, event type, deal terms
summary, spread estimate, sources, timestamp, and status badge is approaching the cap for
a compact card component. The density budget must be declared before Phase 4 implementation.

**Q3. Should the trader dashboard and trade history be one app or two separate Next.js
route groups?**
The plan describes a "trader dashboard tab listing their trades" as part of Phase 6, which
implies the alert feed and trade history share the `apps/web` app under separate route
groups. This aligns with IMPL-UX-001 (end-user surface as one app), but the IA integrity
gate (Gate 2) must explicitly declare the navigation node graph covering both route groups
before either is implemented.

**Q4. How is agent presence surfaced in the trader UI?**
The UX blueprint (UX-P-005, UX-C-006, UX-C-012) requires that agent presence is readable
by the account holder, including authorized scopes and last-active timestamp. The
market-alert system's enrichment and ingestion workers operate as `agent` actors. Whether
their presence is surfaced in the trader settings page or the admin audit view (or both)
must be decided before Phase 4 ships.

**Q5. Is a PWA manifest and service worker in scope for Phase 4?**
The plan specifies "PWA parity — alert feed, acknowledge action, and outbound channel
preferences work on the mobile PWA surface." A PWA requires a service worker and manifest
that the blueprint's headless Playwright CI must be able to test. The state matrix for the
PWA surface (breakpoint: mobile) must be declared alongside the desktop breakpoint in the
same `state-matrix.json` artifact before Phase 4 begins.
