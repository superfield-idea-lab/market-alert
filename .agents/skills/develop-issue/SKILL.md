---
name: develop-issue
description: Reference document for develop-issue worker agents. The superfield-auto orchestrator reads this file and embeds its contents into Agent tool prompts. Never invoke via the Skill tool.
user_invocable: false
---

# Develop Issue — Worker Reference

> **This file is a reference document, not an invocable skill.** The
> `superfield-auto` orchestrator reads this file with `cat` and pastes its full
> contents into each `Agent` tool prompt. It must never be called via the
> `Skill` tool — that would run the worker inside the orchestrator's thread,
> serializing execution and breaking the parallel model.

Implement one assigned issue in its dedicated worktree and keep ownership until
the linked PR is merged.

## Issue assignment

The caller passes the assigned issue as part of the agent prompt. The prompt
must include:

- `issue_number` — the GitHub issue number to implement
- `pr_number` — the open draft PR number linked to the issue, if one exists yet
- `branch` — the branch name for this issue
- `worktree_path` — absolute path to the dedicated issue worktree
- `role` — either `primary` or `speculative`

All work happens inside `worktree_path`. Do not touch the main repo checkout
or any other issue's worktree.

### Role: primary

The primary agent is assigned to the highest-priority unmerged Plan issue.
It must drive implementation, CI, checklist, and **merge** without stopping.
If `merge-ready.sh` says ready, merge immediately. After any push, if checks
are still pending, keep ownership and continue polling deterministic repo
scripts until CI finishes. Do not yield until the PR is merged and the issue
is CLOSED, unless a fatal blocker remains that cannot be resolved without a
human.

While waiting for CI to complete, do not idle. Perform checklist gardening
instead: read the current code state, compare it against each unchecked item
in the issue checklist, and tick off any item that is already evidenced by
the committed code. This keeps the checklist current and unblocks the merge
gate without waiting for CI to finish first.

The primary agent never exits early. If every implementation item is done and
CI is still running, garden the checklist. If every checklist item is ticked
and CI is still running, re-read the issue and look for anything missed. Only
stop when the PR is merged and the issue is CLOSED.

### Role: speculative

The speculative agent works on a parallel-eligible issue. It drives
implementation and checklist to completion, marks the PR ready, then exits
immediately to free the slot for the outer loop. Do not wait for CI to go
green before exiting — CI can run in the background. The outer merge phase
waits for green checks before merging.

Exit as soon as all of these are true:

- implementation is complete
- all checklist items are ticked
- PR is marked ready (not draft)

If the only merge blocker is `plan-predecessor-not-merged`, the PR is already
ready — leave it undrafted and exit. The outer merge phase handles the merge
when the predecessor is CLOSED.

## Preconditions

The caller (superfield-auto) has already:

- prepared the issue with `ensure-issue-worktree.sh`
- verified prep with `verify-issue-prep.sh`
- confirmed the worktree exists at `worktree_path` on the correct branch

If prep arrives in `local-bootstrap` mode, the worktree and branch are valid but
the bootstrap push or PR creation was blocked by repo checks. In that case, the
assigned developer keeps ownership, fixes the blocking issues in the assigned
worktree, and then reruns deterministic prep until the branch is pushable and a
PR exists.

Use these scripts from within `worktree_path`:

```bash
.agents/scripts/auto/verify-issue-prep.sh {issue-number}
.agents/scripts/auto/pr-status.sh {pr-number}
.agents/scripts/auto/issue-status.sh {issue-number}
.agents/scripts/auto/needs-rebase.sh {pr-number}
.agents/scripts/auto/rebase-issue-branch.sh {pr-number}
.agents/scripts/auto/merge-ready.sh {pr-number}
```

## Must do

- Work exclusively in the assigned `worktree_path`.
- Implement acceptance criteria and test plan items in small increments.
- If the issue's `Issue type` section says `dev-scout`, treat it as a stub-only
  integration pass, not a feature implementation pass.
- Push regularly so CI stays current.
- Resolve CI, mergeability, and checklist problems as they appear.
- Rebase when `needs-rebase.sh` says the branch is behind `origin/main`.
- Mark the PR ready and merge when `merge-ready.sh` allows it.
- Confirm the linked issue closes after merge.

## Must not do

- Do not work on any issue other than the assigned one.
- Do not touch files outside `worktree_path`.
- Do not leave the PR half-finished for a human to complete.
- Do not rely on intuition for CI or merge readiness when a script can answer it.
- Do not implement real feature behavior for a `dev-scout` issue.

## Workflow

1. `cd` into `worktree_path`. All subsequent commands run there.
2. Read the issue body — understand Phase, Issue type, Canonical docs,
   Deliverables, Acceptance Criteria, and Test Plan.
3. If `Issue type` is `dev-scout`, create no-op stubs for the phase's planned
   entrypoints, seams, and interfaces. The scout implementation must:
   - compile and pass tests without changing runtime behavior
   - add deep source documentation pointing back to canonical docs
   - capture newly discovered integration points and risks
   - update downstream same-phase issues before considering the scout done
4. Otherwise, implement the smallest next missing piece.
5. Run relevant tests locally before committing.
6. Stage files explicitly by name. Commit with a conventional commit message.
7. Push. If no PR exists yet, rerun `ensure-issue-worktree.sh` and
   `verify-issue-prep.sh` after the branch becomes pushable to create the
   remote branch and draft PR, then continue.
8. Re-check PR status, issue checklist state, and remote branch state.
9. If `needs-rebase.sh` says behind, run `rebase-issue-branch.sh` and push.
10. Garden the checklist: for each unchecked item, inspect the committed code and
   tick it if the evidence is already present. Do this whether or not CI is still
   running — do not wait for CI to start gardening.
11. If CI is still pending, continue gardening other checklist items, re-read the
    issue for missed scope, or review implementation for quality — do not idle.
12. Fix CI or mergeability issues immediately when they appear.
13. When `merge-ready.sh` returns `ready: true`:
    - run `mark-pr-ready.sh {pr-number}`
    - perform integration handoff (see below)
    - run `merge-pr.sh {pr-number}`
14. Confirm the issue is CLOSED.

**Speculative agents**: once implementation is complete, all checklist items are
ticked, and the PR is marked ready, exit immediately — do not wait for CI and
do not wait for the predecessor to merge. Do not wait.

**Primary agents**: never exit early. Loop back to step 3 if there is any
remaining work. Loop back to step 9 if CI is still running. Only stop after
the PR is merged and the issue is CLOSED.

## Integration handoff

Before merging, identify the next issue in Plan order (N+1). If it is OPEN,
post a comment on it summarizing:

- Files and modules changed in this PR
- New or modified public APIs, type signatures, or module boundaries
- Import path changes
- Anything the N+1 issue scope needs to be aware of

To find N+1: read the Plan tracking issue, extract ordered issue numbers, find
the current issue's position, fetch the next one's state.

Skip the handoff if there is no next issue or it is already CLOSED.

## Stop only when

**Primary agent** — stop only when:

- the PR is merged and the issue is CLOSED, or
- an external blocker remains after repo, plan, CI, and blueprint context have been exhausted

**Speculative agent** — stop when any of these is true:

- implementation complete, checklist fully ticked, PR marked ready (CI may still be running), or
- `plan-predecessor-not-merged` is the only merge blocker (PR already ready — exit to free the slot), or
- an external blocker remains after repo, plan, CI, and blueprint context have been exhausted
