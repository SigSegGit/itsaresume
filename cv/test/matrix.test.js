// 5.1: matchmaking by code alone, no model: for each offer x profile, the
// share of the offer's requirements a profile skill names (its name, the
// lexicon's same or near concept, the owner's same/near links).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coverage, matrix, toCsv, toMarkdown } from '../src/matrix.js';

function synthetic() {
  return JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));
}

/** A second fictional profile: cloud and containers, no databases. */
function cloudOnly() {
  const p = synthetic();
  p.id = 'cloud';
  p.skills = p.skills.filter((skill) => ['aws', 'gcp', 'docker', 'terraform'].includes(skill.id));
  p.skills.push({ id: 'kubernetes', name: 'Kubernetes', group: 'cloud', level: 'expert', aliases: ['K8s'] });
  return p;
}

const OFFERS = [
  { name: 'dba', requirements: ['PostgreSQL', 'Oracle', 'Python', 'Astreintes'] },
  { name: 'k8s', requirements: ['Kubernetes', 'AWS', 'Terraform', 'Docker'] },
  { name: 'mixed', requirements: ['PostgreSQL', 'AWS', 'Gouvernance'] },
];

test('coverage counts the requirements a profile skill names, and names them', () => {
  const result = coverage(synthetic(), OFFERS[0].requirements);
  assert.deepEqual(result.covered, ['PostgreSQL', 'Oracle', 'Python']);
  assert.equal(result.total, 4);
  assert.equal(result.share, 0.75);
});

test('a requirement no skill names is not covered: a shared theme is not enough', () => {
  assert.equal(coverage(cloudOnly(), ['PostgreSQL']).share, 0);
});

test('the matrix ranks the profiles per offer as a person would', () => {
  const rows = matrix(OFFERS, [{ id: 'synthetic', profile: synthetic() }, { id: 'cloud', profile: cloudOnly() }]);
  const best = (offer) => rows.filter((row) => row.offer === offer).sort((a, b) => b.share - a.share)[0].profile;
  assert.equal(best('dba'), 'synthetic');
  assert.equal(best('k8s'), 'cloud');
  assert.equal(rows.length, 6);
});

test('the matrix is written as CSV and as a Markdown table', () => {
  const rows = matrix(OFFERS.slice(0, 1), [{ id: 'synthetic', profile: synthetic() }]);
  assert.equal(toCsv(rows), 'offer,profile,covered,total,share\ndba,synthetic,3,4,0.75\n');
  assert.match(toMarkdown(rows), /\| dba \| 75 % \|/);
});
