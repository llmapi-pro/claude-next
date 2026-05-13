#!/usr/bin/env node
/**
 * claude-next CLI
 *
 * Usage:
 *   npx claude-next install                          Install /next skill + hook
 *   npx claude-next auto "<task prompt>"             Start autonomous rotating loop
 *   npx claude-next auto --stop                      Request graceful stop of running loop
 *   npx claude-next auto --status                    Show last auto session summary
 *   npx claude-next --version
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pkgRoot = path.resolve(__dirname, '..');
const pkg = require(path.join(pkgRoot, 'package.json'));

const HOME = os.homedir();
const TARGET = path.join(HOME, '.claude', 'skills', 'next');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const RUNTIME_DIR = path.join(HOME, '.claude', 'next');
const AUTO_SENTINEL = path.join(RUNTIME_DIR, 'auto.stop');
const AUTO_SESSIONS = path.join(RUNTIME_DIR, 'auto-sessions');

const ITEMS = ['scripts', 'templates', 'SKILL.md', 'install.sh', 'README.md'];

// Hook is `bash ingest.sh`. Both POSIX and Windows-with-Git-Bash satisfy this.
// On pure Windows the install still succeeds but we warn that the hook needs
// bash at runtime — porting hook scripts to Node is the v0.3.x track.
const HOOK_CMD = 'bash "$HOME/.claude/skills/next/scripts/ingest.sh"';
// Substring match for idempotent re-install. Tolerate both / and \ separators
// so users on Windows who hand-edited the hook with backslashes don't get a
// duplicate hook entry.
const HOOK_RE = /next[\/\\]scripts[\/\\]ingest\.sh/;

function copyRecursive(src, dst) {
  if (typeof fs.cpSync === 'function') { fs.cpSync(src, dst, { recursive: true, force: true }); return; }
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) copyRecursive(path.join(src, entry), path.join(dst, entry));
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function sortKeysDeep(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = sortKeysDeep(obj[k]);
  return out;
}

function bashAvailable() {
  // spawnSync swallows ENOENT into result.error on Windows; check both.
  const r = spawnSync('bash', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

function backupOrInitSettings() {
  if (!fs.existsSync(SETTINGS)) {
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
    fs.writeFileSync(SETTINGS, '{}\n', 'utf8');
    return null;
  }
  // Match install.sh date +%Y%m%d-%H%M%S (local-time).
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const bak = `${SETTINGS}.bak-${stamp}`;
  fs.copyFileSync(SETTINGS, bak);
  return bak;
}

function mergeHookIntoSettings(hookCmd) {
  // UTF-8 contract: read as utf8, JSON parse, JSON stringify, write as utf8.
  // Node JSON.stringify emits raw codepoints (not \uXXXX escapes), and utf8
  // write encodes them to valid bytes — so Chinese hook labels / paths
  // round-trip without mojibake (the same property install.sh's perl block
  // achieved via JSON::PP ->utf8).
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  let s;
  try { s = JSON.parse(raw); } catch (_) { s = {}; }
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};

  s.hooks = s.hooks || {};
  s.hooks.UserPromptSubmit = s.hooks.UserPromptSubmit || [];
  const ups = s.hooks.UserPromptSubmit;

  let already = false;
  for (const e of ups) {
    if (!e || typeof e !== 'object' || !Array.isArray(e.hooks)) continue;
    for (const h of e.hooks) {
      if (h && typeof h === 'object' && typeof h.command === 'string' && HOOK_RE.test(h.command)) {
        already = true; break;
      }
    }
    if (already) break;
  }
  if (already) return { added: false };

  ups.push({ hooks: [{ type: 'command', command: hookCmd }] });
  // canonical = sorted keys (matches install.sh's ->canonical->encode).
  const json = JSON.stringify(sortKeysDeep(s), null, 2) + '\n';
  fs.writeFileSync(SETTINGS, json, 'utf8');
  return { added: true };
}

function verifyHookInSettings() {
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  const s = JSON.parse(raw);
  const ups = (s.hooks && s.hooks.UserPromptSubmit) || [];
  let found = false;
  for (const e of ups) {
    for (const h of (e.hooks || [])) {
      if (h && typeof h.command === 'string' && HOOK_RE.test(h.command)) found = true;
    }
  }
  return { found, total: ups.length };
}

function runDryHook(input) {
  const ingestPath = path.join(TARGET, 'scripts', 'ingest.sh');
  const r = spawnSync('bash', [ingestPath], { input, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' });
  return ((r.stdout || '') + '').trim();
}

const DRY_RUN_TESTS = [
  { input: '{}', label: 'empty input', expectEmpty: true },
  { input: '{"prompt":"hello world","session_id":"test","hook_event_name":"UserPromptSubmit"}', label: 'non-matching prompt', expectEmpty: true },
  { input: '{"prompt":"next ZZ","session_id":"test","hook_event_name":"UserPromptSubmit"}', label: 'next ZZ → missing-slot', expectMatch: /槽位 ZZ 不存在/ },
  { input: '{"prompt":"继续 ZZ","session_id":"test","hook_event_name":"UserPromptSubmit"}', label: '继续 ZZ → missing-slot (CN trigger)', expectMatch: /槽位 ZZ 不存在/ },
  { input: '{"prompt":"next step is to fix the auth bug","session_id":"test","hook_event_name":"UserPromptSubmit"}', label: '"next step is..." → no false positive', expectEmpty: true },
  { input: '{"prompt":"drop the file is broken","session_id":"test","hook_event_name":"UserPromptSubmit"}', label: '"drop the file..." → no false positive', expectEmpty: true },
  { input: '{"prompt":"next ABCD please","session_id":"test","hook_event_name":"UserPromptSubmit"}', label: '"next ABCD..." → 4-char slot rejected', expectEmpty: true },
  { input: '{"prompt":"next A.","session_id":"test","hook_event_name":"UserPromptSubmit"}', label: '"next A." → punctuation boundary', expectMatch: /槽位 A 不存在/ },
];

function install() {
  console.log('━━━ /next skill installer ━━━\n');

  // [1/5] Copy files
  console.log('[1/5] Copying skill files to:', TARGET);
  fs.mkdirSync(TARGET, { recursive: true });
  for (const item of ITEMS) {
    const src = path.join(pkgRoot, item);
    const dst = path.join(TARGET, item);
    if (!fs.existsSync(src)) { console.error(`  ✗ Missing: ${item}`); process.exit(1); }
    copyRecursive(src, dst);
  }
  // chmod on POSIX; Windows ignores file modes so skip.
  if (process.platform !== 'win32') {
    try {
      const sd = path.join(TARGET, 'scripts');
      for (const f of fs.readdirSync(sd)) {
        if (f.endsWith('.sh')) fs.chmodSync(path.join(sd, f), 0o755);
      }
      fs.chmodSync(path.join(TARGET, 'install.sh'), 0o755);
    } catch (_) {}
  }
  fs.mkdirSync(path.join(RUNTIME_DIR, 'pending'), { recursive: true });
  console.log('  ✓ Files copied');
  console.log('  ✓ Runtime dir:', path.join(RUNTIME_DIR, 'pending'));

  // [2/5] Backup
  console.log('\n[2/5] Backing up settings.json...');
  const bak = backupOrInitSettings();
  console.log(bak ? `  ✓ Backup: ${bak}` : '  • No existing settings.json; created fresh.');

  // [3/5] Merge hook
  console.log('\n[3/5] Merging UserPromptSubmit hook...');
  const m = mergeHookIntoSettings(HOOK_CMD);
  console.log(m.added ? '  ✓ Hook added.' : '  • /next hook already present; skipped.');

  // [4/5] Verify
  console.log('\n[4/5] Verifying...');
  const v = verifyHookInSettings();
  if (!v.found) { console.error('  ✗ Hook verification failed.'); process.exit(1); }
  console.log(`  ✓ Hook in place. Total UserPromptSubmit entries: ${v.total}`);

  // [5/5] Dry-run (requires bash). On pure Windows we skip + warn instead of fail.
  console.log('\n[5/5] Dry-run hook...');
  const hasBash = bashAvailable();
  if (!hasBash) {
    console.log('  ⚠ bash not on PATH — skipping runtime dry-run.');
    console.log('    The hook command is `bash ".../ingest.sh"`, which needs bash at runtime.');
    console.log('    On Windows: install Git for Windows (https://gitforwindows.org/) to get bash.exe.');
  } else {
    for (const t of DRY_RUN_TESTS) {
      const out = runDryHook(t.input);
      if (t.expectEmpty) {
        if (out === '') console.log(`  ✓ ${t.label} → silent passthrough`);
        else console.log(`  ⚠ ${t.label} produced output: ${out.split('\n')[0]}`);
      } else if (t.expectMatch) {
        if (t.expectMatch.test(out)) console.log(`  ✓ ${t.label}`);
        else console.log(`  ⚠ ${t.label} unexpected output: ${(out || '(empty)').split('\n')[0]}`);
      }
    }
  }

  console.log('\n━━━ Install complete ━━━\n');
  console.log('Next steps:');
  console.log('  1. Open a new Claude Code window. Try   /next list   (should say: No pending handoffs.)');
  console.log('  2. In a real project, run   /next   to produce your first handoff.');
  console.log('  3. Open another window and paste   继续 X   (or  next X) to verify continuation.');
  console.log('');
  if (!hasBash) {
    console.log('⚠ This system has no bash on PATH. The /next hook fires `bash ingest.sh` so it will be a no-op until bash is installed.');
    console.log('  Windows: install Git for Windows — https://gitforwindows.org/  (provides bash.exe in PATH)');
    console.log('  A future v0.3.x track will port the hook to Node so bash becomes optional.');
    console.log('');
  }
  console.log('Uninstall:');
  console.log(`  rm -rf ${TARGET} ${RUNTIME_DIR}`);
  console.log(`  restore settings: cp ${SETTINGS}.bak-<latest> ${SETTINGS}`);
}

function version() { console.log(pkg.version); }

function help() {
  console.log(`claude-next v${pkg.version}`);
  console.log('');
  console.log('Usage:');
  console.log('  npx claude-next install                  Install the /next skill + hook');
  console.log('  npx claude-next auto "<task>"            Start the autonomous rotating loop');
  console.log('  npx claude-next auto --status            Show last auto-session summary');
  console.log('  npx claude-next auto --stop              Ask the running loop to stop gracefully');
  console.log('  npx claude-next --version                Print version');
  console.log('');
  console.log('After install, use /next inside Claude Code to produce an audited handoff.');
  console.log('In a new window, paste `继续 A` to pick up seamlessly.');
  console.log('');
  console.log('The auto loop rotates windows by itself (no human needed) — it:');
  console.log('  - spawns Claude Code in headless JSON-stdio mode');
  console.log('  - watches for [ROTATE] / [DONE] markers + turn/budget caps');
  console.log('  - auto-invokes /next, waits for handoff, spawns fresh window with 继续 <SLOT>');
  console.log('  - stops on success, budget, no-progress, or ~/.claude/next/auto.stop sentinel');
  console.log('');
  console.log('Repo:  https://github.com/llmapi-pro/claude-next');
}

function parseAutoArgs(argv) {
  const out = {
    command: null,
    prompt: null,
    maxTurnsPerWindow: 30,
    windowBudgetUsd: 2.0,
    totalBudgetUsd: 20.0,
    maxWindows: 20,
    cwd: process.cwd(),
    debug: false,
    dryRun: false,
    claudeBin: process.env.CLAUDE_BIN || 'claude',
    resumeSlot: null,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stop') { out.command = 'stop'; continue; }
    if (a === '--status') { out.command = 'status'; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--debug') { out.debug = true; continue; }
    if (a === '--resume') {
      // Validate against ingest.sh's slot regex ([A-Z]{1,2} after the 0.2.9
      // tightening). Without this, an invalid slot silently no-ops the
      // resume — the new window starts with `继续 foo`, the hook ignores it,
      // and the orchestrator assumes resume succeeded. Uppercase first so
      // case-insensitive CLI usage still works on the producing side.
      const raw = argv[++i];
      const norm = raw && raw.toUpperCase();
      if (!norm || !/^[A-Z]{1,2}$/.test(norm)) {
        console.error(`--resume: invalid slot ${JSON.stringify(raw)} (expected 1-2 letters, A-Z or AA-ZZ)`);
        process.exit(2);
      }
      out.resumeSlot = norm;
      continue;
    }
    if (a === '--cwd') { out.cwd = path.resolve(argv[++i]); continue; }
    if (a === '--claude-bin') { out.claudeBin = argv[++i]; continue; }
    if (a === '--max-turns-per-window') { out.maxTurnsPerWindow = Number(argv[++i]); continue; }
    if (a === '--window-budget-usd') { out.windowBudgetUsd = Number(argv[++i]); continue; }
    if (a === '--total-budget-usd') { out.totalBudgetUsd = Number(argv[++i]); continue; }
    if (a === '--max-windows') { out.maxWindows = Number(argv[++i]); continue; }
    if (a.startsWith('--')) { console.error('Unknown flag: ' + a); process.exit(2); }
    rest.push(a);
  }
  if (!out.command) out.command = 'start';
  out.prompt = rest.join(' ').trim();
  return out;
}

function autoStop() {
  fs.mkdirSync(path.dirname(AUTO_SENTINEL), { recursive: true });
  fs.writeFileSync(AUTO_SENTINEL, new Date().toISOString() + '\n');
  console.log('Wrote sentinel: ' + AUTO_SENTINEL);
  console.log('The running auto loop will stop at its next polling tick (≤2s).');
}

function autoStatus() {
  if (!fs.existsSync(AUTO_SESSIONS)) { console.log('No auto sessions yet.'); return; }
  const entries = fs.readdirSync(AUTO_SESSIONS).filter((d) => /^\d{4}-/.test(d)).sort();
  if (entries.length === 0) { console.log('No auto sessions yet.'); return; }
  const latest = entries[entries.length - 1];
  const dir = path.join(AUTO_SESSIONS, latest);
  const summaryPath = path.join(dir, 'summary.json');
  if (fs.existsSync(summaryPath)) {
    console.log('Latest completed session: ' + latest);
    console.log(fs.readFileSync(summaryPath, 'utf8'));
  } else {
    console.log('Latest session (possibly still running): ' + latest);
    console.log('Dir: ' + dir);
    const mainLog = path.join(dir, 'main.log');
    if (fs.existsSync(mainLog)) {
      const tail = fs.readFileSync(mainLog, 'utf8').trim().split('\n').slice(-20).join('\n');
      console.log('--- last 20 log lines ---');
      console.log(tail);
    }
  }
}

async function autoStart(opts) {
  if (!opts.prompt) {
    console.error('auto: a task prompt is required, e.g. `claude-next auto "implement feature X"`');
    process.exit(2);
  }
  const { runAuto } = require(path.join(pkgRoot, 'lib', 'auto.js'));
  await runAuto({
    initialPrompt: opts.prompt,
    cwd: opts.cwd,
    maxTurnsPerWindow: opts.maxTurnsPerWindow,
    windowBudgetUsd: opts.windowBudgetUsd,
    totalBudgetUsd: opts.totalBudgetUsd,
    maxWindows: opts.maxWindows,
    claudeBin: opts.claudeBin,
    debug: opts.debug,
    dryRun: opts.dryRun,
    resumeSlot: opts.resumeSlot,
  });
}

const cmd = process.argv[2];
switch (cmd) {
  case 'install':
    install();
    break;
  case 'auto': {
    const opts = parseAutoArgs(process.argv.slice(3));
    if (opts.command === 'stop') return autoStop();
    if (opts.command === 'status') return autoStatus();
    autoStart(opts).catch((err) => { console.error(err.stack || err); process.exit(1); });
    break;
  }
  case '-v':
  case '--version':
    version();
    break;
  case '-h':
  case '--help':
  case undefined:
    help();
    break;
  case 'help-postinstall':
    process.exit(0);
  default:
    console.error(`Unknown command: ${cmd}`);
    help();
    process.exit(1);
}
