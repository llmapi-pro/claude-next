#!/usr/bin/env bash
# List all pending handoffs with one-line summary each.
# Detects "stale" audits — frontmatter claims passed/warnings/failed but the
# file body has no `## Audit — Pass A` section (LLM updated frontmatter without
# actually appending the audit section).
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/common.sh"

count=0
lines=()
while read -r slot; do
  [ -z "$slot" ] && continue
  f="$(slot_file "$slot")"
  [ -f "$f" ] || continue
  count=$((count+1))

  created="$(frontmatter_get "$f" created_at)"
  project="$(frontmatter_get "$f" project_root)"
  verdict="$(frontmatter_get "$f" audit_status)"
  [ -z "$verdict" ] && verdict="pending"

  # Cross-check: if frontmatter claims audited but file has no Pass A section,
  # downgrade display to "stale" so the user can spot it.
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

  age="$(relative_age "$created")"

  lines+=("  $slot  $task")
  lines+=("       project: $project  ·  $age  ·  audit: $verdict")
done < <(slots_used)

if [ "$count" -eq 0 ]; then
  echo "No pending handoffs."
  echo ""
  echo "Usage: run /next in an old window to produce a handoff."
  exit 0
fi

echo "Pending handoffs ($count):"
echo ""
for l in "${lines[@]}"; do echo "$l"; done
echo ""
echo "Continue:  in a new window, paste as first message:  continue A   (or  next A  /  继续 A)"
echo "Remove:    in a new window, paste as first message:  drop A       (or  移除 A)"
