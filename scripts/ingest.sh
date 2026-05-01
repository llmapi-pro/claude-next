#!/usr/bin/env bash
# UserPromptSubmit hook. Reads JSON from stdin.
#
# Pass-phrases (must appear at the START of the prompt):
#   continue <SLOT> | next <SLOT> | 继续 <SLOT>   → load handoff + Pass B drift check + inject
#   drop <SLOT>     | 移除 <SLOT>                 → delete handoff, inject confirmation
#
# Otherwise → silent passthrough (exit 0, no output).
#
# CRITICAL: this script MUST never break a normal CC session. Any error → silent exit 0.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

{
  . "$SCRIPT_DIR/common.sh" 2>/dev/null || exit 0

  input="$(cat)"
  [ -z "$input" ] && exit 0

  prompt="$(printf '%s' "$input" | json_get prompt)"
  [ -z "$prompt" ] && exit 0

  # Strip leading whitespace for matching
  trimmed="$(printf '%s' "$prompt" | sed -E 's/^[[:space:]]+//')"

  action=""
  slot=""

  # Slot is 1-3 ASCII letters. The trailing boundary check ($|space|punct) is
  # the critical fix for false positives like `next step is to fix the auth bug`
  # → would have been parsed as slot=STEP. Also adds the documented `continue`
  # alias which the v0.1 README/CHANGELOG/CLI help promised but never wired.
  if [[ "$trimmed" =~ ^(继续|[Nn][Ee][Xx][Tt]|[Cc][Oo][Nn][Tt][Ii][Nn][Uu][Ee])[[:space:]]+([A-Za-z]{1,3})($|[[:space:],.;:!?]) ]]; then
    action="continue"
    slot="$(printf '%s' "${BASH_REMATCH[2]}" | tr '[:lower:]' '[:upper:]')"
  elif [[ "$trimmed" =~ ^(移除|[Dd][Rr][Oo][Pp])[[:space:]]+([A-Za-z]{1,3})($|[[:space:],.;:!?]) ]]; then
    action="remove"
    slot="$(printf '%s' "${BASH_REMATCH[2]}" | tr '[:lower:]' '[:upper:]')"
  else
    exit 0
  fi

  f="$(slot_file "$slot")"
  if [ ! -f "$f" ]; then
    # Don't echo the entire prompt back (could be long / contain secrets).
    ctx="[next skill] handoff slot $slot does not exist (already consumed, or never produced).
Tell the user to run  /next list  to see available slots."
    printf '%s' "$ctx" | json_emit_context
    exit 0
  fi

  if [ "$action" = "remove" ]; then
    task="$(awk '
      /^# Task summary/ {flag=1; next}
      /^# / && flag {exit}
      flag && NF && !/^</ {print; exit}
    ' "$f")"
    rm -f "$f"
    ctx="[next skill] User asked to remove handoff $slot (task: ${task:-unlabeled}). The handoff has been deleted.
Please briefly confirm: \"removed $slot\". Do not load any handoff content and do not assume the user wants to continue — they explicitly said remove."
    printf '%s' "$ctx" | json_emit_context
    exit 0
  fi

  # action=continue: gate on audit_status before consuming.
  audit_status="$(frontmatter_get "$f" audit_status)"
  audit_status="${audit_status:-pending}"

  case "$audit_status" in
    passed)
      audit_note="✅ audit verdict: passed (all claims verified, ≥3 uncertainties)."
      ;;
    warnings)
      audit_note="⚠️ audit verdict: warnings (1-2 minor discrepancies; usable but cross-check the Pass A section)."
      ;;
    failed)
      audit_note="❌ audit verdict: FAILED — Pass A flagged verified-fictitious claims. Strongly suggest the user reject this handoff or manually correct it before acting."
      ;;
    aborted)
      audit_note="⚠️ audit verdict: ABORTED — the audit subagent did not complete (likely killed mid-write). Treat every claim as unverified; cross-check Pass B drift and the Changed-state section against reality before acting."
      ;;
    in_progress|writing)
      audit_note="❌ audit_status='$audit_status' — audit was started but never finished. **Do not trust any claim**. Suggest the user rerun audit by deleting and re-doing /next, or manually verify each Changed-state line."
      ;;
    pending|"")
      audit_note="❌ audit_status='pending' — handoff was written but audit step was SKIPPED entirely (the producing window likely crashed or was closed at step 4). All claims are unverified. Tell the user explicitly that this handoff did not pass the quality gate."
      ;;
    *)
      audit_note="⚠️ audit_status='$audit_status' (unknown value) — treat as unaudited."
      ;;
  esac

  # Run Pass B drift check (appends to file + prints). Best effort.
  "$SCRIPT_DIR/validity.sh" "$slot" >/dev/null 2>&1 || true

  body="$(cat "$f")"

  # Consume: delete handoff (audit gating is informational; we still consume so
  # /next list stays clean. The audit_note tells the user/LLM what to trust.)
  rm -f "$f"

  ctx="[next skill] User pasted pass-phrase to continue handoff $slot.
Below is the full handoff (with Pass A audit and Pass B drift check, if available).
Source file has been consumed and deleted.

$audit_note

Your job:
1. Briefly tell the user you have picked up this task (quote the Task summary line).
2. Clearly list Next step + the 3 Uncertainty items.
3. If Pass B has ⚠️ warnings, surface them and ask user to confirm before acting.
4. If the audit note above is ❌ or ⚠️ ABORTED/SKIPPED, lead with that warning before doing anything else.
5. Wait for user direction before continuing.

=== HANDOFF BEGIN ===
$body
=== HANDOFF END ==="

  printf '%s' "$ctx" | json_emit_context
  exit 0

} 2>/dev/null || exit 0
