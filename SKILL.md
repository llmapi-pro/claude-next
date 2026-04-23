---
name: next
description: 产出可无缝续接到新 Claude Code 窗口的交接稿。当用户想切新窗口（长对话 >400K 出现幻觉、任务切段、老窗口要关）时使用。"/next" 产出 + "/next list" 查 + "/next remove X" 删。
---

# /next — 新窗口续接

你是 `/next` skill 的执行器。根据用户传入的参数，分三条路径：

- **无参数 / 空字符串** → 产出新 handoff（主路径）
- `list` → 列出所有 pending handoff
- `remove <SLOT>` → 删除指定 handoff

## 路径 1：产出 handoff（`/next` 无参）

### 步骤 1 — 识别当前任务

回看最近 ~20 轮对话 + 你自己最近的 Edit / Write / Bash 工具调用，用 **一句话** 总结**当前正在做什么**。只圈当前这条战线，不要扫整个项目。

**必做：** 先把识别结果亮给用户：

```
📋 识别到的当前任务：<一句话>
涉及：<最近碰过的 2-3 个文件或模块>

3 秒内无异议即开始写 handoff。若识别偏了，请直接纠正。
```

**等待用户响应**。如果用户纠正了，按纠正的任务范围重写。如果用户说"继续"或沉默，开始下一步。

### 步骤 2 — 分配 slot

运行：
```bash
bash ~/.claude/skills/next/scripts/slot.sh
```
拿到返回的 SLOT（如 `A`、`B`、`AB`）。

### 步骤 3 — 填充 handoff

读取模板 `~/.claude/skills/next/templates/handoff.template.md`，按模板各节填写真实内容。**每一节都必须写实**：

- **Task summary**：步骤 1 识别的那句话
- **Context**：3-5 句，只写和当前任务相关的背景
- **Progress**：已完成 / 未完成的具体 checkbox
- **Changed state**：逐条列出**真实改动过的 artifact**
  - 文件：路径 + 改了啥 + commit SHA 或 "uncommitted"
  - 镜像：name:tag + 是否 pushed
  - 容器：name + status
  - env/config：哪个文件哪个 key 改了
- **Next step**：一句话，**具体可执行的动作**，不是"继续优化 X"这种方向性描述
- **Uncertainty (MANDATORY ≥3)**：这是最关键的一节
  - 必须 **3-5 条真实不确定项**
  - 不准凑数、不准写"一切正常"、不准写"应该没问题"
  - 每条带 `verify by:` 具体怎么验（命令或检查步骤）
  - 如果你真的只想到 2 条以内——说明你没深想。至少再挖一条"这个改动在高并发 / 边界 case / 回滚路径上会怎样"
- **Open questions for user**：有则列，无则写 `(none)`

Frontmatter 填：
- `slot`: 刚拿到的 SLOT
- `created_at`: 当前 UTC ISO (`date -u +"%Y-%m-%dT%H:%M:%SZ"`)
- `project_root`: 运行 `pwd` 的输出（绝对路径）
- `git_branch`: `git rev-parse --abbrev-ref HEAD`（若不是 git 仓库，填 `(not-a-repo)`）
- `git_head`: `git rev-parse HEAD`（同上）
- `audit_status`: 保留 `pending`（下一步审稿会改）
- `auditor`: `claude-subagent`

写到 `~/.claude/next/pending/<SLOT>.md`。

### 步骤 4 — 审稿（Agent 子代理，fresh context）

**这一步不能跳**。用 Agent 工具启动 subagent，subagent_type=general-purpose。prompt 直接灌入：

```
你是 fresh-context auditor。阅读 ~/.claude/skills/next/templates/audit.rubric.md 获取审稿规范，然后按规范审查以下 handoff 文件：

~/.claude/next/pending/<SLOT>.md

执行完整的 claim-by-claim 核查。按规范要求的固定格式输出 "## Audit — Pass A (write-time)" 节的完整内容。直接输出这段 markdown 即可，不要做任何额外评论。
```

subagent 返回后，你做两件事：

1. **追加**（不是覆盖）subagent 输出到 handoff 文件末尾（用 Edit 或 Bash 的 `cat >>`）
2. 从 subagent 输出里提取 Verdict（passed / warnings / failed），更新 frontmatter 的 `audit_status` 字段

### 步骤 5 — 结果报告

给用户输出（格式固定，方便复制口令）：

```
━━━━━━━━━━━━━━━━━━━━
  📋 续接口令:  继续 <SLOT>
  任务:        <Task summary>
  project:     <project_root>
  audit:       <verdict>   <若 warnings/failed，简述 1 句原因>
  文件:        ~/.claude/next/pending/<SLOT>.md
━━━━━━━━━━━━━━━━━━━━

打开新窗口，首条消息粘贴  继续 <SLOT>  即可无缝续接。
老窗口现在可以关了，口令不过期。

若审稿 verdict = failed：建议先看 Pass A 里 ❌ 的 claim，手动修正 handoff 后再用。
```

若 verdict = **failed**：在上面输出后**额外**问用户："审稿发现 N 条严重不一致，要我现在修正 handoff 重跑一遍审稿吗？" 等用户定夺。

---

## 路径 2：`/next list`

直接运行并把输出完整展示给用户：
```bash
bash ~/.claude/skills/next/scripts/list.sh
```

不要额外解释、不要加料。脚本输出是给用户看的。

---

## 路径 3：`/next remove <SLOT>`

直接运行并展示输出：
```bash
bash ~/.claude/skills/next/scripts/remove.sh <SLOT>
```

如果用户写的是小写或带空格，脚本会自己归一化。

---

## 绝对红线

- ❌ 不要跳过步骤 1 的亮牌确认
- ❌ 不要跳过步骤 4 的 subagent 审稿
- ❌ Uncertainty 少于 3 条就**不写 handoff 文件**，回去再想
- ❌ 不要把 Pass A 的内容自己编——必须 subagent 返回的原文
- ❌ 不要修改 handoff 正文以迎合审稿——有问题是回头修真实状态，不是改 claim
