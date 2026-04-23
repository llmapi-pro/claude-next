#!/usr/bin/env bash
# Allocate next free slot (A..Z, then AA..ZZ). Print to stdout.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/common.sh"

used="$(slots_used)"
is_used() { grep -qx "$1" <<<"$used"; }

for L in A B C D E F G H I J K L M N O P Q R S T U V W X Y Z; do
  if ! is_used "$L"; then echo "$L"; exit 0; fi
done

# Fallback: double letters
for L1 in A B C D E F G H I J K L M N O P Q R S T U V W X Y Z; do
  for L2 in A B C D E F G H I J K L M N O P Q R S T U V W X Y Z; do
    if ! is_used "$L1$L2"; then echo "$L1$L2"; exit 0; fi
  done
done

echo "ERROR: slot space exhausted (>676 pending handoffs). Clean up with /next list + 移除." >&2
exit 1
