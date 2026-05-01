---
name: replan-evaluate
description: Evaluate compliant planned issues for phase order, scout gating, code coupling, and technical risk, then emit structured plan JSON.
user_invocable: false
---

# Replan Evaluate

This skill is the only non-deterministic part of replanning.

Input should come from the deterministic replan scripts, especially:

```bash
.agents/scripts/replan/collect-plan-issues.sh
.agents/scripts/replan/collect-open-prs.sh
.agents/scripts/replan/rank-input.sh
```

## Must do

- Read the structured issue payload, not ad hoc GitHub snippets.
- Evaluate both explicit feature dependencies and inferred code/subsystem
  dependencies.
- Group issues into coherent product phases when supported by the issue set.
- Prefer phase-level ordering that respects both explicit dependencies and
  product-goal cohesion.
- Ensure each phase has exactly one `dev-scout` issue placed before every other
  issue in that phase.
- Model scout completion as the gate for all subsequent work in that phase.
- Prefer the strictest correct ordering that still exposes safe speculative work
  after scout gates are satisfied.
- Treat the emitted Plan as the single source of truth for dependency data.
- Break ties by prioritizing higher technical risk or unknowns first.
- Emit structured JSON suitable for `apply-plan.sh`.

## Must not do

- Do not emit mutable ordering tags for issue titles or issue bodies.
- Do not invent issue facts not grounded in the provided payload.
- Do not emit free-form markdown as the primary output.
- Do not repurpose a feature issue as a scout. A scout must be an issue whose
  `## Issue type` field is `dev-scout`. Never designate an issue with
  `## Issue type: feature` as the phase scout, even if it is the most blocking
  issue in the phase.

## Output contract

Emit JSON with this shape:

```json
{
  "plan_issue_number": 47,
  "phases": [
    {
      "name": "Identity foundation",
      "goal": "Create the auth and session seams needed by all identity work.",
      "depends_on": [],
      "scout_issue_number": 196,
      "issue_numbers": [196, 201, 205]
    }
  ],
  "ordered_issues": [
    {
      "number": 196,
      "title": "chore: scout identity integration seams",
      "phase": "Identity foundation",
      "kind": "dev-scout",
      "risk": 5,
      "rationale": "Scout first to stub integration points and discover hidden coupling before implementation starts.",
      "dependencies": [],
      "dependents": [201],
      "parallel_safe": true
    }
  ]
}
```

`ordered_issues` must be a strict total order with no parallel groups.

### Scout policy

For each phase:

- Check whether any existing open issue in the phase has `## Issue type: dev-scout`
  in its body. If one exists, use it as the scout (emit with its real issue number).
- If no existing dev-scout issue exists for the phase, emit the scout with
  `"number": null` and include a `scout_spec` object (see below). The
  `create-scout-issues.sh` script will create the GitHub issue and patch the
  plan JSON before validation runs.
- Never repurpose a feature issue as the scout. Only issues whose `## Issue type`
  is `dev-scout` may fill the scout slot.
- Place the scout before every other issue in the same phase.
- Non-scout issues in the phase whose scout has `number: null` must omit the
  scout from their `dependencies` array — `create-scout-issues.sh` will add the
  real number after creation.
- Non-scout issues in the phase whose scout has a real number must list it in
  their `dependencies` array unless the scout is already CLOSED.
- Use the scout rationale to capture unknown integration points and risk.
- Treat scout completion as including the post-scout report and issue updates.

When emitting a null-numbered scout, set `scout_issue_number: null` in the
phase object and exclude the scout from `issue_numbers` — `create-scout-issues.sh`
will add the real number to both after creation.

#### `scout_spec` format

Required when `number: null`. Contains everything needed to create the scout
issue body. Fields must satisfy `validate-issue-json.sh` requirements:

```json
{
  "number": null,
  "title": "chore: [dev-scout] stub Identity foundation integration seams",
  "phase": "Identity foundation",
  "kind": "dev-scout",
  "risk": 6,
  "rationale": "No dev-scout issue exists for this phase yet.",
  "dependencies": [],
  "dependents": [201, 205],
  "parallel_safe": true,
  "scout_spec": {
    "canonical_docs": ["docs/prd.md"],
    "motivation": "The Identity foundation phase introduces auth and session seams that all downstream phases depend on. Stubbing these seams first surfaces hidden coupling before implementation starts.",
    "behaviour": "After the scout merges, all phase entrypoints compile and pass tests with no-op implementations. Downstream issues are updated with discovered integration risks.",
    "scope": {
      "in": [
        "Create no-op stub for session token interface",
        "Create no-op stub for auth middleware seam",
        "Document discovered coupling in downstream issue comments"
      ],
      "out": [
        "Real session token logic",
        "Real auth enforcement"
      ]
    },
    "acceptance_criteria": [
      "All stub files compile with tsc --noEmit",
      "Existing tests pass unchanged",
      "Downstream phase issues updated with integration findings"
    ],
    "test_plan": [
      "tsc --noEmit passes with no errors",
      "Full test suite passes with no regressions"
    ]
  }
}
```

### `parallel_safe` field

Each issue must include a `parallel_safe` boolean. An issue is `parallel_safe: true`
when its `dependencies` array is empty or contains only issues that are already
CLOSED at replan time. Issues whose dependencies include any OPEN issue that
appears earlier in the ordering are `parallel_safe: false`.

This annotation is informational only. Merge ordering still follows the strict
total order. The annotation tells tooling which issues could be safely developed
concurrently without merge conflicts or integration risk.
