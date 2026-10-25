// 2.28b: replay a stored run through the current code. Its own model
// answers (raw.json, in call order) are fed again to `analyse`, so every
// rule acting on the model's answer shows; no model is called. The
// verdicts are compared with the stored analysis.json.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyse } from './pipeline.js';

const verdicts = (requirements) => new Map((requirements ?? []).map((r) => [String(r.name).trim().toLowerCase(), r]));

/**
 * `{ changed: [{name, before, after}], before: {score}, after: {score} }`;
 * a requirement only one side has shows `null` on the other.
 */
export async function replayRun({ dir, profile, assessment }) {
  const read = (file) => readFileSync(join(dir, file), 'utf8');
  const offer = read('offer.txt');
  const { calls } = JSON.parse(read('raw.json'));
  const stored = JSON.parse(read('analysis.json'));
  let next = 0;
  const llm = async () => {
    if (next >= calls.length) throw new Error(`the current code asks more calls than the run made (${calls.length})`);
    const call = calls[next];
    next += 1;
    return { text: call.text, backend: call.backend };
  };
  const { analysis } = await analyse({ profile, offer, llm, assessment });
  const before = verdicts(stored.requirements);
  const after = verdicts(analysis.requirements);
  const changed = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(key)?.match ?? null;
    const now = after.get(key)?.match ?? null;
    if (old !== now) changed.push({ name: (after.get(key) ?? before.get(key)).name, before: old, after: now });
  }
  return { changed, before: { score: stored.fit?.score ?? null }, after: { score: analysis.fit?.score ?? null } };
}
