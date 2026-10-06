// 2.22a: the owner's answers to "do you have this skill?" join the profile.
// His own sentence is the skill's quote (ADR-6: the owner's words are a
// source, a model never writes one); a "no" adds nothing; an answer can
// neither raise nor duplicate what the profile already says, nor bring back
// a skill the evidence contradicts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeAnswers } from '../src/answers.js';
import { validateProfile } from '../src/profile.js';
import { loadProfile, RunError } from '../src/run.js';

const PROFILE = new URL('./fixtures/profile.synthetic.json', import.meta.url);
const profile = () => JSON.parse(readFileSync(PROFILE, 'utf8'));
const yes = (fields = {}) => ({
  id: 'kafka-1', asked: 'Kafka (streaming)', answer: 'yes', name: 'Kafka', level: 'working',
  group: 'db', said: 'J\'ai exploité Kafka deux ans pour les flux de facturation.', at: '2026-10-06', ...fields,
});

test('a "yes" answer becomes a skill the pipeline can use, at the owner\'s level, quoting him', () => {
  const { profile: merged, added, errors } = mergeAnswers(profile(), [yes()]);
  assert.deepEqual(errors, []);
  assert.deepEqual(added, ['answer-kafka-1']);
  const skill = merged.skills.find((entry) => entry.id === 'answer-kafka-1');
  assert.equal(skill.name, 'Kafka');
  assert.equal(skill.level, 'working');
  assert.equal(skill.group, 'db');
  assert.equal(skill.quote, yes().said);
  assert.deepEqual(skill.provenance, { answer: 'kafka-1' });
  assert.deepEqual(validateProfile(merged).errors, []);
});

test('a "no" answer adds nothing', () => {
  const before = profile();
  const { profile: merged, added, errors } = mergeAnswers(before, [yes({ answer: 'no', level: undefined, said: '' })]);
  assert.deepEqual(errors, []);
  assert.deepEqual(added, []);
  assert.equal(merged.skills.length, before.skills.length);
});

test('an answer the profile cannot take is refused, by name', () => {
  const cases = [
    [yes({ level: 'guru' }), /kafka-1: level guru/],
    [yes({ said: '  ' }), /kafka-1: no sentence/],
    [yes({ group: 'nowhere' }), /kafka-1: unknown group nowhere/],
    [yes({ name: 'postgres' }), /kafka-1: PostgreSQL already says postgres/],
    [yes({ answer: 'maybe' }), /kafka-1: answer maybe/],
  ];
  for (const [answer, message] of cases) {
    const { added, errors } = mergeAnswers(profile(), [answer]);
    assert.deepEqual(added, [], `${answer.id} was added`);
    assert.match(errors.join('\n'), message);
  }
});

test('two answers with one id are refused', () => {
  const { errors } = mergeAnswers(profile(), [yes(), yes({ name: 'RabbitMQ' })]);
  assert.match(errors.join('\n'), /kafka-1: answered twice/);
});

test('an answer cannot bring back a skill the evidence contradicts', () => {
  const blocked = new Map([['kafka', { name: 'Kafka', names: ['kafka'], verdict: 'contradicted' }]]);
  const { added, errors } = mergeAnswers(profile(), [yes()], { blocked });
  assert.deepEqual(added, []);
  assert.match(errors.join('\n'), /kafka-1: the evidence says Kafka is contradicted/);
});

test('loadProfile merges answers.json beside the profile, and refuses a bad one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'itsacv-answers-'));
  try {
    const path = join(dir, 'profile.json');
    writeFileSync(path, readFileSync(PROFILE, 'utf8'));
    assert.equal(loadProfile(path).profile.skills.some((skill) => skill.id === 'answer-kafka-1'), false);
    writeFileSync(join(dir, 'answers.json'), JSON.stringify([yes()]));
    assert.equal(loadProfile(path).profile.skills.some((skill) => skill.id === 'answer-kafka-1'), true);
    writeFileSync(join(dir, 'answers.json'), JSON.stringify([yes({ level: 'guru' })]));
    assert.throws(() => loadProfile(path), (error) => error instanceof RunError && error.code === 2 && /kafka-1: level guru/.test(error.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
