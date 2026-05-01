'use strict';

const fs = require('fs');
const path = require('path');
const { PENDING_DIR, ensurePendingDir, listUsedSlots } = require('./slot');

const TERMINAL_VERDICTS = new Set(['passed', 'warnings', 'failed', 'aborted']);

/**
 * Wait for a NEW handoff file (slot) to appear, AND for its `audit_status`
 * to reach a terminal verdict (passed | warnings | failed | aborted).
 *
 * Returns { slot, verdict } once observed.
 *
 * Behavior notes:
 *   - We wait for two distinct conditions in sequence: (a) the file appears in
 *     PENDING_DIR with a fresh slot name, then (b) its audit_status moves off
 *     `pending` / `in_progress` / `writing` to a terminal value.
 *   - If timeoutMs elapses while we're stuck on stage (b) (file exists but
 *     audit never finished), we resolve with verdict='aborted' so the caller
 *     can still pick it up rather than falling through to a hard error path.
 *     The aborted verdict propagates to the consumer via the standard ingest
 *     warning, so users still see the truth.
 */
function waitForNewHandoff(opts = {}) {
  const { timeoutMs = 300_000, existingSlots = null, requireAudit = true } = opts;
  ensurePendingDir();
  const before = new Set(existingSlots || listUsedSlots());

  return new Promise((resolve, reject) => {
    let watcher = null;
    let interval = null;
    let timer = null;
    let done = false;
    let pendingSlot = null; // a new slot file appeared but audit not yet terminal

    const cleanup = () => {
      if (watcher) try { watcher.close(); } catch (_) {}
      if (interval) clearInterval(interval);
      if (timer) clearTimeout(timer);
    };
    const finish = (val, err) => {
      if (done) return;
      done = true;
      cleanup();
      if (err) reject(err); else resolve(val);
    };

    const check = () => {
      const now = listUsedSlots();
      for (const slot of now) {
        if (before.has(slot)) continue;
        if (!requireAudit) return finish({ slot, verdict: 'unknown' });
        const verdict = readAuditStatus(slot);
        if (verdict && TERMINAL_VERDICTS.has(verdict)) {
          return finish({ slot, verdict });
        }
        // File exists but audit not done yet — remember the slot for the
        // timeout fallback path.
        pendingSlot = slot;
      }
    };

    try {
      watcher = fs.watch(PENDING_DIR, { persistent: false }, () => setTimeout(check, 200));
    } catch (e) {
      // fs.watch can fail on some platforms; we still have the polling fallback.
    }
    interval = setInterval(check, 1500);
    check();

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (pendingSlot) {
          // File showed up but audit never completed — return as aborted.
          return finish({ slot: pendingSlot, verdict: 'aborted' });
        }
        finish(null, new Error(`Timed out waiting for handoff after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
  });
}

function readAuditStatus(slot) {
  const p = path.join(PENDING_DIR, slot + '.md');
  if (!fs.existsSync(p)) return null;
  // Strip CR so a CRLF-saved handoff (Windows editor / git autocrlf) parses
  // identically to LF. Without this strip, the regex below silently fails to
  // match and we always report 'pending' — which would make auto-mode wait
  // for the full timeout on every CRLF handoff before giving up.
  const text = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return 'pending';
  const line = fmMatch[1].split('\n').find((l) => l.startsWith('audit_status:'));
  if (!line) return 'pending';
  return line.split(':', 2)[1].trim();
}

module.exports = { waitForNewHandoff, readAuditStatus, TERMINAL_VERDICTS };
