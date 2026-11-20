#!/usr/bin/env node
// 6.4g: the restore test of a premium snapshot, wherever it was synced to.
//   node premium/restore-check.js <premium-YYYYMMDDHH.db> [the live premium.db]
// Opens the copy with createStore(), runs SQLite's integrity check and prints
// its counts; given the live database too, says whether the counts agree.
// Exit 0 only when the copy is sound (and agrees, when compared).
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createStore } from './accounts.js';

/** A copy of the file, opened: the snapshot itself is never written to. */
function open(file) {
  const dir = mkdtempSync(join(tmpdir(), 'premium-restore-'));
  const copy = join(dir, basename(file));
  copyFileSync(file, copy);
  const store = createStore(copy);
  return { store, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

export function restoreCheck(snapshot, live = null) {
  const copy = open(snapshot);
  try {
    const result = { integrity: copy.store.verify(), stats: copy.store.stats() };
    if (live) {
      const other = open(live);
      try {
        result.live = other.store.stats();
        result.same = JSON.stringify(result.live) === JSON.stringify(result.stats);
      } finally {
        other.done();
      }
    }
    result.ok = result.integrity === 'ok' && result.same !== false;
    return result;
  } finally {
    copy.done();
  }
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const [snapshot, live] = process.argv.slice(2);
  if (!snapshot) {
    console.error('usage: node premium/restore-check.js <snapshot.db> [live premium.db]');
    process.exit(2);
  }
  const result = restoreCheck(snapshot, live);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
