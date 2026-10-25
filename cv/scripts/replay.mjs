// 2.28b: every stored run of an out directory replayed through the current
// code, from its own model answers (no model call). Prints, per run, the
// verdicts that change and the score before -> after. Nothing is written.
//
//   node scripts/replay.mjs --profile <profile.json> --out <runs dir> [--only <substring>]

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadProfile } from '../src/run.js';
import { replayRun } from '../src/replay.js';

const { values } = parseArgs({ options: { profile: { type: 'string' }, out: { type: 'string' }, only: { type: 'string' } } });
if (!values.profile || !values.out) {
  console.error('usage: node scripts/replay.mjs --profile <profile.json> --out <runs dir> [--only <substring>]');
  process.exit(2);
}
const { profile, assessment } = loadProfile(values.profile);
const runs = readdirSync(values.out).filter((name) => (!values.only || name.includes(values.only))
  && ['raw.json', 'offer.txt', 'analysis.json'].every((file) => existsSync(join(values.out, name, file))));
let moved = 0;
for (const name of runs.sort()) {
  try {
    const { changed, before, after } = await replayRun({ dir: join(values.out, name), profile, assessment });
    if (changed.length === 0 && before.score === after.score) continue;
    moved += 1;
    console.log(`${name}: score ${before.score} -> ${after.score}`);
    for (const row of changed) console.log(`    ${row.name}: ${row.before ?? '-'} -> ${row.after ?? '-'}`);
  } catch (error) {
    console.log(`${name}: not replayed: ${error.message.split('\n')[0]}`);
  }
}
console.log(`${runs.length} run(s) replayed, ${moved} changed`);
