#!/usr/bin/env bash
set -euo pipefail

# recover-issue-body.sh <issue_number> [--restore <index>]
#
# Reads GitHub issue edit history via GraphQL userContentEdits to find
# previous body snapshots.  The REST timeline API does NOT record body edits;
# GraphQL is the only reliable source.
#
# Snapshots are returned newest-first by GitHub; this script reverses them so
# index 0 is the oldest (original) body and the last index is the most recent
# edit before the current body.
#
# Usage:
#   recover-issue-body.sh 42              # list all historical bodies
#   recover-issue-body.sh 42 --restore 0  # restore the oldest (original) body
#   recover-issue-body.sh 42 --restore 1  # restore the second-oldest, etc.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.agents/scripts/replan/common.sh
source "$SCRIPT_DIR/common.sh"

usage() {
  printf 'Usage: %s <issue_number> [--restore <index>]\n' "$(basename "$0")" >&2
  printf '  Lists historical issue bodies from GitHub GraphQL userContentEdits.\n' >&2
  printf '  Use --restore <index> to overwrite the current body with a past version.\n' >&2
  exit 1
}

[[ $# -ge 1 ]] || usage

issue_number="$1"
restore_index=""

shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --restore)
      [[ $# -ge 2 ]] || { printf 'error: --restore requires an index argument\n' >&2; exit 1; }
      restore_index="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

repo="$(tasks_repo)"
owner="$(cut -d/ -f1 <<<"$repo")"
name="$(cut -d/ -f2 <<<"$repo")"

# Fetch edit history via GraphQL.  userContentEdits returns newest-first;
# the diff field contains the *new* body after each edit (not a text diff).
history_json="$(gh api graphql -f query="
{
  repository(owner: \"$owner\", name: \"$name\") {
    issue(number: $issue_number) {
      userContentEdits(first: 100) {
        nodes {
          editedAt
          editor { login }
          diff
        }
      }
    }
  }
}" --jq '.data.repository.issue.userContentEdits.nodes')"

# Reverse to oldest-first so index 0 = original body
history_json="$(printf '%s\n' "$history_json" | jq 'reverse')"

count="$(printf '%s\n' "$history_json" | jq 'length')"

if [[ "$count" == "0" ]]; then
  printf 'No edit history found for issue #%s in %s.\n' "$issue_number" "$repo" >&2
  printf '(GitHub only records edits made after the issue was created.)\n' >&2
  exit 0
fi

if [[ -z "$restore_index" ]]; then
  printf 'Found %s edit snapshot(s) for issue #%s (%s):\n\n' "$count" "$issue_number" "$repo"
  HISTORY_JSON="$history_json" python3 - <<'PY'
import json, os, textwrap

history = json.loads(os.environ["HISTORY_JSON"])
for i, entry in enumerate(history):
    editor = (entry.get("editor") or {}).get("login", "unknown")
    print(f"=== [{i}] {entry['editedAt']}  (edited by {editor}) ===")
    body = entry.get("diff") or ""
    print(textwrap.indent(body, "  "))
    print()
PY
  printf 'To restore a version run:\n'
  printf '  %s %s --restore <index>\n' "$(basename "$0")" "$issue_number"
else
  max_index="$((count - 1))"
  if ! [[ "$restore_index" =~ ^[0-9]+$ ]] || [[ "$restore_index" -gt "$max_index" ]]; then
    printf 'error: index %s out of range (0-%s)\n' "$restore_index" "$max_index" >&2
    exit 1
  fi

  recovered_body="$(printf '%s\n' "$history_json" | jq -r --argjson idx "$restore_index" '.[$idx].diff')"
  edited_at="$(printf '%s\n' "$history_json" | jq -r --argjson idx "$restore_index" '.[$idx].editedAt')"
  editor="$(printf '%s\n' "$history_json" | jq -r --argjson idx "$restore_index" '.[$idx].editor.login')"

  printf 'Restoring issue #%s to body from %s (snapshot by %s)...\n' "$issue_number" "$edited_at" "$editor"
  gh issue edit "$issue_number" --repo "$repo" --body "$recovered_body"
  printf 'Done. Issue #%s body restored.\n' "$issue_number"
fi
