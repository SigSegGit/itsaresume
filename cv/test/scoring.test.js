// Scoring what the offer asks, as a recruiter reads it. From the real runs of
// 2026-09-27 (an architect offer, an AI tech lead offer): soft skills scored
// as missing must-haves, five example tools scored as five must-haves, a
// failed listing call that silently removed the requirement floor, a stem
// that read "product" as "production", and a skill meeting a requirement
// missing from the skills column. Each rule is code; the model's labels are
// not trusted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v4 } from './fixtures/v4.js';
import { normalize } from '../src/normalize.js';
import { report } from '../src/report.js';
import { validateAnalysis } from '../src/analysis.js';
import { listRequirements } from '../src/listing.js';

const answer = (overrides = {}) => ({
  language: 'fr',
  fit: { score: 50, verdict: 'partial', rationale: '' },
  headline: 'Senior SRE',
  summary: ['SRE running PostgreSQL in critical production.'],
  requirements: [{ name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' }],
  experiences: [{ id: 'acme', bullets: ['acme-pg'] }],
  skill_groups: [{ id: 'db', skills: ['postgresql'] }],
  ...overrides,
});
const row = (name, match = 'no', skills = [], importance = 'must') => ({ name, importance, match, skills, note: '' });

const QUALITIES = [
  'Communication claire et structurée', 'Rigueur et sens de l\'organisation', 'Pédagogie', 'Écoute', 'Posture de facilitateur',
  'Capacité à fédérer', 'Leadership technique', 'Profil polyvalent', 'Curieux techniquement',
  'Capacité à interagir avec des Lead Developers et Architectes', 'Team player', 'Autonomie',
];
const SOFT = `Tech lead wanted. Must have: PostgreSQL, Terraform, Kafka.
Soft skills: communication claire et structurée, rigueur et sens de l'organisation, pédagogie, écoute et posture de facilitateur,
capacité à fédérer, leadership technique, profil polyvalent, curieux techniquement, capacité à interagir avec des Lead Developers et Architectes,
team player, autonomie.`;

/** Seen on the architect offer: "Profil polyvalent", "Curieux techniquement"
 * as unmet musts took the qualification from partial to not qualified. */
test('a personal quality is not scored nor a must-have of the qualification; the report lists it apart, for the interview', () => {
  const requirements = [
    row('PostgreSQL', 'yes', ['postgresql']), row('Terraform', 'yes', ['terraform']), row('Kafka'),
    ...QUALITIES.map((name) => row(name)),
  ];
  requirements[3] = row('Communication claire et structurée', 'yes', ['terraform']);
  const { analysis, repairs } = normalize(answer({ requirements }), v4(), { offer: SOFT });
  assert.deepEqual(analysis.requirements.filter((r) => r.kind === 'quality').map((r) => r.name), QUALITIES);
  assert.deepEqual(analysis.fit.score, 67, 'PostgreSQL and Terraform of three musts');
  assert.deepEqual(analysis.fit.qualification, { level: 'partial', gaps: ['Kafka'] });
  const communication = analysis.requirements.find((r) => r.name === 'Communication claire et structurée');
  assert.deepEqual([communication.match, communication.skills], ['no', []], 'no profile skill backs a quality');
  assert.match(repairs.join('\n'), /requirement Pédagogie: a personal quality, not scored \(to show in interview\)/);
  const text = report(analysis, v4(), { backend: 'b', attempts: 1 });
  assert.match(text, /## Personal qualities — not scored, to show in interview\n\n[^\n]*\n\n- Communication claire et structurée \(must\)\n- Rigueur/);
  assert.ok(!/^\| Pédagogie/m.test(text), 'not in the scored table');
  assert.ok(!/^- Pédagogie \(must\)$/m.test(text.split('## Personal qualities')[0]), 'not a gap');
});

test('a requirement naming a product, a profile skill or a never-claimed item is not a quality, whatever the model says', () => {
  const offer = `Must have: Kubernetes, GitHub Copilot, leadership Kubernetes, leadership Terraform, rigueur ITIL v4,
communication DevOps, organisation des sauvegardes PostgreSQL.`;
  const names = ['Kubernetes', 'GitHub Copilot', 'Leadership Kubernetes', 'Leadership Terraform', 'Rigueur ITIL v4', 'Communication DevOps', 'Organisation des sauvegardes PostgreSQL'];
  const requirements = names.map((name) => ({ ...row(name), kind: 'quality' }));
  requirements[3] = { ...row('Leadership Terraform', 'yes', ['terraform']), kind: 'quality' };
  requirements[6] = { ...row('Organisation des sauvegardes PostgreSQL', 'yes', ['postgresql']), kind: 'quality' };
  const { analysis } = normalize(answer({ requirements }), v4(), { offer });
  assert.deepEqual(analysis.requirements.filter((r) => r.kind === 'quality').map((r) => r.name), [], 'the model\'s label is not trusted');
  assert.equal(analysis.requirements.length, names.length);
  assert.equal(analysis.fit.score, 29, 'every one counts: two musts met of seven');
  assert.equal(analysis.fit.qualification.gaps.length, 5);
});

/** The AI tech lead offer, in synthetic wording with its real shapes: each
 * tool of two parenthesised lists became a must of its own, 5/100. */
const TOOLS = `AI tech lead wanted.
Accompagner les équipes dans l'intégration des outils GenAI (GitHub Copilot, Speckit, SAP Joule, etc.) dans les workflows quotidiens.
Expérience pratique des outils GenAI appliqués au développement et à la spécification (Docker, GitHub Copilot, BMad, Speckit, ProductForge, etc.).
Must have: PostgreSQL.`;

test('examples the offer lists in parentheses are one requirement, met by its best example', () => {
  const requirements = [
    row('PostgreSQL', 'yes', ['postgresql']), row('GitHub Copilot'), row('Speckit'), row('SAP Joule'),
    row('Docker', 'yes', ['docker']), row('BMad', 'no', [], 'nice'), row('ProductForge'),
  ];
  const { analysis, repairs } = normalize(answer({ requirements }), v4(), { offer: TOOLS });
  assert.deepEqual(analysis.requirements.map((r) => [r.name, r.importance, r.match, r.skills]), [
    ['PostgreSQL', 'must', 'yes', ['postgresql']],
    ['GitHub Copilot / Speckit / SAP Joule / Docker / BMad / ProductForge', 'must', 'yes', ['docker']],
  ], 'two lists sharing examples are one requirement');
  assert.equal(analysis.fit.score, 75, 'met by a lab skill only: half credit');
  assert.deepEqual(analysis.fit.qualification.gaps, ['GitHub Copilot / Speckit / SAP Joule / Docker / BMad / ProductForge (lab only)']);
  assert.match(analysis.requirements[1].note, /examples the offer lists together: GitHub Copilot, Speckit, SAP Joule, Docker, BMad, ProductForge/);
  assert.match(repairs.join('\n'), /requirements GitHub Copilot, Speckit, SAP Joule, Docker, BMad, ProductForge: examples the offer lists together, counted as one/);
});

test('a never-claimed example is reported as such, not counted as a must-have of its own when another example is met', () => {
  const offer = 'SRE wanted. Must have: PostgreSQL, outils d\'infrastructure (Terraform, Kubernetes, etc.).';
  const requirements = [row('PostgreSQL', 'yes', ['postgresql']), row('Terraform', 'yes', ['terraform'])];
  const { analysis } = normalize(answer({ requirements }), v4(), { offer });
  assert.deepEqual(analysis.requirements.map((r) => [r.name, r.match]), [['PostgreSQL', 'yes'], ['Terraform / Kubernetes', 'yes']]);
  assert.deepEqual(analysis.fit.qualification, { level: 'qualified', gaps: [] });
  assert.equal(analysis.fit.score, 100);
  assert.match(report(analysis, v4(), { backend: 'b', attempts: 1 }), /## Gaps\n\n- Kubernetes \(never claimed; the offer gives it as an example of Terraform \/ Kubernetes, met otherwise\)/);
  const alone = normalize(answer({ requirements: [row('PostgreSQL', 'yes', ['postgresql'])] }), v4(), { offer: 'SRE wanted. Must have: PostgreSQL, conteneurs (Kubernetes, OpenShift).' }).analysis;
  assert.deepEqual(alone.fit.qualification.gaps, ['Kubernetes (never claimed)'], 'no example met: still a never-claimed gap');
  const p = v4();
  p.never.push({ name: 'OpenShift' });
  const listed = [row('PostgreSQL', 'yes', ['postgresql']), row('Kubernetes'), row('OpenShift')];
  const both = normalize(answer({ requirements: listed }), p, { offer: 'SRE wanted. Must have: PostgreSQL, conteneurs (Kubernetes, OpenShift).' }).analysis;
  assert.deepEqual(both.fit.qualification.gaps, ['Kubernetes / OpenShift (never claimed)'], 'every example never claimed: the merged row is');
});

test('a row the model marks as merged is not trusted', () => {
  const requirements = [{ ...row('Kubernetes', 'adjacent', ['docker']), members: [], never_members: [] }];
  const { analysis } = normalize(answer({ requirements }), v4(), { offer: 'SRE wanted. Must have: PostgreSQL, Kubernetes.' });
  const kubernetes = analysis.requirements.find((r) => r.name === 'Kubernetes');
  assert.deepEqual([kubernetes.match, kubernetes.never, kubernetes.members], ['no', true, undefined]);
  assert.deepEqual(analysis.fit.qualification.gaps, ['Kubernetes (never claimed)']);
});

test('a parenthesis holding one item or prose merges nothing', () => {
  const offer = `SRE wanted. Must have: PostgreSQL (Postgres), Kafka (ou équivalent).
Terraform (nous l'utilisons pour la production, avec Python pour tout le reste de l'outillage).
Oracle (Oracle et Python depuis des années).`;
  const requirements = [row('PostgreSQL', 'yes', ['postgresql']), row('Kafka'), row('Terraform', 'yes', ['terraform']), row('Python', 'yes', ['python']), row('Oracle', 'yes', ['oracle'])];
  const { analysis, repairs } = normalize(answer({ requirements }), v4(), { offer });
  assert.deepEqual(analysis.requirements.map((r) => r.name), ['PostgreSQL', 'Kafka', 'Terraform', 'Python', 'Oracle']);
  assert.ok(!/counted as one/.test(repairs.join('\n')));
});

test('each example of a merged requirement is still held to the honesty rule in the free text', () => {
  const requirements = [row('PostgreSQL', 'yes', ['postgresql']), row('Speckit'), row('SAP Joule'), row('Docker', 'yes', ['docker'])];
  const { analysis } = normalize(answer({ requirements, language: 'en', summary: ['Runs PostgreSQL; ships Speckit specs in R&D.'] }), v4(), { offer: TOOLS });
  assert.match(validateAnalysis(analysis, v4()).errors.join('\n'), /the headline or summary claims Speckit, which is not in the profile/);
});

// A listing call that fails must fail the run: swallowed, it took the
// requirement floor with it and the score rose with no trace (75 to 100).
test('a failed listing call fails the run; only an unreadable answer lists nothing', async () => {
  const down = async () => { throw new Error('itsaresume: every backend is down'); };
  await assert.rejects(listRequirements({ offer: 'x', llm: down }), /every backend is down/);
  const garbled = async () => ({ text: 'not json at all' });
  assert.deepEqual(await listRequirements({ offer: 'x', llm: garbled }), []);
});

test('learning fast is a personal quality; machine learning stays a skill', async () => {
  const { namesQuality } = await import('../src/text.js');
  for (const name of ['Capable de monter rapidement sur de nouveaux sujets', 'Montée en compétence rapide', 'Quick learner', 'Autodidacte']) {
    assert.equal(namesQuality(name), true, name);
  }
  for (const name of ['Apprentissage automatique', 'Machine learning', 'Kubernetes']) assert.equal(namesQuality(name), false, name);
});

// Audit 2026-09-27: the report listed the model's bullet picks, not what the
// CV shows (the layout adds requirement-backed bullets and cuts to the page).
test('the report counts the bullets the CV shows, not the model\'s picks', () => {
  const { analysis } = normalize(answer(), v4(), {});
  const rendered = [{ id: 'acme', title: 'SRE', org: 'Acme', bullets: ['one', 'two', 'three'] }];
  const text = report(analysis, v4(), { backend: 'b', attempts: 1, rendered });
  assert.match(text, /## Experiences on the CV\n\n- \*\*SRE\*\* — Acme: 3 bullet\(s\)/);
  assert.match(report(analysis, v4(), { backend: 'b', attempts: 1 }), /## Experiences put forward/, 'without a rendered CV, the picks');
});

// 2.11: a gap the owner has not settled yet (the profile's `pending` list,
// compiled from what waits for his confirmation) is a profile question, not
// a proved lack: the report says so, so he knows which answer moves the score.
test('a gap the profile lists as pending is marked as waiting for the owner', () => {
  const profile = { ...v4(), pending: ['DNS', 'Windows Server'] };
  const { analysis } = normalize(answer({
    requirements: [
      { name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' },
      { name: 'DNS', importance: 'must', match: 'no', skills: [], note: '' },
      { name: 'Kafka', importance: 'must', match: 'no', skills: [], note: '' },
    ],
  }), profile, {});
  const text = report(analysis, profile, { backend: 'b', attempts: 1 });
  assert.match(text, /^- DNS \(must\) — waiting for your confirmation \(pending in the profile\)$/m);
  assert.match(text, /^- Kafka \(must\)$/m, 'a gap not pending stays plain');
  assert.match(text, /\*\*1 gap waits for your confirmation\*\*: settling it may move the score\./);
});

test('without a pending list the gaps are unchanged', () => {
  const { analysis } = normalize(answer({ requirements: [{ name: 'DNS', importance: 'must', match: 'no', skills: [], note: '' }] }), v4(), {});
  const text = report(analysis, v4(), { backend: 'b', attempts: 1 });
  assert.match(text, /^- DNS \(must\)$/m);
  assert.ok(!/waits for your confirmation/.test(text));
});

// Red team: a certification the profile does not hold is never merged into an
// enumeration with a skill it does (CKA no + AWS yes was one "yes" row).
test('a certification is not merged into an enumeration with a held skill', () => {
  const offer = 'We want certifications (CKA, AWS) and Terraform.';
  const requirements = [row('CKA'), row('AWS', 'yes', ['aws']), row('Terraform', 'yes', ['terraform'])];
  const { analysis } = normalize(answer({ requirements }), v4(), { offer });
  const cka = analysis.requirements.find((r) => r.name === 'CKA');
  assert.ok(cka, 'CKA stays a row of its own');
  assert.equal(cka.match, 'no');
  assert.equal(cka.kind, 'certification');
  assert.ok(analysis.requirements.some((r) => r.name === 'AWS' && r.match === 'yes'));
});

// Seen 2026-10-02 (network & security lead offer): "Travail en binôme" was an
// unmet must, shown "non" on the public page: read as "cannot work in pairs".
test('working in pairs is a personal quality, never a failed requirement', () => {
  const requirements = [row('PostgreSQL', 'yes', ['postgresql']), row('Travail en binôme'), row('Pair working')];
  const { analysis } = normalize(answer({ requirements }), v4(), { offer: 'Must have: PostgreSQL, travail en binôme, pair working.' });
  assert.deepEqual(analysis.requirements.filter((r) => r.kind === 'quality').map((r) => r.name), ['Travail en binôme', 'Pair working']);
});

// Same run: "Nationalité française" and "Profil habilitable" were unmet musts:
// a status the profile does not state is to confirm, not a missing skill.
test('an administrative condition the profile does not state is to confirm: not scored, not a gap, listed apart', () => {
  const conditions = ['Nationalité française', 'Profil habilitable', 'Habilitation secret défense', 'Permis B', 'EU work permit'];
  const requirements = [row('PostgreSQL', 'yes', ['postgresql']), row('Kafka'), ...conditions.map((name) => row(name))];
  const { analysis, repairs } = normalize(answer({ requirements }), v4(), { offer: `Must have: PostgreSQL, Kafka, ${conditions.join(', ')}.` });
  assert.deepEqual(analysis.requirements.filter((r) => r.kind === 'condition').map((r) => r.name), conditions);
  assert.deepEqual(analysis.fit.qualification, { level: 'partial', gaps: ['Kafka'] });
  assert.equal(analysis.fit.score, 50, 'PostgreSQL of two musts');
  assert.match(repairs.join('\n'), /requirement Permis B: an administrative condition, to confirm \(not scored\)/);
  const text = report(analysis, v4(), { backend: 'b', attempts: 1 });
  assert.match(text, /## Conditions — not scored, to confirm\n\n[^\n]*\n\n- Nationalité française \(must\)/);
  assert.ok(!/^\| Permis B/m.test(text), 'not in the scored table');
});
