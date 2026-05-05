# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.6] - 2026-05-05

### Fixed — non-ASCII pass-phrase regression (reported via #2)

- **UTF-8 round-trip in JSON helpers.** `scripts/common.sh json_emit_context`
  and `json_get` layered `:encoding(UTF-8)` on both STDIN and STDOUT around
  Perl's JSON::PP, which already emits UTF-8 byte sequences from
  `encode_json`. Every byte was re-interpreted as Latin-1 and re-encoded —
  e.g. `e5 8f a3` (口) became `c3 a5 c2 8f c2 a3` mojibake. The hook output
  was invalid UTF-8, Claude Code rejected it with the cryptic
  "UserPromptSubmit hook error: Failed with non-blocking status code: No
  stderr output", and the matching handoff was already consumed by
  `rm -f $f` → silent data loss for users with Chinese/emoji prompts.
  Fix: keep `binmode STDIN` only on `json_emit_context` (decode bytes →
  wide chars before encode_json sees them) and only `binmode STDOUT` on
  `json_get` (decode_json wants raw bytes). Verified end-to-end with
  `继续 ZZZ` and `测试 中文 emoji 🎉` round-trips.
- **Bash variable-name lexer eats high-bit bytes after `$slot`.** Found
  while debugging the UTF-8 bug. The context template `已粘贴口令续接 handoff $slot。`
  put the Chinese full stop `。` (U+3002 = `e3 80 82`) immediately after a
  bare `$slot`. Bash's identifier lexer absorbed the high-bit bytes as if
  they were valid identifier chars, expanded `${slot。}` (unset under
  `set -u`) → exit 1 → handoff already deleted by line 63 → silent loss.
  The outer `} 2>/dev/null || exit 0` wrapper swallowed the actual
  `unbound variable: slot�` diagnostic. Fix: brace-quote every
  `${slot}` / `${trimmed}` / `${body}` reference in the context templates.
  Pure-ASCII users were never affected (no high-bit bytes after the
  variable = no absorption).

### Compatibility

- Pure-ASCII pass-phrases (`continue A`, `next A`, `drop A`) behaved
  identically before and after these fixes — anyone unaffected by the
  Chinese-byte bugs sees no behavior change. Upgrading is recommended for
  any user who has ever pasted a Chinese pass-phrase, since the silent
  data-loss path can consume a handoff without injecting it.

## [0.2.5] - 2026-05-01

### Fixed — second proactive sweep (no user reports)

- **`NEXT_PENDING_DIR` env override now actually works.** README's
  configuration table promised it as an independently-overridable env var,
  but `scripts/common.sh` unconditionally clobbered any caller value with
  `NEXT_HOME/pending`. Now uses the `:-` default form. The JS lib
  (`lib/slot.js PENDING_DIR`) honors the same env var so auto-mode looks
  in the same place the shell scripts write to.
- **`claude-next auto --resume <SLOT>` actually resumes from the named
  handoff.** The flag was parsed and logged but the first window's prompt
  was hard-coded to `PREAMBLE + initialPrompt`, which ignored the handoff
  entirely. `--resume` only kicked in on the second window after a mid-loop
  rotate — i.e. it was a no-op for its actual use case. Fixed: when
  `--resume X` is set, the first window starts with `继续 X` as its prompt.

### Improved

- **`driver._buffer` now has a 10MB sanity cap.** Previously the NDJSON
  line buffer grew unbounded if the child Claude process ever emitted
  output without a trailing newline (hung child, broken protocol). Beyond
  10MB the buffer is dropped and an `error` event fires so the
  orchestrator can react.
- **`scripts/ingest.sh` honors `NEXT_DEBUG=1`** for a one-line trace per
  invocation written to `~/.claude/next/ingest.debug.log`. By design the
  hook never prints to the user terminal (it would corrupt every prompt),
  so this log is the only way to diagnose why a pass-phrase took (or
  didn't take) a code path. Off by default; zero overhead when unset.
- **`SessionLogger.log()` writes to stderr instead of stdout.** Auto-mode
  writes the child Claude's assistant text to stdout for the human (or
  downstream pipeline) to read; orchestrator meta-logs were going to the
  same stream and interleaving mid-line. Now stdout is purely the child's
  voice and stderr is purely the orchestrator's. `events.jsonl` /
  `main.log` / `summary.json` on disk are unchanged.

### Compatibility

- Pure additive — every existing call path still works. Anyone relying on
  orchestrator log lines reaching stdout should switch to reading
  `~/.claude/next/auto-sessions/<stamp>/main.log` (which has always been
  the source of truth).

## [0.2.4] - 2026-05-01

### Fixed — proactive bug-hunt sweep (no user reports yet, found by code audit)

- **`<SLOT>.audit-passA.md` no longer pollutes the slot list.** v0.2.3 introduced
  the audit subagent writing its result to `<SLOT>.audit-passA.md` in the same
  pending dir, then `audit-finalize.sh` consuming it. Both `lib/slot.js
  listUsedSlots` (`f.endsWith('.md')`) and `scripts/common.sh slots_used`
  (sed-only filter) treated `<SLOT>.audit-passA.md` as a real slot file. In
  the crash window where the producing window dies between the subagent's
  Write and audit-finalize.sh's consume, the file is left behind and gets
  visited by `waitForNewHandoff`, which can resolve with `slot='X.audit-passA'`
  and prompt the next window with `继续 X.audit-passA`. Filter is now a
  strict regex `^[A-Z]{1,3}\.md$` in both implementations, so only real
  handoffs ever appear.

- **Frontmatter parsing handles CRLF.** Both `lib/handoff-wait.js
  readAuditStatus` (used by auto-mode) and `scripts/common.sh
  frontmatter_get` (used by ingest, list, validity) parsed the YAML
  frontmatter as if it were always LF-terminated. A handoff saved in a
  Windows editor or checked out with `git config core.autocrlf=true` has
  CRLF line endings; the regex `^---\n` fails to match `---\r\n`, so every
  frontmatter key silently returned empty. For auto mode this caused
  `audit_status` to be reported as `pending` forever and the loop to wait
  out the full 5-minute timeout on every rotation. Both implementations
  now strip `\r` before parsing.

- **Rotator markers no longer fire on substring matches in prose.** The
  marker set used to include the bare Chinese phrases `任务完成` (`task
  complete`) and `需要换窗` (`need to switch windows`) — both common things
  for a Chinese-speaking child to write inside an explanation, e.g.
  `任务完成第一阶段，开始第二阶段` would instantly stop the entire auto
  loop. The marker matcher also accepted any substring inside a longer
  line. Two changes: (a) the ambiguous Chinese phrases are removed
  entirely; (b) markers must now appear **alone on their own line** (after
  trim) — the same false-positive class fixed for the `next step is to ...`
  pass-phrase regex in 0.2.3. Bracket markers (`[ROTATE]`, `[DONE]`,
  `[HANDOFF]`, `[TASK_COMPLETE]`, `<...>` variants, and `ALL_DONE`) are
  retained because they require explicit emission. The PREAMBLE the
  orchestrator injects into the child Claude is updated to spell out the
  on-its-own-line contract so the child knows it can safely mention the
  markers in prose without triggering them.

### Improved

- **`audit-finalize.sh` is fully POSIX awk** (no gawk-only `match($0, re,
  arr)` array form). The previous code worked everywhere but emitted a
  syntax error to stderr on macOS BSD awk, then silently fell back to the
  grep path — noisy logs that looked alarming but weren't. The new awk is
  pure POSIX and quiet on every platform.
- **`audit-finalize.sh` writes its tempfile in the target directory**, not
  `/tmp`, so the `mv tmp final` step is always atomic on POSIX (same-fs
  rename) instead of degrading to copy+unlink across `tmpfs → ext4`.
- **README documents `aborted` and the transient `pending` /
  `in_progress` / `writing` audit states**, which 0.2.3 introduced but
  didn't explain. Users encountering the new ABORTED warning on a handoff
  will now find an explanation directly under "How the audit works".

### Compatibility

- All v0.1 / v0.2.x pass-phrases continue to work unchanged.
- Existing handoffs from any version remain loadable; CRLF handoffs that
  used to look "stuck" in auto mode will now load on the first poll.
- One marker-set change: assistants in the auto loop that relied on the
  bare phrases `任务完成` or `需要换窗` to signal rotate/done need to use
  the bracketed forms (`[ROTATE]` / `[DONE]`) on their own line instead.
  This is also documented in the updated PREAMBLE.

## [0.2.3] - 2026-05-01

### Fixed — `/next` skill (manual path) — three user-reported regressions in deep sessions

- **Pass-phrase `continue <SLOT>` now works.** The English alias was documented
  in the v0.1 README, CHANGELOG, and CLI help, but the hook regex only matched
  `继续` and `next`. Pasting `continue A` as the first message in a new window
  silently fell through to a normal user prompt with no handoff injection — so
  the new window opened with no orientation message at all. Fixed by adding
  `continue` (case-insensitive) to the regex.
- **Pass-phrase regex is no longer trigger-happy.** Previously `next step is to
  fix the auth bug`, `next time we should ...`, or `drop table users` (anyone
  pasting SQL into a fresh window) were parsed as `slot=STEP / TIME / TABLE`
  and the user's real first message was replaced with a "slot does not exist"
  hook message. The regex now requires a 1-3-letter slot followed by a word
  boundary (end-of-string, whitespace, or punctuation), eliminating the
  false-positive class entirely.
- **Ingest gates on `audit_status`.** A handoff that was written but whose
  step-4 subagent audit never completed (because the producing window crashed,
  was closed, or the user interrupted) was being consumed silently and
  injected into the new window as if it had passed audit. The hook now reads
  `audit_status` before consuming and surfaces explicit warnings for
  `pending` / `in_progress` / `aborted` / `failed`, so the new window's
  Claude leads with the truth ("this handoff did not pass the quality gate")
  instead of trusting unverified claims.
- **Step 1 no longer hangs the turn.** SKILL.md previously said "wait for user
  response" and "3 seconds without objection — proceed" after announcing the
  identified task. Claude Code has no 3-second timer, so the LLM ended its
  turn and waited forever for the user to type "continue", which felt like
  `/next` had hung. The new wording explicitly tells the LLM to keep going;
  if the user got an incorrect identification, they correct it on the next
  turn (which now also includes a pointer to `remove.sh <SLOT>` to undo the
  draft cleanly).
- **Step 4 no longer relies on LLM self-stitching.** Previously the producing
  LLM had to (a) `cat >>` the audit text into the handoff, (b) hand-edit the
  frontmatter `audit_status` line, and (c) print the result-report block.
  In deep contexts any of those three steps could be skipped, garbled by
  shell escaping, or completed without the others — leaving handoffs in
  inconsistent states (file says `pending` but Pass A is in the body, or
  Pass A missing but frontmatter says `passed`). The audit subagent now
  **Write**s its output to `<SLOT>.audit-passA.md`, and a new shell script
  `scripts/audit-finalize.sh` does the file mutation atomically and prints
  the verdict back. The LLM only has to read one string.

### Added

- **`scripts/audit-finalize.sh`** — atomic finalizer for handoff audit. Takes
  `<SLOT> <PASS_A_FILE>` and rewrites frontmatter + appends Pass A in one
  shot, or `<SLOT> --aborted` when the audit subagent didn't return cleanly.
- **`audit_status: aborted`** as a first-class verdict, distinct from
  `pending` (step 4 was skipped entirely) and from `failed` (audit ran and
  found verified-fictitious claims).
- **`/next list` now flags stale audit state.** If frontmatter says
  passed/warnings/failed but the file body has no `## Audit — Pass A`
  section, the listing shows `audit: <verdict> (stale: no Pass A section in
  body)` so users can tell something went wrong.
- **`install.sh` self-test** for the `next step is to ...` false-positive
  guard, so future regex regressions get caught at install time.

### Changed

- **`install.sh` idempotency** is now substring-based on
  `next/scripts/ingest.sh` rather than exact string equality on the hook
  command. Users who tweaked the cmd (added `2>/dev/null`, alternate path
  expansion, etc.) no longer get duplicate hook registrations on re-install.
- **Auto-mode (`claude-next auto`) `waitForNewHandoff`** now distinguishes
  "file never appeared" from "file appeared but audit never finished". In
  the second case it resolves with `verdict='aborted'` after the timeout
  rather than rejecting with a generic timeout error, so the orchestrator
  can still load the (unaudited) handoff and let the consuming window warn
  the user, instead of failing the whole loop.

### Compatibility

- All v0.1 / v0.2.x pass-phrases (`继续 A`, `next A`, `移除 A`, `drop A`)
  continue to work unchanged. `continue A` is now an additional accepted
  alias, matching what the docs always said.
- Existing pending handoffs with `audit_status: passed/warnings/failed` are
  fully compatible. Handoffs with `audit_status: pending` will now produce
  a loud warning in the consuming window — this is the intended behavior.
- No breaking changes to `claude-next auto`'s public CLI flags.

## [0.2.2] - 2026-04-24

### Fixed
- Auto loop process could stay alive for up to 30 minutes after the logical
  loop finished writing its summary. The safety-net `setTimeout` and the
  poll `setInterval` in `waitForDecision` were never cleared, keeping the
  Node event loop busy. Both are now cleared on finish and additionally
  `.unref()`-ed so they can't hold the process open. The outer `runAuto`
  also calls `process.exit(0)` once the summary is flushed, which matters
  for shell orchestrators that `wait` on the child PID.

## [0.2.1] - 2026-04-24

### Fixed
- Auto loop could time out waiting for handoff when the `/next` skill paused
  for its "3 seconds / no objection" user-confirmation gate. The driver now
  sends an auto-confirm `继续` message at +8 s and +60 s after `/next`, and
  extends the handoff-wait timeout from 180 s to 300 s.
- Cosmetic: replaced non-ASCII ellipsis in a log string that could trip
  `set -u` consumers on restricted locales.

## [0.2.0] - 2026-04-24

### Added
- **`claude-next auto "<task>"`** — autonomous rotating loop with zero human
  intervention between windows.
  - Spawns Claude Code as a child via `claude --print --input-format stream-json
    --output-format stream-json`, feeding user turns as NDJSON and reading
    assistant / result events back.
  - Watches for rotation triggers: turn count, per-window cost cap,
    cumulative cost cap, or explicit `[ROTATE]` / `[DONE]` markers in the
    assistant's output.
  - On rotate: sends `/next` to the current child, waits for the new handoff
    file to appear and its `audit_status` to flip from `pending`, kills the
    child, and spawns a fresh one with `继续 <SLOT>` as its first message.
  - Structured session logs under `~/.claude/next/auto-sessions/<stamp>/`
    (`main.log`, `events.jsonl`, `summary.json`).
  - Graceful stop via SIGINT/SIGTERM or the sentinel file
    `~/.claude/next/auto.stop`.
  - Zero additional runtime dependencies — pure Node stdlib, same as v0.1.
- `claude-next auto --status` / `claude-next auto --stop` / `--dry-run` helpers.
- Embedded preamble instructs the child Claude to emit `[ROTATE]` at natural
  checkpoints and `[DONE]` when the overall task is complete.
- New library modules under `lib/`: `auto.js`, `driver.js`, `rotator.js`,
  `handoff-wait.js`, `logger.js`, `slot.js`.

### Notes
- Requires the local `claude` CLI (Claude Code) on `PATH`. Override with
  `--claude-bin` or the `CLAUDE_BIN` env var.
- Recommended to pair `auto` with `--dangerously-skip-permissions` only in
  sandboxed project directories. The loop defaults to
  `--permission-mode bypassPermissions` for the child process.
- The loop reuses the existing `/next` skill for handoffs, so audit gating from
  v0.1 applies inside the loop as well.

## [0.1.0] - 2026-04-24

### Added
- Initial public release.
- `/next` slash command for Claude Code to produce audited handoffs.
- `UserPromptSubmit` hook that intercepts pass-phrases `continue <slot>` / `继续 <slot>` and `drop <slot>` / `移除 <slot>`.
- Fresh-context subagent audit (**Pass A**) at handoff write time, verifying every claim against the filesystem.
- Drift check (**Pass B**) at handoff ingest time — verifies `project_root`, `git HEAD`, branch, and age.
- Forced uncertainty declaration — minimum 3 real uncertainties per handoff, rejected if fewer.
- `/next list` and `/next remove <slot>` sub-commands.
- Slot allocation: A-Z, overflowing to AA-ZZ (up to 702 concurrent pending handoffs).
- `npx claude-next install` convenience installer.
- Idempotent `install.sh` with `settings.json` backup.

### Known limitations
- Requires `bash` and `perl` (core on macOS/Linux; Git-bash on Windows).
- No consumed-handoff archive — deletion is immediate (by design; configurable later).
- Single-user, single-machine — handoffs are local files, no sync.
- Pass-phrase patterns currently hard-coded to `continue|next|继续` and `drop|移除`.

[0.2.6]: https://github.com/llmapi-pro/claude-next/releases/tag/v0.2.6
[0.2.5]: https://github.com/llmapi-pro/claude-next/releases/tag/v0.2.5
[0.2.4]: https://github.com/llmapi-pro/claude-next/releases/tag/v0.2.4
[0.2.3]: https://github.com/llmapi-pro/claude-next/releases/tag/v0.2.3
[0.2.2]: https://github.com/llmapi-pro/claude-next/releases/tag/v0.2.2
[0.2.1]: https://github.com/llmapi-pro/claude-next/releases/tag/v0.2.1
[0.2.0]: https://github.com/llmapi-pro/claude-next/releases/tag/v0.2.0
[0.1.0]: https://github.com/llmapi-pro/claude-next/releases/tag/v0.1.0
