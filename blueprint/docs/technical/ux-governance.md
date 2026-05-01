# Brainstorm: UX Governance

## Positioning
Treat UX governance as a **design review system with hard gates**, not a design generator.

The core shift: do not start with "what screen do you want?" Start with:
- what user outcome must happen
- what data exists
- what constraints cannot be violated

## Multi-Agent Roles
1. **Interviewer Agent**
- Pulls goals, users, jobs-to-be-done, constraints, and success criteria.

2. **IA / UX Critic Agent**
- Reviews intuitiveness, task flow, navigation, cognitive load, and bloat.

3. **Design System Guardian Agent**
- Enforces style-guide conformity and component usage.

4. **Feasibility Agent**
- Verifies UI proposals against current data model and backend capabilities.

5. **Coverage Agent**
- Detects missing functionality, state coverage gaps, and edge-case holes.

6. **Synthesizer Agent**
- Merges findings into a revised spec or wireframe guidance.

## Workflow
### 1) Intake: interview before design
Force structured intake before UI exploration. Extract:
- user types
- top tasks
- frequency of use
- critical paths
- business constraints
- regulatory/policy constraints
- current data entities
- available entity actions
- style-system rules
- platform constraints (mobile, admin panel, dashboard, public app)

Recommended interview prompts:
- Who is the user?
- What are they trying to accomplish?
- What are the top 3 tasks?
- What data objects do they interact with?
- What decisions do they make at each step?
- What must they never be confused about?
- What must be immediately visible vs progressively disclosed?
- What existing components/patterns are allowed?
- What backend operations exist today?

Required output artifact:
- personas
- jobs
- task flows
- domain objects
- constraints
- approved component vocabulary

Rule: if intake artifact is incomplete, refuse high-fidelity design.

### 2) Create an intermediate representation
Never jump directly from conversation to screens. Produce a machine-reviewable UX spec containing:
- user goals
- page inventory
- navigation model
- task flow steps
- per-screen purpose
- required data inputs
- required backend actions
- allowed components
- error/empty/loading states

Example screen spec:
```yaml
screen: Order Details
primary_user: support_agent
goal: understand order status and resolve issues
primary_actions:
  - refund_order
  - resend_invoice
  - contact_customer
required_data:
  - order.id
  - order.status
  - order.total
  - customer.name
  - payment.status
secondary_data:
  - shipment.tracking_number
constraints:
  - cannot edit payment.status manually
  - refund only if order.state in [paid, partially_refunded]
allowed_components:
  - page_header
  - summary_card
  - status_badge
  - activity_timeline
  - action_menu
```

## Specialized Review Capabilities
### A) Style Guideline Guardian
Checks:
- approved components only
- typography hierarchy
- spacing/layout rules
- color/status semantics
- interaction pattern reuse

Must produce rewrites, not just violations. Example outputs:
- "Custom tab bar is not allowed. Replace with standard segmented control."
- "Too many emphasis colors. Use neutral cards plus one primary CTA."
- "Dashboard uses 5 card styles. Collapse to 2 approved card types."

Requires machine-readable access to:
- component library
- tokens
- content guidelines
- layout rules
- canonical flow examples

### B) UX / Intuitiveness Critic
Checks:
- primary task clarity
- IA fit to mental model
- action overload
- step reduction opportunities
- label ambiguity
- progressive disclosure quality
- feedback for errors/state changes

Heuristics:
- one primary action per view
- no dead-end screens
- minimize working-memory load
- avoid mixing browse/edit/analytics unless necessary
- hide advanced controls until needed
- each screen must answer "why am I here?" within 3 seconds

Example critiques:
- "User scans 14 fields before main action. Promote status and next step to header."
- "Settings/history/execution are mixed. Split into Overview / Activity / Configuration."
- "Label 'Process' is ambiguous. Rename to 'Run payout'."

### C) Bloat Detector
For each section/field/action, ask:
- what user goal does this support?
- how often is it used?
- could it be secondary?
- could it be hidden behind expansion?
- could it be removed entirely?

Simple score:
- Critical
- Important
- Occasional
- Rare
- Unjustified

Rules:
- remove Unjustified
- bury Rare unless risky/irreversible

### D) Functional Coverage Checker
Compares:
- target user jobs
- edge cases
- system states
- lifecycle stages

Questions:
- can whole task be completed without leaving flow?
- are empty/loading/error/permission states covered?
- are admin-only actions missing?
- are lifecycle transitions represented?
- can users recover from mistakes?

Example findings:
- "Viewing and editing exist, archiving missing."
- "No state for missing data."
- "Bulk actions exist in domain, no UI path."
- "Users can trigger job but cannot inspect failures."

### E) Data Model Feasibility Checker
Non-negotiable validation mapping UI to real entities/fields/ops.

Verifies:
- displayed field existence
- sort/filter/group support
- action-to-backend mapping
- metric derivability
- relationship support for navigation
- permission alignment
- latency/pagination realities

Fail design if dependent on nonexistent data.

Example findings:
- "Cannot display customer health score; no field or derivation exists."
- "Design assumes real-time updates; backend sync is every 15 minutes."
- "Filter by region unsupported; order records not region-indexed."
- "Inline nested editing proposed; API only supports full document replacement."

Example machine-readable capability contract:
```yaml
entities:
  order:
    fields: [id, status, total, created_at, customer_id]
    actions: [refund, cancel, resend_invoice]
  customer:
    fields: [id, name, email, tier]
relationships:
  order.customer: many_to_one
constraints:
  refund:
    allowed_if: order.status in [paid, partially_refunded]
api_limits:
  order_list:
    sortable_by: [created_at, total, status]
    filterable_by: [status, customer_id]
```

## Hard Gates
Use hard gates, not suggestions.

- **Gate 1: Problem Clarity**
No screens until goals, personas, and tasks are defined.

- **Gate 2: IA Integrity**
No visual refinement until flows and page structure are coherent.

- **Gate 3: Design System Compliance**
No approval with unapproved patterns.

- **Gate 4: Data Feasibility**
No approval when required data/actions do not exist.

- **Gate 5: Edge-Case Coverage**
No approval when empty/error/permission states are missing.

Gate result states:
- Pass
- Pass with revisions
- Fail

## Adaptive Interviewing
Interviewer should ask minimum next question based on risk profile.

Examples:
- CRUD-heavy: ask lifecycle + permissions
- analytics-heavy: ask dimensions, filters, freshness, aggregation limits
- workflow-heavy: ask approvals, statuses, handoffs, exceptions
- consumer-facing: ask trust, onboarding clarity, abandonment points

Goal: smart and adaptive, not bureaucratic.

## Design Constitution
Shared ruleset all agents reference:
- product principles
- style-system rules
- IA principles
- UX heuristics
- content guidelines
- domain vocabulary
- backend/data contract
- accessibility requirements
- platform constraints

Example principles:
- optimize for task completion over feature visibility
- prefer familiar patterns over novelty
- keep one dominant action per view
- show summary first, details second
- never display metrics without defined source
- never allow actions without permission + backend support
- progressively disclose advanced options
- every async action requires feedback + recovery

## Explainable Critiques
All agents output structured critiques:
- issue
- why_it_matters
- evidence
- severity
- proposed_fix

Example:
```yaml
issue: Too many primary actions on dashboard
why_it_matters: Increases choice friction and hides the most common next step
evidence:
  - 6 equally styled CTA buttons in hero area
  - user primary job is "review alerts", not "configure system"
severity: high
proposed_fix:
  - keep "Review alerts" as primary
  - move "Export", "Manage rules", "Invite user" into overflow menu
```

## Constrained Generation Rules
Constrain model generation by requiring:
- approved components only
- known entities/actions only
- section-to-goal mapping
- field-to-data mapping
- action-to-API mapping

Prompt pattern:
> Propose a screen using only approved components. Every section must state its user goal. Every displayed field must map to an existing data field. Every action must map to an existing backend operation. Prefer the simplest design that completes the primary task.

## Process Preference: Text Specs Before Mockups
Recommended sequence:
1. interview
2. structured UX brief
3. flow diagram
4. screen inventory
5. low-fidelity screen specs
6. critique loop
7. mockups/prototypes

Reason: reduces attachment to attractive but invalid design.

## Proposed Skill Set
1. `discover_product_requirements`
Outputs: users, goals, top tasks, constraints, known unknowns

2. `model_domain_and_capabilities`
Outputs: entities, fields, relationships, actions, permissions, API limits

3. `draft_information_architecture`
Outputs: sitemap, screen inventory, nav groups, task-flow map

4. `draft_screen_specs`
Outputs: low-fi specs, required data, action model, empty/error/loading states

5. `enforce_design_system`
Checks: approved components, spacing/layout rules, interaction consistency, content style

6. `critique_usability`
Checks: intuitiveness, cognitive load, discoverability, progressive disclosure, task efficiency

7. `detect_bloat_and_gaps`
Checks: unnecessary elements, missing features, edge cases, state coverage

8. `validate_feasibility_against_data_model`
Checks: field/action existence, aggregation support, relationship support, permission support

9. `propose_revisions`
Input: all critique outputs; Output: revised design spec

## Orchestration Loop
1. interview user
2. build requirements spec
3. build domain/data capability map
4. draft IA
5. draft low-fi UX spec
6. run parallel reviews:
- design system
- usability
- bloat/gaps
- feasibility
7. merge findings
8. revise
9. re-run until all high-severity issues are cleared
10. produce prototype guidance

Critical point: run feasibility review early, not after polished design.

## Practical Example Behavior
Input: "I want a customer success dashboard."

System should ask:
- Who uses it (CSM, manager, exec)?
- What top decisions must they make?
- What are the 3 most common actions?
- What entities/health signals exist today?
- Are scores already computed or require derivation?
- Is it for monitoring, triage, or account planning?
- What happens when data is missing or stale?

Then produce:
- dashboard purpose
- user role
- primary workflow
- supported KPIs based on real fields
- recommended navigation
- excluded features due to bloat or unsupported data

## Common Failure Modes to Prevent
- starting from screens instead of tasks
- inventing unsupported data
- polished but bloated dashboards
- style rules treated as optional
- backend constraints checked too late
- no product-specific definition of "intuitive"

## Artifact Strategy
Use layered artifacts where each phase has:
- one machine-readable source of truth (`json`)
- one human-readable companion (`md`)
- optional visualization (`mmd`, `html`, `svg`)

Format policy:
- `json`: required for checks, gates, and cross-agent handoffs
- `md`: required for human review, rationale, and decision logs
- `mmd` (Mermaid): preferred for IA and task-flow diagrams in-repo
- `html`: preferred for low-fi interactive screen validation
- `svg`: optional static visual export for docs/handoff
- `dot`: optional only if graph tooling needs it
- `png/jpg`: presentation snapshots only, never source of truth
- `xml`: avoid unless a specific toolchain requires it

## Artifact Conventions
### Directory layout
```text
ux-governance/
  00-intake/
  01-domain/
  02-ia/
  03-screen-specs/
  04-reviews/
  05-wireframes/
  06-gates/
  07-handoff/
```

### Canonical files by stage
1. Intake and problem framing (`00-intake/`)
- `ux-intake.json` (authoritative intake schema)
- `ux-intake.md` (narrative brief + open questions)

2. Domain and capabilities (`01-domain/`)
- `domain-capabilities.json` (entities, fields, actions, permissions, limits)
- optional `backend-contract.yaml` (OpenAPI extracts/references)

3. IA and task flows (`02-ia/`)
- `ia-map.mmd` (navigation/grouping model)
- `task-flows.mmd` (primary and edge flows)
- `screen-inventory.json` (screen ids, owners, goals)

4. Screen specs (`03-screen-specs/`)
- `screen-specs.json` (authoritative per-screen contract)
- `screen-specs.md` (review-friendly rendering)

5. Review outputs (`04-reviews/`)
- `review-findings.json` (all findings with severity and ownership)
- `review-findings.md` (summarized critique for stakeholders)

6. Low-fi representations (`05-wireframes/`)
- `wireframes.html` or one HTML file per screen
- optional `wireframes.svg` exports

7. Gate status (`06-gates/`)
- `gates.json` (Gate 1..5 status: pass / pass_with_revisions / fail)
- `gates.md` (why each gate status was assigned)

8. Handoff (`07-handoff/`)
- `implementation-contract.json` (approved build contract)
- `prototype-guidance.md` (implementation notes and sequencing)

### Naming and schema conventions
- use stable snake_case ids for screens, entities, actions, and findings
- include `version`, `updated_at`, and `source_artifacts` in every major JSON artifact
- include `status` and `owner` in review and gate records
- do not duplicate truth across formats
- JSON is authoritative
- Markdown and diagrams are derived/readable companions

## Layered CI Conformance Strategy
Use a layered CI model where only stable, deterministic checks block merges.

### Tier 1 (hard gates, merge-blocking)
1. Accessibility structure invariants
- ARIA snapshot regression checks on critical routes/states
- axe-core severity threshold checks

2. Design-system and layout-rule conformance from DOM/CSS
- approved component/class usage only
- typography and spacing values from allowed token sets only
- overlap/overflow/clipping checks
- one-primary-CTA rule in main task region

3. Flow graph invariants
- critical journeys must remain reachable
- no dead-end nodes in required flows
- max path-length thresholds
- required state nodes (loading/empty/error/success/permission) must exist

4. Targeted visual regression
- screenshot diff only for critical regions/routes/components
- dynamic regions masked or ignored
- route/state coverage enforced by state matrix

5. Performance/rendering sanity on critical pages
- key route/page timing budgets
- above-the-fold critical elements present at interactive point

### Tier 2 (soft gates, non-blocking initially)
- saliency and attention prediction scores
- screenshot layout parsing/classification
- model-assisted UX lint scoring
- synthetic-user walkthrough quality scoring

Rule: Tier 2 reports warnings only until thresholds are calibrated on historical runs.

### CI pipeline shape
```text
build app
-> run Playwright journeys
-> capture DOM, computed styles, ARIA tree, screenshots
-> run deterministic UX linters
-> run accessibility checks
-> run flow-graph checks
-> run targeted screenshot diffs
-> run soft visual-analysis jobs
-> publish ux-conformance report
-> fail only on Tier 1 violations
```

### Recommended unattended tooling
- `playwright`: journeys, ARIA snapshots, screenshot assertions, DOM capture
- `axe-core` integration with Playwright: deterministic accessibility checks
- `backstopjs` (optional): dedicated visual regression for page-level scenarios
- `reg-actions` / `reg-suit` (optional): visual diff reporting on pull requests
- custom DOM/CSS linter: token, layout, and component-policy checks
- graph validator (`networkx` or equivalent): flow invariant checks
- `deepgaze` (optional Tier 2): saliency scoring
- `layout-parser` (optional Tier 2): screenshot-only structure extraction

### CI artifacts and file conventions
Add CI outputs under:
```text
ux-governance/
  08-ci/
    state-matrix.json
    ux-conformance-report.json
    ux-conformance-report.md
    screenshots/
    aria/
    dom/
```

Required files:
- `state-matrix.json`: required routes, states, breakpoints, and critical regions
- `ux-conformance-report.json`: machine-readable pass/fail record
- `ux-conformance-report.md`: human-readable summary for PR review

### CI report schema example
```json
{
  "run_id": "ci-2026-04-14-1430",
  "commit_sha": "abc123",
  "pages": [
    {
      "route": "/accounts",
      "hard_checks": {
        "a11y": "pass",
        "aria_snapshot": "pass",
        "design_tokens": "pass",
        "layout_rules": "fail",
        "visual_regression": "pass",
        "flow_invariants": "pass"
      },
      "soft_checks": {
        "saliency_score": 0.61,
        "visual_clutter_score": 0.74,
        "cta_prominence_rank": 3
      },
      "issues": [
        {
          "id": "LAY-12",
          "severity": "high",
          "type": "layout_rules",
          "message": "Two primary CTA buttons detected above the fold",
          "blocking": true
        }
      ]
    }
  ],
  "summary": {
    "blocking_issues": 1,
    "warning_issues": 2,
    "decision": "fail"
  }
}
```

### First implementation tranche (recommended order)
1. Playwright journeys + targeted screenshot diffs on critical routes/states
2. axe-core + ARIA snapshots as hard gates
3. DOM/CSS linter for token/layout/component-policy checks
4. flow-graph conformance checks for critical journeys
5. saliency/layout-parser analysis as non-blocking warnings

## Minimal Implementation Pattern
Use:
- shared structured context object
- multiple narrow reviewers
- deterministic checks where possible
- explicit severity scoring
- hard approval gates

Example shared context schema:
```json
{
  "users": [],
  "jobs_to_be_done": [],
  "entities": [],
  "fields": {},
  "actions": {},
  "constraints": [],
  "design_system": {},
  "screen_specs": [],
  "review_findings": []
}
```

## Bottom Line
The target pattern is:
- interview first
- spec before mockup
- multiple specialist critics
- hard validation against design system + data model
- revision loop until high-severity issues are cleared

This is how to prevent UX that is visually polished but operationally wrong.
