// The CV holds only the profile's own text. With titles in the profile, the
// model chooses the headline and the summary by id, among the profile's
// titles and facts (Rodin, 2026-09-24: "why does the model still write free
// text on your CV, when your whole thesis says it only chooses?").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v4 } from './fixtures/v4.js';
import { normalize } from '../src/normalize.js';
import { validateAnalysis } from '../src/analysis.js';
import { buildModel } from '../src/tailor.js';
import { checkProvenance } from '../src/evidence.js';
import { buildPrompt } from '../src/prompt.js';
import { analyse } from '../src/pipeline.js';
import { validateProfile } from '../src/profile.js';

const withTitles = () => {
  const p = v4();
  p.titles = [
    { id: 'sre', fr: 'Ingénieur SRE senior', en: 'Senior SRE engineer' },
    { id: 'dba', fr: 'Administrateur PostgreSQL', en: 'PostgreSQL administrator' },
  ];
  return p;
};

const OFFER = 'Senior SRE wanted. Must have: PostgreSQL.';
const answer = (overrides = {}) => ({
  language: 'en',
  fit: { score: 50, verdict: 'partial', rationale: '' },
  headline_ids: ['sre', 'dba'],
  summary_ids: ['pg', 'years'],
  headline: 'Ex-Google SRE, 20 years, hr@evil.example',
  summary: ['Kubernetes expert.'],
  requirements: [{ name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' }],
  experiences: [{ id: 'acme', bullets: ['acme-pg'] }],
  skill_groups: [{ id: 'db', skills: ['postgresql'] }],
  ...overrides,
});

test('the headline and the summary are the profile\'s own titles and facts, chosen by id; the model\'s free text is dropped', () => {
  const { analysis, repairs } = normalize(answer(), withTitles(), { offer: OFFER });
  assert.equal(analysis.headline, 'Senior SRE engineer · PostgreSQL administrator');
  assert.deepEqual(analysis.summary, ['SRE engineer with 10 years in critical production.', 'Runs high-volume PostgreSQL fleets.'], 'the hook first, then the fact');
  assert.equal(analysis.from_profile, true);
  assert.match(repairs.join('\n'), /headline and summary taken from the profile/);
  assert.deepEqual(validateAnalysis(analysis, withTitles(), { offer: OFFER, language: 'en' }).errors, []);
  const model = buildModel(withTitles(), analysis);
  assert.equal(model.headline, 'Senior SRE engineer · PostgreSQL administrator');
  assert.deepEqual(model.profile, analysis.summary);
});

test('unknown or missing ids are refused, not replaced by free text', () => {
  const bad = normalize(answer({ headline_ids: ['ceo'], summary_ids: ['nope'] }), withTitles(), { offer: OFFER }).analysis;
  const errors = validateAnalysis(bad, withTitles(), { offer: OFFER }).errors.join('\n');
  assert.match(errors, /headline_ids: none of them is a profile title/);
  assert.match(errors, /summary_ids: no hook among them/);
  const french = normalize(answer({ language: 'fr', headline_ids: ['sre', 'sre', 'dba'], summary_ids: ['years', 'years', 'pg', 'years'] }), withTitles(), { offer: OFFER }).analysis;
  assert.equal(french.headline, 'Ingénieur SRE senior · Administrateur PostgreSQL', 'each title once');
  assert.deepEqual(french.summary, ['Ingénieur SRE avec 10 ans en production critique.', 'Exploitation de flottes PostgreSQL à haute volumétrie.'], 'in the offer language, each fact once');
});

test('the prompt lists the titles and facts by id and asks for ids', () => {
  const { prompt, system } = buildPrompt(withTitles(), OFFER);
  assert.match(prompt, /^- sre — Senior SRE engineer$/m);
  assert.match(prompt, /^- pg \(fact\) — Runs high-volume PostgreSQL fleets\.$/m);
  assert.match(system, /headline_ids/);
});

/** Seen on the real runs of 2026-09-27: summaries made of two internal notes
 * ("Force = ...", "~11 ans ... →") and one hook. The owner's profile gives
 * hooks ("à adapter, ne pas les combiner toutes"); the rest is context. */
test('the summary is one hook, the first one listed, and at most one supporting fact; a note never prints', () => {
  const p = withTitles();
  p.profile_facts.push(
    { id: 'hook-dba', kind: 'hook', fr: 'Administrateur PostgreSQL.', en: 'PostgreSQL administrator.' },
    { id: 'force', kind: 'note', fr: 'Force = bases de données', en: 'Strength = databases' },
    { id: 'oncall', kind: 'fact', fr: 'Astreintes sur flux critiques.', en: 'On-call on critical flows.' },
  );
  const { analysis, repairs } = normalize(answer({ summary_ids: ['force', 'pg', 'years', 'hook-dba', 'oncall'] }), p, { offer: OFFER });
  assert.deepEqual(analysis.summary, ['SRE engineer with 10 years in critical production.', 'Runs high-volume PostgreSQL fleets.']);
  const text = repairs.join('\n');
  assert.match(text, /summary: force is a note \(context only\), not printed/);
  assert.match(text, /summary: hook-dba left out, one hook only/);
  assert.match(text, /summary: oncall left out, one supporting fact at most/);
  assert.deepEqual(validateAnalysis(analysis, p, { offer: OFFER, language: 'en' }).errors, []);
});

test('an answer whose summary names no hook is refused, so the model gets its one retry', async () => {
  const bad = normalize(answer({ summary_ids: ['pg'] }), withTitles(), { offer: OFFER }).analysis;
  assert.deepEqual(bad.summary, [], 'a fact alone is no summary');
  assert.match(validateAnalysis(bad, withTitles(), { offer: OFFER }).errors.join('\n'), /summary_ids: no hook among them/);
  const answers = [JSON.stringify({ requirements: [] }), JSON.stringify(answer({ summary_ids: ['pg'] })), JSON.stringify(answer())];
  const prompts = [];
  const llm = async ({ prompt }) => {
    prompts.push(prompt);
    return { text: answers.shift(), backend: 'fake' };
  };
  const { analysis, attempts } = await analyse({ profile: withTitles(), offer: OFFER, llm });
  assert.equal(attempts, 2);
  assert.match(prompts[2], /summary_ids: no hook among them/, 'the retry says why');
  assert.equal(analysis.summary[0], 'SRE engineer with 10 years in critical production.');
});

test('a profile fact is a hook, a fact or a note, and a profile with titles has a hook', () => {
  assert.deepEqual(validateProfile(withTitles()).errors, []);
  const p = withTitles();
  p.profile_facts[0].kind = 'claim';
  delete p.profile_facts[1].kind;
  const errors = validateProfile(p).errors.join('\n');
  assert.match(errors, /fact years: kind claim is not one of hook, fact, note/);
  assert.match(errors, /fact pg: kind undefined is not one of hook, fact, note/);
  const q = withTitles();
  q.profile_facts[0].kind = 'fact';
  assert.match(validateProfile(q).errors.join('\n'), /the profile has titles but no hook/);
  delete q.titles;
  assert.deepEqual(validateProfile(q).errors, [], 'without titles the model writes the summary');
});

test('the prompt gives each fact its kind and says the summary is one hook', () => {
  const { prompt, system } = buildPrompt(withTitles(), OFFER);
  assert.match(prompt, /^- years \(hook\) — SRE engineer with 10 years in critical production\.$/m);
  assert.match(system, /summary_ids: exactly one hook id/);
  assert.match(system, /never on the CV/);
});

test('a title traces to the truth document like any line of the CV', () => {
  const p = withTitles();
  p.truth = 'truth';
  p.sources = [{ id: 'truth', grade: 'B', title: 'Truth', file: 't.md' }];
  const text = [...p.experiences.flatMap((e) => e.bullets.map((b) => b.fr)), ...p.profile_facts.map((f) => f.fr), 'Ingénieur SRE senior'].join('\n');
  assert.match(checkProvenance(p, [{ id: 'truth', text }]).join('\n'), /title dba: "Administrateur PostgreSQL" is not in truth/);
});

// 2.7f, seen on a real run (2026-09-29): "DevOps", a must met through a skill
// of a hidden group, was nowhere on the CV. The profile's title naming it
// takes the headline's second place.
const withMeta = () => {
  const p = withTitles();
  p.skill_groups.push({ id: 'meta', title: { fr: 'Méta', en: 'Meta' }, hidden: true });
  p.skills.push(
    { id: 'devops', name: 'DevOps', group: 'meta', level: 'proficient', aliases: [] },
    { id: 'automation', name: 'Automation', group: 'meta', level: 'proficient', aliases: [] },
  );
  p.titles.push({ id: 'devops', fr: 'DevOps', en: 'DevOps' });
  return p;
};
const withMust = (name, skill, overrides = {}) => answer({
  requirements: [
    { name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' },
    { name, importance: 'must', match: 'yes', skills: [skill], note: '' },
  ],
  ...overrides,
});

test('a must met only through a hidden skill puts the profile\'s title naming it second in the headline', () => {
  const { analysis } = normalize(withMust('DevOps', 'devops'), withMeta(), { offer: 'Must have: PostgreSQL, DevOps.' });
  assert.equal(analysis.headline, 'Senior SRE engineer · DevOps');
});

test('a headline already naming that must is left as chosen', () => {
  const { analysis } = normalize(withMust('DevOps', 'devops', { headline_ids: ['devops', 'sre'] }), withMeta(), { offer: 'Must have: PostgreSQL, DevOps.' });
  assert.equal(analysis.headline, 'DevOps · Senior SRE engineer');
});

test('a must met only through a hidden skill that no title names is reported as absent from the page', () => {
  const { analysis, repairs } = normalize(withMust('Automation', 'automation'), withMeta(), { offer: 'Must have: PostgreSQL, Automation.' });
  assert.equal(analysis.headline, 'Senior SRE engineer · PostgreSQL administrator');
  assert.match(repairs.join('\n'), /Automation: a must met through skills the CV does not show, and no profile title names it/);
});

test('a must the skills column shows leaves the headline as chosen', () => {
  const { analysis } = normalize(withMust('DevOps', 'devops', { headline_ids: ['sre'] }), withMeta(), { offer: 'Must have: PostgreSQL, DevOps.' });
  assert.equal(analysis.headline, 'Senior SRE engineer · DevOps', 'DevOps, hidden, comes in');
  const visible = normalize(answer({ headline_ids: ['sre'] }), withMeta(), { offer: OFFER }).analysis;
  assert.equal(visible.headline, 'Senior SRE engineer', 'PostgreSQL, shown in the skills column, brings no title');
});

// Seen replaying the real runs: "Automatisation" met through a hidden skill
// took the headline's second place though the picked bullets said it, and
// pushed out a title that named another such must (DevOps).
test('a must the picked bullets already name leaves the headline as chosen', () => {
  const p = withMeta();
  p.experiences[0].bullets[0].en += ' DevOps practices.';
  const { analysis } = normalize(withMust('DevOps', 'devops'), p, { offer: 'Must have: PostgreSQL, DevOps.' });
  assert.equal(analysis.headline, 'Senior SRE engineer · PostgreSQL administrator');
});

test('a title naming one hidden must is not pushed out for another', () => {
  const p = withMeta();
  p.titles.push({ id: 'tools', fr: 'Ingénieur automatisation', en: 'Automation engineer' });
  const a = answer({
    headline_ids: ['sre', 'devops'],
    requirements: [
      { name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' },
      { name: 'Automation', importance: 'must', match: 'yes', skills: ['automation'], note: '' },
      { name: 'DevOps', importance: 'must', match: 'yes', skills: ['devops'], note: '' },
    ],
  });
  const { analysis, repairs } = normalize(a, p, { offer: 'Must have: PostgreSQL, Automation, DevOps.' });
  assert.equal(analysis.headline, 'Senior SRE engineer · DevOps');
  assert.match(repairs.join('\n'), /Automation: .*the headline has no place left for its title/);
});

test('a must met through a visible skill never takes the headline: the skills column is its place', () => {
  const p = withMeta();
  p.titles.push({ id: 'ora', fr: 'DBA Oracle', en: 'Oracle DBA' });
  // Five met fillers before Oracle in the visible db group: the column's cap
  // (MAX_GROUP_SKILLS) cuts Oracle, so only the hidden-group rule keeps its
  // title out of the headline.
  const fillers = ['etcd', 'consul', 'vault', 'nats', 'minio'];
  p.skills.push(...[...fillers, 'oracle'].map((id) => ({ id, name: id, group: 'db', level: 'proficient', aliases: [] })));
  const model = withMust('Oracle', 'oracle');
  model.requirements.splice(1, 0, ...fillers.map((id) => ({ name: id, importance: 'nice', match: 'yes', skills: [id], note: '' })));
  const { analysis } = normalize(model, p, { offer: 'Must have: PostgreSQL, Oracle. Nice: etcd, consul, vault, nats, minio.' });
  assert.equal(analysis.headline, 'Senior SRE engineer · PostgreSQL administrator');
});
