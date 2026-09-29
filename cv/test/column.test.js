// 2.7g: a skill that meets a requirement is in the skills column even when
// the model did not list it (open since the 2026-09-27 audit; seen again on
// 2026-09-29: a must met through a visible skill the column did not show).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize, MAX_GROUPS } from '../src/normalize.js';

function profile() {
  const p = JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));
  p.skill_groups.push({ id: 'meta', title: { fr: 'Méta', en: 'Meta' }, hidden: true });
  p.skills.push({ id: 'devops', name: 'DevOps', group: 'meta', level: 'proficient', aliases: [] });
  return p;
}

const analysis = (requirements, skill_groups) => ({
  language: 'en',
  fit: { score: 50, verdict: 'partial', rationale: '' },
  headline: 'SRE',
  summary: ['SRE.'],
  requirements,
  experiences: [{ id: 'acme', bullets: ['acme-pg'] }],
  skill_groups,
});
const must = (name, skills, match = 'yes') => ({ name, importance: 'must', match, skills, note: '' });
const column = (a, p = profile()) => normalize(a, p).analysis.skill_groups;
const ids = (groups) => groups.flatMap((group) => group.skills);

test('a met skill the model left out of its group comes into it', () => {
  const groups = column(analysis([must('PostgreSQL', ['postgresql']), must('Oracle', ['oracle'])], [{ id: 'db', skills: ['postgresql'] }]));
  assert.ok(groups.find((group) => group.id === 'db').skills.includes('oracle'));
});

test('a met skill whose group the model did not list brings its group', () => {
  const groups = column(analysis([must('PostgreSQL', ['postgresql']), must('Terraform', ['terraform'])], [{ id: 'db', skills: ['postgresql'] }]));
  assert.deepEqual(groups.find((group) => group.id === 'iac')?.skills, ['terraform']);
});

test('a met skill of a hidden group stays out of the column', () => {
  const groups = column(analysis([must('PostgreSQL', ['postgresql']), must('DevOps', ['devops'])], [{ id: 'db', skills: ['postgresql'] }]));
  assert.ok(!ids(groups).includes('devops'));
  assert.ok(!groups.some((group) => group.id === 'meta'));
});

test('beyond the group cap, a group holding a met skill is kept before one that holds none', () => {
  const p = profile();
  const extra = Array.from({ length: MAX_GROUPS }, (_, index) => `g${index}`);
  for (const id of extra) {
    p.skill_groups.push({ id, title: { fr: id, en: id } });
    p.skills.push({ id: `${id}-tool`, name: `Tool ${id}`, group: id, level: 'working', aliases: [] });
  }
  const groups = column(analysis([must('Terraform', ['terraform'])], extra.map((id) => ({ id, skills: [`${id}-tool`] }))), p);
  assert.ok(ids(groups).includes('terraform'));
  assert.equal(groups.length, MAX_GROUPS);
});
