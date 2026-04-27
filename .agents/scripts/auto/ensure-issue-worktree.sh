#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.agents/scripts/auto/common.sh
source "$SCRIPT_DIR/common.sh"

ISSUE_NUMBER="${1:-}"
if [[ -z "$ISSUE_NUMBER" ]]; then
  printf 'usage: %s <issue-number>\n' "$(basename "$0")" >&2
  exit 1
fi

REPO="$(canonical_repo)"
TASKS_REPO="$(tasks_repo)"

ISSUE_JSON="$(gh issue view "$ISSUE_NUMBER" --repo "$TASKS_REPO" --json number,title,url,state)"
ISSUE_TITLE="$(jq -r '.title' <<<"$ISSUE_JSON")"

PR_JSON="$(gh pr list --repo "$REPO" --state open --json number,title,body,headRefName,url,isDraft \
  --jq 'map(select((.body | split("\n"))[]? | test("^(Closes|Fixes|Resolves) #'$ISSUE_NUMBER'$"; "i"))) | .[0]')"
if [[ -z "$PR_JSON" ]]; then
  PR_JSON='null'
fi

created_branch=false
created_pr=false
pushed_branch=false
created_bootstrap_commit=false
bootstrap_mode="full"
bootstrap_blockers='[]'
bootstrap_notes='[]'

git fetch origin main >/dev/null 2>&1

if [[ -n "$PR_JSON" && "$PR_JSON" != "null" ]]; then
  BRANCH_NAME="$(jq -r '.headRefName' <<<"$PR_JSON")"
else
  BRANCH_NAME="$(issue_branch_name "$ISSUE_NUMBER" "$ISSUE_TITLE")"
fi

WORKTREE_PATH="$(issue_worktree_path "$BRANCH_NAME")"

if [[ ! -d "$WORKTREE_PATH" ]]; then
  if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
    git worktree add "$WORKTREE_PATH" "$BRANCH_NAME" >/dev/null
  elif git ls-remote --exit-code --heads origin "$BRANCH_NAME" >/dev/null 2>&1; then
    git fetch origin "$BRANCH_NAME" >/dev/null 2>&1
    git branch --track "$BRANCH_NAME" "origin/$BRANCH_NAME" >/dev/null 2>&1 || true
    git worktree add "$WORKTREE_PATH" "$BRANCH_NAME" >/dev/null
  else
    git worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" origin/main >/dev/null
    created_branch=true
  fi
fi

if ! git ls-remote --exit-code --heads origin "$BRANCH_NAME" >/dev/null 2>&1; then
  ahead_of_main_local="$(git -C "$WORKTREE_PATH" rev-list --count "origin/main..HEAD" 2>/dev/null || printf '0')"
  behind_main_local="$(git -C "$WORKTREE_PATH" rev-list --count "HEAD..origin/main" 2>/dev/null || printf '0')"
  if [[ "$behind_main_local" != "0" ]]; then
    if [[ "$ahead_of_main_local" == "0" ]]; then
      git -C "$WORKTREE_PATH" reset --hard origin/main >/dev/null
    else
      git -C "$WORKTREE_PATH" rebase origin/main >/dev/null
    fi
  fi
fi

if ! git ls-remote --exit-code --heads origin "$BRANCH_NAME" >/dev/null 2>&1; then
  push_output_file="$(mktemp)"
  if git -C "$WORKTREE_PATH" push -u origin "$BRANCH_NAME" > /dev/null 2>"$push_output_file"; then
    pushed_branch=true
  else
    bootstrap_mode="local-bootstrap"
    bootstrap_blockers="$(jq -c '. + ["branch-push-blocked"]' <<<"$bootstrap_blockers")"
    if grep -q "pre-push:" "$push_output_file"; then
      bootstrap_blockers="$(jq -c '. + ["branch-push-blocked-by-hook"]' <<<"$bootstrap_blockers")"
    fi
    note="$(tail -n 20 "$push_output_file" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g' | sed -E 's/^ //; s/ $//')"
    if [[ -n "$note" ]]; then
      bootstrap_notes="$(jq -c --arg note "$note" '. + [$note]' <<<"$bootstrap_notes")"
    fi
  fi
  rm -f "$push_output_file"
fi

if [[ -z "$PR_JSON" || "$PR_JSON" == "null" ]]; then
  ahead_of_main="$(git -C "$WORKTREE_PATH" rev-list --count "origin/main..HEAD" 2>/dev/null || printf '0')"
  if [[ "$ahead_of_main" == "0" && "$bootstrap_mode" == "full" ]]; then
    git -C "$WORKTREE_PATH" commit --allow-empty -m "chore: initialize issue #$ISSUE_NUMBER worktree" >/dev/null
    bootstrap_push_output_file="$(mktemp)"
    if git -C "$WORKTREE_PATH" push origin "$BRANCH_NAME" > /dev/null 2>"$bootstrap_push_output_file"; then
      created_bootstrap_commit=true
    else
      bootstrap_mode="local-bootstrap"
      bootstrap_blockers="$(jq -c '. + ["bootstrap-commit-push-blocked"]' <<<"$bootstrap_blockers")"
      if grep -q "pre-push:" "$bootstrap_push_output_file"; then
        bootstrap_blockers="$(jq -c '. + ["bootstrap-commit-push-blocked-by-hook"]' <<<"$bootstrap_blockers")"
      fi
      note="$(tail -n 20 "$bootstrap_push_output_file" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g' | sed -E 's/^ //; s/ $//')"
      if [[ -n "$note" ]]; then
        bootstrap_notes="$(jq -c --arg note "$note" '. + [$note]' <<<"$bootstrap_notes")"
      fi
    fi
    rm -f "$bootstrap_push_output_file"
  fi
  if [[ "$bootstrap_mode" == "full" ]]; then
    pr_url="$(gh pr create --repo "$REPO" --base main --head "$BRANCH_NAME" --draft --title "$ISSUE_TITLE" --body "Closes #$ISSUE_NUMBER")"
    PR_JSON="$(gh pr view "$BRANCH_NAME" --repo "$REPO" --json number,title,body,headRefName,url,isDraft)"
    created_pr=true
  else
    bootstrap_blockers="$(jq -c '. + ["pr-not-created-yet"]' <<<"$bootstrap_blockers")"
  fi
else
  pr_url="$(jq -r '.url' <<<"$PR_JSON")"
fi

BRANCH_STATUS="$("$SCRIPT_DIR/remote-branch-status.sh" "$BRANCH_NAME")"

jq -n \
  --argjson issue "$ISSUE_JSON" \
  --arg branch "$BRANCH_NAME" \
  --arg worktree "$WORKTREE_PATH" \
  --argjson pr "$PR_JSON" \
  --argjson branch_status "$BRANCH_STATUS" \
  --argjson created_branch "$created_branch" \
  --argjson pushed_branch "$pushed_branch" \
  --argjson created_bootstrap_commit "$created_bootstrap_commit" \
  --argjson created_pr "$created_pr" \
  --arg bootstrap_mode "$bootstrap_mode" \
  --argjson bootstrap_blockers "$bootstrap_blockers" \
  --argjson bootstrap_notes "$bootstrap_notes" \
  '{
    issue: $issue,
    branch: $branch,
    worktree: $worktree,
    pr: {
      number: $pr.number,
      title: $pr.title,
      url: $pr.url,
      is_draft: $pr.isDraft
    },
    branch_status: $branch_status,
    prep_actions: {
      created_branch: $created_branch,
      pushed_branch: $pushed_branch,
      created_bootstrap_commit: $created_bootstrap_commit,
      created_pr: $created_pr
    },
    bootstrap: {
      mode: $bootstrap_mode,
      blockers: $bootstrap_blockers,
      notes: $bootstrap_notes
    }
  }'
