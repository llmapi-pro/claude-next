'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PENDING_DIR = path.join(os.homedir(), '.claude', 'next', 'pending');

function ensurePendingDir() {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
}

function listUsedSlots() {
  ensurePendingDir();
  return fs.readdirSync(PENDING_DIR)
    .filter((f) => f.endsWith('.md'))
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

module.exports = { allocateSlot, listUsedSlots, slotFile, PENDING_DIR, ensurePendingDir };
