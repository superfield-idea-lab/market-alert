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

jq -n '{
  ok: true,
  mode: "noop",
  reason: "dependency-tree-is-canonical-in-plan"
}'
