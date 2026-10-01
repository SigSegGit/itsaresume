// The core rules: a profile is well-formed, an analysis from the model may
// only point at what the profile contains, and the CV is built from the
// profile alone (plus a checked summary and headline).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateProfile } from '../src/profile.js';
import { validateAnalysis } from '../src/analysis.js';
import { buildModel } from '../src/tailor.js';

const load = () => JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));

/** A valid analysis of an offer asking for PostgreSQL, Terraform and Kubernetes. */
const analysis = () => ({
  language: 'en',
  fit: { score: 72, verdict: 'good', rationale: 'Strong on databases and IaC, no Kubernetes.' },
  requirements: [
    { name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' },
    { name: 'Terraform', importance: 'must', match: 'yes', skills: ['terraform'], note: '' },
    { name: 'Kubernetes', importance: 'nice', match: 'adjacent', skills: ['docker'], note: 'containers via Docker' },
    { name: 'Kafka', importance: 'nice', match: 'no', skills: [], note: '' },
  ],
  headline: 'Senior SRE — PostgreSQL & Terraform',
  summary: ['SRE with 10 years running PostgreSQL in production.', 'Industrialises with Terraform.'],
  experiences: [{ id: 'acme', bullets: ['acme-pg', 'acme-iac'] }],
  skill_groups: [
    { id: 'db', skills: ['postgresql'] },
    { id: 'iac', skills: ['terraform', 'docker'] },
  ],
});

const errorsOf = (a, p = load()) => validateAnalysis(a, p).errors.join('\n');

test('the synthetic profile is valid', () => {
  assert.deepEqual(validateProfile(load()).errors, []);
});

test('a profile whose bullet cites an unknown skill is refused', () => {
  const p = load();
  p.experiences[0].bullets[0].skills.push('cobol');
  assert.match(validateProfile(p).errors.join('\n'), /cobol/);
});

test('a profile with a skill in an unknown group, a bad level or a missing translation is refused', () => {
  const p = load();
  p.skills[0].group = 'nowhere';
  p.skills[1].level = 'guru';
  p.experiences[1].bullets[1].en = '';
  const errors = validateProfile(p).errors.join('\n');
  assert.match(errors, /nowhere/);
  assert.match(errors, /guru/);
  assert.match(errors, /bank-oncall/);
});

test('duplicate ids in a profile are refused', () => {
  const p = load();
  p.skills.push({ ...p.skills[0] });
  assert.match(validateProfile(p).errors.join('\n'), /duplicate.*postgresql/i);
});

test('a valid analysis passes', () => {
  assert.deepEqual(validateAnalysis(analysis(), load()).errors, []);
});

test('an analysis may not select an experience, a bullet or a skill the profile lacks', () => {
  const a = analysis();
  a.experiences.push({ id: 'ghost-job', bullets: [] });
  a.experiences[0].bullets.push('bank-oracle'); // belongs to another experience
  a.skill_groups[0].skills.push('kubernetes');
  a.skill_groups[1].skills.push('postgresql'); // wrong group
  const errors = errorsOf(a);
  assert.match(errors, /ghost-job/);
  assert.match(errors, /bank-oracle/);
  assert.match(errors, /kubernetes/);
  assert.match(errors, /postgresql.*group|group.*postgresql/i);
});

/** The rule that makes the CV honest: the free text may not claim a required
 * technology that is not in the profile. */
test('a summary or headline claiming a technology absent from the profile is refused', () => {
  const a = analysis();
  a.summary.push('Hands-on Kubernetes and Kafka operator.');
  const errors = errorsOf(a);
  assert.match(errors, /Kubernetes/);
  assert.match(errors, /Kafka/);

  const b = analysis();
  b.headline = 'Kafka engineer';
  assert.match(errorsOf(b), /Kafka/);
});

test('naming a technology the profile has, even through an alias, is allowed', () => {
  const a = analysis();
  a.summary.push('Comfortable on Amazon Web Services and Postgres.');
  a.requirements.push({ name: 'Amazon Web Services', importance: 'nice', match: 'yes', skills: ['aws'], note: '' });
  assert.deepEqual(validateAnalysis(a, load()).errors, []);
});

test('an analysis with an out-of-range score, a bad verdict, a bad language or no experience is refused', () => {
  const a = analysis();
  a.fit.score = 140;
  a.fit.verdict = 'amazing';
  a.language = 'de';
  a.experiences = [];
  const errors = errorsOf(a);
  assert.match(errors, /score/);
  assert.match(errors, /verdict/);
  assert.match(errors, /language/);
  assert.match(errors, /experience/);
});

test('a requirement marked matched must name at least one profile skill, and an unmatched one none', () => {
  const a = analysis();
  a.requirements[0].skills = [];
  a.requirements[3].skills = ['python'];
  const errors = errorsOf(a);
  assert.match(errors, /PostgreSQL/);
  assert.match(errors, /Kafka/);
});

test('the model takes every text from the profile, in the analysis language, except headline and summary', () => {
  const model = buildModel(load(), analysis());
  assert.equal(model.name, 'Alex MARTIN');
  assert.equal(model.name_caps, 'ALEX MARTIN');
  assert.equal(model.headline, 'Senior SRE — PostgreSQL & Terraform');
  assert.deepEqual(model.profile, analysis().summary);
  assert.equal(model.labels.experience, 'EXPERIENCE');
  // Every experience appears, most recent first, so the career has no holes.
  assert.deepEqual(model.experiences.map((e) => e.org), ['Acme Payments', 'Example Bank']);
  assert.deepEqual(model.experiences[0].bullets, ['Ran a PostgreSQL fleet.', 'Industrialised with Terraform.']);
  assert.equal(model.experiences[0].dates, '2019 – 2025');
  // An experience the analysis did not select keeps its first bullet only.
  assert.deepEqual(model.experiences[1].bullets, ['Tuned Oracle queries.']);
  assert.deepEqual(model.skill_groups, [
    { title: 'Databases', items: ['PostgreSQL'] },
    { title: 'Automation / IaC', items: ['Terraform', 'Docker'] },
  ]);
  assert.equal(model.contact, 'alex.martin@example.org  |  +33 6 00 00 00 00');
});

test('a French analysis yields French texts and labels', () => {
  const a = analysis();
  a.language = 'fr';
  const model = buildModel(load(), a);
  assert.equal(model.labels.experience, 'EXPÉRIENCES');
  assert.equal(model.experiences[0].org, 'Acme Paiements');
  assert.deepEqual(model.glance, ['Disponible : immédiatement', 'Astreintes : oui']);
});

test('an experience selected without any bullet shows its requirement-backed ones, or at least its first', () => {
  const a = analysis();
  a.experiences = [{ id: 'acme', bullets: [] }];
  const model = buildModel(load(), a);
  assert.deepEqual(model.experiences[0].bullets, ['Ran a PostgreSQL fleet.', 'Industrialised with Terraform.']);
  assert.deepEqual(model.experiences[1].bullets, ['Tuned Oracle queries.'], 'nothing backs a requirement here: its first bullet');
});

/** A weak model picks too few bullets; the CV is filled from the profile with
 * the bullets that back a matched requirement, after the model's own picks. */
test('bullets backing a matched requirement are added after the model picks, up to the limit', () => {
  const a = analysis();
  a.experiences = [{ id: 'acme', bullets: ['acme-pg'] }];
  // Terraform is matched, Python is not: acme-iac comes in, acme-py stays out.
  assert.deepEqual(buildModel(load(), a).experiences[0].bullets, ['Ran a PostgreSQL fleet.', 'Industrialised with Terraform.']);
});

test('a hidden skill group backs requirements but never shows in the sidebar', () => {
  const p = load();
  p.skill_groups.push({ id: 'meta', hidden: true, title: { fr: 'Méta', en: 'Meta' } });
  p.skills.push({ id: 'english', name: 'English', group: 'meta', level: 'expert', aliases: [] });
  const a = analysis();
  a.requirements.push({ name: 'English', importance: 'must', match: 'yes', skills: ['english'], note: '' });
  a.skill_groups.push({ id: 'meta', skills: ['english'] });
  assert.deepEqual(validateAnalysis(a, p).errors, []);
  assert.ok(buildModel(p, a).skill_groups.every((group) => group.title !== 'Meta'));
});

// Red team: `pending` is a list of names; a string made the report throw
// after every model call had been paid for.
test('a profile whose pending is not a list of non-empty names is refused, naming pending', () => {
  for (const bad of ['Kubernetes', [''], [3], [null]]) {
    const p = load();
    p.pending = bad;
    assert.match(validateProfile(p).errors.join('\n'), /pending/, JSON.stringify(bad));
  }
  const ok = load();
  ok.pending = ['Kubernetes'];
  assert.deepEqual(validateProfile(ok).errors, []);
});
