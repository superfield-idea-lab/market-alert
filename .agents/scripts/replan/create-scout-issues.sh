#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.agents/scripts/replan/common.sh
source "$SCRIPT_DIR/common.sh"

PLAN_FILE="${1:-}"
if [[ -z "$PLAN_FILE" || ! -f "$PLAN_FILE" ]]; then
  printf 'usage: %s <plan-json-file>\n' "$(basename "$0")" >&2
  exit 1
fi

null_count=$(jq '[.ordered_issues[] | select(.kind == "dev-scout" and .number == null)] | length' "$PLAN_FILE")

if [[ "$null_count" -eq 0 ]]; then
  jq -n '{ok: true, created: [], mode: "noop"}'
  exit 0
fi

created_json="[]"

while IFS= read -r scout_json; do
  title=$(jq -r '.title' <<< "$scout_json")
  phase=$(jq -r '.phase' <<< "$scout_json")
  scout_spec=$(jq '.scout_spec' <<< "$scout_json")

  if [[ "$scout_spec" == "null" || -z "$scout_spec" ]]; then
    printf 'error: null-numbered scout for phase "%s" is missing scout_spec\n' "$phase" >&2
    exit 2
  fi

  # Build issue JSON in the format expected by validate-issue-json.sh / render-issue-body.sh
  tmp_issue=$(mktemp /tmp/scout-issue-XXXXXX.json)
  jq -n \
    --arg title "$title" \
    --arg phase "$phase" \
    --argjson spec "$scout_spec" \
    '{
      title: $title,
      phase: $phase,
      issue_kind: "dev-scout",
      canonical_docs: ($spec.canonical_docs // []),
      dependencies: [],
      motivation: $spec.motivation,
      behaviour: $spec.behaviour,
      scope: $spec.scope,
      acceptance_criteria: $spec.acceptance_criteria,
      test_plan: $spec.test_plan,
      stage: "Specified"
    }' > "$tmp_issue"

  "$SCRIPT_DIR/../feature/validate-issue-json.sh" "$tmp_issue" >/dev/null
  body="$("$SCRIPT_DIR/../feature/render-issue-body.sh" "$tmp_issue")"
  rm -f "$tmp_issue"

  url=$(gh issue create --repo "$(tasks_repo)" --title "$title" --body "$body")
  issue_number=$(grep -oE '[0-9]+$' <<< "$url")

  # Patch the plan JSON in-place:
  # 1. Fill in the scout's number in ordered_issues
  # 2. Set scout_issue_number in the phase and add to issue_numbers
  # 3. Add the scout as a dependency for all non-scout issues in the same phase
  updated=$(jq \
    --arg phase "$phase" \
    --argjson n "$issue_number" \
    '
      .ordered_issues = [.ordered_issues[] |
        if .kind == "dev-scout" and .phase == $phase and .number == null then
          .number = $n
        else
          .
        end
      ]
      | .phases = [.phases[] |
        if .name == $phase and .scout_issue_number == null then
          .scout_issue_number = $n
          | .issue_numbers = (.issue_numbers + [$n])
        else
          .
        end
      ]
      | .ordered_issues = [.ordered_issues[] |
        if .phase == $phase and .kind != "dev-scout" and ((.dependencies | index($n)) == null) then
          .dependencies = (.dependencies + [$n])
        else
          .
        end
      ]
    ' "$PLAN_FILE")

  printf '%s' "$updated" > "$PLAN_FILE"

  created_json=$(jq --argjson n "$issue_number" --arg t "$title" \
    '. + [{number: $n, title: $t}]' <<< "$created_json")

  printf 'created scout issue #%s for phase "%s": %s\n' "$issue_number" "$phase" "$title" >&2

done < <(jq -c '.ordered_issues[] | select(.kind == "dev-scout" and .number == null)' "$PLAN_FILE")

jq -n --argjson created "$created_json" '{ok: true, created: $created}'
