// 2.24a: the CV as data for the browser's A4 page. The server sends only
// what the docx would show, ranked; the browser only chooses how many fit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildModel, pageData, rankBullets } from '../src/tailor.js';

const load = () => JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));

const analysis = () => ({
  language: 'en',
  fit: { score: 72, verdict: 'good', rationale: '' },
  requirements: [
    { name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' },
    { name: 'Terraform', importance: 'must', match: 'yes', skills: ['terraform'], note: '' },
  ],
  headline: 'Senior SRE — PostgreSQL & Terraform',
  summary: ['SRE with 10 years running PostgreSQL in production.'],
  experiences: [{ id: 'acme', bullets: ['acme-iac', 'acme-pg'] }],
  skill_groups: [{ id: 'db', skills: ['postgresql'] }, { id: 'iac', skills: ['terraform'] }],
});

test('the page holds nothing the docx would refuse, in the docx order', () => {
  const profile = load();
  const a = analysis();
  const page = pageData(profile, a);
  const docx = buildModel(profile, a, { bullets: new Set(rankBullets(profile, a).map((entry) => entry.id)) });
  assert.deepEqual(page.experiences.map((e) => e.title), docx.experiences.map((e) => e.title));
  page.experiences.forEach((experience, index) => {
    assert.deepEqual(experience.items.map((item) => item.text), docx.experiences[index].bullets, experience.title);
  });
  for (const key of ['name', 'headline', 'contact', 'skill_groups', 'education', 'certifications', 'languages', 'profile', 'labels']) {
    assert.deepEqual(page[key], docx[key], key);
  }
});

test('each item carries its rank in rankBullets, and no layout', () => {
  const profile = load();
  const a = analysis();
  const ranked = rankBullets(profile, a).map((entry) => entry.id);
  const items = pageData(profile, a).experiences.flatMap((e) => e.items);
  assert.ok(items.length > 0);
  for (const item of items) assert.equal(item.rank, ranked.indexOf(item.id) + 1, item.id);
  assert.equal(items.find((item) => item.id === 'acme-iac').rank, 1, 'the model\'s first pick ranks first');
  assert.ok(!JSON.stringify(pageData(profile, a)).match(/"(height|font|margin|spacing)"/), 'no layout');
});

test('a main mission always shows: its first bullets are a must, the rest are not', () => {
  const profile = load();
  const a = analysis();
  const page = pageData(profile, a);
  const must = buildModel(profile, a, { bullets: new Set() });
  const mustTexts = new Set(must.experiences.flatMap((e) => e.bullets));
  const items = page.experiences.flatMap((e) => e.items);
  assert.ok(items.some((item) => item.must) && items.some((item) => !item.must));
  for (const item of items) assert.equal(item.must, mustTexts.has(item.text), item.id);
});

test('a bullet the ranking leaves out never reaches the page', () => {
  const profile = load();
  const a = analysis();
  const ranked = new Set(rankBullets(profile, a).map((entry) => entry.id));
  const fallback = new Set(profile.experiences.flatMap((e) => e.bullets.slice(0, 1).map((b) => b.id)));
  for (const item of pageData(profile, a).experiences.flatMap((e) => e.items)) {
    assert.ok(ranked.has(item.id) || fallback.has(item.id), item.id);
  }
});
