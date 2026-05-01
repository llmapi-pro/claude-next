'use strict';

/**
 * Rotation policy — decides when the current window should hand off.
 *
 * Signals considered:
 *   - turn count >= maxTurnsPerWindow
 *   - cumulative cost >= windowBudgetUsd
 *   - assistant emitted explicit rotate marker (line-isolated [ROTATE] or [HANDOFF])
 *   - assistant emitted explicit done marker (line-isolated [DONE], [TASK_COMPLETE], or ALL_DONE)
 *
 * Marker matching policy:
 *   Markers must appear ALONE on a line (after trim) — i.e. the assistant
 *   wrote a line whose only content is the marker. This avoids the historic
 *   false-positive class where prose like `the next step is to...` or
 *   `任务完成第一阶段，继续下一步` triggered rotation/done because the
 *   marker substring happened to appear inside running text. We dropped the
 *   ambiguous Chinese marker phrases (`需要换窗`, `任务完成`) entirely for the
 *   same reason — they are too easy to emit by accident; the user can still
 *   trigger rotation explicitly with `[ROTATE]` on its own line.
 *
 * Consumers feed signals via `observe*` methods, and read `decide()` after
 * each turn.
 */

const ROTATE_MARKERS = ['[ROTATE]', '[HANDOFF]', '<ROTATE>', '<HANDOFF>'];
const DONE_MARKERS = ['[DONE]', '[TASK_COMPLETE]', '<DONE>', '<TASK_COMPLETE>', 'ALL_DONE'];

// A small tail buffer so we can detect markers that span chunk boundaries.
// 256 chars is enough for any reasonable marker token plus surrounding line.
const TAIL_KEEP = 256;

class Rotator {
  constructor(cfg = {}) {
    this.maxTurnsPerWindow = cfg.maxTurnsPerWindow || 30;
    this.windowBudgetUsd = cfg.windowBudgetUsd || 2.0;
    this.totalBudgetUsd = cfg.totalBudgetUsd || 20.0;
    this.maxWindows = cfg.maxWindows || 20;
    this._tail = '';
    this._explicitSignal = null;
  }

  observeAssistantText(text) {
    // Carry over a small tail so a marker split across two chunks is still
    // detected on a single line. Guarantees bounded memory regardless of
    // total assistant output size.
    const blob = (this._tail + text);
    this._tail = blob.length > TAIL_KEEP ? blob.slice(-TAIL_KEEP) : blob;

    // Inspect line by line, requiring the marker to be the entire line
    // (after trim). This is the false-positive guard — marker as substring
    // inside prose no longer fires.
    const lines = blob.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (ROTATE_MARKERS.includes(line)) this._explicitSignal = 'rotate';
      if (DONE_MARKERS.includes(line)) this._explicitSignal = 'done';
    }
  }

  resetWindow() {
    this._tail = '';
    this._explicitSignal = null;
  }

  /**
   * Return one of: null (keep going), 'rotate' (handoff now), 'done' (stop entirely).
   */
  decide({ turns, windowCost, totalCost, windowsDone }) {
    if (this._explicitSignal === 'done') return 'done';
    if (totalCost >= this.totalBudgetUsd) return 'done';
    if (windowsDone >= this.maxWindows) return 'done';
    if (this._explicitSignal === 'rotate') return 'rotate';
    if (turns >= this.maxTurnsPerWindow) return 'rotate';
    if (windowCost >= this.windowBudgetUsd) return 'rotate';
    return null;
  }
}

module.exports = { Rotator, ROTATE_MARKERS, DONE_MARKERS };
