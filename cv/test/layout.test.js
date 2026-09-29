// Nicolas's rule: one full page; two only when the relevant content alone
// reaches a page and a half. And the PDF must stay readable by an ATS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import PizZip from 'pizzip';
import { fitToPage, ONE_PAGE, TWO_PAGES_FROM, SAFETY } from '../src/fit.js';
import { atsCheck } from '../src/ats.js';
import { render } from '../src/render.js';
import { buildModel } from '../src/tailor.js';

/** A fake layout: a fixed part, then a fixed height per bullet (in pages). */
const layout = (base, perBullet) => {
  const calls = [];
  const measure = async (bullets) => {
    calls.push(bullets.size);
    return base + perBullet * bullets.size;
  };
  return { measure, calls };
};

const ranked = (relevant, other) => [
  ...Array.from({ length: relevant }, (_, i) => ({ id: `r${i}`, tier: 1 })),
  ...Array.from({ length: other }, (_, i) => ({ id: `o${i}`, tier: 0 })),
];

test('the page is filled with the best-ranked bullets that still fit on one page', async () => {
  const { measure } = layout(0.4, 0.05); // 12 bullets fill the page exactly: too tight
  const result = await fitToPage({ ranked: ranked(5, 20), measure });
  assert.equal(result.bullets.size, 11);
  assert.ok(result.pages <= ONE_PAGE - SAFETY);
  assert.deepEqual([...result.bullets].slice(0, 5), ['r0', 'r1', 'r2', 'r3', 'r4'], 'relevant bullets first');
});

/** Seen on a real run: the skills column alone ran past the page, so no
 * number of bullets could fit; the column has to give way first. */
test('when even the fixed part overflows the page, the skills column is shortened until it fits', async () => {
  const measure = async (bullets, cap = 6) => 0.75 + 0.06 * cap + 0.05 * bullets.size; // cap 6: 1.11 pages
  const result = await fitToPage({ ranked: ranked(5, 5), measure });
  assert.equal(result.cap, 3);
  assert.ok(result.pages <= ONE_PAGE - SAFETY, `${result.pages} pages`);
  assert.equal(result.bullets.size, 1);
  const roomy = await fitToPage({ ranked: ranked(5, 5), measure: async (bullets) => 0.4 + 0.05 * bullets.size });
  assert.equal(roomy.cap, 6, 'the full column when there is room');
});

test('too much relevant content for one page, but under a page and a half: trimmed to one page', async () => {
  const { measure } = layout(0.4, 0.05); // 20 relevant bullets = 1.4 pages
  const result = await fitToPage({ ranked: ranked(20, 5), measure });
  assert.equal(result.bullets.size, 11);
  assert.ok([...result.bullets].every((id) => id.startsWith('r')), 'the least relevant go first');
});

test('relevant content reaching a page and a half gets two pages', async () => {
  const { measure } = layout(0.4, 0.05); // 24 relevant bullets = 1.6 pages
  const result = await fitToPage({ ranked: ranked(24, 5), measure });
  assert.ok(result.pages >= TWO_PAGES_FROM && result.pages <= 2);
  assert.equal(result.bullets.size, 24, 'every relevant bullet, and nothing irrelevant');
});

test('relevant content beyond two pages is trimmed to two pages', async () => {
  const { measure } = layout(0.4, 0.05); // 40 relevant bullets = 2.4 pages
  const result = await fitToPage({ ranked: ranked(40, 0), measure });
  assert.equal(result.bullets.size, 31);
  assert.ok(result.pages <= 2);
});

test('fitting costs a handful of layouts, not one per bullet', async () => {
  const { measure, calls } = layout(0.4, 0.05);
  await fitToPage({ ranked: ranked(5, 60), measure });
  assert.ok(calls.length <= 9, `${calls.length} layouts`);
});

// ATS: what a parser extracts from the PDF must contain the CV, in order.
const model = () => ({
  name_caps: 'ALEX MARTIN',
  contact: 'alex.martin@example.org  |  +33 6 00 00 00 00',
  labels: { profile: 'PROFILE', experience: 'EXPERIENCE', skills: 'TECHNICAL SKILLS' },
  profile: ['SRE with ten years in production.'],
  experiences: [{ title: 'Senior SRE', org: 'Acme Payments', bullets: ['Ran a PostgreSQL fleet under heavy load.'] }],
});
const extracted = [
  'ALEX MARTIN',
  'alex.martin@example.org | +33 6 00 00 00 00',
  'TECHNICAL SKILLS',
  'PROFILE',
  'SRE with ten years in',
  'production.',
  'EXPERIENCE',
  'Senior SRE 2019 – 2025',
  'Acme Payments',
  '● Ran a PostgreSQL fleet under',
  'heavy load.',
].join('\n');

test('an ATS reading of the PDF finds every piece of the CV, lines wrapped or not', () => {
  assert.deepEqual(atsCheck(model(), extracted).problems, []);
});

test('text missing from the ATS reading is reported', () => {
  const text = extracted.replace('Acme Payments', '');
  assert.match(atsCheck(model(), text).problems.join('\n'), /Acme Payments/);
});

test('an experience read before the profile is reported as out of order', () => {
  const text = extracted.replace('PROFILE', 'XX').replace('EXPERIENCE', 'PROFILE').replace('XX', 'EXPERIENCE');
  assert.match(atsCheck(model(), text).problems.join('\n'), /order/);
});

test('the document properties name the candidate, for the PDF and the ATS', () => {
  const profile = JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));
  const analysis = {
    language: 'en', fit: {}, requirements: [{ name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'] }],
    headline: 'Senior SRE', summary: ['x'], experiences: [{ id: 'acme', bullets: ['acme-pg'] }], skill_groups: [{ id: 'db', skills: ['postgresql'] }],
  };
  const core = new PizZip(render(buildModel(profile, analysis))).file('docProps/core.xml').asText();
  assert.match(core, /<dc:creator>Alex MARTIN<\/dc:creator>/);
  assert.match(core, /<dc:title>CV — Alex MARTIN — Senior SRE<\/dc:title>/);
  assert.match(core, /<cp:keywords>[^<]*PostgreSQL[^<]*<\/cp:keywords>/);
  assert.ok(!core.includes('itsaresume-cv'));
});

test('the report states the layout and the ATS check', async () => {
  const { report } = await import('../src/report.js');
  const profile = JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));
  const analysis = {
    language: 'en', fit: { score: 100, verdict: 'strong', rationale: '' },
    requirements: [{ name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' }],
    headline: 'Senior SRE', summary: ['x'], experiences: [{ id: 'acme', bullets: ['acme-pg'] }], skill_groups: [],
  };
  const ok = report(analysis, profile, { backend: 'b', attempts: 1, layout: { pages: 0.97, layouts: 6 }, ats: { problems: [], checked: 21 } });
  assert.match(ok, /1 page, content down to 97% of it \(6 layouts measured\)/);
  assert.match(ok, /ATS.*21 pieces.*found/);
  const bad = report(analysis, profile, { backend: 'b', attempts: 1, ats: { problems: ['missing from the PDF text: Acme'], checked: 21 } });
  assert.match(bad, /missing from the PDF text: Acme/);
  assert.match(report(analysis, profile, { backend: 'b', attempts: 1 }), /not measured/);
});

test('a word split at its own hyphen across two lines still counts as found', () => {
  const m = model();
  m.experiences[0].bullets = ['Secure machine-to-machine synchronisation.'];
  const text = extracted.replace('● Ran a PostgreSQL fleet under\nheavy load.', '● Secure machine-to-\nmachine synchronisation.');
  assert.deepEqual(atsCheck(m, text).problems, []);
});

/** Seen: a CV measured at "1 page, 100%" came out of Word as a PDF with a
 * blank second page (the paragraph Word requires after a table spilled). */
test('a blank page in the PDF is reported', () => {
  const pages = `${extracted}\f   \n\f`;
  assert.match(atsCheck(model(), pages).problems.join('\n'), /page 2 of the PDF is blank/);
  assert.deepEqual(atsCheck(model(), `${extracted}\f`).problems, [], 'a final page separator alone is not a page');
});

/** Seen: content measured at exactly 1.00 page came out of the PDF export
 * with a blank second page. A page counts as full with a small margin left. */
test('a layout that only just fills the page is not accepted', async () => {
  const measure = async (bullets) => (bullets.size <= 10 ? 0.9 : 1.0);
  const result = await fitToPage({ ranked: ranked(0, 20), measure });
  assert.equal(result.bullets.size, 10);
});
