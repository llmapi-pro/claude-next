#!/usr/bin/env bash
# List all pending handoffs with one-line summary each.
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
  [ -z "$verdict" ] && verdict="(none)"

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
  echo "用法: 在老窗口运行 /next 产出一份交接稿。"
  exit 0
fi

echo "Pending handoffs ($count):"
echo ""
for l in "${lines[@]}"; do echo "$l"; done
echo ""
echo "续接:  在新窗口首条消息输入  继续 A    （或 next A）"
echo "移除:  在新窗口首条消息输入  移除 A    （或 drop A）"
