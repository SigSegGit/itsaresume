// 2.7d, the mirror of the equivalents set (Rodin, 2026-09-29): requirements
// that name a profile skill and must still not be met through it. Part 1
// tested only false "no"; nothing tested a false "adjacent".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize } from '../src/normalize.js';
import { validateAnalysis } from '../src/analysis.js';

function profile(extra = [], never = [{ name: 'Kubernetes', aliases: ['K8s'] }]) {
  const p = JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));
  p.skills.push(...extra);
  p.never = never;
  return p;
}

const analysis = (requirements) => ({
  language: 'fr',
  fit: { score: 50, verdict: 'partial', rationale: '' },
  headline: 'SRE',
  summary: ['SRE.'],
  requirements,
  experiences: [],
  skill_groups: [],
});

const judge = (name, p = profile(), match = 'no', skills = []) =>
  normalize(analysis([{ name, importance: 'must', match, skills, note: '' }]), p).analysis.requirements[0];

const PUPPET = { id: 'puppet', name: 'Puppet', group: 'iac', level: 'proficient', aliases: [] };
const ANSIBLE = { id: 'ansible', name: 'Ansible', group: 'iac', level: 'proficient', aliases: [] };
const KUBERNETES = { id: 'kubernetes', name: 'Kubernetes', group: 'iac', level: 'proficient', aliases: [] };

test('a certification the profile does not hold stays no, though the skill is owned', () => {
  const row = judge('Certification AWS exigée');
  assert.equal(row.match, 'no');
  assert.equal(row.kind, 'certification');
});

test('a certification the model met through the skill is no: the profile holds no such certification', () => {
  const row = judge('Certification AWS exigée', profile(), 'yes', ['aws']);
  assert.equal(row.match, 'no');
  assert.deepEqual(row.skills, []);
});

test('a certification named by its code alone ("niveau CKA") is not met by owning Kubernetes', () => {
  assert.equal(judge('Expertise Kubernetes niveau CKA', profile([KUBERNETES], [])).match, 'no');
});

test('a certification the profile holds, expired, is adjacent with its line', () => {
  const row = judge('Certification ITIL v4');
  assert.equal(row.match, 'adjacent');
  assert.match(row.note, /ITIL v4 — expirée/);
});

test('a met certification row passes validation without a profile skill', () => {
  const { analysis: normalised } = normalize(analysis([{ name: 'Certification ITIL v4', importance: 'must', match: 'no', skills: [], note: '' }]), profile());
  assert.equal(normalised.requirements[0].match, 'adjacent');
  assert.deepEqual(validateAnalysis(normalised, profile()).errors.filter((error) => /Certification/.test(error)), []);
});

test('the TLS certificates of a PKI are not a certification', () => {
  assert.equal(judge('Gestion des certificats TLS').kind, undefined);
});

test('a migration to a tool the profile lacks is not met by the tool it leaves', () => {
  assert.equal(judge('Migration de Puppet vers Ansible', profile([PUPPET])).match, 'no');
});

test('a migration to a tool the profile holds is met through that tool only', () => {
  const row = judge('Migration de Puppet vers Ansible', profile([PUPPET, ANSIBLE]));
  assert.equal(row.match, 'adjacent');
  assert.deepEqual(row.equivalent, ['Ansible']);
});

test('"Base de données NoSQL" is not met through PostgreSQL and Oracle', () => {
  assert.equal(judge('Base de données NoSQL').match, 'no');
});

test('"Bases de données NoSQL" is met through MongoDB when the profile holds it', () => {
  const row = judge('Bases de données NoSQL', profile([{ id: 'mongodb', name: 'MongoDB', group: 'db', level: 'working', aliases: [] }]));
  assert.equal(row.match, 'adjacent');
  assert.deepEqual(row.equivalent, ['MongoDB']);
});

test('a migration the model met through the tool it leaves is only the model\'s reading', () => {
  const row = judge('Migration de Puppet vers Ansible', profile([PUPPET]), 'yes', ['puppet']);
  assert.equal(row.match, 'adjacent');
  assert.equal(row.judged, true);
});
