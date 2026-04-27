#!/usr/bin/env bash
set -euo pipefail

CREATED_FILE="${1:-}"
if [[ -z "$CREATED_FILE" || ! -f "$CREATED_FILE" ]]; then
  printf 'usage: %s <created-issue-json-file>\n' "$(basename "$0")" >&2
  exit 1
fi

issue_number="$(jq -r '.number' "$CREATED_FILE")"
title="$(jq -r '.title' "$CREATED_FILE")"
phase="$(jq -r '.phase // empty' "$CREATED_FILE")"
issue_kind="$(jq -r '.issue_kind // "feature"' "$CREATED_FILE")"
parallel_safe="$(jq -r '.parallel_safe // false' "$CREATED_FILE")"
dependencies="$(jq -c '.dependencies // []' "$CREATED_FILE")"
metadata="$(jq -c -n \
  --argjson number "$issue_number" \
  --arg phase "$phase" \
  --arg kind "$issue_kind" \
  --argjson dependencies "$dependencies" \
  --argjson parallel_safe "$parallel_safe" \
  '{
    number: $number,
    phase: (if $phase == "" then null else $phase end),
    kind: $kind,
    dependencies: $dependencies,
    parallel_safe: $parallel_safe
  }')"
printf -- '- #%s - %s\n' "$issue_number" "$title"
printf -- '  <!-- superfield: %s -->\n' "$metadata"
