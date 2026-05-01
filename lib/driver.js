'use strict';

/**
 * Claude Code driver — spawns a single `claude --print --input-format stream-json
 * --output-format stream-json` child and exposes:
 *   - send(userText)        → feed a user message
 *   - onAssistant(cb)       → subscribe to assistant text chunks
 *   - onResult(cb)          → subscribe to per-turn result events (cost, duration)
 *   - onExit(cb)            → subscribe to child exit
 *   - kill()                → graceful SIGTERM, then SIGKILL after timeout
 *
 * NDJSON over stdio — zero runtime deps.
 */

const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

class ClaudeDriver {
  constructor(opts = {}) {
    this.cmd = opts.claudeBin || 'claude';
    this.cwd = opts.cwd || process.cwd();
    this.sessionId = opts.sessionId || randomUUID();
    this.resumeId = opts.resumeId || null;
    this.maxBudgetUsd = opts.maxBudgetUsd || null;
    this.permissionMode = opts.permissionMode || 'bypassPermissions';
    this.extraArgs = opts.extraArgs || [];
    this.debug = !!opts.debug;
    this._listeners = { assistant: [], result: [], exit: [], raw: [], error: [] };
    this._buffer = '';
    this._child = null;
    this._exited = false;
    this._turnCount = 0;
    this._cumCost = 0;
    this._lastResult = null;
  }

  spawn() {
    if (this._child) throw new Error('Driver already spawned');
    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', this.permissionMode,
    ];
    if (this.resumeId) {
      args.push('--resume', this.resumeId);
    } else {
      args.push('--session-id', this.sessionId);
    }
    if (this.maxBudgetUsd != null) args.push('--max-budget-usd', String(this.maxBudgetUsd));
    args.push(...this.extraArgs);

    if (this.debug) console.error('[driver] spawn', this.cmd, args.join(' '));
    this._child = spawn(this.cmd, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._child.stdout.on('data', (b) => this._onStdout(b));
    this._child.stderr.on('data', (b) => {
      if (this.debug) process.stderr.write('[claude.stderr] ' + b.toString());
    });
    this._child.on('exit', (code, signal) => {
      this._exited = true;
      for (const cb of this._listeners.exit) cb({ code, signal });
    });
    this._child.on('error', (err) => {
      for (const cb of this._listeners.error) cb(err);
    });
  }

  send(userText) {
    if (!this._child || this._exited) throw new Error('Driver not ready');
    const msg = { type: 'user', message: { role: 'user', content: userText } };
    this._child.stdin.write(JSON.stringify(msg) + '\n');
    this._turnCount += 1;
  }

  endInput() {
    if (this._child && !this._exited) this._child.stdin.end();
  }

  _onStdout(buf) {
    this._buffer += buf.toString();
    let nl;
    while ((nl = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, nl);
      this._buffer = this._buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      this._dispatch(obj);
    }
  }

  _dispatch(obj) {
    for (const cb of this._listeners.raw) cb(obj);
    const type = obj.type;
    if (type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
      for (const part of obj.message.content) {
        if (part.type === 'text' && part.text) {
          for (const cb of this._listeners.assistant) cb(part.text, obj);
        }
      }
    } else if (type === 'result') {
      if (typeof obj.total_cost_usd === 'number') this._cumCost = obj.total_cost_usd;
      this._lastResult = obj;
      for (const cb of this._listeners.result) cb(obj);
    } else if (type === 'system' && obj.subtype === 'init' && obj.session_id) {
      this.sessionId = obj.session_id;
    }
  }

  on(event, cb) {
    if (!this._listeners[event]) throw new Error('Unknown event: ' + event);
    this._listeners[event].push(cb);
    return () => {
      this._listeners[event] = this._listeners[event].filter((x) => x !== cb);
    };
  }

  get turns() { return this._turnCount; }
  get cumulativeCostUsd() { return this._cumCost; }
  get lastResult() { return this._lastResult; }
  get exited() { return this._exited; }

  async kill(timeoutMs = 5000) {
    if (!this._child || this._exited) return;
    try { this._child.stdin.end(); } catch (_) {}
    this._child.kill('SIGTERM');
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        if (!this._exited) try { this._child.kill('SIGKILL'); } catch (_) {}
        resolve();
      }, timeoutMs);
      this._child.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }
}

module.exports = { ClaudeDriver };
