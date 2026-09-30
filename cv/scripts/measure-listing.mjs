// 2.1c: recall of the listing call on the labelled corpus, per model.
//
//   node scripts/measure-listing.mjs --url http://127.0.0.1:8789 [--backend <name>] [--schema] [--only <id>]
//
// Each corpus offer goes through `listRequirements` (the router decides the
// model: point `--url` at a router configured for one backend). Prints, per
// offer, the recall and the labels missed, then the total. Nothing is
// written: record the numbers in docs/HANDOVER.md (2.1c).

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { complete } from '../src/llm.js';
import { listRequirements } from '../src/listing.js';
import { loadCorpus, recall } from '../src/measure.js';

const { values } = parseArgs({ options: { url: { type: 'string' }, only: { type: 'string' }, backend: { type: 'string' }, schema: { type: 'boolean' } } });
if (!values.url) {
  console.error('usage: node scripts/measure-listing.mjs --url <router> [--backend <name>] [--only <id>]');
  process.exit(2);
}
const corpus = loadCorpus(fileURLToPath(new URL('../corpus', import.meta.url))).filter((entry) => !values.only || entry.id === values.only);
const llm = ({ system, prompt, schema }) => complete({ url: values.url, system, prompt, schema, backend: values.backend });

let found = 0;
let labels = 0;
let extra = 0;
for (const entry of corpus) {
  const started = Date.now();
  const listed = await listRequirements({ offer: entry.offer, llm, structured: Boolean(values.schema) });
  const result = recall(entry.requirements, listed);
  const excluded = (entry.excluded ?? []).filter((x) => recall([x], listed).found.length);
  found += result.found.length;
  labels += entry.requirements.length;
  extra += listed.length;
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`${entry.id}: ${result.found.length}/${entry.requirements.length} in ${seconds}s, ${listed.length} listed` + (result.missed.length ? `; missed ${result.missed.join(', ')}` : '') + (excluded.length ? `; listed excluded ${excluded.map((x) => x.name).join(', ')}` : ''));
}
console.log(`recall ${found}/${labels} (${Math.round((100 * found) / Math.max(labels, 1))} %), ${extra} items listed`);
