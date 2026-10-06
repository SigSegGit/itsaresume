// 2.22b: the questions to the owner. A requirement no profile skill meets,
// in one run or across all of them, grouped by its concept (ESCO and
// data/tech.json, else its own words), minus what he already answered and
// what the profile now says, ranked by how many offers ask it. Only a skill
// is asked: a quality, a condition, a language, a certification, or what the
// profile says he never did is not a question.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gatherQuestions, readRuns } from '../src/questions.js';

const PROFILE = new URL('./fixtures/profile.synthetic.json', import.meta.url);
const CLI = new URL('../bin/itsacv.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const profile = () => JSON.parse(readFileSync(PROFILE, 'utf8'));
const req = (name, match = 'no', fields = {}) => ({ name, importance: 'must', match, skills: [], note: '', ...fields });
const run = (name, offer, requirements) => ({ name, offer, analysis: { requirements } });
const asked = (questions) => questions.map((question) => question.asked);

test('a requirement no profile skill meets is a question; a met or adjacent one is not', () => {
  const questions = gatherQuestions([run('a', 'offer one', [req('Rust'), req('Terraform', 'yes'), req('Kafka', 'adjacent')])], { profile: profile() });
  assert.deepEqual(asked(questions), ['Rust']);
});

test('only a skill is asked: a quality, a condition, a language, a certification, a never-claimed one are not', () => {
  const questions = gatherQuestions([run('a', 'offer one', [
    req('Autonomie', 'no', { kind: 'quality' }),
    req('Permis B', 'no', { kind: 'condition' }),
    req('Allemand', 'no', { kind: 'language' }),
    req('CKA', 'no', { kind: 'certification' }),
    req('COBOL', 'no', { never: true }),
    req('Rust'),
  ])], { profile: profile() });
  assert.deepEqual(asked(questions), ['Rust']);
});

test('requirements naming one concept are one question, counted once per offer, ranked by offers then musts', () => {
  const questions = gatherQuestions([
    run('a', 'offer one', [req('Kubernetes'), req('Rust', 'no', { importance: 'nice' })]),
    run('b', 'offer two', [req('K8s'), req('Zig'), req('Rust', 'no', { importance: 'nice' }), req('Ada', 'no', { importance: 'nice' })]),
    run('c', '  offer   one ', [req('Kubernetes')]),
  ], { profile: profile() });
  assert.deepEqual(asked(questions), ['Kubernetes', 'Rust', 'Zig', 'Ada']);
  const [kubernetes, rust, zig] = questions;
  assert.deepEqual(kubernetes.names, ['Kubernetes', 'K8s']);
  assert.deepEqual(kubernetes.concepts, ['tech:kubernetes']);
  assert.equal(kubernetes.offers, 2);
  assert.equal(kubernetes.must, 2);
  assert.deepEqual(kubernetes.runs, ['a', 'b', 'c']);
  assert.equal(zig.must, 1);
  assert.equal(rust.must, 0);
});

test('what the owner answered is not asked again, yes or no, by the words asked or the name given', () => {
  const questions = gatherQuestions([run('a', 'offer one', [req('Kubernetes'), req('Rust'), req('Zig')])], {
    profile: profile(),
    answers: [
      { id: 'k8s-1', asked: 'K8s', answer: 'no', at: '2026-10-06' },
      { id: 'rust-1', asked: 'Rust lang', answer: 'yes', name: 'Rust', at: '2026-10-06' },
    ],
  });
  assert.deepEqual(asked(questions), ['Zig']);
});

test('a requirement the profile now meets, by a name or a concept, is not a question (an older run)', () => {
  // PostgreSQL 16: by its concept only; Hyperion Forge (no concept): by its name only.
  const owner = profile();
  owner.skills.push({ id: 'forge', name: 'Hyperion Forge', group: 'iac', level: 'working', aliases: [] });
  const questions = gatherQuestions([run('a', 'offer one', [req('PostgreSQL 16'), req('hyperion forge'), req('Amazon Web Services'), req('Rust')])], { profile: owner });
  assert.deepEqual(asked(questions), ['Rust']);
});

test('a run older than a rule is read with today\'s rules: a quality, a condition, a language, a certification it kept as a skill is not asked', () => {
  const questions = gatherQuestions([run('a', 'offer one', [req('Curieux techniquement'), req('Nationalité française'), req('Anglais professionnel'), req('Certification CKA'), req('Rust')])], { profile: profile() });
  assert.deepEqual(asked(questions), ['Rust']);
});

test('runs older than offer.txt are one offer per first line, joined to the text a later run of it kept', () => {
  const lead = (name, offer) => ({ name, offer, analysis: { requirements: [req('Rust')] } });
  const questions = gatherQuestions([
    lead('20260924-010000-ai-tech-lead', null),
    lead('20260925-020000-ai-tech-lead', null),
    lead('20261001-030000-ai-tech-lead', 'AI Tech Lead\nthe offer'),
    lead('20261002-040000-sre', null),
    lead('20261003-050000-sre', null),
  ], { profile: profile() });
  assert.equal(questions[0].offers, 2);
});

test('readRuns reads each run with an analysis, skips the others, and names the unreadable', () => {
  const out = mkdtempSync(join(tmpdir(), 'itsacv-questions-'));
  try {
    mkdirSync(join(out, '20261001-100000-sre'));
    writeFileSync(join(out, '20261001-100000-sre', 'analysis.json'), JSON.stringify({ requirements: [req('Rust')] }));
    writeFileSync(join(out, '20261001-100000-sre', 'offer.txt'), 'offer one');
    mkdirSync(join(out, '20261001-110000-rejected'));
    writeFileSync(join(out, '20261001-110000-rejected', 'rejected-attempt-1.txt'), 'nonsense');
    mkdirSync(join(out, '20261001-120000-broken'));
    writeFileSync(join(out, '20261001-120000-broken', 'analysis.json'), '{ not json');
    writeFileSync(join(out, 'qa-log.jsonl'), '');
    const { runs, unreadable } = readRuns(out);
    assert.deepEqual(runs.map((entry) => [entry.name, entry.offer]), [['20261001-100000-sre', 'offer one']]);
    assert.deepEqual(asked(gatherQuestions(runs, { profile: profile() })), ['Rust']);
    assert.deepEqual(unreadable.map((entry) => entry.name), ['20261001-120000-broken']);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('itsacv questions prints the questions of every run, or of the runs named, minus the answers beside the profile', () => {
  const home = mkdtempSync(join(tmpdir(), 'itsacv-questions-'));
  try {
    const out = join(home, 'out');
    writeFileSync(join(home, 'profile.json'), readFileSync(PROFILE));
    writeFileSync(join(home, 'answers.json'), JSON.stringify([{ id: 'zig-1', asked: 'Zig', answer: 'no', at: '2026-10-06' }]));
    for (const [name, offer, names] of [['r1', 'offer one', ['Kubernetes', 'Rust']], ['r2', 'offer two', ['K8s', 'Zig']]]) {
      mkdirSync(join(out, name), { recursive: true });
      writeFileSync(join(out, name, 'analysis.json'), JSON.stringify({ requirements: names.map((entry) => req(entry)) }));
      writeFileSync(join(out, name, 'offer.txt'), offer);
    }
    const all = spawnSync(process.execPath, [CLI, 'questions', '--out', out, '--profile', join(home, 'profile.json')], { encoding: 'utf8' });
    assert.equal(all.status, 0, all.stderr);
    const lines = all.stdout.split('\n').filter((line) => /^\s*\d+ offer/.test(line));
    assert.equal(lines.length, 2, all.stdout);
    assert.match(lines[0], /^\s*2 offers.*Kubernetes.*K8s/);
    assert.match(lines[1], /^\s*1 offer\b.*Rust/);
    assert.doesNotMatch(all.stdout, /Zig/);
    const one = spawnSync(process.execPath, [CLI, 'questions', join(out, 'r2'), '--profile', join(home, 'profile.json')], { encoding: 'utf8' });
    assert.equal(one.status, 0, one.stderr);
    assert.match(one.stdout, /K8s/);
    assert.doesNotMatch(one.stdout, /Rust|Zig/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
