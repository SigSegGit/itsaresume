// 2.1: the labelled corpus (`corpus/*.json`) and what is measured on it.
// Synthetic offers, labelled by a human reader: each requirement must or
// nice, and `excluded` names the offer says it does not want. A label the
// code gets wrong today says so (`known`): the test holds the code to the
// labels, and a fix must drop the `known` it fixes (a ratchet, both ways).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { BANDS, bandOf, checkCorpus, corpusProblems, corpusScores, loadCorpus, measureImportance, recall, recetteSheet, runText } from '../src/measure.js';
import { importanceIn } from '../src/importance.js';

const corpus = loadCorpus(fileURLToPath(new URL('../corpus', import.meta.url)));

test('the corpus holds at least 8 offers and 70 labelled requirements', () => {
  assert.ok(corpus.length >= 8, `${corpus.length} offers`);
  const labels = corpus.reduce((sum, entry) => sum + entry.requirements.length, 0);
  assert.ok(labels >= 70, `${labels} labels`);
});

test('every corpus label is named by its offer, once, must or nice', () => {
  assert.deepEqual(corpus.flatMap(corpusProblems), []);
});

test('a label the offer never names is a corpus problem', () => {
  const entry = { id: 'x', offer: 'Kafka serait un plus.', requirements: [{ name: 'Terraform', importance: 'nice' }] };
  assert.equal(corpusProblems(entry).length, 1);
});

test('importance on the corpus: the code is wrong exactly where a label says it is known to be', () => {
  const known = corpus.flatMap((entry) => entry.requirements.filter((r) => r.known).map((r) => `${entry.id}: ${r.name}`));
  const measured = measureImportance(corpus);
  assert.deepEqual(measured.wrong.sort(), known.sort());
  assert.ok(measured.right.length >= 38, `${measured.right.length} right`);
});

test('importance on the corpus: a name the offer excludes is never a must', () => {
  const wrong = corpus.flatMap((entry) => (entry.excluded ?? []).filter((x) => importanceIn(entry.offer, x.name) === 'must').map((x) => `${entry.id}: ${x.name}`));
  const known = corpus.flatMap((entry) => (entry.excluded ?? []).filter((x) => x.known).map((x) => `${entry.id}: ${x.name}`));
  assert.deepEqual(wrong.sort(), known.sort());
});

test('recall finds a label named by a listed item either way round', () => {
  const labels = [{ name: 'Go' }, { name: 'GitHub Actions' }, { name: 'Kafka' }];
  assert.deepEqual(recall(labels, ['Strong Go', { name: 'GitHub' }]), { found: ['Go', 'GitHub Actions'], missed: ['Kafka'] });
});

test('recall does not take a stem for a name', () => {
  assert.deepEqual(recall([{ name: 'Go' }], ['Google Cloud']), { found: [], missed: ['Go'] });
});

test('a label the code contradicts is measured wrong, one it agrees with right', () => {
  const entry = {
    id: 'x',
    offer: 'Kafka serait un plus. Terraform est obligatoire.',
    requirements: [
      { name: 'Kafka', importance: 'must' },
      { name: 'Terraform', importance: 'must' },
    ],
  };
  assert.deepEqual(measureImportance([entry]), { right: ['x: Terraform'], silent: [], wrong: ['x: Kafka'] });
});

// Fit on the corpus: each offer says the score band an SRE/production
// profile should get (`expected`), and corpus-check holds a run to it.

test('every corpus offer expects a band (low, mid, high) and a score range inside 0-100', () => {
  const bad = corpus.filter(({ expected: e }) => !e || !(e.band in BANDS) || !(e.score?.[0] >= 0 && e.score[0] <= e.score[1] && e.score[1] <= 100));
  assert.deepEqual(bad.map((entry) => entry.id), []);
});

test('a score falls in one band: low below 35, mid below 70, high from 70', () => {
  assert.deepEqual([0, 34, 35, 69, 70, 100].map(bandOf), ['low', 'low', 'mid', 'mid', 'high', 'high']);
});

test('corpus scores are read from measure-analysis output and from the QA log, by id or by offer text', () => {
  const entries = [{ id: 'a', offer: 'Offre A' }, { id: 'b', offer: 'Offre B' }];
  const text = [
    'a: 1 attempt(s), labels 3/4, yes 1 adjacent 0 no 3, score 25 (40s)',
    'b: refused: no JSON',
    JSON.stringify({ offer: ' Offre B\n', fit: { score: 80 } }),
    JSON.stringify({ offer: 'Autre offre', fit: { score: 50 } }),
    'labels 3/8, refused 1, retried 0, 80s',
  ].join('\n');
  assert.deepEqual(corpusScores(text, entries), { a: [25], b: [80] });
});

test('a corpus score outside its expected range is flagged, an offer never run is told apart', () => {
  const entries = [
    { id: 'jardinier', expected: { band: 'low', score: [0, 20] } },
    { id: 'sre', expected: { band: 'high', score: [60, 100] } },
    { id: 'cobol', expected: { band: 'low', score: [0, 30] } },
  ];
  const rows = checkCorpus(entries, { jardinier: [10, 45], sre: [75] });
  assert.deepEqual(rows.map((row) => [row.id, row.verdict]), [['jardinier', 'off'], ['sre', 'ok'], ['cobol', 'unrun']]);
  assert.deepEqual(rows[0].bands, ['low', 'mid']);
});

test('the acceptance sheet (corpus/RECETTE.md) is the one written from the corpus', () => {
  assert.equal(readFileSync(fileURLToPath(new URL('../corpus/RECETTE.md', import.meta.url)), 'utf8'), recetteSheet(corpus));
});

test('a run file written by PowerShell 5 (UTF-16, BOM) reads as text, like UTF-8', () => {
  const line = 'fr-x: 1 attempt(s), score 12 (3s)\n';
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(line, 'utf16le')]);
  assert.equal(runText(utf16), line);
  assert.equal(runText(Buffer.from(`﻿${line}`, 'utf8')), line);
  assert.equal(runText(Buffer.from(line, 'utf8')), line);
});
