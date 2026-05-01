#!/usr/bin/env bash
# audit-finalize.sh — finalize a handoff's audit_status atomically.
#
# Usage:
#   bash audit-finalize.sh <SLOT> <PASS_A_FILE>
#   bash audit-finalize.sh <SLOT> --aborted
#
# What it does:
#   1. Reads the Pass A markdown (subagent output) from PASS_A_FILE.
#   2. Appends it to ~/.claude/next/pending/<SLOT>.md.
#   3. Extracts the verdict line (`- passed | warnings | failed`) from Pass A
#      and rewrites the frontmatter `audit_status:` field.
#   4. Cleans up PASS_A_FILE.
#
# If invoked with --aborted instead of a Pass A file, just sets audit_status to
# `aborted` (used when the audit subagent times out or crashes).
#
# This is the script that LIBERATES the producing LLM from having to reliably
# do "cat >> file && sed -i frontmatter && output report" three times in a row
# in a 400K-token-deep context window. The shell script does the file mutation;
# the LLM only has to call this once and read the resulting verdict.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/common.sh"

slot="${1:-}"
src="${2:-}"

if [ -z "$slot" ] || [ -z "$src" ]; then
  echo "ERROR: usage: audit-finalize.sh <SLOT> <PASS_A_FILE | --aborted>" >&2
  exit 1
fi

slot="$(echo "$slot" | tr '[:lower:]' '[:upper:]' | tr -dc 'A-Z')"
f="$(slot_file "$slot")"

if [ ! -f "$f" ]; then
  echo "ERROR: no handoff at slot $slot ($f)" >&2
  exit 1
fi

if [ "$src" = "--aborted" ]; then
  verdict="aborted"
  pass_a_block=""
else
  if [ ! -f "$src" ]; then
    echo "ERROR: Pass A source file not found: $src" >&2
    exit 1
  fi
  pass_a_block="$(cat "$src")"

  # Extract verdict. Prefer the line under `### Verdict`, fall back to the
  # first verdict word anywhere in the file. Implementation uses POSIX awk
  # (no gawk-only `match($0, re, arr)` array form — that fails silently with
  # noisy stderr on macOS BSD awk) and grep -E for the fallback.
  verdict="$(awk '
    /^### Verdict/ { in_verdict=1; next }
    /^### / && in_verdict { exit }
    in_verdict && /(passed|warnings|failed)/ {
      line = $0
      gsub(/[^a-z]+/, " ", line)
      n = split(line, parts, " ")
      for (i = 1; i <= n; i++) {
        if (parts[i] == "passed" || parts[i] == "warnings" || parts[i] == "failed") {
          print parts[i]; exit
        }
      }
    }
  ' "$src" 2>/dev/null)"
  if [ -z "$verdict" ]; then
    verdict="$(grep -oE '\b(passed|warnings|failed)\b' "$src" 2>/dev/null | head -1)"
  fi
  if [ -z "$verdict" ]; then
    verdict="failed"  # Audit didn't produce a recognizable verdict → conservative
  fi
fi

# Atomic update: write to a tempfile in the SAME directory as the target,
# then mv. Same-fs is required for mv to be atomic on POSIX. The previous
# `mktemp -t` form put the tempfile in /tmp, which is a different filesystem
# from ~/.claude/next/pending on most Linux installs (tmpfs vs the home fs)
# — that made the mv a copy+unlink, briefly leaving the file half-written.
tgt_dir="$(dirname "$f")"
tmp="$(mktemp "$tgt_dir/.next-final.XXXXXX" 2>/dev/null || echo "$tgt_dir/.next-final.$$.md")"

# 1. Rewrite frontmatter audit_status line (and only that line).
awk -v v="$verdict" '
  BEGIN { fm=0; found=0 }
  NR==1 && /^---$/ { fm=1; print; next }
  fm && /^---$/ {
    if (!found) print "audit_status: " v
    fm=0
    print
    next
  }
  fm && /^audit_status:/ { print "audit_status: " v; found=1; next }
  { print }
' "$f" > "$tmp"

# 2. If we have a Pass A block to append, do so unless it's already there.
if [ -n "$pass_a_block" ]; then
  if ! grep -q '^## Audit — Pass A' "$tmp" 2>/dev/null; then
    printf '\n%s\n' "$pass_a_block" >> "$tmp"
  fi
fi

mv "$tmp" "$f"

# 3. Clean up source.
[ "$src" != "--aborted" ] && rm -f "$src"

echo "$verdict"
