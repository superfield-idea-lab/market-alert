# Superfield Develop

Develop a single Plan issue from deterministic prep through merge.

Use this when you want to target one specific issue. For continuous parallel
execution across all eligible issues, use `superfield-auto` instead.

## Usage

```
/superfield-develop {issue-number}
```

If no issue number is supplied, select the highest-priority open issue from the Plan:

```bash
.agents/scripts/auto/select-next-work.sh
```

## Flow

1. Prep the issue:

```bash
.agents/scripts/auto/ensure-issue-worktree.sh {issue-number}
.agents/scripts/auto/verify-issue-prep.sh {issue-number}
```

If prep returns `mode=local-bootstrap`, proceed in the local issue worktree even
though the remote branch and PR do not exist yet. In that mode, hook-detected
repo issues are part of the assigned issue's work to resolve before the first
successful push.

2. Read `verify-issue-prep.sh` output to get `branch` and `worktree`. If
   `pr.number` is present, pass it through. If not, the develop step must create
   the remote branch and PR after the branch becomes pushable.

3. Invoke the `develop-issue` skill in a delegated worker, passing the issue
   number, PR number, branch, and worktree path. The caller remains a thin
   coordinator; the delegated worker does the repo work exclusively inside the
   worktree.

4. The `develop-issue` skill owns the issue through implementation, CI green,
   checklist complete, PR ready, and merge.
