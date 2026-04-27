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

PREP_JSON="$("$SCRIPT_DIR/ensure-issue-worktree.sh" "$ISSUE_NUMBER")"

WORKTREE_PATH="$(jq -r '.worktree' <<<"$PREP_JSON")"
BRANCH_NAME="$(jq -r '.branch' <<<"$PREP_JSON")"
PR_NUMBER="$(jq -r '.pr.number' <<<"$PREP_JSON")"
REMOTE_EXISTS="$(jq -r '.branch_status.remote_exists' <<<"$PREP_JSON")"
TRACKING="$(jq -r '.branch_status.tracking' <<<"$PREP_JSON")"
MAIN_FRESH="$(jq -r '.branch_status.main_sync.branched_from_latest_main' <<<"$PREP_JSON")"
BOOTSTRAP_MODE="$(jq -r '.bootstrap.mode // "full"' <<<"$PREP_JSON")"

ok=true
reasons='[]'

if [[ ! -d "$WORKTREE_PATH" ]]; then
  ok=false
  reasons="$(jq -c '. + ["worktree-missing"]' <<<"$reasons")"
fi

if [[ "$REMOTE_EXISTS" != "true" && "$BOOTSTRAP_MODE" == "full" ]]; then
  ok=false
  reasons="$(jq -c '. + ["branch-not-on-remote"]' <<<"$reasons")"
fi

if [[ "$TRACKING" != "true" && "$BOOTSTRAP_MODE" == "full" ]]; then
  ok=false
  reasons="$(jq -c '. + ["branch-not-tracking-remote"]' <<<"$reasons")"
fi

if [[ (-z "$PR_NUMBER" || "$PR_NUMBER" == "null") && "$BOOTSTRAP_MODE" == "full" ]]; then
  ok=false
  reasons="$(jq -c '. + ["pr-missing"]' <<<"$reasons")"
fi

if [[ "$MAIN_FRESH" != "true" ]]; then
  ok=false
  reasons="$(jq -c '. + ["branch-not-based-on-latest-main"]' <<<"$reasons")"
fi

if [[ "$(git -C "$WORKTREE_PATH" branch --show-current)" != "$BRANCH_NAME" ]]; then
  ok=false
  reasons="$(jq -c '. + ["worktree-on-wrong-branch"]' <<<"$reasons")"
fi

if [[ "$BOOTSTRAP_MODE" == "local-bootstrap" ]]; then
  reasons="$(jq -c '. + ["local-bootstrap-only"]' <<<"$reasons")"
fi

jq -n \
  --argjson prep "$PREP_JSON" \
  --argjson ok "$ok" \
  --argjson reasons "$reasons" \
  --argjson branched_from_latest_main "$MAIN_FRESH" \
  --arg bootstrap_mode "$BOOTSTRAP_MODE" \
  '{
    ok: $ok,
    mode: $bootstrap_mode,
    reasons: $reasons,
    branched_from_latest_main: $branched_from_latest_main,
    prep: $prep
  }'
