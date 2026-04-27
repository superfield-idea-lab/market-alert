#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.agents/scripts/auto/common.sh
source "$SCRIPT_DIR/common.sh"

REPO="$(tasks_repo)"
PLAN_JSON="$(gh issue list --repo "$REPO" --state open --limit 200 --json number,title,url --jq 'map(select(.title == "Plan")) | .[0]')"

if [[ -z "$PLAN_JSON" || "$PLAN_JSON" == "null" ]]; then
  jq -n '{kind: "none", reason: "plan-not-found"}'
  exit 0
fi

PLAN_BODY="$(gh issue view "$(jq -r '.number' <<<"$PLAN_JSON")" --repo "$REPO" --json body -q .body)"
PLAN_PHASES_JSON="$(plan_phases_json_from_body "$PLAN_BODY")"
PLAN_ENTRIES_JSON="$(plan_entries_json_from_body "$PLAN_BODY")"

plan_issue_numbers=()
while IFS= read -r _line; do [[ -n "$_line" ]] && plan_issue_numbers+=("$_line"); done \
  < <(plan_issue_numbers_from_body "$PLAN_BODY")

for issue_number in "${plan_issue_numbers[@]}"; do
  [[ -n "$issue_number" ]] || continue

  issue_json="$("$SCRIPT_DIR/issue-status.sh" "$issue_number")"
  issue_state="$(jq -r '.state' <<<"$issue_json")"

  if [[ "$issue_state" != "OPEN" ]]; then
    continue
  fi

  issue_body="$(gh issue view "$issue_number" --repo "$REPO" --json body -q .body)"
  phase_blockers="$(phase_dependency_blockers_json "$PLAN_PHASES_JSON" "$issue_number" "$issue_body")"
  if [[ "$phase_blockers" != "[]" ]]; then
    jq -n --argjson issue "$issue_json" --argjson blockers "$phase_blockers" '{
      kind: "none",
      reason: "phase-dependency-blocked",
      issue: $issue,
      blockers: $blockers
    }'
    exit 0
  fi

  deps=()
  while IFS= read -r _line; do [[ -n "$_line" ]] && deps+=("$_line"); done \
    < <(jq -r --argjson number "$issue_number" '.[] | select(.number == $number) | .dependencies[]?' <<<"$PLAN_ENTRIES_JSON")
  dependencies_closed=true
  for dep in "${deps[@]}"; do
    [[ -n "$dep" ]] || continue
    dep_state="$(gh issue view "$dep" --repo "$REPO" --json state -q .state)"
    if [[ "$dep_state" != "CLOSED" ]]; then
      dependencies_closed=false
      break
    fi
  done

  if [[ "$dependencies_closed" != "true" ]]; then
    continue
  fi

  pr_json="$(gh pr list --repo "$(canonical_repo)" --state open --json number,title,body,headRefName,isDraft,url \
    --jq 'map(select((.body | split("\n"))[]? | test("^(Closes|Fixes|Resolves) #'$issue_number'$"; "i"))) | .[0]')"

  jq -n --argjson issue "$issue_json" --argjson pr "${pr_json:-null}" '{
    kind: "issue",
    reason: "next-plan-issue",
    issue: $issue,
    pr: (if $pr == null then null else {
      number: $pr.number,
      title: $pr.title,
      url: $pr.url,
      head_ref: $pr.headRefName,
      is_draft: $pr.isDraft
    } end)
  }'
  exit 0
done

jq -n '{kind: "none", reason: "no-eligible-issue"}'
