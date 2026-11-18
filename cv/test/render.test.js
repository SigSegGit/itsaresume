// The docx: rendered from the committed template, which keeps Nicolas's
// two-column design and holds tags only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import PizZip from 'pizzip';
import { render, TEMPLATE } from '../src/render.js';
import { buildModel } from '../src/tailor.js';

const profile = () => JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));
const analysis = (language = 'en') => ({
  language,
  fit: { score: 72, verdict: 'good', rationale: '' },
  requirements: [],
  headline: 'Senior SRE — PostgreSQL & Terraform',
  summary: ['First summary sentence.', 'Second summary sentence.'],
  experiences: [{ id: 'acme', bullets: ['acme-pg', 'acme-iac'] }],
  skill_groups: [{ id: 'db', skills: ['postgresql'] }, { id: 'iac', skills: ['terraform', 'docker'] }],
});

const documentXml = (buffer) => new PizZip(buffer).file('word/document.xml').asText();
const visibleText = (xml) => [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('\n');

test('the template holds tags only, no personal text', () => {
  const xml = documentXml(readFileSync(TEMPLATE));
  const pieces = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);
  assert.ok(pieces.length > 20, 'the template has its tags');
  for (const piece of pieces) {
    assert.match(piece, /^(\{[^{}]+\}|\s)*$/, `untagged text in the template: ${piece}`);
  }
});

test('rendering replaces every tag, in order, with the model', () => {
  const xml = documentXml(render(buildModel(profile(), analysis())));
  const text = visibleText(xml);
  assert.ok(!/[{}]/.test(text), 'no tag left');
  const expected = [
    'ALEX MARTIN',
    'Senior SRE — PostgreSQL &amp; Terraform',
    'alex.martin@example.org  |  +33 6 00 00 00 00',
    'AT A GLANCE',
    'Available: immediately',
    'TECHNICAL SKILLS',
    'Databases',
    'PostgreSQL',
    'Automation / IaC',
    'Terraform',
    'Docker',
    'EDUCATION',
    'Master',
    'CERTIFICATIONS',
    'ITIL v4',
    'LANGUAGES',
    'French — native',
    'PROFILE',
    'First summary sentence.',
    'EXPERIENCE',
    'Senior SRE',
    '2019 – 2025',
    'Acme Payments',
    'Ran a PostgreSQL fleet.',
    'Industrialised with Terraform.',
    'Env: ',
    'PostgreSQL, Terraform, Python',
    'Application support',
    'Example Bank',
    'Tuned Oracle queries.',
  ];
  let cursor = 0;
  for (const piece of expected) {
    const found = text.indexOf(piece, cursor);
    assert.ok(found >= 0, `missing or out of order: ${piece}`);
    cursor = found + piece.length;
  }
  assert.ok(!text.includes('Automation in Python.'), 'an unselected bullet stays out');
});

test('the design survives rendering: fills, colours, font, bullets', () => {
  const xml = documentXml(render(buildModel(profile(), analysis())));
  for (const needle of ['w:fill="1B2A4A"', 'w:fill="EAE4D6"', 'w:val="B8935A"', 'w:ascii="Calibri"', '<w:numPr>', '<w:tab/>']) {
    assert.ok(xml.includes(needle), `lost from the design: ${needle}`);
  }
});

test('French labels come out in French', () => {
  const text = visibleText(documentXml(render(buildModel(profile(), analysis('fr')))));
  for (const label of ['EN BREF', 'COMPÉTENCES TECHNIQUES', 'FORMATION', 'LANGUES', 'PROFIL', 'EXPÉRIENCES', 'Acme Paiements']) {
    assert.ok(text.includes(label), `missing: ${label}`);
  }
});

test('an experience without an environment line gets none', () => {
  const p = profile();
  p.experiences[1].env = [];
  const text = visibleText(documentXml(render(buildModel(p, analysis()))));
  assert.equal(text.split('Env: ').length - 1, 1, 'one Env line, for the first experience only');
});

test('a model missing a field makes rendering fail instead of printing "undefined"', () => {
  const model = buildModel(profile(), analysis());
  delete model.headline;
  assert.throws(() => render(model), /headline/);
});

/** Loop markers are whole paragraphs in the template; if they survived they
 * would leave blank lines all over the CV. Only the design's own spacers may
 * be empty. */
test('loop markers leave no empty paragraph behind', () => {
  const empties = (xml) => [...xml.matchAll(/<w:p[ >].*?<\/w:p>/gs)].filter((m) => !/<w:t[ >]/.test(m[0])).length;
  const template = documentXml(readFileSync(TEMPLATE));
  const rendered = documentXml(render(buildModel(profile(), analysis())));
  assert.equal(empties(rendered), empties(template));
});

// 2.50 (the owner, 2026-11-18): how the CV was made goes in the page footer,
// full width, not in the narrow column; the body keeps its height.
test('made_by is the docx footer, in the bottom margin, in the CV language', () => {
  const owner = { ...profile(), made_by: { fr: 'Adapté par itsaresume, mon outil IA', en: 'Tailored by itsaresume, my AI tool' } };
  for (const [language, text] of [['en', 'Tailored by itsaresume, my AI tool'], ['fr', 'Adapté par itsaresume, mon outil IA']]) {
    const model = buildModel(owner, analysis(language));
    assert.equal(model.made_by, text);
    const zip = new PizZip(render(model));
    const footer = zip.file('word/footer1.xml')?.asText() ?? '';
    assert.ok(visibleText(footer).includes(text), `${language}: the footer says it`);
    const xml = zip.file('word/document.xml').asText();
    assert.match(xml, /<w:footerReference w:type="default" r:id="rIdMadeBy"\/>/);
    assert.match(xml, /w:footer="100"/, 'the footer sits inside the bottom margin');
    assert.match(zip.file('word/_rels/document.xml.rels').asText(), /Id="rIdMadeBy"[^>]*Target="footer1.xml"/);
    assert.match(zip.file('[Content_Types].xml').asText(), /PartName="\/word\/footer1.xml"/);
    assert.ok(!visibleText(xml).includes(text), 'not in the body');
  }
  const plain = new PizZip(render(buildModel(profile(), analysis())));
  assert.equal(plain.file('word/footer1.xml'), null, 'no made_by, no footer');
  assert.equal(buildModel(profile(), analysis()).made_by, '');
});

test('made_by needs both languages, and never names what the profile never claims', async () => {
  const { validateProfile } = await import('../src/profile.js');
  const base = profile();
  assert.deepEqual(validateProfile({ ...base, made_by: { fr: 'Adapté par itsaresume', en: 'Tailored by itsaresume' } }).errors, []);
  assert.ok(validateProfile({ ...base, made_by: { fr: 'Adapté par itsaresume' } }).errors.some((error) => /made_by/.test(error)));
});
