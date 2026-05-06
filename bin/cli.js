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
const AUTO_SENTINEL = path.join(HOME, '.claude', 'next', 'auto.stop');
const AUTO_SESSIONS = path.join(HOME, '.claude', 'next', 'auto-sessions');

const ITEMS = ['scripts', 'templates', 'SKILL.md', 'install.sh', 'README.md'];

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

function install() {
  console.log('[claude-next] Installing skill files to:', TARGET);
  fs.mkdirSync(TARGET, { recursive: true });
  for (const item of ITEMS) {
    const src = path.join(pkgRoot, item);
    const dst = path.join(TARGET, item);
    if (!fs.existsSync(src)) { console.error(`[claude-next] Missing: ${item}`); process.exit(1); }
    copyRecursive(src, dst);
  }
  try {
    const scriptsDir = path.join(TARGET, 'scripts');
    for (const f of fs.readdirSync(scriptsDir)) {
      if (f.endsWith('.sh')) fs.chmodSync(path.join(scriptsDir, f), 0o755);
    }
    fs.chmodSync(path.join(TARGET, 'install.sh'), 0o755);
  } catch (_) {}
  console.log('[claude-next] Running install.sh...\n');
  const result = spawnSync('bash', [path.join(TARGET, 'install.sh')], { stdio: 'inherit', cwd: TARGET });
  if (result.error) { console.error('[claude-next] bash failed:', result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status || 1);
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
