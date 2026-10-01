// 2.6: must or nice, decided by code from the offer's own cues. ADR-9: a
// 1.5B model read "Kafka serait un plus" as required; the listing call's
// rule ("must unless the offer calls it optional, a plus, or nice to have")
// is the model's to follow, the cues are the code's to read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importanceIn } from '../src/importance.js';
import { normalize } from '../src/normalize.js';

const CASES = [
  ['Kafka serait un plus.', 'Kafka', 'nice'],
  ["Maîtrise d'Ansible indispensable, Kafka serait un plus.", 'Ansible', 'must'],
  ["Maîtrise d'Ansible indispensable, Kafka serait un plus.", 'Kafka', 'nice'],
  ['Compétences obligatoires : Ansible, DevOps.', 'DevOps', 'must'],
  ['Nice to have:\n- Kafka\n- Terraform\n', 'Terraform', 'nice'],
  ['Idéalement, une première expérience GCP.', 'GCP', 'nice'],
  ['Une connaissance de Kafka, Terraform et Ansible serait appréciée.', 'Kafka', 'nice'],
  ['Kafka (un plus)', 'Kafka', 'nice'],
  ['Experience with Kafka is a plus.', 'Kafka', 'nice'],
  ['Terraform is required.', 'Terraform', 'must'],
  ['Kafka serait un plus.\nCompétences requises : Kafka, Linux.', 'Kafka', 'must'],
  // No cue, or a false friend: the code says nothing.
  ['Il y a plus de 10 serveurs Linux à administrer.', 'Linux', null],
  ['Un plus grand nombre de clusters PostgreSQL.', 'PostgreSQL', null],
  ['Profil souhaité :\n- PostgreSQL\n', 'PostgreSQL', null],
  ['Vous administrerez des clusters PostgreSQL.', 'PostgreSQL', null],
  ['Kafka serait un plus.', 'Terraform', null],
  // 2.1b, from the corpus: a negated must cue is no must; a cue on
  // "certification X" is the certification's; "a big plus" is a plus.
  ["La connaissance d'Ansible n'est pas obligatoire mais sera appréciée.", 'Ansible', 'nice'],
  ['Kubernetes is not required for this role.', 'Kubernetes', null],
  ['Kubernetes: not mandatory.', 'Kubernetes', null],
  ['It would be a big plus to know Sigstore.', 'Sigstore', 'nice'],
  ['Une certification AWS est un atout.', 'AWS', null],
  ['Une certification AWS est un atout.', 'certification AWS', 'nice'],
  ['Kubernetes certification (CKA) would be a plus.', 'CKA', 'nice'],
];

for (const [offer, name, expected] of CASES) {
  // Line breaks shown as " | ": a backslash in a test name is escaped by TAP.
  test(`${JSON.stringify(offer.replace(/\n/g, ' | '))}: ${name} is ${expected ?? 'left to the model'}`, () => {
    assert.equal(importanceIn(offer, name), expected);
  });
}

const analysis = (requirements) => ({
  language: 'fr',
  fit: { score: 50, verdict: 'partial', rationale: '' },
  headline: 'SRE',
  summary: ['SRE.'],
  requirements,
  experiences: [{ id: 'acme', bullets: ['acme-pg'] }],
  skill_groups: [],
});
const profile = () => JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));

test('normalize applies the offer\'s cues over the model\'s importance, and says so', () => {
  const offer = "Maîtrise de PostgreSQL indispensable. Terraform serait un plus.";
  const { analysis: out, repairs } = normalize(analysis([
    { name: 'PostgreSQL', importance: 'nice', match: 'yes', skills: ['postgresql'], note: '' },
    { name: 'Terraform', importance: 'must', match: 'yes', skills: ['terraform'], note: '' },
  ]), profile(), { offer });
  assert.deepEqual(out.requirements.map((r) => [r.name, r.importance]), [['PostgreSQL', 'must'], ['Terraform', 'nice']]);
  assert.match(repairs.join('\n'), /Terraform: nice by the offer's cue/);
});

test('a never-claimed requirement the offer calls a plus is not counted as a must', () => {
  const p = profile();
  p.never = [{ name: 'Kafka', aliases: [] }];
  const offer = 'Maîtrise de PostgreSQL indispensable. Kafka serait un plus.';
  const { analysis: out } = normalize(analysis([{ name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' }]), p, { offer });
  assert.equal(out.requirements.find((r) => r.name === 'Kafka').importance, 'nice');
  assert.equal(out.fit.qualification.level, 'qualified');
});

// Red team: a header section ends at a blank line or a plain line.
test('a nice header does not reach past a blank line or a plain line', () => {
  const offer = 'Nice to have:\n- Kafka\n\nYour mission\nYou will operate Terraform in production.';
  assert.equal(importanceIn(offer, 'Terraform'), null);
  assert.equal(importanceIn(offer, 'Kafka'), 'nice');
  assert.equal(importanceIn('Nice to have:\n- Kafka\nYou will operate Terraform.', 'Terraform'), null);
});
