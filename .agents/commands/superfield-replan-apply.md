# Superfield Replan Apply

Use this command to apply a structured phase-aware plan after evaluation is done.

## Must do

- Rewrite the `Plan` issue from structured data only.
- Keep planned entries as plain issue references.
- Preserve stable phase metadata in issue bodies and keep the dependency tree in
  the `Plan` only.

## Deterministic flow

```bash
.agents/scripts/replan/validate-plan-json.sh {plan-json-file}
.agents/scripts/replan/apply-plan.sh {plan-json-file}
.agents/scripts/replan/sync-dependents.sh {plan-json-file}
```

Do not hand-edit the `Plan` issue body when the structured scripts can apply it.
