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

// Fit on the corpus: each offer says the band an SRE/production profile
// should score (`expected: { band, score: [min, max] }`). Nothing here calls
// a model: scores come from runs already made (scripts/corpus-check.mjs).

/** Score bands, inclusive. */
export const BANDS = { low: [0, 34], mid: [35, 69], high: [70, 100] };

/** The band a 0-100 score falls in. */
export function bandOf(score) {
  return Object.keys(BANDS).find((band) => score <= BANDS[band][1]);
}

/**
 * Scores per corpus id found in `text`: measure-analysis output lines
 * (`<id>: ... score <n>`) and QA log lines (JSON with `offer` and
 * `fit.score`, matched to the corpus by offer text). Other lines are skipped.
 */
export function corpusScores(text, corpus) {
  const ids = new Set(corpus.map((entry) => entry.id));
  const byOffer = new Map(corpus.map((entry) => [String(entry.offer ?? '').trim(), entry.id]));
  const scores = {};
  const push = (id, score) => {
    if (!ids.has(id) || !Number.isFinite(score)) return;
    (scores[id] ??= []).push(score);
  };
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('{')) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      push(byOffer.get(String(entry.offer ?? '').trim()), entry.fit?.score);
      continue;
    }
    const measured = /^(\S+): .*\bscore (\d+)\b/.exec(line);
    if (measured) push(measured[1], Number(measured[2]));
  }
  return scores;
}

/** One row per corpus offer: its scores, their bands, ok / off / unrun. */
export function checkCorpus(corpus, scores) {
  return corpus.map(({ id, expected }) => {
    const got = scores[id] ?? [];
    const [min, max] = expected.score ?? BANDS[expected.band];
    const verdict = got.length === 0 ? 'unrun' : got.every((score) => score >= min && score <= max) ? 'ok' : 'off';
    return { id, expected: expected.band, range: [min, max], scores: got, bands: got.map(bandOf), verdict };
  });
}

/** The acceptance sheet: every corpus offer and the score it should get. */
export function recetteSheet(corpus) {
  const lines = [
    '# Recette du corpus : score attendu par offre',
    '',
    'Écrit par `node scripts/corpus-check.mjs --sheet` depuis `corpus/*.json` (champ `expected`) ;',
    'un test vérifie qu\'il est à jour. Bandes : low 0-34, mid 35-69, high 70-100, pour un',
    'profil SRE / ingénieur de production. `node scripts/corpus-check.mjs <run>` compare un run.',
    '',
    '| offre | bande | score attendu |',
    '| --- | --- | --- |',
    ...corpus.map(({ id, expected }) => `| ${id} | ${expected.band} | ${(expected.score ?? BANDS[expected.band]).join('-')} |`),
  ];
  return `${lines.join('\n')}\n`;
}
