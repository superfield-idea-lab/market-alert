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

- emit exactly one scout issue with `kind: "dev-scout"`
- place that scout before every other issue in the same phase
- make every non-scout issue in the phase depend on the scout issue unless it
  is already CLOSED
- use the scout rationale to capture unknown integration points and risk
- treat scout completion as including the post-scout report and issue updates

### `parallel_safe` field

Each issue must include a `parallel_safe` boolean. An issue is `parallel_safe: true`
when its `dependencies` array is empty or contains only issues that are already
CLOSED at replan time. Issues whose dependencies include any OPEN issue that
appears earlier in the ordering are `parallel_safe: false`.

This annotation is informational only. Merge ordering still follows the strict
total order. The annotation tells tooling which issues could be safely developed
concurrently without merge conflicts or integration risk.
