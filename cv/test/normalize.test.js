// Safe repairs of a model's answer: they may move or remove what the model
// selected, never add anything the model did not point at, and never touch
// the free text (headline, summary) where invention lives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize } from '../src/normalize.js';
import { validateAnalysis } from '../src/analysis.js';

const profile = () => JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));
const answer = () => ({
  language: 'en',
  fit: { score: 72, verdict: 'good', rationale: '' },
  requirements: [{ name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' }],
  headline: 'Senior SRE',
  summary: ['Runs PostgreSQL.'],
  experiences: [{ id: 'acme', bullets: ['acme-pg'] }],
  skill_groups: [{ id: 'db', skills: ['postgresql'] }],
});

test('a bullet id given as an experience id is moved under its experience', () => {
  const a = answer();
  a.experiences.push({ id: 'bank-oracle', bullets: [] });
  const { analysis, repairs } = normalize(a, profile());
  assert.deepEqual(analysis.experiences, [
    { id: 'acme', bullets: ['acme-pg'] },
    { id: 'bank', bullets: ['bank-oracle'] },
  ]);
  assert.match(repairs.join('\n'), /bank-oracle/);
  assert.deepEqual(validateAnalysis(analysis, profile()).errors, []);
});

test('a bullet listed under the wrong experience moves to its own', () => {
  const a = answer();
  a.experiences[0].bullets.push('bank-oncall');
  const { analysis } = normalize(a, profile());
  assert.deepEqual(analysis.experiences, [
    { id: 'acme', bullets: ['acme-pg'] },
    { id: 'bank', bullets: ['bank-oncall'] },
  ]);
});

test('a requirement marked matched without any profile skill becomes unmatched', () => {
  const a = answer();
  a.requirements.push({ name: 'Kubernetes', importance: 'nice', match: 'adjacent', skills: [], note: '' });
  a.requirements.push({ name: 'Kafka', importance: 'nice', match: 'no', skills: ['docker'], note: '' });
  const { analysis, repairs } = normalize(a, profile());
  assert.equal(analysis.requirements[1].match, 'no');
  assert.deepEqual(analysis.requirements[2].skills, [], 'an unmatched requirement claims no skill');
  assert.equal(repairs.length, 2);
});

test('ids the profile does not have are dropped and reported, never kept', () => {
  const a = answer();
  a.experiences.push({ id: 'ghost-job', bullets: ['ghost-bullet'] });
  a.skill_groups[0].skills.push('cobol');
  a.skill_groups.push({ id: 'nowhere', skills: ['python'] });
  // On a requirement named like no profile skill: a named one keeps its own skill alone anyway.
  a.requirements.push({ name: 'Python scripting', importance: 'nice', match: 'yes', skills: ['python', 'fortran'], note: '' });
  const { analysis, repairs } = normalize(a, profile());
  const text = JSON.stringify(analysis);
  for (const id of ['ghost-job', 'ghost-bullet', 'cobol', 'nowhere', 'fortran']) {
    assert.ok(!text.includes(id), `${id} kept`);
    assert.match(repairs.join('\n'), new RegExp(id));
  }
});

test('a skill shown in the wrong group moves to its own group', () => {
  const a = answer();
  a.skill_groups[0].skills.push('terraform');
  const { analysis } = normalize(a, profile());
  assert.deepEqual(analysis.skill_groups, [
    { id: 'db', skills: ['postgresql'] },
    { id: 'iac', skills: ['terraform'] },
  ]);
});

test('the verdict always comes from the computed score, whatever the model said', () => {
  const a = answer();
  a.fit.verdict = 'great';
  a.fit.score = 12;
  const { fit } = normalize(a, profile()).analysis;
  assert.equal(fit.score, 100, 'one must-have, met');
  assert.equal(fit.verdict, 'strong');
});

/** The line normalisation must never cross. */
test('the headline and summary are never repaired: a false claim still fails', () => {
  const a = answer();
  a.requirements.push({ name: 'Kafka', importance: 'nice', match: 'no', skills: [], note: '' });
  a.summary.push('Kafka expert.');
  const { analysis } = normalize(a, profile());
  assert.deepEqual(analysis.summary, a.summary);
  assert.equal(analysis.headline, a.headline);
  assert.match(validateAnalysis(analysis, profile()).errors.join('\n'), /Kafka/);
});

test('normalisation does not modify its input', () => {
  const a = answer();
  a.experiences.push({ id: 'bank-oracle', bullets: [] });
  const before = JSON.stringify(a);
  normalize(a, profile());
  assert.equal(JSON.stringify(a), before);
});

/** Seen with gemma-4-e4b: "itsanas-architecture: Conception et ..." in place
 * of the id. The id before the colon is the model's own pointer. */
test('an "id: text" answer is read as the id', () => {
  const a = answer();
  a.experiences = [{ id: 'acme', bullets: ['acme-iac: Industrialised things with Terraform'] }];
  a.skill_groups = [{ id: 'db', skills: ['postgresql: the database'] }];
  const { analysis } = normalize(a, profile());
  assert.deepEqual(analysis.experiences, [{ id: 'acme', bullets: ['acme-iac'] }]);
  assert.deepEqual(analysis.skill_groups, [{ id: 'db', skills: ['postgresql'] }]);
});

/** Seen with gemma-4-e4b: "Kubernetes: adjacent via Docker" for a profile
 * that lists Kubernetes. The profile's own names settle it. */
test('a requirement named exactly like a profile skill is met by that skill', () => {
  const a = answer();
  a.requirements.push({ name: 'Amazon Web Services', importance: 'must', match: 'adjacent', skills: ['docker'], note: '' });
  a.requirements.push({ name: 'terraform', importance: 'must', match: 'no', skills: [], note: '' });
  const { analysis, repairs } = normalize(a, profile());
  assert.equal(analysis.requirements[1].match, 'yes');
  assert.deepEqual(analysis.requirements[1].skills, ['aws']);
  assert.equal(analysis.requirements[2].match, 'yes');
  assert.deepEqual(analysis.requirements[2].skills, ['terraform']);
  assert.match(repairs.join('\n'), /Amazon Web Services.*aws/);
});

// Seen 2026-10-06 on a real offer (cv §9): "stockage" became yes through the
// term of a P2P skill, "AI" through the term of an alerting skill, and each
// dropped the right skills. A term is broader than a name: it settles nothing.
test('a requirement named like a skill\'s term only is left to the model, its skills kept', () => {
  const p = profile();
  p.skills.push({ id: 'p2p', name: 'Stockage distribué P2P', group: 'infra', level: 'working', aliases: ['P2P'], terms: ['stockage', 'AI'] });
  const a = answer();
  a.requirements.push(
    { name: 'Stockage', importance: 'must', match: 'yes', skills: ['postgresql', 'oracle'], note: '' },
    { name: 'AI', importance: 'nice', match: 'no', skills: [], note: '' },
    { name: 'P2P', importance: 'nice', match: 'no', skills: [], note: '' },
  );
  const { analysis, repairs } = normalize(a, p);
  const row = (name) => analysis.requirements.find((r) => r.name === name);
  assert.deepEqual(row('Stockage').skills, ['postgresql', 'oracle'], 'the term\'s skill does not replace the model\'s');
  assert.deepEqual([row('AI').match, row('AI').skills], ['no', []]);
  assert.deepEqual([row('P2P').match, row('P2P').skills], ['yes', ['p2p']], 'an alias still settles it');
  assert.doesNotMatch(repairs.join('\n'), /requirement (Stockage|AI): named like/);
});

// Seen 2026-10-02: "Fortinet / FortiGate" stayed a gap beside the profile's
// Fortinet skill, "HA (haute disponibilité réseau)" went to a lab skill.
test('a requirement whose every part names a profile skill is met by those skills; one unnamed part keeps it as is', () => {
  const a = answer();
  a.requirements.push(
    { name: 'AWS / GCP', importance: 'must', match: 'no', skills: [], note: '' },
    { name: 'Python (scripting)', importance: 'must', match: 'adjacent', skills: ['oracle'], note: '' },
    { name: 'Kubernetes / Docker', importance: 'must', match: 'no', skills: [], note: '' },
  );
  const { analysis, repairs } = normalize(a, profile());
  const row = (name) => analysis.requirements.find((r) => r.name === name);
  assert.deepEqual([row('AWS / GCP').match, row('AWS / GCP').skills], ['yes', ['aws', 'gcp']]);
  assert.deepEqual([row('Python (scripting)').match, row('Python (scripting)').skills], ['yes', ['python']]);
  assert.notEqual(row('Kubernetes / Docker').match, 'yes', 'Kubernetes is not in the profile');
  assert.match(repairs.join('\n'), /requirement AWS \/ GCP: each part named like a profile skill \(aws, gcp\), now yes/);
});

// Measured on the real runs (2026-10-04): a skill's term is too loose for a
// part, "Sécurité (IA)" went to yes by SecOps's term "sécurité".
test('a part named only by a skill term does not meet the requirement', () => {
  const p = profile();
  p.skills.find((skill) => skill.id === 'docker').terms = ['conteneurs'];
  const a = answer();
  a.requirements.push({ name: 'Conteneurs (IA)', importance: 'must', match: 'adjacent', skills: ['docker'], note: '' });
  const { analysis } = normalize(a, p);
  assert.equal(analysis.requirements.find((r) => r.name === 'Conteneurs (IA)').match, 'adjacent');
});
