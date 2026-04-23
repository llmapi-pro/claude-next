---
next_version: 1
slot: {{SLOT}}
created_at: {{ISO_TIMESTAMP}}
project_root: {{PROJECT_ROOT}}
git_branch: {{GIT_BRANCH}}
git_head: {{GIT_HEAD}}
audit_status: pending
auditor: {{AUDITOR_CMD}}
---

# Task summary
<一句话：当前正在做什么。由老窗口根据最近对话 + 工具调用自动识别；不确定时老窗口先亮出识别结果让用户纠偏再写。>

# Context
<3-5 句：为什么做、到哪一步了、依赖哪些前置。只写和当前任务相关的，不要扫整个 repo。>

# Progress
- [x] <已完成项>
- [ ] <未完成项>

# Changed state
<逐条写改动过的真实 artifact。每条都是可独立验证的具体事物，不是抽象描述。>
- file: <path> — <what changed> — commit: <sha or "uncommitted">
- image: <name:tag> — pushed: yes/no — registry: <url or local>
- container: <name> — status: running/restarted/down
- env / config: <file> — <key changed>

# Next step
<一句话：新窗口第一件事做什么。必须是可执行的具体动作，不是方向性描述。>

# Uncertainty (MANDATORY, ≥3)
<老窗口在写 handoff 时必须列出 3-5 条真实不确定项。不能凑数、不能写"一切正常"。每条带 verify by 方法。>
- **UNK-1**: <claim I'm not sure about> — verify by: <具体命令或检查步骤>
- **UNK-2**: ...
- **UNK-3**: ...

# Open questions for user
<若无，写 "(none)"。若有，一行一条。>

---

## Audit — Pass A (write-time)
<由独立 auditor（fresh context LLM）填写。老窗口不准动这一节。>

## Audit — Pass B (read-time)
<新窗口 ingest 时填写 drift 检查结果。>
