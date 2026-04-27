#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$name" >&2
    exit 127
  fi
}

require_cmd gh
require_cmd jq
require_cmd awk
require_cmd grep
require_cmd git
require_cmd sed
require_cmd python3

canonical_repo() {
  gh repo view --json nameWithOwner -q .nameWithOwner
}

repo_root() {
  dirname "$(git rev-parse --path-format=absolute --git-common-dir)"
}

tasks_repo() {
  local base candidate
  base="$(canonical_repo)"
  candidate="$(gh repo view --json nameWithOwner -q '(.owner.login) + "/" + (.name) + "-tasks"')"

  if gh repo view "$candidate" >/dev/null 2>&1; then
    printf '%s\n' "$candidate"
  else
    printf '%s\n' "$base"
  fi
}

extract_issue_refs() {
  grep -oE '#[0-9]+' | tr -d '#' | awk '!seen[$0]++'
}

extract_closing_issue_number() {
  awk 'BEGIN{IGNORECASE=1} /^(Closes|Fixes|Resolves) #[0-9]+/ {print; exit}' \
    | grep -oE '[0-9]+' \
    | head -n1
}

section_body() {
  local section="$1"
  awk -v section="$section" '
    /^## / {
      if (in_section) {
        exit
      }
      in_section = ($0 == "## " section)
      next
    }
    in_section {
      print
    }
  '
}

count_checkboxes() {
  local pattern="$1"
  grep -cE "$pattern" || true
}

section_first_line() {
  local body="$1"
  local section="$2"
  printf '%s\n' "$body" \
    | section_body "$section" \
    | sed -n '/[^[:space:]]/ { s/^[[:space:]]*//; s/[[:space:]]*$//; p; q; }'
}

issue_kind_from_body() {
  local body="$1"
  section_first_line "$body" "Issue type"
}

issue_phase_from_body() {
  local body="$1"
  section_first_line "$body" "Phase"
}

plan_phases_json_from_body() {
  local body="$1"
  PLAN_BODY="$body" python3 - <<'PY'
import json
import os
import re

body = os.environ["PLAN_BODY"]
phases = []
current = None

for raw_line in body.splitlines():
    line = raw_line.rstrip()
    if line.startswith("## Phase: "):
        if current is not None:
            phases.append(current)
        current = {
            "name": line[len("## Phase: "):].strip(),
            "depends_on": [],
            "issue_numbers": [],
            "scout_issue_number": None,
        }
        continue
    if current is None:
        continue
    if line.startswith("Depends on phases: "):
        value = line.split(": ", 1)[1].strip()
        if value and value != "None.":
            current["depends_on"] = [part.strip() for part in value.split(",") if part.strip()]
        continue
    if line.startswith("Scout gate: #"):
        match = re.search(r"#(\d+)", line)
        if match:
            current["scout_issue_number"] = int(match.group(1))
        continue
    match = re.match(r"^- #(\d+) - ", line)
    if match:
        current["issue_numbers"].append(int(match.group(1)))

if current is not None:
    phases.append(current)

print(json.dumps(phases))
PY
}

plan_entries_json_from_body() {
  local body="$1"
  PLAN_BODY="$body" python3 - <<'PY'
import json
import os
import re

body = os.environ["PLAN_BODY"]
entries = []
current_phase = None
current_depends_on = []
current_scout = None
last_entry = None

for raw_line in body.splitlines():
    line = raw_line.rstrip()
    if line.startswith("## Phase: "):
        current_phase = line[len("## Phase: "):].strip()
        current_depends_on = []
        current_scout = None
        last_entry = None
        continue
    if line.startswith("Depends on phases: "):
        value = line.split(": ", 1)[1].strip()
        current_depends_on = [] if not value or value == "None." else [part.strip() for part in value.split(",") if part.strip()]
        continue
    if line.startswith("Scout gate: #"):
        match = re.search(r"#(\d+)", line)
        current_scout = int(match.group(1)) if match else None
        continue

    match = re.match(r"^- #(\d+) - (.*?)(?: \[risk: (\d+)\])?(?: ⊜)?$", line)
    if match:
        number = int(match.group(1))
        title = match.group(2)
        risk = int(match.group(3)) if match.group(3) else None
        entry = {
            "number": number,
            "title": title,
            "risk": risk,
            "phase": current_phase,
            "phase_depends_on": list(current_depends_on),
            "phase_scout_issue_number": current_scout,
            "kind": "dev-scout" if current_scout == number else None,
            "dependencies": [],
            "parallel_safe": None,
        }
        entries.append(entry)
        last_entry = entry
        continue

    match = re.match(r"^\s*<!-- superfield: (.+) -->\s*$", line)
    if match and last_entry is not None:
        try:
            metadata = json.loads(match.group(1))
        except json.JSONDecodeError:
            continue
        if isinstance(metadata, dict):
            last_entry.update(metadata)

print(json.dumps(entries))
PY
}

plan_issue_numbers_from_body() {
  local body="$1"
  plan_entries_json_from_body "$body" | jq -r '.[].number'
}

phase_dependency_blockers_json() {
  local phases_json="$1"
  local issue_number="$2"
  local issue_body="$3"
  local issue_kind issue_phase blockers dep_phase dep_issue dep_state

  issue_kind="$(issue_kind_from_body "$issue_body")"
  issue_phase="$(issue_phase_from_body "$issue_body")"
  if [[ "$issue_kind" != "dev-scout" || -z "$issue_phase" || "$issue_phase" == "Unassigned." || "$phases_json" == "[]" ]]; then
    printf '[]\n'
    return 0
  fi

  blockers='[]'
  while IFS= read -r dep_phase; do
    [[ -n "$dep_phase" ]] || continue
    while IFS= read -r dep_issue; do
      [[ -n "$dep_issue" ]] || continue
      [[ "$dep_issue" == "$issue_number" ]] && continue
      dep_state="$(gh issue view "$dep_issue" --repo "$(tasks_repo)" --json state -q .state)"
      if [[ "$dep_state" != "CLOSED" ]]; then
        blockers="$(jq -c --argjson num "$dep_issue" '. + [$num] | unique' <<<"$blockers")"
      fi
    done < <(jq -r --arg phase "$dep_phase" '.[] | select(.name == $phase) | .issue_numbers[]?' <<<"$phases_json")
  done < <(jq -r --arg phase "$issue_phase" '.[] | select(.name == $phase) | .depends_on[]?' <<<"$phases_json")

  printf '%s\n' "$blockers"
}

json_file() {
  local path="$1"
  jq -c . "$path"
}

sanitize_slug() {
  tr '[:upper:]' '[:lower:]' \
    | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' \
    | sed -E 's/^[a-z]+:[[:space:]]*//' \
    | sed -E 's/[^a-z0-9]+/-/g' \
    | sed -E 's/^-+|-+$//g' \
    | cut -c1-48
}

issue_branch_name() {
  local issue_number="$1"
  local issue_title="$2"
  local prefix slug

  prefix="$(sed -E 's/^([a-z]+):.*/\1/;t;d' <<<"$issue_title" || true)"
  if [[ -z "$prefix" ]]; then
    prefix="feat"
  fi

  slug="$(printf '%s' "$issue_title" | sanitize_slug)"
  if [[ -z "$slug" ]]; then
    slug="issue"
  fi

  printf '%s/%s-%s\n' "$prefix" "$issue_number" "$slug"
}

issue_worktree_path() {
  local branch_name="$1"
  local repo_name
  repo_name="$(basename "$(repo_root)")"
  printf '/tmp/superfield-worktrees/%s/%s\n' "$repo_name" "${branch_name//\//-}"
}

managed_issue_branch_regex() {
  printf '%s\n' '^[a-z]+/[0-9]+-[a-z0-9-]+$'
}

worktree_root() {
  local repo_name
  repo_name="$(basename "$(repo_root)")"
  printf '/tmp/superfield-worktrees/%s\n' "$repo_name"
}

issue_payload() {
  local issue_number="$1"
  gh issue view "$issue_number" --repo "$(tasks_repo)" --json number,title,body,state,url
}

pr_payload() {
  local pr_number="$1"
  gh pr view "$pr_number" --repo "$(canonical_repo)" \
    --json number,title,body,state,isDraft,mergedAt,url,headRefName,baseRefName
}
