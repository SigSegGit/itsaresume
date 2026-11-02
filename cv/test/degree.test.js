// A degree an offer asks for is answered by the profile's education, never by
// a skill: the model looks at the skill catalogue only and read a Master's
// level diploma as "no degree".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize, settledKind } from '../src/normalize.js';
import { validateAnalysis } from '../src/analysis.js';

const school = (fr, en = fr) => ({ id: 'school', title: { fr, en }, details: [] });

function profile(education) {
  const p = JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));
  p.education = education;
  return p;
}

const MASTER = [school('École Exemple — Expert en informatique, Bac+5 (2015)', "Example School — IT Expert, Master's level (2015)")];
const LICENCE = [school('Université Exemple — Licence informatique (2015)', "Example University — Bachelor's degree (2015)")];

const judge = (name, education = MASTER, match = 'no', skills = []) => {
  const analysis = {
    language: 'fr',
    fit: { score: 50, verdict: 'partial', rationale: '' },
    headline: 'SRE',
    summary: ['SRE.'],
    requirements: [{ name, importance: 'must', match, skills, note: 'Diplôme non renseigné dans le catalogue.' }],
    experiences: [],
    skill_groups: [],
  };
  return normalize(analysis, profile(education)).analysis.requirements[0];
};

for (const name of ['Diplôme ingénieur ou Master informatique', "Diplôme d'ingénieur", 'Bac+5 en informatique', "Master's degree in computer science", 'Master en informatique']) {
  test(`a Bac+5 in the education meets "${name}"`, () => {
    const row = judge(name);
    assert.equal(row.match, 'yes');
    assert.equal(row.kind, 'degree');
    assert.deepEqual(row.skills, []);
    assert.match(row.note, /École Exemple/);
    assert.ok(!row.judged);
  });
}

test('a degree below the one asked stays no, whatever the model read', () => {
  const row = judge('Diplôme ingénieur ou Master informatique', LICENCE, 'yes', ['aws']);
  assert.equal(row.match, 'no');
  assert.equal(row.kind, 'degree');
  assert.deepEqual(row.skills, []);
});

test('a degree at the level asked is met: a licence for a Bac+3', () => {
  assert.equal(judge('Diplôme Bac+3 minimum', LICENCE).match, 'yes');
});

test('a profile with no education does not meet a degree', () => {
  assert.equal(judge('Diplôme ingénieur ou Master informatique', []).match, 'no');
});

for (const name of ['Scrum Master', 'Master Data Management', 'Diplomatie et communication', 'Ingénieur de production']) {
  test(`"${name}" asks for no degree`, () => {
    assert.notEqual(judge(name).kind, 'degree');
  });
}

test('a run older than the rule is read with it: a degree it kept as a skill is a degree', () => {
  assert.equal(settledKind({ name: 'Diplôme ingénieur ou Master informatique', match: 'no' }, profile(MASTER)), 'degree');
});

test('a degree row met with no skill passes the validation', () => {
  const row = judge('Master en informatique');
  const errors = validateAnalysis({ language: 'fr', fit: { score: 50, verdict: 'partial', rationale: '' }, headline: 'SRE', summary: ['SRE.'], requirements: [row], experiences: [], skill_groups: [] }, profile(MASTER));
  assert.ok(!errors.some((error) => /names no profile skill/.test(error)), errors.join());
});
