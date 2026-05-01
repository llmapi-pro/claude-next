'use strict';

/**
 * claude-next auto — main autonomous-loop orchestrator.
 *
 * Flow per window:
 *   1. Spawn ClaudeDriver(child Claude Code process via stream-json stdio)
 *   2. Feed initial or continuation prompt as user message
 *   3. Observe assistant output + result events until Rotator says rotate|done
 *   4. If rotate: send `/next` to child, wait for handoff file, kill child,
 *      start new child with `继续 <SLOT>` as first message. Loop.
 *   5. If done: send `/next` for final checkpoint (optional), then exit.
 *
 * Safety:
 *   - Sentinel file ~/.claude/next/auto.stop triggers graceful stop.
 *   - SIGINT / SIGTERM trigger graceful stop.
 *   - Per-window --max-budget-usd passed to child for hard cap.
 *   - Total budget cap enforced in Rotator.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ClaudeDriver } = require('./driver');
const { Rotator } = require('./rotator');
const { SessionLogger } = require('./logger');
const { waitForNewHandoff, readAuditStatus } = require('./handoff-wait');
const { listUsedSlots } = require('./slot');

const SENTINEL_PATH = path.join(os.homedir(), '.claude', 'next', 'auto.stop');

const PREAMBLE = `You are running inside claude-next AUTO mode. An external orchestrator is
driving this session and may rotate to a fresh window at any point.

Protocol:
  - When you finish a turn, continue the task autonomously on the next turn.
  - When context feels full or you've reached a natural checkpoint, emit the
    rotate marker. The marker MUST appear ALONE on its own line — i.e. write
    a line whose only content is exactly [ROTATE] (no surrounding prose, no
    quotes, no Markdown decoration). The orchestrator will then ask you to
    run /next and will start a fresh window reading the handoff.
  - When the entire task is complete, emit the done marker the same way: a
    line whose only content is exactly [DONE].
  - Do NOT mention either marker inside prose, code blocks, or quotes — only
    the bare-marker-on-its-own-line form is recognized, so you can safely
    discuss the markers when explaining what you are doing.
  - Work in small, verifiable steps. Commit progress to files as you go so a
    fresh window can pick up via handoff.
  - Track your own task list via TaskCreate / TaskUpdate.

Your task:
`;

async function runAuto(opts) {
  const {
    initialPrompt,
    cwd = process.cwd(),
    maxTurnsPerWindow = 30,
    windowBudgetUsd = 2.0,
    totalBudgetUsd = 20.0,
    maxWindows = 20,
    claudeBin = 'claude',
    debug = false,
    dryRun = false,
    resumeSlot = null,
  } = opts;

  const logger = new SessionLogger();
  const rotator = new Rotator({ maxTurnsPerWindow, windowBudgetUsd, totalBudgetUsd, maxWindows });
  logger.event('start', { cwd, maxTurnsPerWindow, windowBudgetUsd, totalBudgetUsd, maxWindows, initialPrompt });
  logger.log(`starting auto loop · cwd=${cwd}`);

  let stopRequested = false;
  const stopHandler = () => {
    if (stopRequested) return;
    stopRequested = true;
    logger.log('stop requested (SIGINT/SIGTERM/sentinel)');
  };
  process.once('SIGINT', stopHandler);
  process.once('SIGTERM', stopHandler);

  let currentPrompt = PREAMBLE + initialPrompt;
  let currentSlot = resumeSlot;
  let windowsDone = 0;
  let totalCost = 0;
  let driver = null;

  const cleanupSentinel = () => {
    if (fs.existsSync(SENTINEL_PATH)) try { fs.unlinkSync(SENTINEL_PATH); } catch (_) {}
  };
  cleanupSentinel();

  if (dryRun) {
    logger.log('DRY RUN: would start first window with prompt:');
    logger.log(currentPrompt.slice(0, 500) + (currentPrompt.length > 500 ? '…' : ''));
    logger.writeSummary({ dry_run: true, reason: 'dry-run' });
    logger.close();
    return { reason: 'dry-run', windows: 0 };
  }

  let finalReason = 'unknown';

  try {
    while (!stopRequested) {
      if (fs.existsSync(SENTINEL_PATH)) {
        logger.log('sentinel file found, stopping');
        stopRequested = true;
        break;
      }

      const existingSlots = listUsedSlots();
      driver = new ClaudeDriver({
        cwd,
        claudeBin,
        maxBudgetUsd: windowBudgetUsd,
        extraArgs: [],
        debug,
      });
      if (currentSlot) {
        logger.log(`resuming via handoff · slot=${currentSlot}`);
      }

      rotator.resetWindow();
      driver.spawn();
      logger.beginWindow(currentSlot || '(initial)', driver.sessionId);

      driver.on('assistant', (text) => {
        process.stdout.write(text);
        rotator.observeAssistantText(text);
      });
      driver.on('result', (r) => {
        logger.event('result', { session_id: driver.sessionId, cost_usd: r.total_cost_usd, duration_ms: r.duration_ms });
      });
      driver.on('error', (err) => logger.log(`driver error: ${err.message}`));

      // Feed the prompt
      driver.send(currentPrompt);

      // Wait for rotator decision OR child exit
      const decision = await waitForDecision(driver, rotator, { totalCost, windowsDone, logger, stopSignal: () => stopRequested });

      // Child may still be running. Handle per decision.
      if (decision === 'done') {
        logger.log('rotator says DONE — stopping loop');
        await driver.kill();
        windowsDone += 1;
        totalCost = Math.max(totalCost, driver.cumulativeCostUsd);
        logger.endWindow(currentSlot || '(initial)', { turns: driver.turns, cost: driver.cumulativeCostUsd, reason: 'done' });
        finalReason = 'done';
        break;
      }

      if (decision === 'exit' || decision === 'budget') {
        // Child exited by itself or hit cost limit; try to continue by rotating.
        logger.log(`window ended (reason=${decision}) — rotating`);
      } else if (decision === 'stop') {
        logger.log('external stop — ending window');
        await driver.kill();
        windowsDone += 1;
        totalCost = Math.max(totalCost, driver.cumulativeCostUsd);
        logger.endWindow(currentSlot || '(initial)', { turns: driver.turns, cost: driver.cumulativeCostUsd, reason: 'stop' });
        finalReason = 'stop';
        break;
      }

      // decision === 'rotate': tell child to produce handoff, then kill.
      if (!driver.exited) {
        logger.log('sending /next to current child...');
        try { driver.send('/next'); } catch (_) {}
        // /next skill gates on user "3 秒内无异议" confirmation. Auto-confirm
        // twice (once for the initial gate, once in case audit-subagent wants
        // follow-up input). A no-op "继续" is enough to unblock.
        setTimeout(() => { try { driver.send('继续'); } catch (_) {} }, 8_000);
        setTimeout(() => { try { driver.send('继续'); } catch (_) {} }, 60_000);
        try {
          const result = await waitForNewHandoff({ existingSlots, timeoutMs: 300_000 });
          currentSlot = result.slot;
          logger.event('handoff_created', { slot: currentSlot, verdict: result.verdict });
          logger.log(`handoff ready · slot=${currentSlot} · verdict=${result.verdict}`);
        } catch (e) {
          logger.log('handoff wait failed: ' + e.message);
          currentSlot = null;
        }
      }
      await driver.kill();
      windowsDone += 1;
      totalCost = Math.max(totalCost, driver.cumulativeCostUsd);
      logger.endWindow(currentSlot || '(none)', { turns: driver.turns, cost: driver.cumulativeCostUsd, reason: 'rotate' });

      // Check total budget/cap before next spawn.
      if (totalCost >= totalBudgetUsd) { finalReason = 'budget-exhausted'; break; }
      if (windowsDone >= maxWindows) { finalReason = 'max-windows'; break; }
      if (!currentSlot) { finalReason = 'handoff-failed'; break; }

      currentPrompt = `继续 ${currentSlot}`;
      driver = null;
    }

    if (!finalReason || finalReason === 'unknown') finalReason = stopRequested ? 'stop' : 'done';
  } catch (err) {
    logger.log('fatal: ' + (err && err.stack ? err.stack : err));
    finalReason = 'error';
    if (driver) try { await driver.kill(); } catch (_) {}
  } finally {
    const summary = logger.writeSummary({ reason: finalReason, final_slot: currentSlot });
    logger.close();
    cleanupSentinel();
    console.log('\n━━━ auto loop finished ━━━');
    console.log(JSON.stringify(summary, null, 2));
    // Force-exit. Some providers leave unref'd handles (HTTPS agents, child
    // pipes) that can keep the Node event loop alive for minutes after the
    // logical loop ends; this matters when an orchestrator is wait-ing on us.
    setImmediate(() => process.exit(0));
    return summary;
  }
}

function waitForDecision(driver, rotator, { totalCost, windowsDone, logger, stopSignal }) {
  return new Promise((resolve) => {
    let done = false;
    let iv = null;
    let safetyTimer = null;
    const finish = (val) => {
      if (done) return;
      done = true;
      if (iv) { clearInterval(iv); iv = null; }
      if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
      resolve(val);
    };

    driver.on('exit', () => { finish('exit'); });
    driver.on('result', () => {
      const d = rotator.decide({
        turns: driver.turns,
        windowCost: driver.cumulativeCostUsd,
        totalCost: Math.max(totalCost, driver.cumulativeCostUsd),
        windowsDone,
      });
      if (d) finish(d);
    });

    iv = setInterval(() => {
      if (stopSignal && stopSignal()) { finish('stop'); return; }
      if (fs.existsSync(SENTINEL_PATH)) { finish('stop'); return; }
    }, 2000);
    if (typeof iv.unref === 'function') iv.unref();

    // Safety net: if nothing happens for 30 min, bail.
    safetyTimer = setTimeout(() => {
      if (!done) {
        logger.log('hard timeout 30min — treating as rotate');
        finish('rotate');
      }
    }, 30 * 60 * 1000);
    if (typeof safetyTimer.unref === 'function') safetyTimer.unref();
  });
}

module.exports = { runAuto };
