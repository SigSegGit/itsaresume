// 2.25b: a compact catalogue, same skills: every id, name, alias, term,
// level and group still in the prompt, in fewer characters. Off by default
// until a real replay shows no run loses a matched requirement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPrompt } from '../src/prompt.js';

function profile() {
  const p = JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));
  p.skills.push({ id: 'oncall', name: 'Astreinte', group: 'iac', level: 'lab', aliases: ['on-call'], terms: ['incidents', 'incident', 'post-mortem'] });
  return p;
}

test('the compact catalogue keeps every skill id, name, alias and term', () => {
  const p = profile();
  const { prompt } = buildPrompt(p, 'Offre.', [], { compact: true });
  for (const skill of p.skills) {
    for (const word of [skill.id, skill.name, ...(skill.aliases ?? []), ...(skill.terms ?? [])]) assert.ok(prompt.includes(word), `${skill.id}: ${word}`);
  }
});

test('the compact catalogue states each skill’s level and group, lab still spelt out', () => {
  const { prompt } = buildPrompt(profile(), 'Offre.', [], { compact: true });
  assert.match(prompt, /Levels: E expert, P proficient, W working, N notions, L lab \(personal R&D only\)/);
  assert.match(prompt, /^Group db\b[^\n]*\n- postgresql — PostgreSQL \/ Postgres, E$/m);
  assert.match(prompt, /- oncall — Astreinte \/ on-call \[incidents, post-mortem\], L$/m, 'a term the lexicon keys alike ("incident") once');
});

test('the compact catalogue is shorter, and the default prompt is unchanged', () => {
  const p = profile();
  const plain = buildPrompt(p, 'Offre.', []).prompt;
  const compact = buildPrompt(p, 'Offre.', [], { compact: true }).prompt;
  assert.ok(compact.length < plain.length, `${compact.length} < ${plain.length}`);
  assert.match(plain, /Skills \(id — name, level, group\):/);
});
