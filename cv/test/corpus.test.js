// 2.1: the labelled corpus (`corpus/*.json`) and what is measured on it.
// Synthetic offers, labelled by a human reader: each requirement must or
// nice, and `excluded` names the offer says it does not want. A label the
// code gets wrong today says so (`known`): the test holds the code to the
// labels, and a fix must drop the `known` it fixes (a ratchet, both ways).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { corpusProblems, loadCorpus, measureImportance, recall } from '../src/measure.js';
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
