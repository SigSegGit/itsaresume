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
