// 2.58-2.59 (the owner, 2026-11-19, a recruiter's feedback): skills listed
// on the left are not enough, each must be told by an experience's bullet;
// the founder's R&D experience comes first. The bullets stay the profile's
// own sentences: the code chooses them, no model writes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildModel, defaultBullets, unanchored } from '../src/tailor.js';
import { report } from '../src/report.js';

const base = () => JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));
const bullet = (id, skills = []) => ({ id, fr: `Puce ${id}.`, en: `Bullet ${id}.`, skills });

function profile() {
  const value = base();
  const [acme] = value.experiences;
  acme.bullets.push(bullet('acme-a'), bullet('acme-b'), bullet('acme-c'));
  value.experiences.push({ id: 'rnd', kind: 'rnd', title: { fr: 'Fondateur / R&D', en: 'Founder / R&D' }, org: { fr: 'Labo', en: 'Lab' }, start: '2026', bullets: [bullet('rnd-docker', ['docker'])], env: ['Docker'] });
  return value;
}

const requirement = (name, skills, match = 'yes') => ({ name, importance: 'must', match, skills, note: '' });
const analysis = () => ({
  language: 'en',
  fit: { score: 80, rationale: '' },
  requirements: [requirement('Terraform', ['terraform']), requirement('Docker', ['docker']), requirement('AWS', ['aws'])],
  headline: 'SRE',
  summary: ['An SRE.'],
  experiences: [{ id: 'acme', bullets: ['acme-pg', 'acme-a', 'acme-b', 'acme-c'] }, { id: 'rnd', bullets: ['rnd-docker'] }],
  skill_groups: [{ id: base().skill_groups[0].id, skills: ['terraform', 'docker', 'aws'] }],
});

test('2.58: a matched skill is told by a bullet even when the model picked others', () => {
  const selected = defaultBullets(profile(), analysis());
  assert.ok(selected.has('acme-iac'), 'Terraform is told by its bullet, past the picks');
  const model = buildModel(profile(), analysis(), { bullets: selected });
  assert.ok(model.experiences.find((shown) => shown.id === 'acme').bullet_ids.includes('acme-iac'));
});

test('2.58: a skill shown that no bullet of the profile tells is listed to anchor', () => {
  const model = buildModel(profile(), analysis());
  assert.deepEqual(unanchored(profile(), analysis(), model.experiences), ['aws']);
  const text = report(analysis(), profile(), { rendered: model.experiences });
  assert.match(text, /## To anchor in the profile/);
  assert.match(text, /AWS/);
});

test('2.59: the founder’s R&D experience comes first when it is shown', () => {
  const model = buildModel(profile(), analysis());
  assert.equal(model.experiences[0].id, 'rnd');
  const without = analysis();
  without.experiences = [{ id: 'acme', bullets: ['acme-pg'] }];
  without.requirements = [requirement('PostgreSQL', ['postgresql'])];
  assert.notEqual(buildModel(profile(), without).experiences[0]?.id, 'rnd', 'not when it backs nothing');
});
