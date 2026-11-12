// 2.40 (seen on 2.39): "N years of X" is counted by code on the profile's
// dated experiences, not judged by each model. Synthetic profile only:
// PostgreSQL cited 2019-2025 (6 years), Oracle 2015-2019 (4), GCP in none.
// It only raises (replay of 2026-11-12: lowering refused 10 honest yes).

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

test('2.40: fewer years than asked leave the model verdict (it only raises)', () => {
  const { row, repairs } = judge("5 ans d'expérience Oracle", 'adjacent', ['oracle']);
  assert.equal(row.match, 'adjacent', JSON.stringify(row));
  assert.ok(!repairs.some((repair) => /years asked/.test(repair)), repairs.join(String.fromCharCode(10)));
});

test('2.40: a yes is never lowered by the count (an umbrella skill no bullet cites counts 0)', () => {
  const { row } = judge("3 ans d'expérience GCP", 'yes', ['gcp']);
  assert.equal(row.match, 'yes', JSON.stringify(row));
});

test('2.40: a requirement stating no number of years is left to the other rules', () => {
  const { repairs } = judge('Expérience PostgreSQL', 'adjacent');
  assert.ok(!repairs.some((repair) => /years/.test(repair)), repairs.join(String.fromCharCode(10)));
});
