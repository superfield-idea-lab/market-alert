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

REPO="$(tasks_repo)"
ISSUE_JSON="$(gh issue view "$ISSUE_NUMBER" --repo "$REPO" --json number,title,url,state,body)"
BODY="$(jq -r '.body' <<<"$ISSUE_JSON")"

acceptance_section="$(printf '%s\n' "$BODY" | section_body "Acceptance criteria")"
test_plan_section="$(printf '%s\n' "$BODY" | section_body "Test plan")"

acceptance_total="$(printf '%s\n' "$acceptance_section" | count_checkboxes '^- \[[ xX]\]')"
acceptance_unchecked="$(printf '%s\n' "$acceptance_section" | count_checkboxes '^- \[ \]')"
test_total="$(printf '%s\n' "$test_plan_section" | count_checkboxes '^- \[[ xX]\]')"
test_unchecked="$(printf '%s\n' "$test_plan_section" | count_checkboxes '^- \[ \]')"

deps_json='[]'
dependencies_closed=true

jq -n \
  --argjson issue "$ISSUE_JSON" \
  --argjson dependencies "$deps_json" \
  --argjson acceptance_total "$acceptance_total" \
  --argjson acceptance_unchecked "$acceptance_unchecked" \
  --argjson test_total "$test_total" \
  --argjson test_unchecked "$test_unchecked" \
  --argjson dependencies_closed "$dependencies_closed" \
  '
  {
    number: $issue.number,
    title: $issue.title,
    url: $issue.url,
    state: $issue.state,
    acceptance: {
      total: $acceptance_total,
      unchecked: $acceptance_unchecked,
      complete: ($acceptance_total > 0 and $acceptance_unchecked == 0)
    },
    test_plan: {
      total: $test_total,
      unchecked: $test_unchecked,
      complete: ($test_total > 0 and $test_unchecked == 0)
    },
    checklist: {
      total: ($acceptance_total + $test_total),
      unchecked: ($acceptance_unchecked + $test_unchecked),
      complete: (($acceptance_total + $test_total) > 0 and ($acceptance_unchecked + $test_unchecked) == 0)
    },
    dependencies: $dependencies,
    dependencies_closed: $dependencies_closed
  }'
