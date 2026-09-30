// 2.9: the stem that decides whether two words are one ("stated in the
// offer", a bullet backed by its quotes, a requirement grounded in skills).
// The six-letter prefix made "product" and "production" one word.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stem, statedIn } from '../src/text.js';

const SAME = [
  ['conteneurs', 'conteneurisation'],
  ['services', 'service'],
  ['process', 'processes'],
  ['deploy', 'deployed'],
  ['deploy', 'deploying'],
  ['develop', 'developer'],
  ['develop', 'development'],
  ['déploiement', 'déploiements'],
  ['automatisation', 'automatiser'],
  ['automation', 'automated'],
  ['orchestration', 'orchestrateur'],
  ['orchestration', 'orchestrator'],
  ['virtualisation', 'virtualization'],
  ['données', 'donnée'],
  // From the replay of the real runs (2026-09-30): both were matches.
  ['architectes', 'architecture'],
  ['expérimenté', 'expérience'],
];

const DIFFERENT = [
  ['product', 'production'],
  ['products', 'productions'],
  ['config', 'configuration'],
];

for (const [a, b] of SAME) {
  test(`stem: ${a} and ${b} are one word`, () => assert.equal(stem(a), stem(b)));
}

for (const [a, b] of DIFFERENT) {
  test(`stem: ${a} and ${b} are two words`, () => assert.notEqual(stem(a), stem(b)));
}

test('stem: a short root is never cut below four letters', () => {
  assert.equal(stem('gestion'), 'gestion');
  assert.equal(stem('bases'), 'base');
});

test('a requirement "Product ownership" is not stated by an offer that says production', () => {
  assert.equal(statedIn('Vous garantissez la disponibilité de la production.', 'Product ownership'), false);
  assert.equal(statedIn('Vous assurez la conteneurisation des applications.', 'Conteneurs'), true);
});
