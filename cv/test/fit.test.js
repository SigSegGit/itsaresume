// 4.8-4.10 (the owner, 2026-11-14): each run takes its own sources (files,
// links, a LinkedIn export, an old CV, a profile written by an AI) and its
// offer (text, link, file); nothing is kept; a score and a short report,
// the CV only from 75. Fictional data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PizZip from 'pizzip';
import { readSource, mergeResumes, profileFromTexts, profileFromSources } from '../src/sources.js';
import { loadedFrom, tailorOffer } from '../src/run.js';
import { LISTING_SYSTEM } from '../src/listing.js';

const home = () => mkdtempSync(join(tmpdir(), 'itsacv-fit-'));
const RESUME = { basics: { name: 'Sam Doe', email: 'sam@example.org' }, work: [{ name: 'Nimbus', position: 'Platform engineer', startDate: '2021-03', highlights: ['Ran PostgreSQL with Terraform.'] }], skills: [{ name: 'Data', level: 'Advanced', keywords: ['PostgreSQL', 'Terraform'] }] };

test('4.8: a source is a JSON Resume, a LinkedIn export (folder or ZIP), a docx, a text, or a link', async () => {
  const dir = home();
  try {
    writeFileSync(join(dir, 'r.json'), JSON.stringify(RESUME));
    assert.equal((await readSource(join(dir, 'r.json'))).resume.basics.name, 'Sam Doe');
    const zip = new PizZip();
    zip.file('Profile.csv', 'First Name,Last Name\nSam,Doe\n');
    zip.file('Positions.csv', 'Company Name,Title,Description,Started On,Finished On\nNimbus,Engineer,Ran PostgreSQL.,Mar 2021,\n');
    writeFileSync(join(dir, 'export.zip'), zip.generate({ type: 'nodebuffer' }));
    assert.equal((await readSource(join(dir, 'export.zip'))).resume.work[0].name, 'Nimbus');
    const docx = new PizZip();
    docx.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Old CV line one.</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Line two.</w:t></w:r></w:p></w:body></w:document>');
    writeFileSync(join(dir, 'old.docx'), docx.generate({ type: 'nodebuffer' }));
    assert.equal((await readSource(join(dir, 'old.docx'))).text, 'Old CV line one.\nLine two.');
    writeFileSync(join(dir, 'ai.md'), 'A profile an AI wrote.');
    assert.equal((await readSource(join(dir, 'ai.md'))).text, 'A profile an AI wrote.');
    const fetchText = async (url) => `<html><head><script>x()</script><style>p{}</style></head><body><h1>Senior SRE</h1><p>Kubernetes &amp; Terraform</p></body></html>`;
    const page = await readSource('https://jobs.example.org/42', { fetchText });
    assert.equal(page.text, 'Senior SRE\nKubernetes & Terraform');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('4.8: resumes merge: the first name given, positions once, skills together', () => {
  const merged = mergeResumes([RESUME, { basics: { name: 'Other', phone: '+33 1' }, work: [{ name: 'nimbus', position: 'Platform Engineer', highlights: ['Cut costs.'] }, { name: 'Pixel', position: 'Ops' }], skills: [{ name: 'Linux' }] }]);
  assert.equal(merged.basics.name, 'Sam Doe');
  assert.equal(merged.basics.phone, '+33 1');
  assert.deepEqual(merged.work.map((job) => [job.name, job.highlights]), [['Nimbus', ['Ran PostgreSQL with Terraform.', 'Cut costs.']], ['Pixel', []]]);
  assert.deepEqual(merged.skills.map((skill) => skill.name), ['Data', 'Linux']);
});

test('4.9: a profile read from free text keeps only what the text says, word for word', async () => {
  const text = 'Sam Doe. Platform engineer at Nimbus since 2021. Moved 40 services to Kubernetes. Skills: Kubernetes, Linux.';
  const llm = async () => ({ text: JSON.stringify({ basics: { name: 'Sam Doe' }, work: [{ name: 'Nimbus', position: 'Platform engineer', startDate: '2021', highlights: ['Moved 40 services to Kubernetes.', 'Led a team of 30.'] }], skills: [{ name: 'Skills', keywords: ['Kubernetes', 'Linux', 'Rust'] }] }) });
  const { resume, dropped } = await profileFromTexts([text], { llm });
  assert.deepEqual(resume.work[0].highlights, ['Moved 40 services to Kubernetes.']);
  assert.deepEqual(resume.skills[0].keywords, ['Kubernetes', 'Linux']);
  assert.deepEqual(dropped.sort(), ['Led a team of 30.', 'Rust']);
});

test('4.9: sources compile into a checked profile kept in memory only', async () => {
  const dir = home();
  try {
    writeFileSync(join(dir, 'r.json'), JSON.stringify(RESUME));
    const { profile, dropped } = await profileFromSources([join(dir, 'r.json')], { llm: async () => { throw new Error('no text source, no call'); } });
    assert.equal(profile.identity.name, 'Sam Doe');
    assert.deepEqual(dropped, []);
    assert.equal(loadedFrom(profile).profile.identity.name, 'Sam Doe');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The threshold: below it, the score and the report; the CV only from it.
const SYNTHETIC = JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));
const answer = (match) => ({
  language: 'fr',
  fit: { score: 50, verdict: 'good', rationale: '' },
  requirements: [{ name: 'PostgreSQL', importance: 'must', match, skills: match === 'yes' ? ['postgresql'] : [], note: '' }, { name: 'Terraform', importance: 'must', match, skills: match === 'yes' ? ['terraform'] : [], note: '' }],
  headline: 'Ingénieur SRE — PostgreSQL',
  summary: ['SRE exploitant PostgreSQL en production critique.'],
  experiences: [{ id: 'acme', bullets: ['acme-pg'] }],
  skill_groups: [{ id: 'db', skills: ['postgresql'] }],
});
const OFFER = 'Ingénieur SRE - Paris\nCompétences requises : PostgreSQL, Terraform.\nContrat : CDI.';
const run = async (match, outDir) => {
  const llm = async ({ system = '' } = {}) => (system === LISTING_SYSTEM ? { text: JSON.stringify({ requirements: [{ name: 'PostgreSQL', importance: 'must' }, { name: 'Terraform', importance: 'must' }] }), backend: 'fake' } : { text: JSON.stringify(answer(match)), backend: 'fake' });
  return tailorOffer({ loaded: loadedFrom(SYNTHETIC), offer: OFFER, llm, outDir, useWord: false, minScore: 75 });
};

test('4.10: from 75 the CV is written; below, the score and the report only', async () => {
  const dir = home();
  try {
    const high = await run('yes', join(dir, 'a'));
    assert.ok(high.analysis.fit.score >= 75, String(high.analysis.fit.score));
    assert.ok(existsSync(join(high.dir, 'cv.docx')));
    const low = await run('no', join(dir, 'b'));
    assert.ok(low.analysis.fit.score < 75, String(low.analysis.fit.score));
    assert.ok(!existsSync(join(low.dir, 'cv.docx')));
    assert.match(readFileSync(join(low.dir, 'report.md'), 'utf8'), /below the threshold of 75/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
