'use strict';

/**
 * Rotation policy — decides when the current window should hand off.
 *
 * Signals considered:
 *   - turn count >= maxTurnsPerWindow
 *   - cumulative cost >= windowBudgetUsd
 *   - assistant emitted explicit marker [ROTATE] or [HANDOFF]
 *   - assistant emitted explicit done marker [DONE] or [TASK_COMPLETE]
 *
 * Consumers feed signals via `observe*` methods, and read `decide()` after
 * each turn.
 */

const ROTATE_MARKERS = ['[ROTATE]', '[HANDOFF]', '<ROTATE>', '<HANDOFF>', '需要换窗'];
const DONE_MARKERS = ['[DONE]', '[TASK_COMPLETE]', '<DONE>', '<TASK_COMPLETE>', '任务完成', 'ALL_DONE'];

class Rotator {
  constructor(cfg = {}) {
    this.maxTurnsPerWindow = cfg.maxTurnsPerWindow || 30;
    this.windowBudgetUsd = cfg.windowBudgetUsd || 2.0;
    this.totalBudgetUsd = cfg.totalBudgetUsd || 20.0;
    this.maxWindows = cfg.maxWindows || 20;
    this._seenAssistantText = '';
    this._explicitSignal = null;
  }

  observeAssistantText(text) {
    this._seenAssistantText += '\n' + text;
    for (const m of ROTATE_MARKERS) if (text.includes(m)) this._explicitSignal = 'rotate';
    for (const m of DONE_MARKERS) if (text.includes(m)) this._explicitSignal = 'done';
  }

  resetWindow() {
    this._seenAssistantText = '';
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
