// Fit on the corpus, checked against runs already made: never calls a model.
//
//   node scripts/corpus-check.mjs <run>... [--sheet]
//
// Each <run> is a file or a directory:
// - a file: measure-analysis output (`node scripts/measure-analysis.mjs ... > run.txt`)
//   or a QA log (`out/qa-log.jsonl`), or both concatenated;
// - a directory: run folders (`offer.txt` + `analysis.json`) found below it.
// Prints, per corpus offer, its scores against its expected band and range,
// and exits 1 when one is off. `--sheet` rewrites corpus/RECETTE.md.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkCorpus, corpusScores, loadCorpus, recetteSheet, runText } from '../src/measure.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { sheet: { type: 'boolean' } } });
const dir = fileURLToPath(new URL('../corpus', import.meta.url));
const corpus = loadCorpus(dir);

if (values.sheet) {
  writeFileSync(join(dir, 'RECETTE.md'), recetteSheet(corpus));
  console.log(`corpus/RECETTE.md: ${corpus.length} offers`);
  if (positionals.length === 0) process.exit(0);
}
if (positionals.length === 0) {
  console.error('usage: node scripts/corpus-check.mjs <run file or directory>... [--sheet]');
  process.exit(2);
}

/** Run folders below `root`, as QA log lines. */
function runLines(root) {
  const lines = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (!statSync(path).isDirectory()) continue;
    if (existsSync(join(path, 'offer.txt')) && existsSync(join(path, 'analysis.json'))) {
      const analysis = JSON.parse(readFileSync(join(path, 'analysis.json'), 'utf8'));
      lines.push(JSON.stringify({ offer: readFileSync(join(path, 'offer.txt'), 'utf8'), fit: { score: analysis.fit?.score } }));
    } else lines.push(...runLines(path));
  }
  return lines;
}

const text = positionals.map((path) => (statSync(path).isDirectory() ? runLines(path).join('\n') : runText(readFileSync(path)))).join('\n');
const rows = checkCorpus(corpus, corpusScores(text, corpus));
for (const row of rows) {
  const got = row.scores.length ? row.scores.map((score, i) => `${score} (${row.bands[i]})`).join(', ') : '-';
  console.log(`${row.verdict.padEnd(5)} ${row.id}: expected ${row.expected} ${row.range.join('-')}, got ${got}`);
}
const count = (verdict) => rows.filter((row) => row.verdict === verdict).length;
console.log(`ok ${count('ok')}, off ${count('off')}, unrun ${count('unrun')}`);
process.exit(count('off') ? 1 : 0);
