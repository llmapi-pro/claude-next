#!/usr/bin/env bash
# Pass B drift check: verify handoff claims still match current state.
# Usage: validity.sh <slot>
# Appends "## Audit — Pass B (read-time)" to the handoff file and prints same.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/common.sh"

slot="${1:-}"
if [ -z "$slot" ]; then
  echo "ERROR: slot required" >&2
  exit 1
fi

f="$(slot_file "$slot")"
if [ ! -f "$f" ]; then
  echo "ERROR: no handoff at slot $slot" >&2
  exit 1
fi

project_root="$(frontmatter_get "$f" project_root)"
git_head="$(frontmatter_get "$f" git_head)"
git_branch="$(frontmatter_get "$f" git_branch)"
created_at="$(frontmatter_get "$f" created_at)"
cwd="$PWD"

warnings=()
oks=()

# 1. Project root scope
if [ -n "$project_root" ] && [ -d "$project_root" ]; then
  if [ "$cwd" = "$project_root" ] || [[ "$cwd" == "$project_root"/* ]]; then
    oks+=("cwd 在 project_root 子树下 ($project_root)")
  else
    warnings+=("⚠️ cwd=$cwd 不在 handoff 的 project_root=$project_root 子树下——确认是否在正确目录？")
  fi
elif [ -n "$project_root" ]; then
  warnings+=("⚠️ project_root=$project_root 当前不存在")
fi

# 2. Git HEAD drift
if [ -n "$git_head" ] && [ "$git_head" != "(not-a-repo)" ] && [ -n "$project_root" ] && [ -d "$project_root/.git" ]; then
  cur_head="$(git -C "$project_root" rev-parse HEAD 2>/dev/null || echo "")"
  if [ -n "$cur_head" ]; then
    short_old="${git_head:0:10}"
    short_cur="${cur_head:0:10}"
    if [ "$git_head" = "$cur_head" ]; then
      oks+=("git HEAD 未变 ($short_cur)")
    else
      if git -C "$project_root" merge-base --is-ancestor "$git_head" "$cur_head" 2>/dev/null; then
        warnings+=("ℹ️ git HEAD 已前进 $short_old → $short_cur（老 commit 仍在祖先链；注意新改动）")
      else
        warnings+=("⚠️ git HEAD 变化且非快进 $short_old → $short_cur（rebase/reset？handoff 可能失配）")
      fi
    fi

    cur_branch="$(git -C "$project_root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
    if [ -n "$git_branch" ] && [ "$git_branch" != "(not-a-repo)" ] && [ -n "$cur_branch" ] && [ "$git_branch" != "$cur_branch" ]; then
      warnings+=("⚠️ branch 变化：handoff=$git_branch，当前=$cur_branch")
    fi
  fi
fi

# 3. Age warning
hrs="$(age_hours "$created_at")"
if [ "${hrs:-0}" -ge 24 ]; then
  warnings+=("ℹ️ handoff 已 ${hrs}h 未消费（>24h），警惕内容过时")
fi

# Build Pass B section
tmp="$(mktemp -t next-passB.XXXXXX 2>/dev/null || echo "/tmp/next-passB.$$.txt")"
{
  echo ""
  echo "## Audit — Pass B (read-time)"
  echo ""
  echo "_Checked at: $(now_iso) from cwd: ${cwd}_"
  echo ""
  if [ ${#oks[@]} -gt 0 ]; then
    for o in "${oks[@]}"; do echo "- ✅ $o"; done
  fi
  if [ ${#warnings[@]} -gt 0 ]; then
    for w in "${warnings[@]}"; do echo "- $w"; done
  else
    echo "- ✅ No drift detected."
  fi
} > "$tmp"

cat "$tmp" >> "$f"
cat "$tmp"
rm -f "$tmp"
