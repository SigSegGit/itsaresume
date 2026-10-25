// 2.28b-iii: the profile decides, not the model's first verdict (the owner,
// 2026-10-25: "no" only when what the job needs is really missing from the
// whole profile, not because exact words are). Synthetic profile only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v4 } from './fixtures/v4.js';
import { normalize } from '../src/normalize.js';
import { validateAnalysis } from '../src/analysis.js';

const answer = (requirements) => ({
  language: 'fr',
  fit: { score: 50, verdict: 'partial' },
  headline: 'SRE',
  summary: ['SRE.'],
  requirements,
  experiences: [],
  skill_groups: [],
});

/** One requirement as the model answered it, normalised against `profile`. */
function judge(name, { match = 'no', skills = [], profile = v4() } = {}) {
  const { analysis, repairs } = normalize(answer([{ name, importance: 'must', match, skills, note: '' }]), profile);
  return { row: analysis.requirements[0], repairs, analysis, profile };
}

const withSkill = (skill) => {
  const p = v4();
  p.skills.push({ group: 'ai', aliases: [], ...skill });
  return p;
};

// The core of a requirement: generic words aside, it is the concept.
for (const name of ['Langage SQL', 'Maîtrise du SQL', 'Expérience SQL', 'Connaissance des bases de données']) {
  test(`"${name}" marked no is met through the profile's expert PostgreSQL`, () => {
    const { row } = judge(name);
    assert.equal(row.match, 'yes', JSON.stringify(row));
    assert.ok(row.skills.includes('postgresql'), row.skills.join());
    assert.equal(row.judged, undefined);
  });
}

test('a practice word ("Requêtage SQL") is met by an expert or proficient skill', () => {
  assert.equal(judge('Requêtage SQL').row.match, 'yes');
  assert.equal(judge('Administration de bases de données').row.match, 'yes');
});

test('a practice word asks more than a working level: adjacent', () => {
  const p = v4();
  for (const skill of p.skills) if (skill.id === 'postgresql' || skill.id === 'oracle') skill.level = 'working';
  const { row } = judge('Requêtage SQL', { profile: p });
  assert.equal(row.match, 'adjacent');
  assert.equal(judge('SQL', { profile: p }).row.match, 'yes', 'the concept alone is met at a working level');
});

test('the model adjacent with the right pick is lifted when the name has generic words', () => {
  assert.equal(judge('Maîtrise du SQL', { match: 'adjacent', skills: ['postgresql'] }).row.match, 'yes');
});

test('a wrong pick of the model does not hide the profile: "SQL" through Python is met through PostgreSQL', () => {
  const { row } = judge('SQL', { match: 'yes', skills: ['python'] });
  assert.equal(row.match, 'yes');
  assert.ok(row.skills.includes('postgresql'), row.skills.join());
  assert.ok(!row.skills.includes('python'), 'the wrong pick stays out');
  assert.equal(row.judged, undefined);
});

test('"Bases de données relationnelles" is a technology, not a personal quality', () => {
  const { row } = judge('Bases de données relationnelles');
  assert.equal(row.kind, undefined);
  assert.equal(row.match, 'yes');
});

test('a quality word without a technology is still a personal quality', () => {
  assert.equal(judge('Sens du relationnel').row.kind, 'quality');
  assert.equal(judge("Esprit d'équipe").row.kind, 'quality');
});

test('"Cloud" alone is met through AWS (proficient)', () => {
  const { row } = judge('Cloud');
  assert.equal(row.match, 'yes');
  assert.ok(row.skills.includes('aws'));
});

test('"DevOps" is met through infrastructure as code held at expert', () => {
  const { row } = judge('Pratiques DevOps');
  assert.equal(row.match, 'yes', JSON.stringify(row));
  assert.ok(row.skills.includes('terraform'), row.skills.join());
});

test('"Automatisation" is met through Terraform or Python', () => {
  const { row } = judge('Automatisation');
  assert.equal(row.match, 'yes', JSON.stringify(row));
});

test('"Intelligence artificielle" with a lab LLM skill is adjacent, not no', () => {
  const { row } = judge('Intelligence artificielle', { profile: withSkill({ id: 'local-llm', name: 'LLM locaux', level: 'lab' }) });
  assert.equal(row.match, 'adjacent', JSON.stringify(row));
  assert.deepEqual(row.skills, ['local-llm']);
});

test('a skill whose name carries a version or a qualifier is placed on its concept ("PostgreSQL 16")', () => {
  const p = v4();
  p.skills = p.skills.filter((skill) => skill.id !== 'postgresql' && skill.id !== 'oracle');
  p.skills.push({ id: 'pg16', name: 'PostgreSQL 16', group: 'db', level: 'expert', aliases: [] });
  const { row } = judge('SQL', { profile: p });
  assert.equal(row.match, 'yes', JSON.stringify(row));
  assert.deepEqual(row.skills, ['pg16']);
});

test('a depth word the skill may lack ("Oracle tuning") stays adjacent', () => {
  const { row } = judge('Oracle tuning');
  assert.equal(row.match, 'adjacent');
  assert.deepEqual(row.skills, ['oracle']);
});

test('a requirement naming a concept the profile lacks beside one it holds ("SQL / NoSQL") is adjacent', () => {
  assert.equal(judge('SQL / NoSQL').row.match, 'adjacent');
});

test('a tool of the same family as a held one ("Puppet" beside Terraform) is adjacent, to verify', () => {
  const { row } = judge('Puppet');
  assert.equal(row.match, 'adjacent', JSON.stringify(row));
  assert.equal(row.judged, true);
  assert.deepEqual(row.skills, ['terraform']);
  assert.match(row.note, /Terraform/);
});

test('a sibling database ("MySQL") is adjacent to verify, not yes through an ESCO synonym', () => {
  const { row } = judge('MySQL');
  assert.equal(row.match, 'adjacent', JSON.stringify(row));
  assert.equal(row.judged, true);
});

test('what an experience bullet states ("Optimisation de requêtes") is adjacent, to verify, through its skills', () => {
  const { row } = judge('Optimisation de requêtes');
  assert.equal(row.match, 'adjacent', JSON.stringify(row));
  assert.equal(row.judged, true);
  assert.deepEqual(row.skills, ['oracle']);
  assert.match(row.note, /bank/);
});

test('what the whole profile lacks stays no', () => {
  assert.equal(judge('COBOL').row.match, 'no');
  assert.equal(judge('Kubernetes').row.match, 'no', 'never claimed');
  assert.equal(judge('Kubernetes', { match: 'yes', skills: ['docker'] }).row.match, 'no', 'never claimed, whatever the model picked');
});

test("the owner's near ruling holds the profile's verdict at adjacent", () => {
  const p = v4();
  p.links = [{ words: 'sql', skill: 'postgresql', verdict: 'near' }, { words: 'sql', skill: 'oracle', verdict: 'near' }];
  assert.equal(judge('SQL', { profile: p }).row.match, 'adjacent');
});

test('every verdict the profile gives passes validation', () => {
  const names = ['Requêtage SQL', 'Puppet', 'MySQL', 'Optimisation de requêtes', 'Oracle tuning', 'Cloud', 'COBOL'];
  const p = v4();
  const { analysis } = normalize(answer(names.map((name) => ({ name, importance: 'must', match: 'no', skills: [], note: '' }))), p);
  assert.deepEqual(validateAnalysis(analysis, p).errors.filter((error) => /requirement/.test(error)), []);
});
