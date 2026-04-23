# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

[0.1.0]: https://github.com/llmapi-pro/claude-next/releases/tag/v0.1.0
