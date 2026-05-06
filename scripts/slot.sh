#!/usr/bin/env bash
# Allocate next free slot (A..Z, then AA..ZZ). Print allocated slot to stdout.
# After allocation, scan pending pool for handoffs >NEXT_STALE_HOURS old
# (default 72h) and emit a stderr nudge so the user notices stockpile
# accumulation before slot space gets crowded. The slot stdout protocol is
# unaffected — SKILL.md only reads stdout.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/common.sh"

used="$(slots_used)"
is_used() { grep -qx "$1" <<<"$used"; }

allocated=""
for L in A B C D E F G H I J K L M N O P Q R S T U V W X Y Z; do
  if ! is_used "$L"; then allocated="$L"; break; fi
done

if [ -z "$allocated" ]; then
  for L1 in A B C D E F G H I J K L M N O P Q R S T U V W X Y Z; do
    for L2 in A B C D E F G H I J K L M N O P Q R S T U V W X Y Z; do
      if ! is_used "$L1$L2"; then allocated="$L1$L2"; break 2; fi
    done
  done
fi

if [ -z "$allocated" ]; then
  echo "ERROR: slot space exhausted (>702 pending handoffs)." >&2
  echo "       Run  /next list  (sorted oldest-first) and  /next remove <SLOT>  to clear." >&2
  exit 1
fi

echo "$allocated"

# --- stderr-only stale-pending nudge ---
# Doesn't affect SKILL.md (reads stdout only). Skipped silently if anything
# fails — never break the allocation.
{
  stale_threshold="${NEXT_STALE_HOURS:-72}"
  stale=()
  while IFS= read -r s; do
    [ -z "$s" ] && continue
    [ "$s" = "$allocated" ] && continue
    f="$(slot_file "$s")"
    [ -f "$f" ] || continue
    created="$(frontmatter_get "$f" created_at)"
    hrs="$(age_hours "$created")"
    if [ "${hrs:-0}" -ge "$stale_threshold" ] 2>/dev/null; then
      stale+=("${s}(${hrs}h)")
    fi
  done <<<"$used"

  if [ ${#stale[@]} -gt 0 ]; then
    printf '⚠️  %d pending handoff(s) older than %dh still in pool: %s\n' \
      "${#stale[@]}" "$stale_threshold" "$(IFS=,; echo "${stale[*]}")" >&2
    echo "    Use  /next list  to review,  /next remove <SLOT>  to clear." >&2
  fi
} || true

exit 0
