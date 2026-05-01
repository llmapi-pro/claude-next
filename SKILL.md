---
name: next
description: Produce a clean handoff to a fresh Claude Code window. Use when the current conversation is too long (>400K tokens, hallucinations, lost context, or the user wants to close the window). "/next" produces a handoff, "/next list" shows all pending, "/next remove X" deletes one.
---

# /next — Handoff to a fresh Claude Code window

You are the `/next` skill executor. Branch on the argument:

- **No arg / empty string** → produce a new handoff (main path)
- `list` → list all pending handoffs
- `remove <SLOT>` → delete the named handoff

---

## Path 1 — Produce a handoff (`/next` with no arg)

### Step 1 — Identify the current task

Look back over the last ~20 turns of conversation + your own most recent Edit / Write / Bash tool calls. Summarize **what we are doing right now** in a single sentence. Stay on the *current* line of work — do not survey the whole project.

Briefly tell the user what you identified, in this format:

```
📋 Identified task: <one sentence>
Touched: <2-3 files or modules touched recently>

Producing handoff now. If I got the task wrong, say so and I'll restart with the right scope.
```

**Do not stop turn here.** Proceed to step 2 immediately. The user can correct you in the next turn — when they do, run `bash ~/.claude/skills/next/scripts/remove.sh <SLOT>` and start over with the right scope. Do **not** hard-pause waiting for a "go ahead" — that is the historic bug that made `/next` feel stuck in deep contexts.

### Step 2 — Allocate slot

Run:
```bash
bash ~/.claude/skills/next/scripts/slot.sh
```
Capture the returned SLOT (e.g. `A`, `B`, `AB`).

### Step 3 — Fill the handoff

Read the template `~/.claude/skills/next/templates/handoff.template.md` and fill every section with real content:

- **Task summary**: the sentence from step 1
- **Context**: 3-5 sentences, only what matters for the *current* task
- **Progress**: concrete `[x]` / `[ ]` checkboxes
- **Changed state**: every real artifact you touched
  - file: path + what changed + commit SHA or "uncommitted"
  - image: name:tag + pushed yes/no
  - container: name + status
  - env / config: file + key
- **Next step**: one sentence, a *concrete executable action*. Not "continue improving X".
- **Uncertainty (MANDATORY ≥3)**: most important section
  - 3-5 real uncertainties, each with `verify by:` (a real command or check)
  - Do not pad. Do not write "everything looks fine". If you can only think of two, dig harder — at minimum ask "what does this change do under high concurrency / edge case / rollback?"
- **Open questions for user**: if none, write `(none)`

Frontmatter:
- `slot`: from step 2
- `created_at`: `date -u +"%Y-%m-%dT%H:%M:%SZ"`
- `project_root`: output of `pwd`
- `git_branch`: `git rev-parse --abbrev-ref HEAD` (or `(not-a-repo)`)
- `git_head`: `git rev-parse HEAD` (or `(not-a-repo)`)
- `audit_status`: leave as `pending` (the finalize script will overwrite it)
- `auditor`: `claude-subagent`

Write the file to `~/.claude/next/pending/<SLOT>.md`.

### Step 4 — Audit (subagent, fresh context)

**This step is not optional.** Spawn a subagent (subagent_type=general-purpose). The subagent must **Write** its audit to a separate file — *do not* have it print the audit back to you so you manually `cat >>` (that LLM-self-stitching step is the historic source of "audit got truncated / never appeared / status never updated" bugs in deep contexts).

Subagent prompt (use exactly, replacing `<SLOT>`):

```
You are a fresh-context auditor. Read ~/.claude/skills/next/templates/audit.rubric.md
for the audit specification, then audit this handoff:

  ~/.claude/next/pending/<SLOT>.md

Run a complete claim-by-claim verification. Then **Write** the
"## Audit — Pass A (write-time)" section in the rubric's exact format to:

  ~/.claude/next/pending/<SLOT>.audit-passA.md

Do not append to the handoff yourself. Do not print the audit back. Just write
the file and end your turn.
```

After the subagent returns, finalize atomically (this script rewrites `audit_status` in the frontmatter and appends the Pass A block to the handoff):

```bash
bash ~/.claude/skills/next/scripts/audit-finalize.sh <SLOT> ~/.claude/next/pending/<SLOT>.audit-passA.md
```

The script prints the verdict (`passed` / `warnings` / `failed`) on stdout. **Capture that string** — you need it for step 5.

If the subagent never produced the audit-passA file (error, timeout, wrong path), fall back:
```bash
bash ~/.claude/skills/next/scripts/audit-finalize.sh <SLOT> --aborted
```
This marks `audit_status: aborted` so the consuming window will warn the user instead of trusting unverified claims.

### Step 5 — Result report

Output exactly this block (substitute the captured verdict + slot + summary):

```
━━━━━━━━━━━━━━━━━━━━
  📋 Pass-phrase:  continue <SLOT>     (also accepts: next <SLOT>  /  继续 <SLOT>)
  Task:            <Task summary>
  project:         <project_root>
  audit:           <verdict>   <if warnings/failed/aborted, one-sentence reason>
  file:            ~/.claude/next/pending/<SLOT>.md
━━━━━━━━━━━━━━━━━━━━

Open a new window and paste  continue <SLOT>  as the first message.
You can close this window now — the pass-phrase does not expire.

If verdict = failed: look at the ❌ items in Pass A and either fix the underlying
state or rewrite the handoff before reusing it.
```

If verdict is **failed**, additionally ask: "The audit found N serious mismatches. Want me to fix the handoff and rerun the audit now?"

---

## Path 2 — `/next list`

Run and show the output verbatim:
```bash
bash ~/.claude/skills/next/scripts/list.sh
```

Don't reformat or summarize. The script output is the user-facing display.

---

## Path 3 — `/next remove <SLOT>`

Run and show the output:
```bash
bash ~/.claude/skills/next/scripts/remove.sh <SLOT>
```

The script normalizes case and whitespace itself.

---

## Hard rules

- ❌ Do **not** stop turn at step 1 waiting for user confirmation. Identify, announce, proceed.
- ❌ Do **not** skip the step-4 subagent audit.
- ❌ Do **not** hand-write the Pass A content yourself — only the subagent's actual output (the finalize script appends it for you).
- ❌ Do **not** edit handoff *body* sections (Context / Progress / Changed state / Next step / Uncertainty) in response to audit findings — fix the real underlying state instead. Audit can only flip `audit_status` and append Pass A.
- ❌ If Uncertainty has fewer than 3 real items, do not write the file. Go back and dig.
