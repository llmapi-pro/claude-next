#!/usr/bin/env bash
# UserPromptSubmit hook. Reads JSON from stdin.
# If prompt matches `继续 <SLOT>` or `next <SLOT>` → load handoff + run Pass B, inject.
# If prompt matches `移除 <SLOT>` or `drop <SLOT>` → delete handoff, inject confirmation.
# Otherwise → silent passthrough (exit 0, no output).
#
# CRITICAL: this script MUST never break a normal CC session. Any error → silent exit 0.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

{
  # NEXT_DEBUG=1 → trace every command + arg + exit to ~/.claude/next/ingest.debug.log.
  # Documented in CHANGELOG 0.2.5 but never wired up until 0.2.7. Off by default;
  # zero overhead when unset. Goes to fd 3 instead of stderr so the outer
  # `} 2>/dev/null` swallow doesn't lose the trace.
  if [ "${NEXT_DEBUG:-0}" = "1" ]; then
    mkdir -p "$HOME/.claude/next" 2>/dev/null || true
    exec 3>>"$HOME/.claude/next/ingest.debug.log"
    BASH_XTRACEFD=3
    PS4='+ [$(date -u +%H:%M:%S)] '
    set -x
  fi

  . "$SCRIPT_DIR/common.sh" 2>/dev/null || exit 0

  input="$(cat)"
  [ -z "$input" ] && exit 0

  prompt="$(printf '%s' "$input" | json_get prompt)"
  [ -z "$prompt" ] && exit 0

  # Strip leading whitespace for matching
  trimmed="$(printf '%s' "$prompt" | sed -E 's/^[[:space:]]+//')"

  action=""
  slot=""

  if [[ "${trimmed}" =~ ^(继续|[Nn][Ee][Xx][Tt])[[:space:]]+([A-Za-z]+) ]]; then
    action="continue"
    slot="$(printf '%s' "${BASH_REMATCH[2]}" | tr '[:lower:]' '[:upper:]')"
  elif [[ "${trimmed}" =~ ^(移除|[Dd][Rr][Oo][Pp])[[:space:]]+([A-Za-z]+) ]]; then
    action="remove"
    slot="$(printf '%s' "${BASH_REMATCH[2]}" | tr '[:lower:]' '[:upper:]')"
  else
    exit 0
  fi

  f="$(slot_file "${slot}")"
  if [ ! -f "$f" ]; then
    ctx="[next skill] 口令 '${trimmed}' 对应的 handoff 槽位 ${slot} 不存在（可能已消费或未曾产出）。
若要看所有可用槽位，请告诉用户运行  /next list"
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
    ctx="[next skill] 用户要求移除 handoff ${slot}（任务: ${task:-未标注}）。该 handoff 已删除。
请简短确认: \"已移除 ${slot}\"。不要加载任何交接内容，也不要假设用户想续接——他明确说了移除。"
    printf '%s' "$ctx" | json_emit_context
    exit 0
  fi

  # action=continue: run Pass B (appends to file + prints), then inject whole handoff.
  # When NEXT_DEBUG=1, tee validity.sh's stderr to the same debug log so future
  # validity.sh regressions (the source had three unbraced-$var-before-CJK bugs
  # fixed in 0.2.7) surface immediately instead of vanishing into 2>&1.
  if [ "${NEXT_DEBUG:-0}" = "1" ]; then
    "$SCRIPT_DIR/validity.sh" "${slot}" >>"$HOME/.claude/next/ingest.debug.log" 2>&1 || true
  else
    "$SCRIPT_DIR/validity.sh" "${slot}" >/dev/null 2>&1 || true
  fi

  body="$(cat "$f")"

  # Consume: delete handoff
  rm -f "$f"

  ctx="[next skill] 用户已粘贴口令续接 handoff ${slot}。
以下是完整交接稿（已包含 Pass A 审稿和刚跑完的 Pass B drift 检查）。
源文件已消费并删除。

你的职责：
1. 简短告诉用户你已接手此任务（引用 Task summary 里那句话）
2. 清晰列出 Next step + Uncertainty 3 条
3. 如 Pass B 有 ⚠️ 警告，务必提示用户确认后再动手
4. 等待用户指令再继续

=== HANDOFF BEGIN ===
${body}
=== HANDOFF END ==="

  printf '%s' "$ctx" | json_emit_context
  exit 0

} 2>/dev/null || exit 0
