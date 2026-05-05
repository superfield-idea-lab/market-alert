#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.agents/scripts/auto/common.sh
source "$SCRIPT_DIR/common.sh"

TARGET="${1:-}"
REPO="$(canonical_repo)"

if [[ -z "$TARGET" ]]; then
  PR_JSON="$(gh pr view --repo "$REPO" --json number,title,url,body,state,isDraft,mergeable,mergeStateStatus,headRefName,baseRefName,mergedAt,headRefOid)"
else
  PR_JSON="$(gh pr view "$TARGET" --repo "$REPO" --json number,title,url,body,state,isDraft,mergeable,mergeStateStatus,headRefName,baseRefName,mergedAt,headRefOid)"
fi

HEAD_SHA="$(jq -r '.headRefOid' <<<"$PR_JSON")"
RAW_CHECKS="$(gh api "repos/$REPO/commits/$HEAD_SHA/check-runs" --paginate --jq '.check_runs[]' 2>/dev/null | jq -s '.' || echo '[]')"
CHECKS_JSON="$(jq 'map({
  name: .name,
  state: (if .status == "completed" then .conclusion else .status end),
  bucket: (
    if .status != "completed" then "pending"
    elif .conclusion == "success" or .conclusion == "skipped" or .conclusion == "neutral" then "pass"
    elif .conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "action_required" then "fail"
    elif .conclusion == "cancelled" then "cancel"
    else "pending"
    end
  ),
  workflow: (.app.name // ""),
  link: (.html_url // "")
})' <<<"$RAW_CHECKS")"

linked_issue_number="$(jq -r '.body' <<<"$PR_JSON" | extract_closing_issue_number || true)"
if [[ -n "$linked_issue_number" ]]; then
  ISSUE_JSON="$("$SCRIPT_DIR/issue-status.sh" "$linked_issue_number")"
else
  ISSUE_JSON='null'
fi

jq -n \
  --argjson pr "$PR_JSON" \
  --argjson checks "$CHECKS_JSON" \
  --arg linked_issue_number "${linked_issue_number:-}" \
  --argjson issue "$ISSUE_JSON" \
  '
  {
    number: $pr.number,
    title: $pr.title,
    url: $pr.url,
    head_ref: $pr.headRefName,
    base_ref: $pr.baseRefName,
    state: $pr.state,
    is_draft: $pr.isDraft,
    merged: ($pr.mergedAt != null),
    mergeable: $pr.mergeable,
    merge_state_status: $pr.mergeStateStatus,
    linked_issue_number: (if $linked_issue_number == "" then null else ($linked_issue_number | tonumber) end),
    checks: {
      total: ($checks | length),
      passing: ($checks | map(select(.bucket == "pass")) | length),
      failing: ($checks | map(select(.bucket == "fail" or .bucket == "cancel")) | length),
      pending: ($checks | map(select(.bucket == "pending")) | length),
      details: $checks,
      all_green: (($checks | length) > 0 and (($checks | map(select(.bucket == "fail" or .bucket == "cancel")) | length) == 0) and (($checks | map(select(.bucket == "pending")) | length) == 0))
    },
    issue: $issue
  }'
