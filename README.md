# claude-next

> **One-key handoff for deep Claude Code sessions.** Pass your work to a fresh window with an **independent audit** — no manual summary pasting, no copy-pasted "here's what I was doing".

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/claude-next.svg)](https://www.npmjs.com/package/claude-next)
[![GitHub stars](https://img.shields.io/github/stars/llmapi-pro/claude-next?style=social)](https://github.com/llmapi-pro/claude-next)

---

## The problem

Claude Code sessions degrade past ~400K tokens. You've seen it:

- Fabricates file paths that never existed
- Skips TODOs it explicitly acknowledged earlier
- Contradicts its own setup decisions from 200 turns ago

The natural fix is **opening a new window**. But the manual workflow is painful:

1. Ask old Claude: "summarize what we were doing, write an opening message for a new window"
2. Copy-paste into new window
3. Ask new Claude: "does this match what's actually in the codebase?"
4. Ask old Claude to verify, loop

Steps 3-4 exist because **old Claude writing its own handoff produces self-congratulatory summaries** — it remembers claiming to push the image, forgets whether it actually did.

`claude-next` automates the loop, and adds an independent fresh-context auditor that checks every claim against the real filesystem before handoff.

---

## What it does

```
 old window                    new window
 ──────────                    ──────────
 /next           →  handoff + audit stored
                                    │
                                    ▼
                        first message: "continue A"
                                    │
           drift-check + inject ◄───┘
                                    │
                                    ▼
                    Claude picks up exactly where you left off
```

- **Old window**: `/next` — produces a structured handoff, spawns a fresh-context subagent to audit every claim against the filesystem, gives you a short pass-phrase (`continue A`).
- **New window**: paste the pass-phrase as the first message. A `UserPromptSubmit` hook intercepts, re-verifies the handoff is still current (git HEAD / cwd / age), and injects it as context. The new Claude starts fully oriented.

---

## v0.2: `claude-next auto` — hands-free rotating loop

If you want Claude Code to just keep **working on a long task by itself**, rotating windows at every checkpoint with no human in the loop, run:

```bash
npx claude-next auto "Implement feature X and its tests until [DONE]"
```

What this does:

1. Spawns Claude Code as a child process in its headless JSON-stdio mode (`--print --input-format stream-json --output-format stream-json`).
2. Feeds the task prompt plus a preamble that teaches the child to emit `[ROTATE]` at natural checkpoints and `[DONE]` when the overall task is complete.
3. Watches for rotation triggers: turn count, per-window cost cap, cumulative cost cap, or an explicit `[ROTATE]` marker.
4. On rotate: sends `/next` to the child, waits for the handoff slot's audit to finish, kills the child, and spawns a fresh one with `继续 <SLOT>` as its first message.
5. Stops when the child emits `[DONE]`, or the total budget is exhausted, or you touch the sentinel file `~/.claude/next/auto.stop` (or hit Ctrl-C).

All windows in a single run share a structured log under `~/.claude/next/auto-sessions/<timestamp>/` (`main.log`, `events.jsonl`, `summary.json`).

```bash
# common flags
npx claude-next auto "<task>" \
  --max-turns-per-window 30 \
  --window-budget-usd 2 \
  --total-budget-usd 20 \
  --max-windows 20

npx claude-next auto --status      # inspect last run
npx claude-next auto --stop        # ask the running loop to stop at next tick
npx claude-next auto --dry-run "task"  # show what would be sent, don't spawn
```

Requires the local `claude` CLI on `PATH`. Override with `--claude-bin` or `CLAUDE_BIN`.

The child runs with `--permission-mode bypassPermissions` by default — only run `auto` in project directories you trust.

You never write a summary yourself. You never ask "does this match reality" — the audit already did.

---

## Install

### Quickest (via npm)

```bash
npx claude-next install
```

### Manual

```bash
git clone https://github.com/llmapi-pro/claude-next ~/.claude/skills/next
bash ~/.claude/skills/next/install.sh
```

The installer is **idempotent**:
- Backs up your existing `~/.claude/settings.json` to `.bak-<timestamp>`
- Adds only the `UserPromptSubmit` hook, preserving every other field
- Self-tests three hook scenarios before declaring success

### Uninstall

```bash
rm -rf ~/.claude/skills/next ~/.claude/next
cp ~/.claude/settings.json.bak-<latest> ~/.claude/settings.json
```

---

## Usage

### Produce a handoff

In the old (long) session:

```
/next
```

Claude will:
1. Identify the current task from the last ~20 turns of your conversation
2. Announce the identification — you have 3 seconds to correct it
3. Allocate a slot (`A`, `B`, ..., `Z`, then `AA`...)
4. Fill a structured handoff (context, progress, changed state, next step, **mandatory ≥3 uncertainties**)
5. Spawn a fresh-context subagent to audit every claim
6. Print a pass-phrase

Example output:
```
━━━━━━━━━━━━━━━━━━━━
  📋 Pass-phrase: continue A
  Task:          Deploy identity-guard v2b to staging
  project:       /root/myproject
  audit:         warnings  (2 ⚠️ wording nits, 0 ❌)
  file:          ~/.claude/next/pending/A.md
━━━━━━━━━━━━━━━━━━━━
```

### Continue in a new window

Open a fresh Claude Code window. **First message:**

```
continue A
```

Or with extra direction:

```
continue A run the smoke test first
```

The hook will:
1. Match the pass-phrase (`continue` / `next` / `继续` all work)
2. Run a drift check — has `git HEAD` moved? Is the cwd inside `project_root`? Is the handoff >24h old?
3. Inject the full handoff (with both audit passes) as additional context
4. Delete the source handoff file (consumed)

Claude opens by summarizing the task, listing the next step and uncertainties, and waits for your go-ahead.

### List / remove

```
/next list           # Show all pending handoffs
/next remove A       # Delete a specific one
```

Or from a new window, as the first message:

```
drop A               # Same as /next remove A
```

---

## Why this instead of memory-bank tools?

`claude-next` is not a memory system. It's a **handoff protocol** with a **quality gate**. The difference matters.

|                              | Memory-bank tools<br>(claude-mem, memory-bank-mcp, ...) | `claude-next` |
|------------------------------|:-:|:-:|
| Captures everything passively | ✅ | ❌ (explicit `/next` only) |
| Auto-injects on new session  | ✅ | ❌ (pass-phrase required) |
| **Independent audit before handoff** | ❌ | ✅ fresh-context subagent |
| **Drift check before ingest** | ❌ | ✅ git/cwd/age verified |
| **Forces uncertainty declaration** | ❌ | ✅ ≥3 real items, rejected otherwise |
| Zero ambient impact on unrelated windows | ⚠️ | ✅ no `SessionStart` hook |

If you want general-purpose memory capture, **use [claude-mem](https://github.com/thedotmack/claude-mem)**. If you want deliberate handoff with built-in skepticism about what the source session claims, use `claude-next`. The two can coexist — `claude-next` touches only `UserPromptSubmit` and only fires when you explicitly paste a pass-phrase.

---

## How the audit works

The auditor runs in a **subagent with fresh context** — it has not seen the conversation that produced the handoff. It only has:

1. The handoff file
2. Read-only access to the project directory
3. A strict rubric (see `templates/audit.rubric.md`)

For every claim — "I pushed image X", "commit `abc123` contains the fix", "file `src/y.ts` modified" — the auditor runs the corresponding real check (`docker image inspect`, `git cat-file -e`, `ls`). Results are appended to the handoff as `## Audit — Pass A (write-time)` with verdicts:

- `passed` — all claims verified, ≥3 uncertainties
- `warnings` — 1-2 ⚠️ minor discrepancies, worth noting
- `failed` — ❌ verified fiction, or <3 uncertainties (you get to rewrite)

Because the auditor is fresh, it catches exactly the class of error that long-context self-summarization produces: the claim "I deployed it" when the deploy actually failed and was forgotten 50 turns ago.

---

## Compatibility

- **Claude Code** on macOS, Linux, or Windows (Git-bash)
- **Requires**: `bash`, `perl` (core modules only — `JSON::PP`, `Time::Local` — both ship with Perl 5.14+)
- **Optional**: `git` and `docker` for richer drift/audit checks
- **Does not require**: Python, `jq`, Node (except for the `npx` installer), or any external LLM API

---

## Pass-phrase syntax

Match is at the **start** of your first message in a new window:

| Action | English | Chinese |
|---|---|---|
| Load handoff | `continue A` or `next A` | `继续 A` |
| Delete handoff | `drop A` | `移除 A` |

Slot is case-insensitive in the pass-phrase but stored uppercase. You can add any text after the slot (`continue A run tests first`) — Claude sees both.

---

## Configuration

Defaults are sensible, override via env vars if needed:

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_HOME` | `~/.claude/next` | Runtime state directory |
| `NEXT_PENDING_DIR` | `$NEXT_HOME/pending` | Where handoffs live |
| `NEXT_MIN_UNK` | `3` | Minimum uncertainty items |

---

## Roadmap

- [ ] Optional consumed-handoff archive (`NEXT_ARCHIVE=1`)
- [ ] MCP server wrapper (for Cursor, Cline, other MCP-compatible clients)
- [ ] Auto-trigger at configurable token thresholds
- [ ] PowerShell fallback for pure-Windows environments (no Git-bash)
- [ ] Per-project handoff directories (isolate monorepo sub-projects)
- [ ] Handoff signing for team use (cryptographically attest audit verdict)

Vote / propose in [Issues](https://github.com/llmapi-pro/claude-next/issues).

---

## Contributing

Small project, welcoming contributions. Start here:

1. Read `SKILL.md` — source of truth for what `/next` does
2. Read `templates/audit.rubric.md` — most improvements live here
3. Clone, `bash install.sh`, dogfood a day, open a PR

Please keep PRs focused — one behavioral change per PR, with a one-line rationale.

---

## License

MIT — see [LICENSE](./LICENSE). Use freely, modify freely, no warranty.

---

## 中文说明

### 解决什么问题

Claude Code 深度对话超过约 400K token 后明显退化——捏造、偷懒、记忆丢失。自然的解决办法是**开新窗口**，但手动工作流有摩擦：

1. 让老窗口总结 + 写开场白
2. 粘贴到新窗口
3. 反过来问老窗口"和代码真实状态一致吗"
4. 循环

步骤 3-4 存在的原因是**老窗口写自己的交接稿会自圆其说**——它记得说过"我 push 了镜像"，但忘了实际有没有 push。

`claude-next` 把整个流程自动化，并用**独立 fresh-context auditor** 对每一条 claim 做核对。

### 三个差异化点

- **Fresh-context subagent 审稿**：写完 handoff 立刻由独立子代理（零对话历史）核对每条 claim vs 真实文件系统
- **Drift 检查**：新窗口 ingest 前再验一次 git HEAD / cwd / age
- **强制不确定声明**：每份 handoff 至少 3 条真实 uncertainty，凑不够拒绝生成

### 快速上手

```bash
npx claude-next install
```

然后：
- 老窗口: `/next` → 拿到口令 `继续 A`
- 新窗口首条消息: `继续 A` → 续接完成

### 对比 claude-mem 等 memory bank

`claude-next` 不是记忆系统，是**有质量门的交接协议**。它和 claude-mem 可以共存——前者只在你主动粘口令时才动作，零被动副作用。

如果你只想被动记忆捕获 + 自动注入，用 [claude-mem](https://github.com/thedotmack/claude-mem)。如果你想要带审稿的明确交接，用 `claude-next`。

### 口令表

| 操作 | 英文 | 中文 |
|---|---|---|
| 载入 | `continue A` / `next A` | `继续 A` |
| 删除 | `drop A` | `移除 A` |

---

## Credits

Built by humans working alongside Claude. Inspired by the pain of every deep session that hit 400K and fell over.

Report issues, ideas, war stories: https://github.com/llmapi-pro/claude-next/issues
