// The profile's own rules (Nicolas's profile v4, §0), enforced by code rather
// than asked of the model:
//   1. every tool stays attached to the mission where it was used;
//   3. short missions and R&D projects appear only when the offer calls on
//      something they demonstrate;
//   4. the three main missions always come first, the reference one the most
//      developed;
//   6. a lab skill is R&D only, and says so;
//   9. an offer whose core rests on a never-claimed or lab-only skill is not
//      "qualified";
// and every line of the CV traces to the profile, word for word.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateProfile } from '../src/profile.js';
import { buildModel, rankBullets } from '../src/tailor.js';
import { normalize } from '../src/normalize.js';
import { validateAnalysis } from '../src/analysis.js';
import { qualification, scoreOf } from '../src/score.js';
import { checkProvenance, olderMentions } from '../src/evidence.js';
import { buildPrompt, SYSTEM } from '../src/prompt.js';
import { report } from '../src/report.js';

/** The synthetic profile, shaped like profile v4: kinds, attribution, lab, never. */
function v4() {
  const p = JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));
  const where = { postgresql: ['acme'], oracle: ['bank'], terraform: ['acme'], python: ['acme'], docker: ['rnd'], aws: ['short'], gcp: ['rnd'] };
  for (const skill of p.skills) skill.where = where[skill.id];
  p.skills.find((s) => s.id === 'docker').level = 'lab';
  p.experiences[0].reference = true;
  p.experiences.push(
    {
      id: 'short',
      kind: 'short',
      title: { fr: 'Missions courtes', en: 'Short assignments' },
      org: { fr: 'Freelance', en: 'Freelance' },
      start: '2022',
      end: '2024',
      bullets: [{ id: 'short-aws', fr: 'Sortie d\'AWS livrée en 10 jours.', en: 'Moved off AWS in 10 days.', skills: ['aws'] }],
    },
    {
      id: 'rnd',
      kind: 'rnd',
      title: { fr: 'Fondateur / R&D', en: 'Founder / R&D' },
      title_empty: { fr: 'Conseil et R&D', en: 'Consulting and R&D' },
      org: { fr: 'EXEMPLE', en: 'EXAMPLE' },
      start: '2026',
      bullets: [{ id: 'rnd-docker', fr: 'Routeur livré en conteneur Docker.', en: 'Router shipped as a Docker container.', skills: ['docker'] }],
    },
  );
  p.never = [{ name: 'Kubernetes', aliases: ['K8s'] }];
  return p;
}

const analysis = (overrides = {}) => ({
  language: 'en',
  fit: { score: 50, verdict: 'partial', rationale: '' },
  headline: 'Senior SRE',
  summary: ['SRE running PostgreSQL in critical production.'],
  requirements: [{ name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' }],
  experiences: [{ id: 'acme', bullets: ['acme-pg'] }],
  skill_groups: [{ id: 'db', skills: ['postgresql'] }],
  ...overrides,
});

test('the v4-shaped profile is valid', () => {
  assert.deepEqual(validateProfile(v4()).errors, []);
});

test('a bullet or an environment line may only name tools used in that experience', () => {
  const p = v4();
  p.experiences[0].bullets[0].skills = ['oracle'];
  p.experiences[1].env.push('Terraform');
  const errors = validateProfile(p).errors.join('\n');
  assert.match(errors, /bullet acme-pg: Oracle is not attributed to acme/);
  assert.match(errors, /environment of bank: Terraform is not attributed to bank/);
});

test('a lab skill belongs to R&D only', () => {
  const p = v4();
  p.skills.find((s) => s.id === 'docker').where = ['acme', 'rnd'];
  assert.match(validateProfile(p).errors.join('\n'), /skill docker: a lab skill belongs to R&D only/);
});

test('main missions come first, then short missions, then R&D, with one reference among the main ones', () => {
  const p = v4();
  p.experiences.unshift(p.experiences.pop());
  assert.match(validateProfile(p).errors.join('\n'), /experiences: main missions first, then short missions, then R&D/);
  const q = v4();
  q.experiences[1].reference = true;
  assert.match(validateProfile(q).errors.join('\n'), /one reference experience, a main mission/);
});

test('the main missions are always on the CV, in order, before anything else', () => {
  const a = analysis({
    requirements: [{ name: 'Docker', importance: 'must', match: 'yes', skills: ['docker'], note: '' }],
    experiences: [{ id: 'rnd', bullets: ['rnd-docker'] }],
  });
  const model = buildModel(v4(), a);
  assert.deepEqual(model.experiences.map((e) => e.title), ['Senior SRE', 'Application support', 'Founder / R&D']);
  assert.ok(model.experiences[0].bullets.length >= 1);
});

/** Rule 3: a project or a short mission earns its place by backing a requirement the offer states. */
test('short missions and R&D projects appear only when they back a matched requirement', () => {
  const a = analysis({ experiences: [{ id: 'acme', bullets: ['acme-pg'] }, { id: 'short', bullets: ['short-aws'] }, { id: 'rnd', bullets: ['rnd-docker'] }] });
  const ranked = rankBullets(v4(), a).map((entry) => entry.id);
  assert.ok(!ranked.includes('short-aws') && !ranked.includes('rnd-docker'), 'not even as filler');
  const model = buildModel(v4(), a);
  assert.ok(!model.experiences.some((e) => e.title === 'Short assignments'), 'no short-missions block');
  const rnd = model.experiences.at(-1);
  assert.equal(rnd.title, 'Consulting and R&D', 'one sober line');
  assert.deepEqual(rnd.bullets, []);
  const { repairs } = normalize(a, v4());
  assert.match(repairs.join('\n'), /short-aws.*backs no requirement the offer states/);
});

test('the reference experience is the most developed', () => {
  const model = buildModel(v4(), analysis(), { bullets: new Set(['acme-pg', 'bank-oracle', 'bank-oncall']) });
  assert.equal(model.experiences[0].bullets.length, 1);
  assert.equal(model.experiences[1].bullets.length, 1, 'capped at the reference\'s count');
});

test('a lab skill says so on the CV', () => {
  const a = analysis({ skill_groups: [{ id: 'iac', skills: ['docker', 'terraform'] }] });
  assert.deepEqual(buildModel(v4(), a).skill_groups[0].items, ['Docker (lab)', 'Terraform']);
});

test('a requirement met by lab skills only counts half', () => {
  const requirements = [{ name: 'Docker', importance: 'must', match: 'yes', skills: ['docker'], note: '' }];
  assert.equal(scoreOf(requirements, { lab: new Set(['docker']) }), 50);
  assert.equal(scoreOf(requirements), 100);
  const { analysis: normalised } = normalize(analysis({ requirements }), v4());
  assert.equal(normalised.fit.score, 50);
});

test('a never-claimed skill stays a gap and may not be written', () => {
  const requirements = [
    { name: 'Kubernetes (EKS)', importance: 'must', match: 'adjacent', skills: ['docker'], note: 'containers' },
    { name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' },
  ];
  const { analysis: normalised, repairs } = normalize(analysis({ requirements }), v4());
  assert.equal(normalised.requirements[0].match, 'no');
  assert.deepEqual(normalised.requirements[0].skills, []);
  assert.equal(normalised.requirements[0].never, true);
  assert.match(repairs.join('\n'), /Kubernetes \(EKS\).*never claimed/);
  const errors = validateAnalysis(analysis({ summary: ['K8s-savvy SRE.'] }), v4()).errors.join('\n');
  assert.match(errors, /K8s.*never to be claimed/);
});

test('qualification: every must met, some missed, or the core missed', () => {
  const lab = new Set(['docker']);
  const never = [{ name: 'Kubernetes' }];
  const req = (name, match, skills = []) => ({ name, importance: 'must', match, skills });
  assert.equal(qualification([req('PostgreSQL', 'yes', ['postgresql']), req('Terraform', 'adjacent', ['terraform'])], { lab, never }).level, 'qualified');
  const partial = qualification([req('PostgreSQL', 'yes', ['postgresql']), req('Terraform', 'yes', ['terraform']), req('Kafka', 'no')], { lab, never });
  assert.equal(partial.level, 'partial');
  assert.deepEqual(partial.gaps, ['Kafka']);
  const out = qualification([req('Kubernetes', 'no'), req('Docker', 'yes', ['docker']), req('Linux', 'yes', ['python'])], { lab, never });
  assert.equal(out.level, 'not-qualified');
  assert.deepEqual(out.gaps, ['Kubernetes (never claimed)', 'Docker (lab only)']);
  assert.equal(qualification([{ name: 'Kafka', importance: 'nice', match: 'no', skills: [] }], { lab, never }).level, 'qualified', 'only musts are the core');
});

test('the normalised fit carries the qualification', () => {
  const requirements = [{ name: 'Kubernetes', importance: 'must', match: 'no', skills: [], note: '' }];
  assert.equal(normalize(analysis({ requirements }), v4()).analysis.fit.qualification.level, 'not-qualified');
});

/** Every line of the CV traces to the profile document, word for word; a
 * composed line cites its pieces, and may not bring a number of its own. */
test('each bullet traces to the truth document, and brings no number of its own', () => {
  const p = v4();
  p.sources = [{ id: 'truth', grade: 'B', title: 'Profile v4', file: 'truth.md' }];
  p.truth = 'truth';
  const text = [
    '**Exploitation d\'une flotte PostgreSQL.** [✔]',
    'Industrialisation avec `Terraform`.',
    'Automatisation [~ à confirmer] en Python.',
    'Optimisation de requêtes Oracle. Astreintes sur flux critiques.',
    '| Sortie d\'AWS | livrée en 10 jours |',
    'Routeur livré en conteneur Docker.',
    'Ingénieur SRE avec 10 ans en production critique.',
    'Exploitation de flottes PostgreSQL à haute volumétrie.',
  ].join('\n');
  const texts = [{ id: 'truth', text }];
  p.experiences[2].bullets[0].quotes = ['Sortie d\'AWS', 'livrée en 10 jours'];
  assert.deepEqual(checkProvenance(p, texts), [], 'markdown emphasis and confidence marks aside');
  p.experiences[0].bullets[0].fr = 'Exploitation d\'une grande flotte PostgreSQL.';
  p.experiences[2].bullets[0].fr = 'Sortie d\'AWS livrée en 8 jours.';
  p.experiences[2].bullets[0].en = 'Moved off AWS in 8 days, 3 people.';
  const errors = checkProvenance(p, texts).join('\n');
  assert.match(errors, /bullet acme-pg: "Exploitation d'une grande flotte PostgreSQL\." is not in truth/);
  assert.match(errors, /bullet short-aws: the number 8 is in none of its quotes/);
  assert.match(errors, /bullet short-aws: the English text has the number 3, the French one does not/);
  p.truth = undefined;
  assert.deepEqual(checkProvenance(p, texts), [], 'no truth document, nothing to trace to');
});

test('the model is told which skills are lab-only and which are never to be claimed', () => {
  const { prompt } = buildPrompt(v4(), 'Senior SRE wanted.');
  assert.match(prompt, /^- docker — Docker, lab \(personal R&D only\)/m);
  assert.match(prompt, /Never claim, the candidate has confirmed having no experience of: Kubernetes, K8s/);
  assert.match(SYSTEM, /lab/i);
  assert.match(SYSTEM, /never claim/i);
});

test('the report states the qualification and what older CVs named that the profile lacks', () => {
  const p = v4();
  const requirements = [
    { name: 'Kafka', importance: 'must', match: 'no', skills: [], note: '' },
    { name: 'Kubernetes', importance: 'must', match: 'no', skills: [], note: '', never: true },
    { name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' },
  ];
  const { analysis: a } = normalize(analysis({ requirements }), p);
  p.sources = [{ id: 'cv-old', grade: 'C', title: 'CV 2024' }];
  const older = olderMentions(a, p, [{ id: 'cv-old', text: 'Kafka, Kubernetes and PostgreSQL.' }]);
  assert.deepEqual(older, [{ requirement: 'Kafka', sources: ['CV 2024'] }], 'never-claimed skills are not suggested back');
  const text = report(a, p, { backend: 'b', attempts: 1, older });
  assert.match(text, /\*\*Qualification:\*\* not qualified/);
  assert.match(text, /Kubernetes \(never claimed\)/);
  assert.match(text, /Named in older CVs, absent from the profile[^\n]*\n+- Kafka — CV 2024/);
});

/** Seen: the owner's CV generator (an AI pipeline) was dropped from the CV
 * for a GenAI offer, because the requirement cited the LLM-routing skill
 * only. A project the model picks stays when one of its skills is of the
 * same group as a skill meeting a requirement; one it does not pick still
 * needs a skill of its own to meet one. */
test('a picked R&D project stays when its skills share a group with a met requirement', () => {
  const infra = analysis({
    requirements: [{ name: 'Terraform', importance: 'must', match: 'yes', skills: ['terraform'], note: '' }],
    experiences: [{ id: 'acme', bullets: ['acme-pg'] }, { id: 'rnd', bullets: ['rnd-docker'] }],
  });
  assert.ok(rankBullets(v4(), infra).some((entry) => entry.id === 'rnd-docker'), 'picked, same group (iac): kept');
  const { analysis: kept, repairs } = normalize(structuredClone(infra), v4());
  assert.deepEqual(kept.experiences.find((e) => e.id === 'rnd').bullets, ['rnd-docker']);
  assert.doesNotMatch(repairs.join('\n'), /rnd-docker.*backs no requirement/);

  const db = analysis({ experiences: [{ id: 'acme', bullets: ['acme-pg'] }, { id: 'rnd', bullets: ['rnd-docker'] }] });
  assert.ok(!rankBullets(v4(), db).some((entry) => entry.id === 'rnd-docker'), 'picked, other group (db only): dropped');
  const unpicked = analysis({ requirements: [{ name: 'Terraform', importance: 'must', match: 'yes', skills: ['terraform'], note: '' }] });
  assert.ok(!rankBullets(v4(), unpicked).some((entry) => entry.id === 'rnd-docker'), 'not picked, no skill of its own met: dropped');
});

// 2.7f, seen on a real run (2026-09-29): the page filler added a short
// mission the model had not picked, through a requirement the main
// missions already backed ("Production"). Rule 3: a short mission earns its
// place by what the main missions cannot show.
test('an unpicked short mission does not fill the page with a requirement the main missions already back', () => {
  const a = analysis({ requirements: [{ name: 'Cloud & IaC', importance: 'nice', match: 'yes', skills: ['terraform', 'aws'], note: '' }] });
  assert.ok(!rankBullets(v4(), a).some((entry) => entry.id === 'short-aws'));
});

test('an unpicked short mission still backs a requirement no main mission backs', () => {
  const a = analysis({ requirements: [{ name: 'AWS', importance: 'must', match: 'yes', skills: ['aws'], note: '' }] });
  assert.ok(rankBullets(v4(), a).some((entry) => entry.id === 'short-aws'));
});

test('a short mission the model picked stays, even beside a main mission backing the same requirement', () => {
  const a = analysis({
    requirements: [{ name: 'Cloud & IaC', importance: 'nice', match: 'yes', skills: ['terraform', 'aws'], note: '' }],
    experiences: [{ id: 'acme', bullets: ['acme-pg'] }, { id: 'short', bullets: ['short-aws'] }],
  });
  assert.ok(rankBullets(v4(), a).some((entry) => entry.id === 'short-aws'));
});
