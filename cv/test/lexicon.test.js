// The lexicon: an offer's words and the owner's, linked through ESCO concepts,
// in French and English, by code alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, key, lookup, relate, skillConcepts } from '../src/lexicon.js';

/** A few ESCO-shaped concepts: two tools under one family, a theme above it. */
const CONCEPTS = [
  { id: 'ict', fr: 'technologies de l’information', en: 'information technology', alt: {}, broader: [] },
  { id: 'cfg', fr: 'outils de gestion de configuration logicielle', en: 'tools for software configuration management', alt: { fr: ['gestion de configuration'], en: ['configuration management'] }, broader: ['ict'] },
  { id: 'ansible', fr: 'Ansible', en: 'Ansible', alt: {}, broader: ['cfg'] },
  { id: 'puppet', fr: 'Puppet (outils de gestion de configuration logicielle)', en: 'Puppet (tools for software configuration management)', alt: { en: ['Puppet'], fr: ['Puppet'] }, broader: ['cfg'] },
  { id: 'db', fr: 'bases de données', en: 'databases', alt: {}, broader: ['ict'] },
  { id: 'pg', fr: 'PostgreSQL', en: 'PostgreSQL', alt: {}, broader: ['db'] },
  { id: 'talk', fr: 'communiquer', en: 'communicate', alt: { fr: ['communication'] }, broader: [] },
  { id: 'mgmt', fr: 'gestion', en: 'management', alt: {}, broader: [] },
];
const index = buildIndex(CONCEPTS);

test('a phrase is keyed without case, accents or punctuation', () => {
  assert.equal(key('Étude d’Architecture, cible !'), 'etude d architecture cible');
  assert.equal(key('C++ / C#'), 'c++ c#');
});

test('a label or a synonym is found in French or English, alone or inside a longer phrase', () => {
  assert.deepEqual(lookup(index, 'Ansible'), ['ansible']);
  assert.deepEqual(lookup(index, 'Configuration management'), ['cfg']);
  assert.deepEqual(lookup(index, 'Bonne maîtrise de la gestion de configuration'), ['cfg']);
  assert.deepEqual(lookup(index, 'Expérience pratique d’Ansible et de PostgreSQL').sort(), ['ansible', 'pg']);
  assert.deepEqual(lookup(index, 'Kubernetes'), []);
});

test('a longer label wins over the shorter one it contains', () => {
  assert.deepEqual(lookup(index, 'outils de gestion de configuration logicielle'), ['cfg']);
  assert.deepEqual(lookup(index, 'La gestion de configuration'), ['cfg'], '"gestion" alone is not also found');
});

test('the owner’s skills are placed on concepts by their names, aliases and terms, in either language', () => {
  const skills = skillConcepts(index, [
    { id: 'ansible', name: 'Ansible', aliases: [], terms: [] },
    { id: 'iac', name: 'Automatisation', aliases: [], terms: ['configuration management'] },
    { id: 'rust', name: 'Rust', aliases: [], terms: [] },
  ]);
  assert.deepEqual([...skills.get('ansible')], ['ansible']);
  assert.deepEqual([...skills.get('iac')], ['cfg']);
  assert.equal(skills.has('rust'), false, 'a skill ESCO does not know is left out, not guessed');
});

test('a requirement relates to a skill as the same concept, a near one (parent, child, sibling), a shared theme, or not at all', () => {
  const skills = skillConcepts(index, [{ id: 'ansible', name: 'Ansible' }, { id: 'pg', name: 'PostgreSQL' }]);
  assert.deepEqual(relate(index, 'Ansible', skills), [{ skill: 'ansible', relation: 'same', concept: 'ansible' }]);
  assert.deepEqual(relate(index, 'Puppet', skills), [{ skill: 'ansible', relation: 'near', concept: 'puppet' }]);
  assert.deepEqual(relate(index, 'Gestion de configuration', skills), [{ skill: 'ansible', relation: 'near', concept: 'cfg' }]);
  assert.deepEqual(relate(index, 'Bases de données', skills), [{ skill: 'pg', relation: 'near', concept: 'db' }]);
  assert.deepEqual(relate(index, 'Communication claire', skills), []);
  assert.deepEqual(relate(index, 'Kubernetes', skills), []);
});

test('a shared theme is a hint, never better than a nearer relation', () => {
  const skills = skillConcepts(index, [{ id: 'pg', name: 'PostgreSQL' }]);
  assert.deepEqual(relate(index, 'Puppet', skills), [{ skill: 'pg', relation: 'theme', concept: 'puppet' }]);
});
