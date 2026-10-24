// A comparative run: one offer through every backend the router serves (or
// those named), then one table of verdicts and why the code made each one
// "adjacent". Nothing is written unless --save.
//
//   node scripts/compare.mjs --url http://127.0.0.1:8789 --profile <profile.json> --offer <offer.txt>
//        [--backends claude-code,lm-studio] [--save <compare.json>]

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { complete } from '../src/llm.js';
import { analyse } from '../src/pipeline.js';
import { loadProfile } from '../src/run.js';
import { compareVerdicts } from '../src/compare.js';

const { values } = parseArgs({ options: { url: { type: 'string' }, profile: { type: 'string' }, offer: { type: 'string' }, backends: { type: 'string' }, save: { type: 'string' } } });
if (!values.url || !values.profile || !values.offer) {
  console.error('usage: node scripts/compare.mjs --url <router> --profile <profile.json> --offer <offer.txt> [--backends a,b] [--save <file>]');
  process.exit(2);
}
let names = values.backends?.split(',').map((name) => name.trim()).filter(Boolean);
if (!names) {
  const status = await (await fetch(new URL('/status', values.url))).json();
  names = status.backends.filter((backend) => backend.state !== 'down').map((backend) => backend.name);
}
const { profile, assessment } = loadProfile(values.profile);
const offer = readFileSync(values.offer, 'utf8');
const runs = {};
for (const backend of names) {
  const started = Date.now();
  try {
    const llm = (request) => complete({ url: values.url, ...request, backend });
    const { analysis, repairs } = await analyse({ profile, offer, llm, assessment });
    runs[backend] = { requirements: analysis.requirements, repairs };
  } catch (error) {
    runs[backend] = { error: error.message.split('\n')[0] };
  }
  console.error(`${backend}: ${Math.round((Date.now() - started) / 1000)} s${runs[backend].error ? `, failed: ${runs[backend].error}` : ''}`);
}
const { rows, failed } = compareVerdicts(runs);
const shown = names.filter((name) => !failed[name]);
console.log(['requirement', ...shown, ''].join(' | '));
for (const row of rows.sort((a, b) => Number(a.agree) - Number(b.agree))) {
  console.log([row.name, ...shown.map((name) => row.verdicts[name] ?? '-'), row.agree ? '' : 'DIFF'].join(' | '));
  for (const [name, why] of Object.entries(row.why)) for (const reason of why) console.log(`    ${name}: ${reason}`);
}
if (values.save) writeFileSync(values.save, `${JSON.stringify({ runs, rows }, null, 2)}\n`);
