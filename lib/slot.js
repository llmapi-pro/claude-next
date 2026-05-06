'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Honor NEXT_PENDING_DIR / NEXT_HOME so the JS lib (auto mode) sees the same
// directory as the shell scripts when those env vars are set. Without this,
// auto mode + a custom NEXT_HOME would write the handoff in one place and
// look for it in another.
const PENDING_DIR = process.env.NEXT_PENDING_DIR
  || path.join(process.env.NEXT_HOME || path.join(os.homedir(), '.claude', 'next'), 'pending');

function ensurePendingDir() {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
}

// Slot file = `<UPPERCASE LETTERS>.md`. Anything else in the pending dir is
// either an unrelated file or one of our own intermediate artifacts (e.g.
// `<SLOT>.audit-passA.md` written by the audit subagent before
// audit-finalize.sh consumes it). Filtering here is the single source of
// truth — everything that lists slots calls this.
//
// Length cap {1,2}: matches what allocateSlot below actually produces (A-Z,
// AA-ZZ). Pre-0.2.9 this was {1,3} — a forward-compat allowance the allocator
// never produced. Tightened in 0.2.9 to align with the ingest.sh regex, which
// must reject 3-letter English words to avoid false-positive triggering on
// "next step", "drop the", etc.
const SLOT_FILE_RE = /^[A-Z]{1,2}\.md$/;

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
