#!/usr/bin/env bash
set -euo pipefail

PLAN_FILE="${1:-}"
if [[ -z "$PLAN_FILE" ]]; then
  printf 'usage: %s <plan-json-file>\n' "$(basename "$0")" >&2
  exit 1
fi

jq -e '
  .plan_issue_number
  and (.ordered_issues | type == "array")
  and ((.ordered_issues | length) > 0)
' "$PLAN_FILE" >/dev/null || {
  printf 'invalid plan json: missing plan_issue_number or ordered_issues\n' >&2
  exit 2
}

if jq -e '
  (.ordered_issues | map(.number) | length) != (.ordered_issues | map(.number) | unique | length)
' "$PLAN_FILE" >/dev/null; then
  printf 'invalid plan json: duplicate issue numbers in ordered_issues\n' >&2
  exit 3
fi

if jq -e '
  any(.ordered_issues[];
    (.number == null)
    or (.title == null)
    or ((.phase // null) != null and ((.phase | type) != "string" or (.phase | length) == 0))
    or ((.kind // null) != null and (.kind != "feature" and .kind != "dev-scout"))
    or (.risk == null)
    or (.rationale == null)
    or ((.dependencies // []) | type != "array")
    or ((.dependents // []) | type != "array")
    or (has("parallel_safe") and ((.parallel_safe | type) != "boolean"))
  )
' "$PLAN_FILE" >/dev/null; then
  printf 'invalid plan json: ordered issue is missing required fields or has invalid phase/kind/parallel_safe data\n' >&2
  exit 4
fi

if jq -e '
  has("batches") or has("parallel_groups")
  or any(.ordered_issues[]; has("batch") or has("parallel_group"))
' "$PLAN_FILE" >/dev/null; then
  printf 'invalid plan json: batch or parallel metadata is forbidden\n' >&2
  exit 5
fi

if jq -e '
  has("phases")
  and (
    (.phases | type != "array")
    or any(.phases[];
      (.name | type != "string" or length == 0)
      or (.goal | type != "string" or length == 0)
      or ((.depends_on // []) | type != "array")
      or any((.depends_on // [])[]; (. | type) != "string" or length == 0)
      or (.scout_issue_number == null)
      or ((.issue_numbers // []) | type != "array")
      or ((.issue_numbers // []) | length == 0)
    )
  )
' "$PLAN_FILE" >/dev/null; then
  printf 'invalid plan json: phases must be a valid array of phase objects\n' >&2
  exit 8
fi

if ! jq -e '
  . as $root
  | ((.phases // [])
    | map(
        . as $phase
        | ((($phase.depends_on // [])
              | map(. as $dependency_name | ($dependency_name != $phase.name and (($root.phases // []) | any(.name == $dependency_name))))
              | all))
      )
    | all)
' "$PLAN_FILE" >/dev/null; then
  printf 'invalid plan json: phase depends_on must reference existing non-self phases\n' >&2
  exit 13
fi

if ! jq -e '
  . as $root
  | ((.phases // [])
    | map(
        . as $phase
        | (
            (($phase.issue_numbers // [])
              | map(. as $issue_number | ($root.ordered_issues | any(.number == $issue_number)))
              | all)
            and ($root.ordered_issues | any(.number == $phase.scout_issue_number))
            and (($phase.issue_numbers | index($phase.scout_issue_number)) != null)
          )
      )
    | all)
' "$PLAN_FILE" >/dev/null; then
  printf 'invalid plan json: phase issue_numbers and scout_issue_number must reference ordered_issues\n' >&2
  exit 9
fi

if ! jq -e '
  . as $root
  | ((.phases // [])
    | map(
        . as $phase
        | (
            ($root.ordered_issues | map(select(.phase == $phase.name and .kind == "dev-scout")) | length) == 1
            and ($root.ordered_issues | map(select(.phase == $phase.name and .kind == "dev-scout") | .number) | first) == $phase.scout_issue_number
          )
      )
    | all)
' "$PLAN_FILE" >/dev/null; then
  printf 'invalid plan json: each phase must map to exactly one matching dev-scout issue\n' >&2
  exit 10
fi

if ! jq -e '
  . as $root
  | (.ordered_issues
    | map(
        . as $issue
        | ((($issue.phase // null) == null)
          or (($root.phases // []) | any(.name == $issue.phase)))
      )
    | all)
' "$PLAN_FILE" >/dev/null; then
  printf 'invalid plan json: ordered issue phase must exist in phases\n' >&2
  exit 11
fi

if ! jq -e '
  . as $root
  | [range(0; (.ordered_issues | length))] as $idxs
  | (($root.phases // [])
    | map(
        . as $phase
        | ($root.ordered_issues | map(select(.phase == $phase.name and .kind == "dev-scout")) | first) as $scout
        | (
            $scout != null
            and all($idxs[];
                . as $i
                | ($root.ordered_issues[$i]) as $issue
                | if $issue.phase == $phase.name and $issue.kind != "dev-scout" then
                    (($issue.dependencies // []) | index($phase.scout_issue_number)) != null
                    and (($root.ordered_issues | map(.number) | index($phase.scout_issue_number)) < $i)
                  else
                    true
                  end
              )
          )
      )
    | all)
' "$PLAN_FILE" >/dev/null; then
  printf 'invalid plan json: non-scout phase issues must depend on an earlier scout issue\n' >&2
  exit 12
fi

if ! jq -e '
  . as $root
  | (($root.phases // [])
    | map(
        . as $phase
        | (($root.ordered_issues | map(.number) | index($phase.scout_issue_number)) as $scout_index
          | (($phase.depends_on // [])
              | map(
                  . as $dependency_name
                  | (($root.phases // [])
                      | map(select(.name == $dependency_name) | .issue_numbers[])
                      | map(($root.ordered_issues | map(.number) | index(.)))
                      | max) as $max_dep_index
                  | ($scout_index != null and $max_dep_index != null and $max_dep_index < $scout_index)
                )
              | all))
      )
    | all)
' "$PLAN_FILE" >/dev/null; then
  printf 'invalid plan json: phase scout must appear after all issues in prerequisite phases\n' >&2
  exit 14
fi

if ! jq -e '
  . as $root
  | all(.ordered_issues[];
      . as $issue
      | all((.dependencies // [])[];
          . as $dep
          | ($root.ordered_issues | any(.number == $dep))
        )
    )
' "$PLAN_FILE" >/dev/null; then
  printf 'invalid plan json: dependency references must exist in ordered_issues\n' >&2
  exit 6
fi

if ! jq -e '
  . as $root
  | [range(0; (.ordered_issues | length))] as $idxs
  | all($idxs[];
      . as $i
      | ($root.ordered_issues[$i]) as $issue
      | all(($issue.dependencies // [])[];
          . as $dep
          | ($root.ordered_issues | map(.number) | index($dep)) as $dep_index
          | ($dep_index != null) and ($dep_index < $i)
        )
    )
' "$PLAN_FILE" >/dev/null; then
  printf 'invalid plan json: dependency order violation\n' >&2
  exit 7
fi

jq -n --arg file "$PLAN_FILE" '{ok: true, file: $file}'
