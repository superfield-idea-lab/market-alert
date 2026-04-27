#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.agents/scripts/replan/common.sh
source "$SCRIPT_DIR/common.sh"

plan_json="$(require_plan_issue)"
plan_number="$(jq -r '.number' <<<"$plan_json")"
plan_body="$(gh issue view "$plan_number" --repo "$(tasks_repo)" --json body -q .body)"
plan_entries="$(plan_entries_json_from_body "$plan_body")"
plan_phases="$(plan_phases_json_from_body "$plan_body")"

issue_numbers=()
while IFS= read -r _line; do [[ -n "$_line" ]] && issue_numbers+=("$_line"); done \
  < <(plan_issue_numbers_from_body "$plan_body")

issues_file="$(mktemp)"
plan_body_file="$(mktemp)"
plan_entries_file="$(mktemp)"
plan_phases_file="$(mktemp)"
trap 'rm -f "$issues_file" "$plan_body_file" "$plan_entries_file" "$plan_phases_file"' EXIT

printf '%s' "$plan_body" > "$plan_body_file"
printf '%s' "$plan_entries" > "$plan_entries_file"
printf '%s' "$plan_phases" > "$plan_phases_file"

# Batch-fetch OPEN issues only via GitHub GraphQL API to avoid N+1 REST calls.
# Closed issues are irrelevant for replanning and constitute the majority of
# Plan-referenced issues over time.
repo_nwo="$(tasks_repo)"
repo_owner="${repo_nwo%%/*}"
repo_name="${repo_nwo##*/}"

batch_fetch_issues() {
  local numbers=("$@")
  local batch_size=50
  local offset=0
  printf '[]' > "$issues_file"

  while (( offset < ${#numbers[@]} )); do
    local batch=("${numbers[@]:offset:batch_size}")
    offset=$(( offset + batch_size ))

    # Build GraphQL query with aliased issue fields
    local query="query {"
    for num in "${batch[@]}"; do
      [[ -n "$num" ]] || continue
      query+=" i${num}: repository(owner: \"${repo_owner}\", name: \"${repo_name}\") {"
      query+="   issue(number: ${num}) {"
      query+="     number title body state url"
      query+="   }"
      query+=" }"
    done
    query+=" }"

    local result
    result="$(gh api graphql -f query="$query")"

    # Extract issues, keep only OPEN ones
    jq -c '[.data | to_entries[].value.issue | select(.state == "OPEN")]' <<<"$result" > "${issues_file}.batch"
    jq -c --slurpfile batch "${issues_file}.batch" '. + $batch[0]' "$issues_file" > "${issues_file}.tmp" \
      && mv "${issues_file}.tmp" "$issues_file"
    rm -f "${issues_file}.batch"
  done
}

if (( ${#issue_numbers[@]} > 0 )); then
  batch_fetch_issues "${issue_numbers[@]}"
else
  printf '[]' > "$issues_file"
fi

# Normalize GraphQL field names to match REST output (camelCase -> camelCase is
# already consistent for the fields we request, but state is uppercase in
# GraphQL: "OPEN"/"CLOSED" vs REST "open"/"closed").  Downstream consumers
# expect the REST casing.
jq -c '[.[] | .state = (.state | ascii_downcase)]' "$issues_file" > "${issues_file}.tmp" \
  && mv "${issues_file}.tmp" "$issues_file"

jq -n \
  --argjson plan "$plan_json" \
  --rawfile plan_body "$plan_body_file" \
  --slurpfile plan_entries "$plan_entries_file" \
  --slurpfile plan_phases "$plan_phases_file" \
  --slurpfile issues "$issues_file" \
  '{
    plan: $plan,
    plan_body: $plan_body,
    plan_entries: $plan_entries[0],
    plan_phases: $plan_phases[0],
    issues: $issues[0]
  }'
