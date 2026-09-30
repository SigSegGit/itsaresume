// 2.1: quality measured on a labelled corpus (`corpus/*.json`), since real
// offers are too few to discriminate. Each file is a synthetic offer and the
// requirements a human reader finds in it, each must or nice.
//
// Two measures, each against the labels:
// - importance: what `importanceIn` decides from the offer's cues. Silent
//   (no cue: the model's reading stands) is not wrong; the opposite of the
//   label is, and a label may say it is a known miss (`known`).
// - recall: which labelled requirements a listing (the model's, or any
//   list of names) holds, by name either way round.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importanceIn } from './importance.js';
import { mentions } from './text.js';

/** Every corpus entry in `dir`, sorted by file name. */
export function loadCorpus(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')));
}

/** Problems that make an entry unfit to measure anything with. */
export function corpusProblems(entry) {
  const problems = [];
  const names = new Set();
  for (const requirement of entry.requirements ?? []) {
    if (!['must', 'nice'].includes(requirement.importance)) problems.push(`${entry.id}: ${requirement.name}: importance must be must or nice`);
    if (!mentions(entry.offer, requirement.name)) problems.push(`${entry.id}: ${requirement.name}: the offer never names it`);
    if (names.has(requirement.name.toLowerCase())) problems.push(`${entry.id}: ${requirement.name}: labelled twice`);
    names.add(requirement.name.toLowerCase());
  }
  if (!(entry.requirements ?? []).length) problems.push(`${entry.id}: no requirement labelled`);
  return problems;
}

/**
 * The code's must/nice against the labels: `right`, `silent` (no cue) and
 * `wrong` (the opposite), each a list of `id: name`.
 */
export function measureImportance(corpus) {
  const result = { right: [], silent: [], wrong: [] };
  for (const entry of corpus) {
    for (const requirement of entry.requirements) {
      const decided = importanceIn(entry.offer, requirement.name);
      const where = `${entry.id}: ${requirement.name}`;
      if (decided === null) result.silent.push(where);
      else if (decided === requirement.importance) result.right.push(where);
      else result.wrong.push(where);
    }
  }
  return result;
}

/**
 * Which labelled requirements `listed` (names) holds: a listed name that
 * names the label, or that the label names ("Go" in "Strong Go").
 */
export function recall(labels, listed) {
  const names = listed.map((item) => (typeof item === 'string' ? item : item.name)).filter(Boolean);
  const found = [];
  const missed = [];
  for (const label of labels) {
    const hit = names.some((name) => mentions(name, label.name) || mentions(label.name, name));
    (hit ? found : missed).push(label.name);
  }
  return { found, missed };
}
