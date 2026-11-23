// 2.62 (the owner, 2026-11-23): a linear, single-column docx template beside
// the two-column one, shaped like his own one-column CV. Same tags, same
// model; lists joined in place; palettes recolour it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import PizZip from 'pizzip';
import { render } from '../src/render.js';
import { buildModel } from '../src/tailor.js';
import { PALETTES, TEMPLATES_DIR, listTemplates, resolveStyle } from '../src/style.js';

const LINEAR = join(TEMPLATES_DIR, 'linear.docx');
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
const paragraphs = (xml) => [...xml.matchAll(/<w:p[ >].*?<\/w:p>/gs)].map((m) => [...m[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(''));
const linear = (language = 'en', p = profile()) => documentXml(render(buildModel(p, analysis(language)), { template: 'linear' }));

test('2.62: the linear template is listed and holds tags only', () => {
  assert.ok(listTemplates().includes('linear'));
  assert.deepEqual(resolveStyle({ template: 'linear' }), { template: 'linear', palette: 'marine' });
  const xml = documentXml(readFileSync(LINEAR));
  const pieces = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);
  assert.ok(pieces.length > 15, 'the template has its tags');
  for (const piece of pieces) assert.match(piece, /^(\{[^{}]+\}|\s|\||:)*$/, `untagged text in the template: ${piece}`);
});

test('2.62: one column on an A4 page, no table', () => {
  const xml = linear();
  assert.ok(!xml.includes('<w:tbl>'), 'no table: one column');
  assert.match(xml, /<w:pgSz w:w="11906" w:h="16838"\/>/);
  assert.ok(xml.includes('<w:numPr>') && xml.includes('<w:tab/>') && xml.includes('w:ascii="Calibri"'), 'bullets, a right tab for dates, Calibri');
});

test('2.62: his order, one line per paragraph, lists joined in place', () => {
  const lines = paragraphs(linear()).filter(Boolean);
  const expected = [
    'Alex MARTIN',
    'Senior SRE — PostgreSQL &amp; Terraform',
    'alex.martin@example.org  |  +33 6 00 00 00 00',
    'EURL Example  |  Paris Area, France',
    'Available: immediately · On-call duty: yes',
    'PROFILE',
    'First summary sentence.',
    'Second summary sentence.',
    'EXPERIENCE',
    'Acme Payments  |  Senior SRE2019 – 2025',
    'Ran a PostgreSQL fleet.',
    'Industrialised with Terraform.',
    'Env: PostgreSQL, Terraform, Python',
    'TECHNICAL SKILLS',
    'Databases: PostgreSQL',
    'Automation / IaC: Terraform, Docker',
    'EDUCATION',
    'Master&apos;s degree — Example School — Project-based learning',
    'ITIL v4 — expired',
    'French — native · English — bilingual',
  ];
  let cursor = 0;
  for (const line of expected) {
    const found = lines.findIndex((text, at) => at >= cursor && text.replace(/'/g, '&apos;') === line);
    assert.ok(found >= 0, `missing or out of order: ${line}\n${lines.join('\n')}`);
    cursor = found + 1;
  }
  assert.ok(!lines.some((text) => /[{}]/.test(text)), 'no tag left');
});

test('2.62: French labels; empty lists leave no empty line', () => {
  const lines = paragraphs(linear('fr'));
  for (const label of ['PROFIL', 'EXPÉRIENCES', 'COMPÉTENCES TECHNIQUES', 'FORMATION']) assert.ok(lines.includes(label), `missing: ${label}`);
  const bare = { ...profile(), glance: [], certifications: [] };
  const empties = (xml) => paragraphs(xml).filter((text) => !text).length;
  assert.equal(empties(linear('en', bare)), empties(linear()), 'no glance, no certifications: no blank paragraph added');
  assert.ok(!paragraphs(linear('en', bare)).some((text) => text.includes('·') && !text.includes('French')), 'no glance line');
});

test('2.62: a palette recolours the linear template too', () => {
  const plain = linear();
  for (const colour of Object.values(PALETTES.marine)) assert.ok(plain.includes(colour), `drawn in the marine role ${colour}`);
  const bordeaux = documentXml(render(buildModel(profile(), analysis()), { template: 'linear', palette: 'bordeaux' }));
  assert.ok(!/1B2A4A|B8935A|EAE4D6/i.test(bordeaux), 'no marine colour left');
});
