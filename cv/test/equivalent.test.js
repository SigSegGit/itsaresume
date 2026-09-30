// Generic requirements a real offer phrases loosely: each has a profile
// equivalent that must come out, never "no" (owner's request, 2026-09-28).
// The profile is the synthetic fixture plus a monitoring and a CI tool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize } from '../src/normalize.js';
import { report } from '../src/report.js';
import { validateAnalysis } from '../src/analysis.js';

function profile() {
  const p = JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));
  p.skills.push(
    { id: 'prometheus', name: 'Prometheus', group: 'iac', level: 'proficient', aliases: [] },
    { id: 'jenkins', name: 'Jenkins', group: 'iac', level: 'proficient', aliases: [] },
  );
  p.never = [{ name: 'Kubernetes', aliases: ['K8s'] }];
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

const judge = (name) => normalize(analysis([{ name, importance: 'must', match: 'no', skills: [], note: '' }]), profile()).analysis.requirements[0];

const PAIRS = [
  ['Cloud public', ['AWS', 'GCP']],
  ['Conteneurisation', ['Docker']],
  ['Infrastructure as Code', ['Terraform']],
  ['Observabilité', ['Prometheus']],
  ['Scripting', ['Python']],
  ['CI/CD', ['Jenkins']],
  ['Cycles de delivery', ['Jenkins']],
  ['Bases de données', ['PostgreSQL', 'Oracle']],
  // Singular and plural name one concept (seen: "Cycle de delivery" stayed no
  // where "Cycles de delivery" came out through CI/CD).
  ['Cycle de delivery', ['Jenkins']],
];

for (const [requirement, names] of PAIRS) {
  test(`"${requirement}" marked no by the model comes out adjacent through ${names.join(', ')}`, () => {
    const judged = judge(requirement);
    assert.equal(judged.match, 'adjacent');
    assert.deepEqual([...judged.equivalent].sort(), [...names].sort());
    assert.match(judged.note, new RegExp(`equivalent: ${names[0]}`));
  });
}

test('a sibling tool is not an equivalent: Puppet stays no beside Terraform', () => {
  assert.equal(judge('Puppet').match, 'no');
});

test('a never-claimed requirement stays no, whatever its category holds', () => {
  const judged = judge('Kubernetes et conteneurisation');
  assert.equal(judged.match, 'no');
  assert.equal(judged.equivalent, undefined);
});

// A language the offer asks for is compared with the profile's languages, by
// code (seen: "Anglais professionnel" no, the profile says "Anglais — bilingue").
function withGerman() {
  const p = profile();
  p.languages.push({ fr: 'Allemand — notions', en: 'German — basics' });
  return p;
}
const judgeLanguage = (name) => normalize(analysis([{ name, importance: 'must', match: 'no', skills: [], note: '' }]), withGerman()).analysis;

for (const name of ['Anglais professionnel', "Maîtrise de l'anglais (écrit et oral)", 'Fluent English', 'Anglais courant', 'Anglais']) {
  test(`"${name}" is met by the profile's "Anglais — bilingue", and counts`, () => {
    const judged = judgeLanguage(name);
    const [row] = judged.requirements;
    assert.equal(row.match, 'yes');
    assert.equal(row.kind, 'language');
    assert.match(row.note, /Anglais — bilingue/);
    assert.equal(judged.fit.score, 100);
    assert.equal(judged.fit.qualification.level, 'qualified');
  });
}

test('a met language row passes validation without a profile skill (the run goes on)', () => {
  const judged = judgeLanguage('Anglais professionnel');
  assert.equal(judged.requirements[0].match, 'yes');
  assert.deepEqual(validateAnalysis(judged, withGerman()).errors.filter((error) => /Anglais/.test(error)), []);
});

test('a language the profile holds at notions level only stays no, its level said', () => {
  const [row] = judgeLanguage('Allemand courant').requirements;
  assert.equal(row.match, 'no');
  assert.equal(row.kind, 'language');
  assert.match(row.note, /Allemand — notions/);
});

test('a language the profile does not name stays no', () => {
  assert.equal(judgeLanguage('Espagnol courant').requirements[0].match, 'no');
});

test('a task done in a language is not a language requirement', () => {
  const [row] = judgeLanguage('Rédaction de documentation technique en anglais').requirements;
  assert.equal(row.match, 'no');
  assert.equal(row.kind, undefined);
});

test('the report says "equivalent: X" rather than a bare no', () => {
  const { analysis: normalised } = normalize(analysis([{ name: 'Conteneurisation', importance: 'must', match: 'no', skills: [], note: '' }]), profile());
  assert.match(report(normalised, profile(), {}), /\| Conteneurisation \| must \| adjacent \|.*equivalent: Docker/);
});

// 2.7c, seen on a real run (2026-09-29): the model met "SQL" through
// PostgreSQL (expert) and Oracle, and the check that a skill names the
// requirement demoted it to "to verify"; "Shell" kept KSH and dropped Bash.
// A requirement whose concept holds profile skills is met by code.
const judgeMet = (name, skills, extra = []) => {
  const p = profile();
  p.skills.push(...extra);
  return normalize(analysis([{ name, importance: 'must', match: 'yes', skills, note: '' }]), p).analysis.requirements[0];
};

test('"SQL" met through PostgreSQL and Oracle stays yes, not "to verify"', () => {
  const row = judgeMet('SQL', ['postgresql', 'oracle']);
  assert.equal(row.match, 'yes');
  assert.equal(row.judged, undefined);
});

test('"SQL" marked no by the model comes out adjacent through PostgreSQL, Oracle', () => {
  const row = judge('SQL');
  assert.equal(row.match, 'adjacent');
  assert.deepEqual([...row.equivalent].sort(), ['Oracle', 'PostgreSQL']);
});

test('"Shell" named like the profile\'s KSH also holds its Bash, the model\'s extra pick dropped', () => {
  const row = judgeMet('Shell', ['ksh', 'python'], [
    { id: 'ksh', name: 'KSH', group: 'iac', level: 'working', aliases: ['Shell'] },
    { id: 'bash', name: 'Bash', group: 'iac', level: 'expert', aliases: [] },
  ]);
  assert.equal(row.match, 'yes');
  assert.deepEqual([...row.skills].sort(), ['bash', 'ksh']);
});

test('"SQL" met through Python alone stays "to verify": the concept must hold the model\'s pick', () => {
  const row = judgeMet('SQL', ['python']);
  assert.equal(row.match, 'adjacent');
  assert.equal(row.judged, true);
});

test('a model reading no concept holds stays "to verify"', () => {
  const row = judgeMet('Culture produit', ['python']);
  assert.equal(row.match, 'adjacent');
  assert.equal(row.judged, true);
});

// Seen replaying the real runs: the union above added Bash to "Python
// scripting" (a category word beside the tool) and Bastion to "SQL".
test('"Python scripting" met through Python does not add the profile\'s Bash', () => {
  const row = judgeMet('Python scripting', ['python'], [{ id: 'bash', name: 'Bash', group: 'iac', level: 'expert', aliases: [], terms: ['scripting'] }]);
  assert.deepEqual(row.skills, ['python']);
});

// ESCO's "Access" (Microsoft Access) sits inside "privileged access": a
// skill is placed on the concepts its labels name whole, not on a word
// taken inside one (seen: "Microsoft Access" adjacent through Bastion).
test('a word inside a skill\'s label does not place it: "Microsoft Access" stays no beside Bastion', () => {
  const p = profile();
  p.skills.push({ id: 'bastion', name: 'Bastion', group: 'sec', level: 'proficient', aliases: [], terms: ['privileged access'] });
  const row = normalize(analysis([{ name: 'Microsoft Access', importance: 'must', match: 'no', skills: [], note: '' }]), p).analysis.requirements[0];
  assert.equal(row.match, 'no');
});

// 2.7e (Rodin, 2026-09-29): a level the offer states is compared with the
// profile's; "Anglais bilingue exigé" against "courant" was yes.
const withEnglish = (level) => {
  const p = withGerman();
  p.languages = p.languages.map((line) => (/^Anglais/.test(line.fr) ? { fr: `Anglais — ${level}`, en: `English — ${level}` } : line));
  return p;
};
const judgeLevel = (name, p) => normalize(analysis([{ name, importance: 'must', match: 'no', skills: [], note: '' }]), p).analysis.requirements[0];

test('a level asked above the profile\'s is adjacent, the profile\'s line said', () => {
  const row = judgeLevel('Anglais bilingue exigé', withEnglish('courant'));
  assert.equal(row.match, 'adjacent');
  assert.match(row.note, /courant/);
});

test('a level asked at or below the profile\'s is met ("niveau B2" against "courant")', () => {
  assert.equal(judgeLevel('Anglais niveau B2', withEnglish('courant')).match, 'yes');
});

test('notions asked are met by notions held', () => {
  assert.equal(judgeLevel('Allemand (notions)', withGerman()).match, 'yes');
});

test('a level asked that the profile holds only as notions stays no', () => {
  assert.equal(judgeLevel('Allemand courant', withGerman()).match, 'no');
});

// Seen on a real offer (2026-09-30): "trilingual candidates (English,
// Spanish, and French or Italian)". The example merge made one row
// "English / Spanish / French / Italian", no longer a language row, and the
// run was refused twice ("marked yes but names no profile skill"). A
// language is settled on its own, level included: never merged.
test('languages an offer lists together are settled one by one, never merged', () => {
  const offer = 'Languages: English required. For EMEA, trilingual candidates (English, Spanish, and French or Italian) are prioritized.';
  const rows = [
    { name: 'English', importance: 'must', match: 'yes', skills: ['english'], note: '' },
    { name: 'Spanish', importance: 'nice', match: 'no', skills: [], note: '' },
    { name: 'French', importance: 'nice', match: 'yes', skills: ['french'], note: '' },
    { name: 'Italian', importance: 'nice', match: 'no', skills: [], note: '' },
  ];
  const p = withGerman();
  const judged = normalize(analysis(rows), p, { offer }).analysis;
  const byName = new Map(judged.requirements.map((row) => [row.name, row]));
  assert.equal(byName.get('English')?.kind, 'language', [...byName.keys()].join(' | '));
  assert.equal(byName.get('English').match, 'yes');
  assert.ok(![...byName.keys()].some((name) => /English \//.test(name)), 'English was merged');
  assert.deepEqual(validateAnalysis(judged, p).errors.filter((error) => /English|French|Spanish|Italian/.test(error)), []);
});
