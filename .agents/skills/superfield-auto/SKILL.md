---
name: superfield-auto
description: User-facing wrapper for the Superfield auto workflow. Use when the user explicitly asks to run the repository's continuous Plan execution loop with speculative development and sequential merges.
---

# Superfield Auto

Run a parallel development loop until there is no remaining planned work.
The human-facing thread is the orchestrator. It runs deterministic scripts and
launches worker `Agent` subagents. It never implements issues itself.

## Loop — repeat until done

### Phase 1 — Merge

List open PRs, then for each in Plan order:

```bash
bash .agents/scripts/auto/merge-ready.sh {pr-number}
```

If `ready: true`:
```bash
bash .agents/scripts/auto/mark-pr-ready.sh {pr-number}
bash .agents/scripts/auto/merge-pr.sh {pr-number}
```
After each merge, restart from the top. Stop if only blocker is
`plan-predecessor-not-merged`. Then:
```bash
bash .agents/scripts/auto/cleanup-stale-worktrees.sh
```

### Phase 2 — Select

```bash
bash .agents/scripts/auto/parallel-eligible.sh
```

Returns `selected` (slot 1 / primary) and `eligible` (speculative slots).
If no `selected`: all Plan issues are CLOSED — stop.
Take up to 3 total slots: 1 primary + up to 2 speculative from `eligible`.

### Phase 3 — Prep

For each issue in the batch:
```bash
bash .agents/scripts/auto/ensure-issue-worktree.sh {issue-number}
bash .agents/scripts/auto/verify-issue-prep.sh {issue-number}
```
Record `worktree_path` and `branch` from the output. `local-bootstrap` mode
is OK — the worker handles the first push and PR creation.

### Phase 4 — Launch workers

1. Read the worker reference doc:
   ```bash
   cat .agents/skills/develop-issue/SKILL.md
   ```

2. For each slot, call the `Agent` tool with:
   - `description`: e.g. `"develop issue 137 primary"`
   - `subagent_type`: `"general-purpose"`
   - `prompt`: the template below, with `{SKILL_MD_CONTENTS}` replaced by the
     full text of the file you just read

3. **Issue ALL Agent calls in a single message** so they start in parallel.

#### Worker prompt template

```
You are a develop-issue worker agent.

## Assignment
- issue_number: {N}
- pr_number: {PR or "(none yet — local-bootstrap mode)"}
- branch: {BRANCH}
- worktree_path: {PATH}
- role: {primary|speculative}

## Worker Instructions

{SKILL_MD_CONTENTS}

## Commit standards
- Use conventional commits: feat, fix, refactor, test, docs, chore, or security.
- Stage files explicitly by name. Never use `git add .`.
- Never use `--no-verify`.

Begin now. cd into your worktree and start by reading the issue.
```

### What NOT to do in Phase 4

- Do NOT use the `Skill` tool to invoke `develop-issue`. It runs in your
  thread and blocks — this has been the #1 failure mode.
- Do NOT implement code, edit files, or make commits yourself.
- Do NOT launch workers one at a time waiting for each to finish.
- Do NOT delegate the orchestrator loop to a subagent — the `Agent` tool does
  not support nesting, so a subagent cannot launch its own subagents.

### After launch

Wait for the primary worker to finish (PR merged, issue CLOSED).
As speculative slots free up, immediately re-run `parallel-eligible.sh` and
launch new `Agent` workers for the next eligible issues.

### Phase 5 — Compact

After the primary finishes, use `/compact` to compress context, then go to
Phase 1.

## Stop condition

Stop only when `parallel-eligible.sh` returns no `selected` issue, or an
unresolvable external blocker exists. Pending CI on the primary is not a
stop condition.

## Reference

Full command specification: `.agents/commands/superfield-auto.md`
Worker reference doc: `.agents/skills/develop-issue/SKILL.md`
Plan-driven workflow rules: `CLAUDE.md`
