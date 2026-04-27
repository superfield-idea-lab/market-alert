#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.agents/scripts/replan/common.sh
source "$SCRIPT_DIR/common.sh"

PLAN_FILE="${1:-}"
if [[ -z "$PLAN_FILE" ]]; then
  printf 'usage: %s <plan-json-file>\n' "$(basename "$0")" >&2
  exit 1
fi

"$SCRIPT_DIR/validate-plan-json.sh" "$PLAN_FILE" >/dev/null

plan_issue_number="$(jq -r '.plan_issue_number' "$PLAN_FILE")"
body="$(jq -r '
  . as $root
  | def issue_metadata($issue):
    "<!-- superfield: "
      + ({
          number: $issue.number,
          phase: ($issue.phase // null),
          kind: ($issue.kind // "feature"),
          dependencies: ($issue.dependencies // []),
          parallel_safe: ($issue.parallel_safe // false)
        } | @json)
      + " -->";
  | def phase_block($root; $phase):
    [
      "## Phase: " + $phase.name,
      "",
      "Goal: " + $phase.goal,
      "Depends on phases: "
        + (if (($phase.depends_on // []) | length) == 0 then "None." else (($phase.depends_on // []) | join(", ")) end),
      "Scout gate: #" + ($phase.scout_issue_number | tostring),
      "",
      (
        $root.ordered_issues[]
        | select(.phase == $phase.name)
        | [
            "- #" + (.number|tostring) + " - "
              + (if .kind == "dev-scout" then "[dev-scout] " else "" end)
              + .title + " [risk: " + (.risk|tostring) + "]"
              + (if .parallel_safe == true then " ⊜" else "" end),
            "  " + issue_metadata(.)
          ][]
      )
    ];
  (($root.phases // []) | map(.name)) as $phase_names
  | if (($phase_names | length) > 0) then
    [
      "Planned implementation order for all outstanding features. Development may run in parallel only after phase scout gates are satisfied.",
      "",
      "> Last replanned: " + (now | todateiso8601 | split("T")[0]),
      "> Each phase starts with a dev scout. No non-scout issue in a phase may begin until its scout PR is merged and its follow-up issue updates are complete.",
      "",
      (($root.phases[] | phase_block($root; .))[]),
      (
        $root.ordered_issues[]
        | . as $issue
        | select((($issue.phase // null) == null) or (($phase_names | index($issue.phase)) == null))
        | [
            "- #" + (.number|tostring) + " - " + .title + " [risk: " + (.risk|tostring) + "]"
              + (if .parallel_safe == true then " ⊜" else "" end),
            "  " + issue_metadata(.)
          ][]
      )
    ]
  else
    [
      "Planned implementation order for all outstanding features. Work proceeds strictly one issue at a time.",
      "",
      "> Last replanned: " + (now | todateiso8601 | split("T")[0]),
      "",
      ($root.ordered_issues[] |
        [
          "- #" + (.number|tostring) + " - " + .title + " [risk: " + (.risk|tostring) + "]"
            + (if .parallel_safe == true then " ⊜" else "" end),
          "  " + issue_metadata(.)
        ][]
      )
    ]
  end | flatten | join("\n")
' "$PLAN_FILE")"

gh issue edit "$plan_issue_number" --repo "$(tasks_repo)" --body "$body" >/dev/null

jq -n --argjson plan_issue_number "$plan_issue_number" --arg body "$body" '{
  ok: true,
  plan_issue_number: $plan_issue_number,
  body: $body
}'
