// 2.40 (seen on 2.39): "N years of X" is counted by code on the profile's
// dated experiences, not judged by each model. Synthetic profile only:
// PostgreSQL cited 2019-2025 (6 years), Oracle 2015-2019 (4), GCP in none.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v4 } from './fixtures/v4.js';
import { normalize } from '../src/normalize.js';

const answer = (requirements) => ({ language: 'fr', fit: { score: 50, verdict: 'partial' }, headline: 'SRE', summary: ['SRE.'], requirements, experiences: [], skill_groups: [] });
function judge(name, match, skills = []) {
  const { analysis, repairs } = normalize(answer([{ name, importance: 'must', match, skills, note: '' }]), v4());
  return { row: analysis.requirements[0], repairs: repairs.filter((repair) => repair.includes(name)) };
}

test('2.40: N years met by the experiences citing the skill is yes, whatever the model said', () => {
  const { row, repairs } = judge("5 ans d'expérience PostgreSQL", 'adjacent');
  assert.equal(row.match, 'yes', JSON.stringify(row));
  assert.ok(repairs.some((repair) => /6 years/.test(repair)), repairs.join('\n'));
});

test('2.40: fewer years than asked is adjacent, even when the model said yes', () => {
  const { row, repairs } = judge("5 ans d'expérience Oracle", 'yes', ['oracle']);
  assert.equal(row.match, 'adjacent', JSON.stringify(row));
  assert.ok(repairs.some((repair) => /4 years/.test(repair) && /\(was yes\)/.test(repair)), repairs.join('\n'));
});

test('2.40: a skill no dated experience cites gives no years: no', () => {
  const { row } = judge("3 ans d'expérience GCP", 'yes', ['gcp']);
  assert.equal(row.match, 'no', JSON.stringify(row));
});

test('2.40: a requirement stating no number of years is left to the other rules', () => {
  const { repairs } = judge('Expérience PostgreSQL', 'adjacent');
  assert.ok(!repairs.some((repair) => /years/.test(repair)), repairs.join('\n'));
});
