'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

class SessionLogger {
  constructor(opts = {}) {
    const base = opts.baseDir || path.join(os.homedir(), '.claude', 'next', 'auto-sessions');
    fs.mkdirSync(base, { recursive: true });
    this.stamp = opts.stamp || new Date().toISOString().replace(/[:.]/g, '-');
    this.dir = path.join(base, this.stamp);
    fs.mkdirSync(this.dir, { recursive: true });
    this.eventsPath = path.join(this.dir, 'events.jsonl');
    this.mainPath = path.join(this.dir, 'main.log');
    this.summaryPath = path.join(this.dir, 'summary.json');
    this._eventsFd = fs.openSync(this.eventsPath, 'a');
    this._mainFd = fs.openSync(this.mainPath, 'a');
    this.startTs = Date.now();
    this.windowCount = 0;
    this.totalCostUsd = 0;
    this.totalTurns = 0;
  }

  event(type, payload = {}) {
    const rec = { ts: new Date().toISOString(), type, ...payload };
    fs.writeSync(this._eventsFd, JSON.stringify(rec) + '\n');
  }

  log(line) {
    const rec = `[${new Date().toISOString()}] ${line}\n`;
    fs.writeSync(this._mainFd, rec);
    // Write orchestrator meta-logs to STDERR (not stdout). The child
    // Claude's assistant text is written to stdout by auto.js — mixing
    // both on the same stream interleaves them mid-line, making the
    // assistant's text unreadable. Stderr keeps the two streams separable
    // for any consumer that pipes `claude-next auto` output.
    process.stderr.write(rec);
  }

  beginWindow(slot, sessionId) {
    this.windowCount += 1;
    this.event('window_begin', { window: this.windowCount, slot, sessionId });
    this.log(`=== window ${this.windowCount} · slot=${slot} · session=${sessionId} ===`);
  }

  endWindow(slot, info) {
    this.totalCostUsd += info.cost || 0;
    this.totalTurns += info.turns || 0;
    this.event('window_end', { window: this.windowCount, slot, ...info });
    this.log(`--- window ${this.windowCount} end · turns=${info.turns} · cost=$${(info.cost || 0).toFixed(4)} · reason=${info.reason}`);
  }

  writeSummary(extra = {}) {
    const summary = {
      started_at: new Date(this.startTs).toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: Date.now() - this.startTs,
      windows: this.windowCount,
      total_cost_usd: this.totalCostUsd,
      total_turns: this.totalTurns,
      ...extra,
    };
    fs.writeFileSync(this.summaryPath, JSON.stringify(summary, null, 2));
    this.log(`summary written to ${this.summaryPath}`);
    return summary;
  }

  close() {
    try { fs.closeSync(this._eventsFd); } catch (_) {}
    try { fs.closeSync(this._mainFd); } catch (_) {}
  }
}

module.exports = { SessionLogger };
