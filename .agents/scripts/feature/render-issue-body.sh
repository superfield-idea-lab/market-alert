#!/usr/bin/env bash
set -euo pipefail

ISSUE_FILE="${1:-}"
if [[ -z "$ISSUE_FILE" || ! -f "$ISSUE_FILE" ]]; then
  printf 'usage: %s <issue-json-file>\n' "$(basename "$0")" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/validate-issue-json.sh" "$ISSUE_FILE" >/dev/null

jq -r '
  [
    "## Phase",
    "",
    (.phase // "Unassigned"),
    "",
    "## Issue type",
    "",
    (.issue_kind // "feature"),
    "",
    "## Canonical docs",
    "",
    (if ((.canonical_docs // []) | length) == 0 then "None." else ((.canonical_docs // [])[] | "- `" + . + "`") end),
    "",
    "## Motivation",
    "",
    .motivation,
    "",
    "## Behaviour",
    "",
    .behaviour,
    "",
    "## Scope",
    "",
    "In scope:",
    (.scope.in[] | "- " + .),
    "",
    "Out of scope:",
    (.scope.out[] | "- " + .),
    "",
    "## Acceptance criteria",
    "",
    (.acceptance_criteria[] | "- [ ] " + .),
    "",
    "## Test plan",
    "",
    (.test_plan[] | "- [ ] " + .),
    "",
    "## Stage",
    "",
    "**Current:** " + .stage
  ] | flatten | join("\n")
' "$ISSUE_FILE"
