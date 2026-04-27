#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.agents/scripts/feature/common.sh
source "$SCRIPT_DIR/common.sh"

CREATED_FILE="${1:-}"
if [[ -z "$CREATED_FILE" || ! -f "$CREATED_FILE" ]]; then
  printf 'usage: %s <created-issue-json-file>\n' "$(basename "$0")" >&2
  exit 1
fi

plan_json="$(find_plan_issue_json)"
if [[ -z "$plan_json" || "$plan_json" == "null" ]]; then
  printf 'open Plan issue not found\n' >&2
  exit 2
fi

plan_number="$(jq -r '.number' <<<"$plan_json")"
plan_body="$(gh issue view "$plan_number" --repo "$(tasks_repo)" --json body -q .body)"
issue_number="$(jq -r '.number' "$CREATED_FILE")"
entry="$("$SCRIPT_DIR/render-plan-entry.sh" "$CREATED_FILE")"
phase="$(jq -r '.phase // empty' "$CREATED_FILE")"
plan_entries_json="$(plan_entries_json_from_body "$plan_body")"

if ! jq -e --argjson number "$issue_number" 'any(.[]; .number == $number)' <<<"$plan_entries_json" >/dev/null; then
  if [[ -n "$phase" ]]; then
    plan_body="$(PLAN_BODY="$plan_body" ENTRY="$entry" PHASE="$phase" python3 - <<'PY'
import os

body = os.environ["PLAN_BODY"]
entry = os.environ["ENTRY"]
phase = os.environ["PHASE"]
header = f"## Phase: {phase}"

if not body.strip():
    print(
        "Planned implementation order for all outstanding features. Work proceeds strictly one issue at a time.\n\n"
        f"{header}\n\n{entry}"
    )
    raise SystemExit

lines = body.splitlines()
for i, line in enumerate(lines):
    if line.strip() == header:
        insert_at = len(lines)
        for j in range(i + 1, len(lines)):
            if lines[j].startswith("## Phase: "):
                insert_at = j
                break
        block = lines[:insert_at]
        while block and block[-1] == "":
            block.pop()
        rest = lines[insert_at:]
        out = block + ["", entry]
        if rest:
            out += [""] + rest
        print("\n".join(out).rstrip())
        raise SystemExit

text = body.rstrip()
print(f"{text}\n\n{header}\n\n{entry}")
PY
)"
  elif [[ -n "$plan_body" ]]; then
    plan_body="${plan_body}"$'\n'"$entry"
  else
    plan_body="Planned implementation order for all outstanding features. Work proceeds strictly one issue at a time."$'\n\n'"$entry"
  fi
  gh issue edit "$plan_number" --repo "$(tasks_repo)" --body "$plan_body" >/dev/null
fi

jq -n \
  --argjson plan_issue_number "$plan_number" \
  --argjson issue_number "$issue_number" \
  --arg entry "$entry" \
  '{ok: true, plan_issue_number: $plan_issue_number, issue_number: $issue_number, entry: $entry}'
