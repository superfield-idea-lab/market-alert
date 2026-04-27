# Superfield Auto

Run a parallel development loop until there is no remaining planned work.

Accepts an optional argument `N` — the maximum number of issues to develop
concurrently. Defaults to **3**.

```
/superfield-auto        # N=3
/superfield-auto 5      # N=5
/superfield-auto 1      # single-issue mode (equivalent to superfield-develop)
```

Use the deterministic repo scripts under `.agents/scripts/auto/` before reasoning about GitHub state.
These scripts are the source of truth for:

- whether a PR is open or merged
- whether required checks are green
- whether a linked issue checklist is complete
- which plan issues are eligible for parallel development
- whether prep is complete for branch, worktree, remote, and PR
- which stale managed worktrees can be cleaned up safely

## Architecture constraint — Agent tool, never Skill tool

The `superfield-auto` orchestrator launches workers by calling the **`Agent` tool**
with a self-contained prompt. The `Agent` tool spawns an independent subprocess
that runs in parallel and returns when done.

The orchestrator must **never** use the `Skill` tool for worker dispatch. `Skill`
runs synchronously inside the caller's thread — it blocks, serializes execution,
and turns the orchestrator into an implementor. This has been the #1 failure mode
in practice.

How workers are launched:

1. Read `.agents/skills/develop-issue/SKILL.md` once (the worker reference doc).
2. For each issue slot, compose an `Agent` tool call whose prompt **embeds** the
   full worker workflow from that file, plus the issue-specific parameters.
3. Issue **all** `Agent` calls in a **single message** so they start in parallel.
4. The **primary** agent runs in the foreground (`run_in_background: false`).
   Speculative agents run in the background (`run_in_background: true`) so the
   orchestrator receives completion notifications and can refill freed slots
   immediately without waiting for the primary to finish.

The `develop-issue` skill is a reference document, not something to invoke.
Do not pass `skill: "develop-issue"` to the `Skill` tool under any circumstances.

## Execution model

**Development is parallel. Merges are strictly sequential in Plan order.**

**Thread ownership is strict.**

- The human-facing thread is the orchestrator. It runs deterministic scripts,
  checks state, and launches worker agents. It must not do issue implementation
  work itself.
- Every issue assignment, including slot 1, is executed by a worker `Agent`
  subagent working in that issue's dedicated worktree.
- If the orchestrator starts doing issue implementation itself, that is a
  workflow failure. Return to the outer loop shape immediately.
- The orchestrator cannot be delegated to a subagent because the `Agent` tool
  does not support nesting — subagents cannot launch their own subagents.

The N worker slots divide into two roles:

- **Slot 1 — primary worker**: always assigned to the highest-priority unmerged
  Plan issue. This slot is never speculative. Its agent owns the issue through
  implementation, CI, and merge. Nothing can merge ahead of it.

- **Slots 2..N — speculative workers**: assigned to parallel-eligible issues
  (issues whose dependencies are all CLOSED). Their PRs get built and made ready,
  but they cannot merge until slot 1's issue is merged and they become the new
  highest-priority. When a speculative worker finishes its current issue, its
  slot should be reused immediately for the next eligible issue from the Plan.
  Issues not present in the Plan are always ignored.

When slot 1 merges, the next Plan issue becomes the new slot 1, a speculative
slot opens, and a new agent fills it.
When any speculative slot frees up, refill it from the remaining eligible Plan
issues in Plan order. Do not leave speculative capacity idle while eligible
planned work exists.

## Loop structure

Repeat until there is no remaining eligible work:

```
1. Merge phase   — drain the merge queue in strict Plan order
2. Select phase  — assign slot 1 + up to N-1 speculative slots
3. Prep phase    — ensure each issue has branch, worktree, remote, and PR
4. Develop phase — launch N parallel worker agents simultaneously
5. Compact phase — compress accumulated context before the next iteration
6. Go to 1
```

Each phase is described in detail below.

## Phase 1 — Merge

Before starting new development, drain everything that can merge.

For each open PR in Plan order:

```bash
.agents/scripts/auto/merge-ready.sh {pr-number}
```

If `merge-ready.sh` returns `ready: true`:

```bash
.agents/scripts/auto/mark-pr-ready.sh {pr-number}
.agents/scripts/auto/merge-pr.sh {pr-number}
```

After each successful merge, restart the merge phase from the top — a merge
may unblock the next PR in Plan order.

If a PR is blocked only by `plan-predecessor-not-merged`, stop the merge loop.
Nothing else can merge until that predecessor is done.

After the merge phase, run cleanup:

```bash
.agents/scripts/auto/cleanup-stale-worktrees.sh
```

## Phase 2 — Select

Run:

```bash
.agents/scripts/auto/parallel-eligible.sh
```

This returns:

- `selected`: the highest-priority OPEN issue in the Plan (always slot 1)
- `eligible`: additional issues whose dependencies are all CLOSED

If there is no `selected` issue, all Plan issues are CLOSED — the loop is done.

Assign slots:

- **Slot 1**: the `selected` issue — always assigned, no exceptions
- **Slots 2..N**: take up to `N-1` issues from `eligible`, in the order returned
- Refill speculative slots continuously from the Plan whenever one finishes;
  never source work from issues outside the Plan

If an issue already has an active PR with CI green and is ready to merge, skip
assigning it a speculative slot — the merge phase handles it. Only assign slots
to issues that still need development work.

## Phase 3 — Prep

For each issue in the batch, deterministically prepare it:

```bash
.agents/scripts/auto/ensure-issue-worktree.sh {issue-number}
.agents/scripts/auto/verify-issue-prep.sh {issue-number}
```

Prep must confirm:

- a dedicated branch exists
- a dedicated worktree exists at the path reported by `verify-issue-prep.sh`
- the branch exists on the remote and tracks it
- a PR exists (prep may create a bootstrap commit and draft PR if needed)
- the branch is based on the latest `origin/main`; rebase if behind

Fix prep failures before launching. Do not launch an agent for an issue whose
prep cannot be verified.

## Phase 4 — Develop (parallel via Agent tool)

This is the most critical phase. The orchestrator composes and launches worker
agents — it does not do any implementation work itself.

### Step 1 — Read the worker reference doc

```bash
cat .agents/skills/develop-issue/SKILL.md
```

This file describes the full develop-issue workflow: how workers read the issue,
implement code, push, garden checklists, handle CI, rebase, and merge or exit.

### Step 2 — Compose Agent prompts

For each slot, build a prompt that includes:

- The **full text** of `develop-issue/SKILL.md` (so the worker is self-contained)
- The issue-specific parameters: `issue_number`, `pr_number`, `branch`,
  `worktree_path`, `role`

Use this template for each worker prompt:

```
You are a develop-issue worker agent.

## Assignment
- issue_number: {N}
- pr_number: {PR}
- branch: {BRANCH}
- worktree_path: {PATH}
- role: {primary|speculative}

## Worker instructions

{paste the full contents of .agents/skills/develop-issue/SKILL.md here}
```

### Step 3 — Launch workers

Launch the primary and speculative agents differently:

- **Primary**: launch with `run_in_background: false` (default). The
  orchestrator blocks until the primary completes — PR merged, issue CLOSED.
- **Speculative**: launch with `run_in_background: true`. These return
  immediately with an agent ID. The orchestrator is not blocked.

All Agent calls can still be issued in a single message to start simultaneously.

Example (3 slots):

```
Message contains 3 Agent tool calls:
  Agent(description="develop issue 141 primary",    prompt="<slot 1 prompt>", run_in_background=false)
  Agent(description="develop issue 134 speculative", prompt="<slot 2 prompt>", run_in_background=true)
  Agent(description="develop issue 139 speculative", prompt="<slot 3 prompt>", run_in_background=true)
```

### Step 4 — Refill speculative slots on completion

When notified that a background speculative agent has completed:

1. Run `parallel-eligible.sh` to get the updated eligible list.
2. Exclude issues already assigned to an active slot.
3. If a new eligible issue exists:
   a. Run `ensure-issue-worktree.sh` and `verify-issue-prep.sh` for it.
   b. Launch a new background speculative agent (`run_in_background: true`) immediately.
4. If no eligible issue exists, leave the slot idle — it will be refilled at
   the next iteration when slot 1 merges and the Plan advances.

Repeat for every speculative completion notification received while the primary
is still running. Never wait for the primary before refilling.

When the primary completion notification arrives, proceed to Phase 5 — Compact.

### What NOT to do in Phase 4

- Do NOT use the `Skill` tool to invoke `develop-issue` — it runs in your thread
- Do NOT implement code, edit files, or make commits yourself
- Do NOT launch speculative agents without `run_in_background: true`
- Do NOT wait for the primary to finish before refilling a freed speculative slot

---

The outer-loop agent remains a scheduler during this phase. It does not absorb
slot 1 locally. Its job is to launch, monitor, and refill workers.

**Primary agent behaviour** (`role: primary`):

- Drives implementation, CI, checklist, and merge without pause.
- After each push, stays active and waits for CI to complete rather than
  exiting the auto loop while checks are still running.
- While waiting, re-check `merge-ready.sh` and `needs-rebase.sh`
  deterministically until the PR is mergeable or a concrete failing check
  appears that requires intervention.
- If `merge-ready.sh` says ready, merge immediately.
- Do not yield until the PR is merged and the issue is CLOSED, unless a fatal
  blocker remains that cannot be overcome without human intervention.

**Speculative agent behaviour** (`role: speculative`):

- Drives implementation and checklist to completion, marks the PR ready, then
  exits immediately to free the slot.
- Does not wait for CI to go green before exiting — CI runs in the background.
  The outer merge phase waits for green checks before merging.
- Before exiting, check `merge-ready.sh` once. If the only blocker is
  `plan-predecessor-not-merged`, the PR is already ready — leave it undrafted
  and exit.
- Do not wait for the primary to merge before returning.

All agents work exclusively in their `worktree_path`. They do not touch the
main repo checkout or any other issue's worktree.

**Iteration boundary is primary completion, not batch completion.**

The primary agent defines the duration of an iteration. Speculative agents run
in the background and exit early. The orchestrator receives a completion
notification for each background agent. Each notification triggers an immediate
refill attempt — run `parallel-eligible.sh`, prep, and launch a replacement
background agent for the freed slot. Do not wait for the primary to finish
before refilling. When the primary agent completes, proceed to Phase 5 — Compact.

If the primary worker is still active, speculative capacity must stay hot. Do
not postpone speculative launches until the primary finishes stabilizing. Prep
and launch them as soon as `parallel-eligible.sh` says they are eligible.

## Phase 5 — Compact

After the primary agent finishes (PR merged, issue CLOSED), use `/compact` to
compress the accumulated context before starting the next iteration. This
prevents context from filling up across many iterations during long runs.

## Merge ordering — invariant

`merge-ready.sh` enforces Plan position at merge time. A PR is only
mergeable when all preceding Plan issues are CLOSED.

This invariant is enforced by the script, not by convention. Speculative agents
cannot bypass it. The primary slot ensures there is always an active thread
driving the #1 merge blocker to completion.

## Integration handoff

Before merging, the worker agent identifies the next issue in Plan
order (N+1). If it is OPEN, the agent posts a comment on it summarizing:

- files and modules changed
- new or modified public APIs, type signatures, or module boundaries
- import path changes
- anything the N+1 issue scope needs to know

Skip if there is no N+1 or it is already CLOSED.

## Stop condition

Stop only when:

- `parallel-eligible.sh` returns no `selected` issue (all Plan issues CLOSED), or
- progress is blocked by an external constraint that cannot be resolved from
  repo, GitHub context, plan, or blueprint

When blocked, report the diagnosis to the user.
Pending CI on the primary issue alone is not a blocker and must not cause
`superfield-auto` to exit.

If `superfield-auto` is interrupted and re-invoked, Phase 1 will drain any
ready merges and Phase 2 will re-assign the same highest-priority open issue
to slot 1. The new primary worker agent will re-read PR and issue
state and continue from where work left off.

## Decision policy

Proceed without clarifying questions when the next step is low risk and obvious.
The bias is toward forward progress.

If a batch makes no progress on any issue, re-run `parallel-eligible.sh` and
form a new batch rather than retrying stuck issues indefinitely.

## Scripts reference

```bash
.agents/scripts/auto/parallel-eligible.sh          # select batch (slot 1 + eligible)
.agents/scripts/auto/ensure-issue-worktree.sh {N}  # prep one issue
.agents/scripts/auto/verify-issue-prep.sh {N}      # verify prep, get worktree path
.agents/scripts/auto/needs-rebase.sh {pr}          # check rebase needed
.agents/scripts/auto/rebase-issue-branch.sh {pr}   # rebase onto origin/main
.agents/scripts/auto/merge-ready.sh {pr}           # check merge gate
.agents/scripts/auto/mark-pr-ready.sh {pr}         # undraft PR
.agents/scripts/auto/merge-pr.sh {pr}              # merge
.agents/scripts/auto/cleanup-stale-worktrees.sh    # clean up merged worktrees
```
