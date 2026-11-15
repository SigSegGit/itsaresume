// 4.12 (the owner, 2026-11-14): a choice of CV template and colour palette,
// one default each. Palettes recolour the template's own roles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import PizZip from 'pizzip';
import { readFileSync } from 'node:fs';
import { PALETTES, DEFAULT_STYLE, listTemplates, resolveStyle } from '../src/style.js';
import { render } from '../src/render.js';
import { buildModel, defaultBullets } from '../src/tailor.js';

const xml = (buffer) => new PizZip(buffer).file('word/document.xml').asText();
const profile = () => JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));
const analysis = { language: 'en', fit: { score: 72, verdict: 'good', rationale: 'ok' }, requirements: [{ name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' }], headline: 'Senior SRE', summary: ['SRE engineer running PostgreSQL fleets in critical production.'], experiences: [{ id: 'acme', bullets: ['acme-pg'] }], skill_groups: [{ id: 'db', skills: ['postgresql'] }] };
const model = () => buildModel(profile(), analysis, { bullets: defaultBullets(profile(), analysis) });

test('4.12: one default template and palette, the template folder listed', () => {
  assert.deepEqual(DEFAULT_STYLE, { template: 'two-column', palette: 'marine' });
  assert.ok(listTemplates().includes('two-column'));
  assert.ok(Object.keys(PALETTES).length >= 4);
  assert.deepEqual(resolveStyle({}), { template: 'two-column', palette: 'marine' });
  assert.throws(() => resolveStyle({ palette: 'fluo' }), /palette: one of/);
  assert.throws(() => resolveStyle({ template: '../x' }), /template: one of/);
});

test('4.12: a palette recolours the template; the default leaves it as drawn', () => {
  const plain = xml(render(model()));
  const marine = xml(render(model(), { palette: 'marine' }));
  assert.equal(marine, plain);
  const bordeaux = xml(render(model(), { palette: 'bordeaux' }));
  assert.ok(!/1B2A4A/i.test(bordeaux) && !/B8935A/i.test(bordeaux), 'no colour of the default left');
  assert.ok(bordeaux.includes(PALETTES.bordeaux.primary) && bordeaux.includes(PALETTES.bordeaux.accent));
});
