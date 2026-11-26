// The kind of contract an offer is for, decided by code (the owner,
// 2026-11-25: a mission through an intermediary says "Freelance", a CDI says
// "CDI", and an offer that says neither keeps both, as before). The profile
// may give a glance line per kind, a date of availability, and closing
// sentences for the profile section, each for one kind or for all, one of
// them with a link the CV makes clickable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PizZip from 'pizzip';
import { offerContract } from '../src/contract.js';
import { buildModel } from '../src/tailor.js';
import { render } from '../src/render.js';
import { validateProfile as checkProfile } from '../src/profile.js';
import { loadedFrom, tailorOffer } from '../src/run.js';
import { LISTING_SYSTEM } from '../src/listing.js';

test('the contract is read from the offer: freelance, permanent, or either', () => {
  for (const text of ['Mission freelance de 6 mois', 'TJM : 600 €', '620 €/j HT', '620 € par jour', 'Portage salarial accepté', 'Day rate: 650 EUR', 'Contractor role, 6 months', 'Prestation via une société intermédiaire, ce que tu touches : 620 €/j HT']) {
    assert.equal(offerContract(`Ingénieur DevOps.\n${text}\nLyon.`), 'freelance', text);
  }
  for (const text of ['Contrat : CDI', 'Poste en CDI, télétravail partiel', 'Permanent contract, full time', 'This is a permanent position']) {
    assert.equal(offerContract(`Ingénieur DevOps.\n${text}\nLyon.`), 'permanent', text);
  }
  for (const text of ['CDI ou freelance', 'Ouvert aux CDI comme aux freelances (TJM selon profil)', 'Ingénieur DevOps à Lyon', '']) {
    assert.equal(offerContract(text), 'any', text);
  }
  assert.equal(offerContract('Nous cherchons un CDIste'), 'any', 'a word boundary');
});

const SYNTHETIC = () => JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));

/** The synthetic profile with a contract line, a date and two closing sentences. */
function profile() {
  const p = SYNTHETIC();
  p.identity.available_from = '2026-12-01';
  p.glance = [
    { fr: 'Freelance (EURL Example) ou CDI', en: 'Freelance (EURL Example) or permanent', freelance: { fr: 'Freelance (EURL Example)', en: 'Freelance (EURL Example)' }, permanent: { fr: 'CDI', en: 'Permanent contract' } },
    { fr: 'Hybride / remote', en: 'Hybrid / remote' },
  ];
  p.profile_tail = [
    { fr: 'Code public : example.org/ci.', en: 'Public code: example.org/ci.', link: { text: 'example.org/ci', url: 'https://example.org/ci' } },
    { fr: 'Seules les missions pertinentes figurent ici.', en: 'Only the relevant missions are shown here.', when: 'freelance' },
  ];
  return p;
}

const analysis = (contract, language = 'fr') => ({
  language,
  ...(contract ? { contract } : {}),
  fit: { score: 72, verdict: 'good', rationale: '' },
  requirements: [],
  headline: 'Senior SRE',
  summary: ['Première phrase.'],
  experiences: [{ id: 'acme', bullets: ['acme-pg'] }],
  skill_groups: [{ id: 'db', skills: ['postgresql'] }],
});

const NOW = new Date('2026-11-25T10:00:00Z');

test('the glance line follows the offer contract; an offer that says neither keeps both', () => {
  const line = (contract, language) => buildModel(profile(), analysis(contract, language), { now: NOW }).glance[0];
  assert.equal(line('freelance'), 'Freelance (EURL Example)');
  assert.equal(line('permanent'), 'CDI');
  assert.equal(line('permanent', 'en'), 'Permanent contract');
  assert.equal(line('any'), 'Freelance (EURL Example) ou CDI');
  assert.equal(line(undefined), 'Freelance (EURL Example) ou CDI', 'an older analysis, as before');
  assert.equal(buildModel(profile(), analysis('permanent'), { now: NOW }).glance[2], 'Hybride / remote', 'a line with no variant is unchanged');
});

test('the date of availability is shown until it has passed', () => {
  assert.equal(buildModel(profile(), analysis('any'), { now: NOW }).glance[1], 'Disponible au 1er décembre 2026');
  assert.equal(buildModel(profile(), analysis('any', 'en'), { now: NOW }).glance[1], 'Available from 1 December 2026');
  const later = profile();
  later.identity.available_from = '2027-01-15';
  assert.equal(buildModel(later, analysis('any'), { now: NOW }).glance[1], 'Disponible au 15 janvier 2027');
  const passed = buildModel(profile(), analysis('any'), { now: new Date('2026-12-02T08:00:00Z') }).glance;
  assert.ok(!passed.some((item) => /Disponible au/.test(item)), passed.join(' | '));
  const none = SYNTHETIC();
  assert.deepEqual(buildModel(none, analysis('any'), { now: NOW }).glance, ['Disponible : immédiatement', 'Astreintes : oui'], 'no date, no line');
});

test('closing sentences join the profile section for the kinds they name; their link is kept', () => {
  const freelance = buildModel(profile(), analysis('freelance'), { now: NOW });
  assert.deepEqual(freelance.profile, ['Première phrase.', 'Code public : example.org/ci.', 'Seules les missions pertinentes figurent ici.']);
  assert.deepEqual(freelance.links, [{ text: 'example.org/ci', url: 'https://example.org/ci' }]);
  const permanent = buildModel(profile(), analysis('permanent'), { now: NOW });
  assert.deepEqual(permanent.profile, ['Première phrase.', 'Code public : example.org/ci.']);
  assert.deepEqual(buildModel(SYNTHETIC(), analysis('freelance'), { now: NOW }).profile, ['Première phrase.'], 'none in the profile, none on the CV');
});

const docx = (model) => new PizZip(render(model, { template: 'linear' }));

test('a link of the profile section is clickable in the docx', () => {
  const zip = docx(buildModel(profile(), analysis('freelance'), { now: NOW }));
  const xml = zip.file('word/document.xml').asText();
  const rels = zip.file('word/_rels/document.xml.rels').asText();
  const id = /<w:hyperlink r:id="([^"]+)"[^>]*>(?:(?!<\/w:hyperlink>).)*example\.org\/ci(?:(?!<\/w:hyperlink>).)*<\/w:hyperlink>/s.exec(xml)?.[1];
  assert.ok(id, 'a hyperlink around the link text');
  assert.match(rels, new RegExp(`Id="${id}"[^>]*Target="https://example\\.org/ci"[^>]*TargetMode="External"|Target="https://example\\.org/ci"[^>]*Id="${id}"`));
  const text = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
  assert.ok(text.includes('Code public : example.org/ci.'), 'the sentence reads whole');
  const plain = docx(buildModel(SYNTHETIC(), analysis('freelance'), { now: NOW }));
  assert.doesNotMatch(plain.file('word/document.xml').asText(), /<w:hyperlink/);
});

test('the profile checks the new fields', () => {
  const ok = profile();
  assert.deepEqual(checkProfile(ok).errors ?? [], []);
  const bad = (change) => {
    const p = profile();
    change(p);
    return checkProfile(p).errors.join(' | ');
  };
  assert.match(bad((p) => { p.identity.available_from = '1/12/2026'; }), /available_from/);
  assert.match(bad((p) => { p.glance[0].freelance = { fr: 'x' }; }), /glance 1: freelance needs fr and en/);
  assert.match(bad((p) => { p.profile_tail[1].when = 'sometimes'; }), /profile_tail 2: when/);
  assert.match(bad((p) => { p.profile_tail[0].link.url = 'javascript:alert(1)'; }), /profile_tail 1: link/);
  assert.match(bad((p) => { p.profile_tail[0].link.text = 'elsewhere'; }), /profile_tail 1: link/);
  assert.match(bad((p) => { delete p.profile_tail[0].en; }), /profile_tail 1: needs fr and en/);
});

test('a run records the contract it read from the offer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'itsacv-contract-'));
  const offer = ['Ingénieur SRE confirmé - Paris', 'Missions : exploitation, automatisation, astreinte.', 'Compétences requises : PostgreSQL, Terraform.', "Profil recherché : expérience de la production critique, esprit d'équipe.", 'Mission freelance, TJM selon profil, télétravail partiel.'].join('\n');
  const answer = { ...analysis(undefined), requirements: [{ name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' }] };
  const llm = async ({ system = '' } = {}) => (system === LISTING_SYSTEM ? { text: JSON.stringify({ requirements: [{ name: 'PostgreSQL', importance: 'must' }] }), backend: 'fake' } : { text: JSON.stringify(answer), backend: 'fake' });
  try {
    const result = await tailorOffer({ loaded: loadedFrom(profile()), offer, llm, outDir: dir, useWord: false });
    assert.equal(result.analysis.contract, 'freelance');
    assert.equal(JSON.parse(readFileSync(join(result.dir, 'analysis.json'), 'utf8')).contract, 'freelance');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
