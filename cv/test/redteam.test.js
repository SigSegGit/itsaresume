// Regressions from the red-team pass of 2026-09-24. Each test is an attack
// that worked, reproduced with a fully obedient model; each now fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v4 } from './fixtures/v4.js';
import { validateAnalysis } from '../src/analysis.js';
import { normalize } from '../src/normalize.js';
import { validateProfile } from '../src/profile.js';
import { checkProvenance } from '../src/evidence.js';
import { buildModel } from '../src/tailor.js';

const CYRILLIC_E = String.fromCharCode(0x0435);
const BOM = String.fromCharCode(0xfeff);
const SOFT_HYPHEN = String.fromCharCode(0x00ad);
const fullwidth = (text) => [...text].map((c) => (/[!-~]/.test(c) ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c)).join('');

const OFFER = 'Senior SRE wanted.\nMust have: PostgreSQL. Kubernetes is a must too.';

const answer = (overrides = {}) => ({
  language: 'en',
  fit: { score: 50, verdict: 'partial', rationale: '' },
  headline: 'Senior SRE',
  summary: ['SRE running PostgreSQL in critical production.'],
  requirements: [{ name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' }],
  experiences: [{ id: 'acme', bullets: ['acme-pg'] }],
  skill_groups: [{ id: 'db', skills: ['postgresql'] }],
  ...overrides,
});

const errorsOf = (overrides, offer = OFFER) => validateAnalysis(answer(overrides), v4(), { offer }).errors.join('\n');

test('a never-claimed skill written with a lookalike letter or an invisible character is still refused', () => {
  assert.match(errorsOf({ headline: `Senior SRE, Kubern${CYRILLIC_E}tes` }), /headline: a letter from another alphabet/);
  assert.match(errorsOf({ summary: [`Kubern${CYRILLIC_E}tes and PostgreSQL in critical production.`] }), /summary 1: a letter from another alphabet/);
  assert.match(errorsOf({ headline: `Senior SRE, Kuber${BOM}netes` }), /Kubernetes, which the profile says is never to be claimed/);
  assert.match(errorsOf({ headline: `Senior SRE, Kuber${SOFT_HYPHEN}netes` }), /Kubernetes, which the profile says is never to be claimed/);
  assert.match(errorsOf({ headline: `Senior SRE, Kuber${BOM}netes` }), /headline: a control character/);
  assert.match(errorsOf({ summary: [`See ${fullwidth('www.evil.example')} for more.`] }), /summary 1: a link/);
});

test('a technology the offer names cannot reach the headline by being left out of the requirements', () => {
  const offer = 'Data platform SRE wanted.\nMust have: PostgreSQL, Snowflake.\nSnowflake experience is essential.';
  assert.match(errorsOf({ headline: 'Senior SRE, PostgreSQL and Snowflake' }, offer), /headline: Snowflake comes from the offer, not from the profile/);
  assert.deepEqual(validateAnalysis(answer({ headline: 'Senior Data Platform SRE' }), v4(), { offer }).errors, [], 'the offer\'s title words are fine');
});

test('a lab-only requirement stays half credit when the model pads it with other skills', () => {
  const requirements = [{ name: 'Docker', importance: 'must', match: 'yes', skills: ['docker', 'postgresql'], note: '' }];
  const { analysis, repairs } = normalize(answer({ requirements }), v4(), { offer: 'Container engineer wanted. Must have: Docker.' });
  assert.deepEqual(analysis.requirements[0].skills, ['docker']);
  assert.equal(analysis.fit.score, 50);
  assert.equal(analysis.fit.qualification.level, 'not-qualified');
  assert.match(repairs.join('\n'), /requirement Docker: named like the profile skill docker/);
});

test('a never-claimed item the offer names counts, even when the model leaves it out', () => {
  const { analysis, repairs } = normalize(answer(), v4(), { offer: 'Senior SRE wanted.\nMust have: Kubernetes in production, PostgreSQL.' });
  const added = analysis.requirements.find((r) => r.name === 'Kubernetes');
  assert.ok(added, 'added from the offer text');
  assert.deepEqual({ importance: added.importance, match: added.match, never: added.never }, { importance: 'must', match: 'no', never: true });
  assert.deepEqual(analysis.fit.qualification.gaps, ['Kubernetes (never claimed)']);
  assert.match(repairs.join('\n'), /Kubernetes: named in the offer, never claimed in the profile/);
});

test('a skill may not be tied in the free text to a mission that never used it', () => {
  const errors = errorsOf({ summary: ['Ran Docker and Oracle in critical production at Acme Payments.'] }, 'Senior SRE wanted. Must have: PostgreSQL, Docker, Oracle.');
  assert.match(errors, /summary 1: Docker is tied to Acme Payments, where it was not used/);
  assert.match(errors, /summary 1: Oracle is tied to Acme Payments, where it was not used/);
  assert.deepEqual(validateAnalysis(answer({ summary: ['Ran PostgreSQL at Acme Payments; Oracle at Example Bank.'] }), v4(), { offer: OFFER }).errors, []);
});

test('a lab skill is labelled in the document keywords too', () => {
  const a = answer({ requirements: [{ name: 'Docker', importance: 'nice', match: 'yes', skills: ['docker'], note: '' }] });
  assert.ok(buildModel(v4(), a).keywords.includes('Docker (lab)'));
});

test('repeated requirement rows count once', () => {
  const rows = Array.from({ length: 9 }, () => ({ name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' }));
  const requirements = [...rows, { name: 'Kafka', importance: 'must', match: 'no', skills: [], note: '' }];
  const { analysis, repairs } = normalize(answer({ requirements }), v4(), { offer: 'Senior SRE wanted. Must have: PostgreSQL and Kafka.' });
  assert.equal(analysis.requirements.length, 2);
  assert.equal(analysis.fit.score, 50);
  assert.equal(analysis.fit.qualification.level, 'not-qualified');
  assert.match(repairs.join('\n'), /requirement PostgreSQL: listed 9 times, counted once/);
});

test('of two rows for one requirement, the stricter match is kept', () => {
  const requirements = [
    { name: 'Oracle tuning', importance: 'nice', match: 'yes', skills: ['oracle'], note: '' },
    { name: 'Oracle tuning', importance: 'must', match: 'adjacent', skills: ['oracle'], note: '' },
  ];
  const { analysis } = normalize(answer({ requirements }), v4(), { offer: 'Senior SRE wanted. Must have: Oracle tuning.' });
  assert.deepEqual(analysis.requirements.map((r) => [r.name, r.importance, r.match]), [['Oracle tuning', 'must', 'adjacent']]);
});

/** Seen on a real run: 50 skills picked, the column ran onto a second page
 * and pushed every optional bullet off the CV. */
test('the skills column holds at most six groups of six skills, those meeting a requirement first', () => {
  const p = v4();
  for (let i = 0; i < 8; i += 1) p.skills.push({ id: `db${i}`, name: `Base${i}`, group: 'db', level: 'working', aliases: [] });
  for (let g = 0; g < 6; g += 1) {
    p.skill_groups.push({ id: `g${g}`, title: { fr: `G${g}`, en: `G${g}` } });
    p.skills.push({ id: `s${g}`, name: `Tool${g}`, group: `g${g}`, level: 'working', aliases: [] });
  }
  const a = answer({
    requirements: [{ name: 'Base7', importance: 'must', match: 'yes', skills: ['db7'], note: '' }],
    skill_groups: [{ id: 'db', skills: Array.from({ length: 8 }, (_, i) => `db${i}`) }, ...Array.from({ length: 6 }, (_, g) => ({ id: `g${g}`, skills: [`s${g}`] }))],
  });
  const { analysis, repairs } = normalize(a, p);
  assert.equal(analysis.skill_groups.length, 6);
  assert.equal(analysis.skill_groups[0].skills.length, 6);
  assert.equal(analysis.skill_groups[0].skills[0], 'db7', 'the skill meeting a requirement comes first');
  assert.match(repairs.join('\n'), /skill group db: 8 skills, cut to 6/);
  assert.match(repairs.join('\n'), /skill group g5: beyond 6 groups, left out/);
});

test('a requirement the offer never states is dropped, and brings nothing onto the CV', () => {
  const offer = 'Senior DBA wanted. Must have: PostgreSQL. Conteneurs appréciés.';
  const requirements = [
    { name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' },
    { name: 'AWS', importance: 'nice', match: 'yes', skills: ['aws'], note: '' },
    { name: 'Terraform', importance: 'must', match: 'yes', skills: ['terraform'], note: '' },
    { name: 'Conteneurisation', importance: 'nice', match: 'yes', skills: ['docker'], note: '' },
  ];
  const { analysis, repairs } = normalize(answer({ requirements }), v4(), { offer });
  assert.deepEqual(analysis.requirements.map((r) => r.name), ['PostgreSQL', 'Conteneurisation'], 'a word of the offer, inflected, still counts');
  assert.match(repairs.join('\n'), /requirement AWS: not stated in the offer, dropped/);
  assert.ok(!buildModel(v4(), analysis).experiences.some((e) => e.title === 'Short assignments'));
});

test('a profile line must be made of its quotes, name no skill its French lacks, and no never-claimed item', () => {
  const p = v4();
  p.truth = 'truth';
  p.sources = [{ id: 'truth', grade: 'B', title: 'Truth', file: 'truth.md' }];
  const text = [
    ...p.experiences.flatMap((e) => e.bullets.map((b) => b.fr)),
    ...p.profile_facts.map((f) => f.fr),
    'PostgreSQL | Kubernetes | Non',
  ].join('\n');
  const texts = [{ id: 'truth', text }];
  assert.deepEqual(checkProvenance(p, texts), []);
  const pg = p.experiences[0].bullets[0];
  pg.quotes = [];
  assert.match(checkProvenance(p, texts).join('\n'), /bullet acme-pg: no quote/);
  pg.quotes = ['PostgreSQL', 'Kubernetes'];
  pg.fr = 'Migration de la production PostgreSQL vers Kubernetes.';
  assert.match(checkProvenance(p, texts).join('\n'), /bullet acme-pg: "migration" is in none of its quotes/);
  delete pg.quotes;
  pg.fr = 'Exploitation d\'une flotte PostgreSQL.';
  pg.en = 'Ran a PostgreSQL fleet and Oracle.';
  assert.match(checkProvenance(p, texts).join('\n'), /bullet acme-pg: the English text names Oracle, the French one does not/);
  const q = v4();
  q.experiences[0].bullets[0].fr = 'Migration vers Kubernetes.';
  assert.match(validateProfile(q).errors.join('\n'), /bullet acme-pg names Kubernetes, which is never claimed/);
});
/** Seen on a real run (AI Tech Lead offer): "Pédagogie: yes — Design produit,
 * DevOps", "Communication claire: yes — Anglais, Français", "Écoute: yes —
 * DevOps". The profile says nothing of the kind; the score and the
 * qualification rose on it. A requirement is met only through a skill the
 * profile names for it: one of its words is in the skill's name, an alias or
 * a term. (Personal qualities are now set apart, test/scoring.test.js; the
 * rule is shown here on requirements that are scored.) */
test('a requirement its skills do not name is the model reading only: half credit, to verify, a gap of the qualification', () => {
  const p = v4();
  p.skills.find((s) => s.id === 'python').terms = ['scripting'];
  const offer = 'Senior SRE wanted. Must have: virtualisation, scripting avancé, PostgreSQL. Supervision.';
  const requirements = [
    { name: 'Virtualisation', importance: 'must', match: 'yes', skills: ['terraform', 'python'], note: '' },
    { name: 'Supervision', importance: 'must', match: 'adjacent', skills: ['postgresql'], note: '' },
    { name: 'Scripting avancé', importance: 'must', match: 'yes', skills: ['python'], note: '' },
    { name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' },
  ];
  const { analysis, repairs } = normalize(answer({ requirements }), p, { offer });
  assert.deepEqual(analysis.requirements.map((r) => [r.name, r.match, r.judged === true]), [
    ['Virtualisation', 'adjacent', true], ['Supervision', 'adjacent', true], ['Scripting avancé', 'yes', false], ['PostgreSQL', 'yes', false],
  ]);
  assert.equal(analysis.fit.score, 75);
  assert.deepEqual(analysis.fit.qualification.gaps, ['Virtualisation (to verify)', 'Supervision (to verify)']);
  assert.match(repairs.join('\n'), /requirement Virtualisation: no profile skill names it, the model's reading only: adjacent, to verify/);
});

/** Seen on a real run (architect offer): "Expert en PostgreSQL haute
 * disponibilité" — PostgreSQL HA is lab-only in the profile. A summary
 * sentence naming what only the lab covers says so, as the owner's own
 * wording does ("haute disponibilité Patroni/etcd pratiquée en lab"). The
 * headline is a title ("Ingénieur plateforme IA") and is not held to it. */
test('a summary sentence naming what only the lab covers says it comes from the lab or R&D', () => {
  const offer = 'Senior SRE wanted. Must have: PostgreSQL, Docker.';
  const errors = (summary, headline = 'Senior SRE') => validateAnalysis(answer({ summary: [summary], headline }), v4(), { offer }).errors.join('\n');
  assert.match(errors('Runs PostgreSQL and Docker in critical production.'), /summary 1: Docker is practised in the lab only: say so/);
  assert.match(errors('Containers expert with PostgreSQL.'), /summary 1: containers is practised in the lab only: say so/i);
  assert.equal(errors('Runs PostgreSQL; ships a router as a Docker container in R&D.'), '');
  assert.equal(errors('Runs PostgreSQL in critical production.', 'Senior SRE, Docker'), '', 'not the headline');
});

/** Second pass (2026-09-24): a combining grapheme joiner or a variation
 * selector renders as nothing, like U+FEFF did. */
test('an invisible combining mark does not hide a never-claimed skill', () => {
  for (const code of [0x034f, 0xfe0f, 0x180b]) {
    const hidden = `Senior SRE, Kuber${String.fromCharCode(code)}netes`;
    assert.match(errorsOf({ headline: hidden }), /Kubernetes, which the profile says is never to be claimed/, code.toString(16));
  }
});

test('a number written in words must come from the profile too', () => {
  assert.match(errorsOf({ summary: ['Twenty years running PostgreSQL in critical production.'] }), /summary 1: the number twenty is not in the profile/i);
  assert.match(errorsOf({ summary: ['SRE avec quinze ans en production critique.'] }), /summary 1: the number quinze is not in the profile/);
});

test('summary sentences are strings and importance is must or nice', () => {
  const bad = validateAnalysis(answer({ summary: [{ text: 'x' }, true] }), v4(), { offer: OFFER }).errors.join('\n');
  assert.match(bad, /summary 1 is not a sentence/);
  const requirements = [{ name: 'PostgreSQL', importance: 'call +33 6 12 34 56 78', match: 'yes', skills: ['postgresql'], note: '' }];
  const { analysis, repairs } = normalize(answer({ requirements }), v4(), { offer: OFFER });
  assert.equal(analysis.requirements[0].importance, 'must');
  assert.match(repairs.join('\n'), /requirement PostgreSQL: importance .* read as must/);
});
