# Superfield Replan

Use this command to rewrite the `Plan` tracking issue around phase-aware
delivery with scout-first execution inside each phase.

This command owns orchestration. Deterministic scripts handle compliance,
collection, and apply steps. The internal `replan-evaluate` skill handles only dependency and risk
judgment.

## Must do

- Read the open `Plan` tracking issue.
- Audit all open issues for template compliance before ranking work.
- Audit open PRs for repository compliance before ranking work.
- Evaluate feature and code dependencies across all planned issues.
- Group work into product phases when the issue set supports a coherent
  phase model.
- Ensure each phase begins with exactly one `dev scout` issue.
- Gate non-scout work in a phase behind that phase's scout issue.
- Treat scout completion as including the post-scout issue update pass. Do not
  schedule implementation work in that phase before the scout closes.
- Break ties by prioritizing the issues with the highest technical risk or
  unknowns.
- Rewrite the `Plan` issue so it is the single source of truth for ordering.

## Must not do

- Do not introduce plan-order tags such as `Step 1` or `Batch 2` into issue
  titles or issue bodies.
- Do not add phase metadata to issue titles. Phase metadata belongs in issue
  body sections and in the `Plan`.
- Do not leave non-compliant issue or PR formatting unaddressed before rewriting
  the Plan.
- Do not put progress summaries or duplicate issue content into PR bodies.

## Compliance rules

Feature issues must follow the repository template:

- expected headings must be present
- `Acceptance criteria` must contain checkboxes
- `Test plan` must contain checkboxes
- `Phase` must be present
- `Issue type` must be present
- `Canonical docs` must be present
- issue titles may keep a normal scope prefix like `feat:` or `fix:`
- issue titles must not contain plan-order metadata such as `Step`, `Batch`, or
  numeric phase tags
- issue bodies may contain stable phase metadata, issue type metadata, and
  canonical doc references
- the dependency tree belongs only in the `Plan`, not in individual issues
- issue bodies must not contain mutable plan-order metadata that needs
  maintenance

Normalization is **non-destructive**: existing section content is preserved.
Missing sections are added with placeholder defaults. Sections that exist but
lack checkboxes get a `- [ ] TBD` appended — existing text is never replaced.

If an issue body was overwritten and needs recovery, use:

```bash
.agents/scripts/replan/recover-issue-body.sh <issue_number>
.agents/scripts/replan/recover-issue-body.sh <issue_number> --restore <index>
```

This reads GitHub's GraphQL `userContentEdits` field, which is the only
reliable source of body edit history. The REST timeline/events APIs do not
record issue body edits.

PRs must follow repository PR rules:

- one PR closes exactly one issue
- the PR body must contain only the issue closing reference, for example
  `Closes #123`
- merged PRs are expected to close their linked issue

## Command flow

1. Audit compliance:

```bash
.agents/scripts/replan/audit-issues.sh
.agents/scripts/replan/audit-prs.sh
.agents/scripts/replan/normalize-issue-template.sh
.agents/scripts/replan/normalize-pr-body.sh
```

2. Collect structured input:

```bash
.agents/scripts/replan/collect-plan-issues.sh
.agents/scripts/replan/collect-open-prs.sh
.agents/scripts/replan/rank-input.sh
```

3. Use the internal `replan-evaluate` skill to produce structured phase-aware
   ordering with scout gates.
4. Apply the result:

```bash
.agents/scripts/replan/validate-plan-json.sh {plan-json-file}
.agents/scripts/replan/apply-plan.sh {plan-json-file}
.agents/scripts/replan/sync-dependents.sh {plan-json-file}
```

## Plan output rules

- The `Plan` issue may contain ordering structure and phase sections.
- The `Plan` issue is the single canonical source for task dependency data.
- Planned items must be plain issue references, not checkboxes.
- The `Plan` is the canonical place for cross-phase order and scout gating.
- Individual issues must remain free of mutable step numbering.
