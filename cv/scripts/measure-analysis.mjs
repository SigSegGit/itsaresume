// 2.3: the analysis call on the labelled corpus, with or without its schema
// (ids closed to the catalogue), per model.
//
//   node scripts/measure-analysis.mjs --url http://127.0.0.1:8789 --profile <profile.json>
//        [--backend <name>] [--schema] [--only <id>] [--save <run.json>] [--against <run.json>]
//
// Each corpus offer goes through the real `analyse` (listing, analysis, one
// retry). Prints, per offer: attempts, refused or not, the labels the
// analysis kept, the verdicts (yes/adjacent/no) and the score. `--save`
// writes every verdict; `--against` compares this run's verdicts with a
// saved one on the requirements both name. Nothing else is written: record
// the numbers in docs/HANDOVER.md (2.3).

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { complete } from '../src/llm.js';
import { analyse } from '../src/pipeline.js';
import { loadProfile } from '../src/run.js';
import { loadCorpus, recall } from '../src/measure.js';
import { scoreOf } from '../src/score.js';

const { values } = parseArgs({ options: { url: { type: 'string' }, profile: { type: 'string' }, only: { type: 'string' }, backend: { type: 'string' }, schema: { type: 'boolean' }, save: { type: 'string' }, against: { type: 'string' } } });
if (!values.url || !values.profile) {
  console.error('usage: node scripts/measure-analysis.mjs --url <router> --profile <profile.json> [--backend <name>] [--schema] [--only <id>] [--save <file>] [--against <file>]');
  process.exit(2);
}
const { profile, assessment } = loadProfile(values.profile);
const lab = new Set(profile.skills.filter((skill) => skill.level === 'lab').map((skill) => skill.id));
const corpus = loadCorpus(fileURLToPath(new URL('../corpus', import.meta.url))).filter((entry) => !values.only || entry.id === values.only);
const llm = (request) => complete({ url: values.url, ...request, backend: values.backend });
const before = values.against ? JSON.parse(readFileSync(values.against, 'utf8')) : undefined;

const saved = {};
const total = { found: 0, labels: 0, refused: 0, retried: 0, same: 0, shared: 0, seconds: 0 };
for (const entry of corpus) {
  const started = Date.now();
  let line;
  try {
    const { analysis, attempts } = await analyse({ profile, offer: entry.offer, llm, assessment, structured: Boolean(values.schema) });
    const requirements = analysis.requirements;
    const found = recall(entry.requirements, requirements).found.length;
    const count = (match) => requirements.filter((r) => r.match === match).length;
    saved[entry.id] = Object.fromEntries(requirements.map((r) => [r.name.toLowerCase(), r.match]));
    total.found += found;
    total.retried += attempts > 1 ? 1 : 0;
    line = `${attempts} attempt(s), labels ${found}/${entry.requirements.length}, yes ${count('yes')} adjacent ${count('adjacent')} no ${count('no')}, score ${scoreOf(requirements, { lab })}`;
    if (before?.[entry.id]) {
      const shared = Object.keys(saved[entry.id]).filter((name) => name in before[entry.id]);
      const same = shared.filter((name) => before[entry.id][name] === saved[entry.id][name]).length;
      total.same += same;
      total.shared += shared.length;
      line += `, verdicts as saved ${same}/${shared.length}`;
    }
  } catch (error) {
    total.refused += 1;
    line = `refused: ${error.message.split('\n')[0]}`;
  }
  total.labels += entry.requirements.length;
  const seconds = Math.round((Date.now() - started) / 1000);
  total.seconds += seconds;
  console.log(`${entry.id}: ${line} (${seconds}s)`);
}
console.log(`labels ${total.found}/${total.labels}, refused ${total.refused}, retried ${total.retried}, ${total.seconds}s` + (before ? `, verdicts as saved ${total.same}/${total.shared}` : ''));
if (values.save) writeFileSync(values.save, JSON.stringify(saved, null, 2));
