#!/usr/bin/env bash
# List all pending handoffs, sorted oldest-first so stale handoffs surface
# at the top. Lines for handoffs >NEXT_STALE_HOURS old (default 72h, matches
# slot.sh nudge threshold) get a ⚠️ marker; >24h get an ℹ️ marker.
#
# Detects "stale audits" — frontmatter claims passed/warnings/failed but the
# file body has no `## Audit — Pass A` section (LLM updated frontmatter
# without actually appending the audit section).
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/common.sh"

stale_threshold="${NEXT_STALE_HOURS:-72}"

# Build records as TAB-separated tuples we can sort by age:
#   <hours_padded>\t<slot>\t<task>\t<project>\t<age_relative>\t<verdict>
# Padded to 6 digits so lexicographic sort matches numeric.
records=()
while read -r slot; do
  [ -z "$slot" ] && continue
  f="$(slot_file "$slot")"
  [ -f "$f" ] || continue

  created="$(frontmatter_get "$f" created_at)"
  project="$(frontmatter_get "$f" project_root)"
  verdict="$(frontmatter_get "$f" audit_status)"
  [ -z "$verdict" ] && verdict="pending"

  case "$verdict" in
    passed|warnings|failed)
      if ! grep -q '^## Audit — Pass A' "$f" 2>/dev/null; then
        verdict="${verdict} (stale: no Pass A section in body)"
      fi
      ;;
  esac

  task="$(awk '
    /^# Task summary/ {flag=1; next}
    /^# / && flag {exit}
    flag && NF && !/^</ {print; exit}
  ' "$f")"
  [ -z "$task" ] && task="(no summary)"

  age_rel="$(relative_age "$created")"
  age_hr="$(age_hours "$created")"
  age_hr="${age_hr:-0}"
  printf -v key '%06d' "$age_hr"

  # Field separator: control char \x1f (unit separator) — won't appear in
  # any real slot/task/project string.
  records+=("${key}"$'\x1f'"${slot}"$'\x1f'"${task}"$'\x1f'"${project}"$'\x1f'"${age_rel}"$'\x1f'"${verdict}"$'\x1f'"${age_hr}")
done < <(slots_used)

count=${#records[@]}
if [ "$count" -eq 0 ]; then
  echo "No pending handoffs."
  echo ""
  echo "Usage: run /next in an old window to produce a handoff."
  exit 0
fi

echo "Pending handoffs ($count, oldest first):"
echo ""

# Sort descending by age key (oldest = largest age = top)
printf '%s\n' "${records[@]}" | sort -r | while IFS=$'\x1f' read -r _key slot task project age_rel verdict age_hr; do
  marker="  "
  if [ "${age_hr:-0}" -ge "$stale_threshold" ] 2>/dev/null; then
    marker="⚠️"
  elif [ "${age_hr:-0}" -ge 24 ] 2>/dev/null; then
    marker="ℹ️"
  fi
  printf '%s %s  %s\n'        "$marker" "$slot" "$task"
  printf '       project: %s  ·  %s  ·  audit: %s\n' "$project" "$age_rel" "$verdict"
done

echo ""
echo "Continue:  in a new window, paste as first message:  continue A   (or  next A  /  继续 A)"
echo "Remove:    in a new window, paste as first message:  drop A       (or  移除 A)"
