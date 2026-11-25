#!/usr/bin/env node
// 2026-11-25: the premium base back from its encrypted journal, on the
// owner's machine, with his age identity (never on the VM).
//   node premium/journal-restore.js <journal folder> <identity file> <out.db>
// Prints the chain, the changesets applied, integrity and counts; exit 0
// only when the restored base is sound.
import { readFileSync } from 'node:fs';
import { restoreJournal } from './journal.js';

const [dir, identity, out] = process.argv.slice(2);
if (!dir || !identity || !out) {
  process.stderr.write('usage: node premium/journal-restore.js <journal folder> <identity file> <out.db>\n');
  process.exit(2);
}
try {
  const result = restoreJournal(dir, readFileSync(identity, 'utf8'), out);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.integrity === 'ok' ? 0 : 1;
} catch (error) {
  process.stderr.write(`journal-restore: ${error.message}\n`);
  process.exitCode = 1;
}
