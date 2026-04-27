#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.agents/scripts/replan/common.sh
source "$SCRIPT_DIR/common.sh"

# Accept optional pre-collected files to avoid redundant API calls:
#   rank-input.sh [plan_file] [pr_file] [issue_audit_file] [pr_audit_file]
# When a positional argument is provided, the corresponding collection script
# is skipped and the file is read directly.

plan_file="${1:-}"
pr_file="${2:-}"
issue_audit_file="${3:-}"
pr_audit_file="${4:-}"

tmp_files=()
cleanup_tmp() { rm -f "${tmp_files[@]+"${tmp_files[@]}"}"; }
trap cleanup_tmp EXIT

write_tmp() {
  local f
  f="$(mktemp)"
  tmp_files+=("$f")
  cat > "$f"
  printf '%s' "$f"
}

if [[ -z "$plan_file" ]]; then
  plan_file="$("$SCRIPT_DIR/collect-plan-issues.sh" | write_tmp)"
fi
if [[ -z "$pr_file" ]]; then
  pr_file="$("$SCRIPT_DIR/collect-open-prs.sh" | write_tmp)"
fi
if [[ -z "$issue_audit_file" ]]; then
  issue_audit_file="$("$SCRIPT_DIR/audit-issues.sh" | write_tmp)"
fi
if [[ -z "$pr_audit_file" ]]; then
  pr_audit_file="$("$SCRIPT_DIR/audit-prs.sh" | write_tmp)"
fi

# Use --slurpfile instead of --argjson to avoid "Argument list too long" errors
# when JSON payloads are large.
jq -n \
  --slurpfile plan "$plan_file" \
  --slurpfile prs "$pr_file" \
  --slurpfile issue_audit "$issue_audit_file" \
  --slurpfile pr_audit "$pr_audit_file" \
  '{
    plan: $plan[0].plan,
    issues: $plan[0].issues,
    open_prs: $prs[0],
    audits: {
      issues: $issue_audit[0],
      prs: $pr_audit[0]
    }
  }'
