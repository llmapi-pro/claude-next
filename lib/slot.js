'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PENDING_DIR = path.join(os.homedir(), '.claude', 'next', 'pending');

function ensurePendingDir() {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
}

// Slot file = `<UPPERCASE LETTERS>.md`. Anything else in the pending dir is
// either an unrelated file or one of our own intermediate artifacts (e.g.
// `<SLOT>.audit-passA.md` written by the audit subagent before
// audit-finalize.sh consumes it). Filtering here is the single source of
// truth — everything that lists slots calls this.
const SLOT_FILE_RE = /^[A-Z]{1,3}\.md$/;

function listUsedSlots() {
  ensurePendingDir();
  return fs.readdirSync(PENDING_DIR)
    .filter((f) => SLOT_FILE_RE.test(f))
    .map((f) => f.slice(0, -3));
}

function allocateSlot() {
  const used = new Set(listUsedSlots());
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const L of letters) if (!used.has(L)) return L;
  for (const L1 of letters) for (const L2 of letters) {
    if (!used.has(L1 + L2)) return L1 + L2;
  }
  throw new Error('Slot space exhausted (>676 pending handoffs)');
}

function slotFile(slot) {
  return path.join(PENDING_DIR, `${slot}.md`);
}

module.exports = { allocateSlot, listUsedSlots, slotFile, PENDING_DIR, ensurePendingDir, SLOT_FILE_RE };
