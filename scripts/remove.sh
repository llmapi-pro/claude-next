#!/usr/bin/env bash
# Remove a pending handoff by slot. Usage: remove.sh A
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/common.sh"

slot="${1:-}"
if [ -z "$slot" ]; then
  echo "ERROR: slot required. Usage: remove.sh A" >&2
  exit 1
fi

# Normalize
slot="$(echo "$slot" | tr '[:lower:]' '[:upper:]' | tr -dc 'A-Z')"
if [ -z "$slot" ]; then
  echo "ERROR: invalid slot" >&2
  exit 1
fi

f="$(slot_file "$slot")"
if [ ! -f "$f" ]; then
  echo "No handoff at slot $slot."
  exit 0
fi

task="$(awk '
  /^# Task summary/ {flag=1; next}
  /^# / && flag {exit}
  flag && NF && !/^</ {print; exit}
' "$f")"

archive_or_rm "$f" "$slot"
echo "Removed handoff $slot: ${task:-(unlabeled)}"
