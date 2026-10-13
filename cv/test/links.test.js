// 2.25a: links between an offer's words and the owner's skills, mined from
// the model's past matches (accepted by code from 3 distinct offers) or ruled
// by the owner (same / near / no, in a private file beside the profile).
// 2.3b-ii: the shortlist those links and the lexicon give each listed
// requirement, offered to the model first, never a lock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_OFFERS, linkedSkills, mergeLinks, mineLinks, readLinks, shortlist } from '../src/links.js';
import { normalize } from '../src/normalize.js';
import { buildPrompt } from '../src/prompt.js';

function profile(links = []) {
  const p = JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));
  p.skills.push({ id: 'ad', name: 'Active Directory', group: 'iac', level: 'proficient', aliases: ['AD'] });
  p.links = links;
  return p;
}

const run = (requirements) => ({ requirements });
const analysis = (requirements) => ({
  language: 'fr',
  fit: { score: 50, verdict: 'partial', rationale: '' },
  headline: 'SRE',
  summary: ['SRE.'],
  requirements,
  experiences: [],
  skill_groups: [],
});

test('mining pairs each content word of a matched requirement with its skills, counted once per offer', () => {
  const p = profile();
  const mined = mineLinks([
    run([{ name: 'Chaîne CI/CD', match: 'yes', skills: ['docker'] }, { name: 'CI/CD encore', match: 'yes', skills: ['docker'] }]),
    run([{ name: 'Pipelines CI/CD', match: 'adjacent', skills: ['docker', 'unknown'] }]),
    run([{ name: 'CI/CD', match: 'no', skills: [] }]),
  ], p);
  const ci = mined.find((link) => link.words === 'ci' && link.skill === 'docker');
  assert.equal(ci.offers, 2, 'two offers, the repeat inside one offer counts once, a "no" never');
  assert.ok(!mined.some((link) => link.skill === 'unknown'), 'a skill the profile lacks is not mined');
  assert.ok(!mined.some((link) => link.words === 'de' || link.words === 'encore' && link.offers > 1));
});

test('a mined link joins the shortlist from 3 offers; below that it waits for a verdict', () => {
  assert.equal(MIN_OFFERS, 3);
  const p = profile([
    { words: 'ci', skill: 'docker', offers: 3, verdict: null },
    { words: 'pipeline', skill: 'terraform', offers: 2, verdict: null },
  ]);
  assert.deepEqual(linkedSkills(p.links, 'Chaîne CI/CD').mined, ['docker']);
  assert.deepEqual(linkedSkills(p.links, 'Pipelines de livraison').mined, [], '2 offers: waiting');
  assert.ok(shortlist(p, 'Chaîne CI/CD').includes('docker'));
  assert.ok(!shortlist(p, 'Pipelines de livraison').includes('terraform'));
});

test('the owner’s verdicts rule: same and near join the shortlist whatever the count, no removes a skill from it', () => {
  const p = profile([
    { words: 'pipeline', skill: 'terraform', offers: 1, verdict: 'same' },
    { words: 'base', skill: 'oracle', offers: 9, verdict: 'no' },
  ]);
  assert.ok(shortlist(p, 'Pipelines de livraison').includes('terraform'));
  assert.ok(shortlist(p, 'Bases PostgreSQL').includes('postgresql'), 'the lexicon’s names stay');
  assert.ok(!shortlist(p, 'Bases de données').includes('oracle'), 'a "no" ruling is never offered');
});

test('words match whole words of the requirement, not inside another word', () => {
  const p = profile([{ words: 'ad cs', skill: 'ad', offers: 0, verdict: 'near' }]);
  assert.deepEqual(linkedSkills(p.links, 'PKI / AD CS').near, ['ad']);
  assert.deepEqual(linkedSkills(p.links, 'Cadcs').near, []);
});

test('merging keeps the owner’s verdicts and refreshes the counts', () => {
  const merged = mergeLinks(
    [{ words: 'ci', skill: 'docker', offers: 1, verdict: 'no' }],
    [{ words: 'ci', skill: 'docker', offers: 4 }, { words: 'sql', skill: 'oracle', offers: 1 }],
  );
  assert.deepEqual(merged, [
    { words: 'ci', skill: 'docker', offers: 4, verdict: 'no' },
    { words: 'sql', skill: 'oracle', offers: 1, verdict: null },
  ]);
});

test('the links file: missing is empty, a wrong verdict stops the run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'links-'));
  assert.deepEqual(readLinks(join(dir, 'links.json')), []);
  writeFileSync(join(dir, 'links.json'), JSON.stringify({ links: [{ words: 'ci', skill: 'docker', offers: 1, verdict: 'maybe' }] }));
  assert.throws(() => readLinks(join(dir, 'links.json')), /verdict/);
});

test('AD CS ruled near Active Directory: a "yes" through AD is adjacent, never yes', () => {
  const p = profile([{ words: 'ad cs', skill: 'ad', offers: 0, verdict: 'near' }, { words: 'adfs', skill: 'ad', offers: 0, verdict: 'near' }]);
  const { analysis: out } = normalize(analysis([{ name: 'AD CS', importance: 'must', match: 'yes', skills: ['ad'], note: '' }]), p);
  assert.equal(out.requirements[0].match, 'adjacent');
  assert.deepEqual(out.requirements[0].skills, ['ad']);
});

test('ADFS ruled near Active Directory: a "no" is adjacent through AD, never no', () => {
  const p = profile([{ words: 'adfs', skill: 'ad', offers: 0, verdict: 'near' }]);
  const { analysis: out } = normalize(analysis([{ name: 'ADFS', importance: 'must', match: 'no', skills: [], note: '' }]), p);
  assert.equal(out.requirements[0].match, 'adjacent');
  assert.deepEqual(out.requirements[0].skills, ['ad']);
});

test('a "no" ruling drops that pick; with nothing left the requirement is no', () => {
  const p = profile([{ words: 'pki', skill: 'ad', offers: 5, verdict: 'no' }]);
  const { analysis: out } = normalize(analysis([{ name: 'PKI', importance: 'must', match: 'adjacent', skills: ['ad'], note: '' }]), p);
  assert.equal(out.requirements[0].match, 'no');
  assert.deepEqual(out.requirements[0].skills, []);
});

test('the prompt offers each listed requirement its shortlist, and says it is not a limit', () => {
  const p = profile([{ words: 'ci', skill: 'docker', offers: 3, verdict: null }]);
  const { prompt } = buildPrompt(p, 'Offre : chaîne CI/CD et PostgreSQL.', [{ name: 'Chaîne CI/CD', importance: 'must' }, { name: 'Gouvernance', importance: 'nice' }]);
  assert.match(prompt, /- Chaîne CI\/CD \(must\) — candidates: docker/);
  assert.match(prompt, /- Gouvernance \(nice\)$/m, 'no candidate, nothing added');
  assert.match(prompt, /any other catalogue skill/i);
});

test('a pick outside the shortlist stays met when the grounding keeps it', () => {
  const p = profile([{ words: 'ci', skill: 'docker', offers: 3, verdict: null }]);
  const { analysis: out } = normalize(analysis([{ name: 'Python', importance: 'must', match: 'yes', skills: ['python'], note: '' }]), p);
  assert.equal(out.requirements[0].match, 'yes');
});
