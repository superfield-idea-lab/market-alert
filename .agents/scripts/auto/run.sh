#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.agents/scripts/auto/common.sh
source "$SCRIPT_DIR/common.sh"

MAX_CONCURRENCY="${1:-3}"
if ! [[ "$MAX_CONCURRENCY" =~ ^[0-9]+$ ]] || (( MAX_CONCURRENCY < 1 )); then
  printf 'usage: %s [max-concurrency>=1]\n' "$(basename "$0")" >&2
  exit 1
fi

cleanup="$("$SCRIPT_DIR/cleanup-stale-worktrees.sh")"
selection="$("$SCRIPT_DIR/parallel-eligible.sh")"
selected="$(jq -r '.selected // empty' <<<"$selection")"

if [[ -z "$selected" || "$selected" == "null" ]]; then
  payload="$(jq -n \
    --argjson cleanup "$cleanup" \
    --argjson selection "$selection" \
    '{
      cleanup: $cleanup,
      selection: $selection
    }')"
  diagnosis="$(printf '%s\n' "$payload" | "$SCRIPT_DIR/diagnose-state.sh" || true)"
  if [[ -n "$diagnosis" ]]; then
    jq -n \
      --argjson cleanup "$cleanup" \
      --argjson selection "$selection" \
      --argjson diagnosis "$diagnosis" \
      '{
        state: $diagnosis.state,
        next_action: "diagnose",
        cleanup: $cleanup,
        selection: $selection,
        diagnosis: $diagnosis
      }'
  else
    jq -n \
      --argjson cleanup "$cleanup" \
      --argjson selection "$selection" \
      '{
        state: "idle",
        next_action: "stop",
        cleanup: $cleanup,
        selection: $selection
      }'
  fi
  exit 0
fi

batch="$(jq -n \
  --argjson selected "$selected" \
  --argjson eligible "$(jq ".eligible[:$((MAX_CONCURRENCY - 1))]" <<<"$selection")" \
  '[
    {number: $selected, role: "primary"}
  ] + ($eligible | map({number: .number, role: "speculative"}))')"

batch_state='[]'
state="active"
next_action="develop-batch"

while IFS= read -r encoded; do
  row() { printf '%s' "$encoded" | base64 -d; }
  issue_number="$(row | jq -r '.number')"
  role="$(row | jq -r '.role')"

  prep="$("$SCRIPT_DIR/verify-issue-prep.sh" "$issue_number")"
  if [[ "$(jq -r '.ok' <<<"$prep")" != "true" ]]; then
    state="blocked"
    next_action="diagnose"
    entry="$(jq -n --arg role "$role" --argjson prep "$prep" '{role: $role, prep: $prep}')"
    batch_state="$(jq -c --argjson entry "$entry" '. + [$entry]' <<<"$batch_state")"
    continue
  fi

  pr_number="$(jq -r '.prep.pr.number' <<<"$prep")"
  local_state="$("$SCRIPT_DIR/reconcile-local-state.sh" "$issue_number")"
  prep_mode="$(jq -r '.mode // "full"' <<<"$prep")"

  if [[ -n "$pr_number" && "$pr_number" != "null" ]]; then
    pr_status="$("$SCRIPT_DIR/pr-status.sh" "$pr_number")"
    rebase_status="$("$SCRIPT_DIR/needs-rebase.sh" "$pr_number")"
    merge_status="$("$SCRIPT_DIR/merge-ready.sh" "$pr_number")"
  else
    pr_status='null'
    rebase_status="$("$SCRIPT_DIR/needs-rebase.sh" "$(jq -r '.prep.branch' <<<"$prep")")"
    merge_status='null'
  fi

  issue_action="develop"
  if [[ "$(jq -r '.state' <<<"$local_state")" != "clean" ]]; then
    issue_action="$(jq -r '.next_action' <<<"$local_state")"
    state="local_state_needs_attention"
  elif [[ "$(jq -r '.ready // false' <<<"$merge_status")" == "true" ]]; then
    issue_action="merge"
  elif [[ "$(jq -r '.needs_rebase' <<<"$rebase_status")" == "true" ]]; then
    issue_action="rebase"
  elif [[ "$prep_mode" == "local-bootstrap" ]]; then
    issue_action="develop"
    state="bootstrap_local_only"
  fi

  entry="$(jq -n \
    --arg role "$role" \
    --arg next_action "$issue_action" \
    --argjson prep "$prep" \
    --argjson pr "$pr_status" \
    --argjson local "$local_state" \
    --argjson rebase "$rebase_status" \
    --argjson merge "$merge_status" \
    '{
      role: $role,
      next_action: $next_action,
      prep: $prep,
      pr: $pr,
      local: $local,
      rebase: $rebase,
      merge: $merge
    }')"
  batch_state="$(jq -c --argjson entry "$entry" '. + [$entry]' <<<"$batch_state")"
done < <(jq -r '.[] | @base64' <<<"$batch")

jq -n \
  --arg state "$state" \
  --arg next_action "$next_action" \
  --argjson cleanup "$cleanup" \
  --argjson selection "$selection" \
  --argjson batch "$batch_state" \
  '{
    state: $state,
    next_action: $next_action,
    cleanup: $cleanup,
    selection: $selection,
    batch: $batch
  }'
