// Evidence: how the tool knows whether a CV lies. Every skill carries graded
// evidence — A: verifiable artefact or third-party document; B: a candid
// self-assessment written to a third party; C: a claim in one of his own CVs —
// for or against. A skill that evidence contradicts, or that nothing
// supports, can neither be shown nor claimed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assess, scanSources, restrict, readSources, checkQuotes } from '../src/evidence.js';
import { normalize } from '../src/normalize.js';
import { validateAnalysis } from '../src/analysis.js';
import { validateProfile } from '../src/profile.js';
import { report } from '../src/report.js';
import { analyse } from '../src/pipeline.js';
import { LISTING_SYSTEM } from '../src/listing.js';

const profile = () => {
  const p = JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));
  p.sources = [
    { id: 'cv-2025', grade: 'C', title: 'CV 2025' },
    { id: 'cv-2026', grade: 'C', title: 'CV 2026' },
    { id: 'mail', grade: 'B', title: 'Self-assessment email' },
    { id: 'repo', grade: 'A', title: 'Public repository' },
  ];
  p.skills.find((s) => s.id === 'gcp').evidence = [{ source: 'mail', stance: 'against', quote: 'no GCP so far' }];
  p.skills.find((s) => s.id === 'terraform').evidence = [{ source: 'repo', stance: 'for', quote: 'main.tf' }];
  return p;
};

const texts = [
  { id: 'cv-2025', text: 'Expert PostgreSQL and Oracle. Terraform. GCP on the side.' },
  { id: 'cv-2026', text: 'PostgreSQL clusters, Python automation, Docker.' },
];

const verdicts = (p = profile()) => new Map(assess(p, scanSources(p, texts)).map((entry) => [entry.id, entry]));

test('a mention in a CV is grade C evidence for that skill, found by name or alias', () => {
  const p = profile();
  const found = scanSources(p, texts);
  assert.deepEqual(found.get('postgresql').map((e) => e.source).sort(), ['cv-2025', 'cv-2026']);
  assert.ok(found.get('postgresql').every((e) => e.grade === 'C' && e.stance === 'for'));
  p.skills.find((s) => s.id === 'aws').aliases = ['Amazon'];
  assert.equal(scanSources(p, [{ id: 'cv-2026', text: 'Amazon workspaces' }]).get('aws').length, 1);
});

test('each skill gets a verdict from its best evidence', () => {
  const v = verdicts();
  assert.equal(v.get('terraform').verdict, 'verified', 'grade A');
  assert.equal(v.get('postgresql').verdict, 'self-declared', 'CVs only');
  assert.equal(v.get('postgresql').sources, 2);
  assert.equal(v.get('aws').verdict, 'unsupported', 'nothing mentions it');
});

/** A candid statement (B) or an artefact (A) against a skill outweighs any
 * number of CV claims (C). */
test('a skill contradicted by grade A or B evidence is contradicted, whatever the CVs say', () => {
  assert.equal(verdicts().get('gcp').verdict, 'contradicted');
});

test('a level claimed from one CV only is flagged, unless it is mere notions', () => {
  const v = verdicts();
  assert.match(v.get('python').flags.join('\n'), /Python: expert level claimed in one CV only/);
  assert.match(v.get('docker').flags.join('\n'), /Docker: proficient level claimed in one CV only/);
  assert.deepEqual(v.get('postgresql').flags, [], 'two CVs back it');
  const p = profile();
  p.skills.find((s) => s.id === 'docker').level = 'notions';
  assert.deepEqual(verdicts(p).get('docker').flags, []);
});

/** "Proficient: AWS" in one CV, "AWS Workspace" in the next: the skill is
 * real, its level is what the sources disagree on. */
test('a level stated by the sources is compared with the profile and with each other', () => {
  const p = profile();
  const docker = p.skills.find((s) => s.id === 'docker');
  const levelFlags = () => verdicts(p).get('docker').flags.filter((flag) => !/one CV only/.test(flag)).join('\n');
  docker.evidence = [{ source: 'cv-2026', stance: 'for', quote: 'Docker', level: 'working' }];
  assert.match(levelFlags(), /Docker: the profile says proficient, the sources say working at most/);
  docker.evidence.push({ source: 'cv-2025', stance: 'for', quote: 'Terraform', level: 'proficient' });
  assert.match(levelFlags(), /Docker: the sources disagree on the level \(working in CV 2026, proficient in CV 2025\)/);
  docker.evidence = [{ source: 'cv-2026', stance: 'for', quote: 'Docker', level: 'proficient' }];
  assert.equal(levelFlags(), '');
  docker.evidence[0].level = 'master';
  assert.match(validateProfile(p).errors.join('\n'), /skill docker: evidence level master is not one of/);
});

/** "security" said of PCI-DSS is a broader word, not another name: a CV that
 * writes "security" says nothing about PCI-DSS. Terms match offers; only the
 * name and the aliases (true synonyms) count as evidence. */
test('a broader term a skill covers is not evidence for it, but still matches an offer', () => {
  const p = profile();
  p.skills.find((s) => s.id === 'postgresql').terms = ['databases'];
  assert.equal(scanSources(p, [{ id: 'cv-2025', text: 'Databases everywhere.' }]).get('postgresql'), undefined);
  const answer = {
    language: 'en', fit: {}, headline: 'SRE', summary: ['Runs databases.'],
    requirements: [{ name: 'Databases', importance: 'must', match: 'no', skills: [], note: '' }],
    experiences: [{ id: 'acme', bullets: ['acme-pg'] }], skill_groups: [{ id: 'db', skills: ['postgresql'] }],
  };
  const { analysis } = normalize(answer, p);
  assert.ok(analysis.requirements[0].skills.includes('postgresql'));
  assert.deepEqual(validateAnalysis(analysis, p).errors, []);
});

test('a ruled-out skill is known by its name and aliases, not by the broader terms it covers', () => {
  const p = profile();
  p.skills.find((s) => s.id === 'gcp').terms = ['cloud'];
  const assessment = assess(p, scanSources(p, texts));
  const answer = {
    language: 'en', fit: { score: 50, verdict: 'partial' }, headline: 'SRE', summary: ['Cloud-minded SRE.'],
    requirements: [{ name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' }],
    experiences: [{ id: 'acme', bullets: ['acme-pg'] }], skill_groups: [{ id: 'db', skills: ['postgresql'] }],
  };
  assert.deepEqual(validateAnalysis(answer, p, { assessment }).errors, []);
});

test('contradicted and unsupported skills are removed from the analysis and reported', () => {
  const p = profile();
  const assessment = assess(p, scanSources(p, texts));
  const answer = {
    language: 'en', fit: {}, headline: 'SRE', summary: ['Runs PostgreSQL.'],
    requirements: [
      { name: 'Google Cloud Platform', importance: 'must', match: 'yes', skills: ['gcp'], note: '' },
      { name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' },
    ],
    experiences: [{ id: 'acme', bullets: ['acme-pg'] }],
    skill_groups: [{ id: 'cloud', skills: ['gcp', 'aws'] }, { id: 'db', skills: ['postgresql'] }],
  };
  const { analysis, repairs } = normalize(answer, p, { assessment });
  assert.deepEqual(analysis.skill_groups, [{ id: 'db', skills: ['postgresql'] }]);
  assert.equal(analysis.requirements[0].match, 'no');
  assert.match(repairs.join('\n'), /gcp.*contradicted/);
  assert.match(repairs.join('\n'), /aws.*unsupported/);
});

test('the summary may not name a contradicted skill, even one the profile lists', () => {
  const p = profile();
  const assessment = assess(p, scanSources(p, texts));
  const answer = {
    language: 'en', fit: { score: 50, verdict: 'partial' }, headline: 'SRE', summary: ['Strong on GCP.'],
    requirements: [{ name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' }],
    experiences: [{ id: 'acme', bullets: ['acme-pg'] }], skill_groups: [{ id: 'db', skills: ['postgresql'] }],
  };
  assert.match(validateAnalysis(answer, p, { assessment }).errors.join('\n'), /GCP.*contradicted/);
});

test('the report verifies every skill the CV shows or matches, with its sources', () => {
  const p = profile();
  const assessment = assess(p, scanSources(p, texts));
  const analysis = {
    language: 'en', fit: { score: 100, verdict: 'strong', rationale: '' }, headline: 'SRE', summary: ['x'],
    requirements: [{ name: 'Terraform', importance: 'must', match: 'yes', skills: ['terraform'], note: '' }],
    experiences: [{ id: 'acme', bullets: ['acme-pg'] }], skill_groups: [{ id: 'db', skills: ['postgresql'] }],
  };
  const text = report(analysis, p, { backend: 'b', attempts: 1, assessment, removed: ['bullet acme-gcp names GCP'] });
  assert.match(text, /## Verification/);
  assert.match(text, /Left out[^\n]*\n+- bullet acme-gcp names GCP/);
  assert.match(text, /Terraform.*verified.*Public repository \(A\)/);
  assert.match(text, /PostgreSQL.*self-declared.*CV 2025 \(C\).*CV 2026 \(C\)/);
});

/** "pas de Kubernetes dans ce projet" names Kubernetes: scanning it would turn
 * a stated gap into evidence for the skill. A and B evidence is entered by
 * hand, with its stance; only CVs (C) are scanned. */
test('a self-assessment or an artefact that names a skill is not evidence for it: only CVs are scanned', () => {
  const found = scanSources(profile(), [
    { id: 'mail', text: 'No GCP and no PostgreSQL in this project.' },
    { id: 'repo', text: 'Docker' },
  ]);
  assert.equal(found.size, 0);
});

test('sources and evidence are checked with the rest of the profile', () => {
  const p = profile();
  p.sources.push({ id: 'mail', grade: 'D', title: 'Again' });
  p.skills.find((s) => s.id === 'python').evidence = [{ source: 'nowhere', stance: 'for' }, { source: 'repo', stance: 'maybe' }];
  const errors = validateProfile(p).errors.join('\n');
  assert.match(errors, /source mail: grade D/);
  assert.match(errors, /duplicate source mail/);
  assert.match(errors, /skill python: evidence from unknown source nowhere/);
  assert.match(errors, /skill python: evidence stance maybe/);
  assert.deepEqual(validateProfile(profile()).errors, []);
});

test('the profile the CV draws from leaves out what the evidence rules out, and says what it left out', () => {
  const p = profile();
  p.experiences[0].bullets.push({ id: 'acme-gcp', fr: 'Migration vers Google Cloud.', en: 'Migration to Google Cloud.', skills: [] });
  p.experiences[0].env.push('GCP');
  p.profile_facts.push({ id: 'cloud', fr: 'Expert AWS.', en: 'AWS expert.' });
  const { profile: allowed, removed } = restrict(p, assess(p, scanSources(p, texts)));
  assert.deepEqual(allowed.skills.map((s) => s.id).filter((id) => ['gcp', 'aws'].includes(id)), []);
  assert.ok(!allowed.experiences[0].bullets.some((b) => b.id === 'acme-gcp'), 'the bullet names a contradicted skill');
  assert.ok(!allowed.experiences[0].env.includes('GCP'));
  assert.ok(!allowed.profile_facts.some((f) => f.id === 'cloud'));
  const text = removed.join('\n');
  assert.match(text, /acme-gcp.*GCP.*contradicted/);
  assert.match(text, /cloud.*AWS.*unsupported/);
  assert.deepEqual(validateProfile(allowed).errors, [], 'what is left is still a valid profile');
  assert.ok(p.skills.some((s) => s.id === 'gcp'), 'the profile itself is untouched');
});

test('an experience left without a bullet is left out as a whole', () => {
  const p = profile();
  p.skills.find((s) => s.id === 'oracle').evidence = [{ source: 'mail', stance: 'against', quote: 'never Oracle' }];
  p.experiences[1].bullets = p.experiences[1].bullets.filter((b) => b.id === 'bank-oracle');
  const { profile: allowed, removed } = restrict(p, assess(p, scanSources(p, texts)));
  assert.ok(!allowed.experiences.some((e) => e.id === 'bank'));
  assert.match(removed.join('\n'), /experience bank/);
});

test('source texts are read from the files the profile names, next to the profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'itsacv-sources-'));
  mkdirSync(join(dir, 'sources'));
  writeFileSync(join(dir, 'sources', 'cv.txt'), 'PostgreSQL');
  const p = { sources: [{ id: 'cv', grade: 'C', title: 'CV', file: 'sources/cv.txt' }, { id: 'repo', grade: 'A', title: 'Repo' }] };
  assert.deepEqual(readSources(p, dir), [{ id: 'cv', text: 'PostgreSQL' }]);
  p.sources[0].file = 'sources/missing.txt';
  assert.throws(() => readSources(p, dir), /source cv: .*missing\.txt/);
  p.sources[0].file = '../elsewhere.txt';
  assert.throws(() => readSources(p, dir), /source cv: .*outside/);
});

test('the model is never shown a skill the evidence rules out, and may not claim it', async () => {
  const p = profile();
  const assessment = assess(p, scanSources(p, texts));
  const prompts = [];
  const answer = {
    language: 'en', fit: { score: 50, verdict: 'partial', rationale: '' }, headline: 'SRE', summary: ['Strong on GCP.'],
    requirements: [{ name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' }],
    experiences: [{ id: 'acme', bullets: ['acme-pg'] }], skill_groups: [{ id: 'db', skills: ['postgresql'] }],
  };
  const llm = async ({ system, prompt }) => {
    if (system === LISTING_SYSTEM) return { text: JSON.stringify({ requirements: [] }), backend: 'fake' };
    prompts.push(prompt);
    return { text: JSON.stringify(answer), backend: 'fake' };
  };
  const offer = 'Senior SRE wanted. Must: PostgreSQL, GCP.';
  await assert.rejects(analyse({ profile: restrict(p, assessment).profile, offer, llm, assessment }), /GCP.*contradicted/);
  assert.ok(!/^- gcp —/m.test(prompts[0]), 'gcp is not in the catalogue');
});

/** The detector must not lie either: a quote is checked against the source
 * text it claims to come from (line breaks and case aside). */
test('a quote from a source with a text must be found in it, word for word', () => {
  const p = profile();
  const python = p.skills.find((s) => s.id === 'python');
  python.evidence = [{ source: 'cv-2026', stance: 'for', quote: 'python   AUTOMATION' }, { source: 'repo', stance: 'for', quote: 'main.tf' }];
  assert.deepEqual(checkQuotes(p, texts), [], 'whitespace and case aside; a source without text is not checked');
  python.evidence[0].quote = 'Python expert';
  assert.match(checkQuotes(p, texts).join('\n'), /skill python: the quote "Python expert" is not in cv-2026/);
  python.evidence[0].quote = '';
  assert.match(checkQuotes(p, texts).join('\n'), /skill python: evidence from cv-2026 has no quote/);
});
