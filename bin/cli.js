#!/usr/bin/env node
/**
 * claude-next CLI
 *
 * Copies the skill files from this npm package into ~/.claude/skills/next/
 * and runs the install.sh script to register the UserPromptSubmit hook.
 *
 * Usage:
 *   npx claude-next install
 *   npx claude-next --version
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const pkgRoot = path.resolve(__dirname, '..');
const pkg = require(path.join(pkgRoot, 'package.json'));

const HOME = os.homedir();
const TARGET = path.join(HOME, '.claude', 'skills', 'next');

// What to copy from the npm package into the target skill directory.
const ITEMS = ['scripts', 'templates', 'SKILL.md', 'install.sh', 'README.md'];

function copyRecursive(src, dst) {
  if (typeof fs.cpSync === 'function') {
    fs.cpSync(src, dst, { recursive: true, force: true });
    return;
  }
  // Fallback for older Node (pre-16.7)
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
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
    if (!fs.existsSync(src)) {
      console.error(`[claude-next] Missing expected file in package: ${item}`);
      process.exit(1);
    }
    copyRecursive(src, dst);
  }

  // chmod scripts + install.sh
  try {
    const scriptsDir = path.join(TARGET, 'scripts');
    for (const f of fs.readdirSync(scriptsDir)) {
      if (f.endsWith('.sh')) fs.chmodSync(path.join(scriptsDir, f), 0o755);
    }
    fs.chmodSync(path.join(TARGET, 'install.sh'), 0o755);
  } catch (_) {
    // best-effort; Windows may not honor chmod
  }

  console.log('[claude-next] Running install.sh...\n');
  const installSh = path.join(TARGET, 'install.sh');
  const result = spawnSync('bash', [installSh], { stdio: 'inherit', cwd: TARGET });

  if (result.error) {
    console.error('[claude-next] Failed to run bash install.sh:', result.error.message);
    console.error('[claude-next] Ensure `bash` is available (Git-bash on Windows).');
    console.error('[claude-next] You can also run it manually: bash', installSh);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function version() {
  console.log(pkg.version);
}

function help() {
  console.log(`claude-next v${pkg.version}`);
  console.log('');
  console.log('Usage:');
  console.log('  npx claude-next install          Install the /next skill + hook into ~/.claude/');
  console.log('  npx claude-next --version        Print version and exit');
  console.log('  npx claude-next --help           This help');
  console.log('');
  console.log('After install, use /next in Claude Code to produce an audited handoff.');
  console.log('In a new window, paste `continue A` (or `继续 A`) as the first message.');
  console.log('');
  console.log('Repo:  https://github.com/llmapi-pro/claude-next');
}

const cmd = process.argv[2];
switch (cmd) {
  case 'install':
    install();
    break;
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
    // Silent for npm postinstall hook — only log if installed globally?
    process.exit(0);
  default:
    console.error(`Unknown command: ${cmd}`);
    help();
    process.exit(1);
}
