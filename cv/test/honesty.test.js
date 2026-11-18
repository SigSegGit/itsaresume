// What the first real run showed a small model gets wrong, and the
// deterministic code that no longer trusts it: the offer's language, and the
// fit score.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectLanguage } from '../src/language.js';
import { scoreOf, CORE_MISSED_CAP } from '../src/score.js';
import { normalize } from '../src/normalize.js';
import { validateAnalysis } from '../src/analysis.js';
import { buildPrompt } from '../src/prompt.js';
import { report } from '../src/report.js';

const profile = () => JSON.parse(readFileSync(new URL('./fixtures/profile.synthetic.json', import.meta.url), 'utf8'));
const FR = 'Au sein de notre équipe, vous exploitez les bases de données et participez à l\'astreinte pour la plateforme.';
const EN = 'You will run our databases and take part in the on-call rotation for the platform with the team.';

const answer = (language = 'fr') => ({
  language,
  fit: { score: 97, verdict: 'strong', rationale: 'Great fit.' },
  requirements: [
    { name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' },
    { name: 'COBOL', importance: 'must', match: 'no', skills: [], note: '' },
    { name: 'Terraform modules', importance: 'nice', match: 'adjacent', skills: ['terraform'], note: '' },
  ],
  headline: 'SRE',
  summary: ['Exploite PostgreSQL.'],
  experiences: [{ id: 'acme', bullets: ['acme-pg'] }],
  skill_groups: [{ id: 'db', skills: ['postgresql'] }],
});

test('the offer language is detected from its words', () => {
  assert.equal(detectLanguage(FR), 'fr');
  assert.equal(detectLanguage(EN), 'en');
});

test('the prompt imposes the offer language', () => {
  assert.match(buildPrompt(profile(), FR).prompt, /French/);
  assert.match(buildPrompt(profile(), EN).prompt, /English/);
});

test('an answer in another language than the offer is refused', () => {
  const errors = validateAnalysis(answer('en'), profile(), { language: 'fr' }).errors.join('\n');
  assert.match(errors, /language/);
  assert.deepEqual(validateAnalysis(answer('fr'), profile(), { language: 'fr' }).errors, []);
});

/** must weighs 3, nice 1; yes counts 1, adjacent 0.5, no 0. */
test('the score is computed from the requirements, not taken from the model', () => {
  assert.equal(scoreOf(answer().requirements), Math.round((100 * (3 * 1 + 3 * 0 + 1 * 0.5)) / (3 + 3 + 1)));
  assert.equal(scoreOf([{ importance: 'must', match: 'yes' }]), 100);
  assert.equal(scoreOf([{ importance: 'must', match: 'no' }, { importance: 'nice', match: 'yes' }]), 25);
  const { analysis } = normalize(answer(), profile());
  assert.equal(analysis.fit.score, 50);
  assert.equal(analysis.fit.verdict, 'partial');
  assert.equal(analysis.fit.model_score, 97, 'the model\'s own figure is kept, for comparison only');
});

test('an analysis without any requirement cannot be scored and is refused', () => {
  const a = answer();
  a.requirements = [];
  const { analysis } = normalize(a, profile());
  assert.match(validateAnalysis(analysis, profile()).errors.join('\n'), /requirement/);
});

test('the report labels the model\'s own comment as unchecked', () => {
  const { analysis } = normalize(answer(), profile());
  const text = report(analysis, profile(), { backend: 'fake', attempts: 1 });
  assert.match(text, /# Fit: 50 \/ 100 — partial/);
  assert.match(text, /unchecked/i);
  assert.match(text, /Great fit\./);
});

// Corpus run 2026-11-15: COBOL, PHP 5.6 and helpdesk offers scored 48-52 on
// generic rows (SQL, Git, incidents) while their own core was missed. More
// than half the must-haves missed is no fit: the score stays in the low band.
test('a score with more than half the must-haves missed is capped in the low band', () => {
  const must = (match) => ({ importance: 'must', match });
  const nice = (match) => ({ importance: 'nice', match });
  const coreMissed = [must('no'), must('no'), must('yes'), ...Array(12).fill(nice('yes'))];
  assert.equal(scoreOf(coreMissed), CORE_MISSED_CAP);
  assert.equal(scoreOf([must('no'), must('yes'), nice('yes')]), 57);
  assert.ok(CORE_MISSED_CAP < 35);
});

// Corpus run 2026-11-17: the COBOL, PHP and React offers stayed mid on generic
// rows (SQL, Git, Windows) with fewer than half their musts missed. The
// technology a title leads with is the job's core: missed, the score stays
// low. A junior or first-level title is no fit for a senior profile either.
test('a missed lead technology of the title caps the score in the low band', () => {
  const row = (name, match, importance = 'must') => ({ name, importance, match });
  const generic = [row('SQL', 'yes'), row('Git', 'yes'), row('Linux', 'yes'), row('ITIL', 'adjacent')];
  const cobol = [row('DB2', 'adjacent'), row('COBOL', 'no'), ...generic];
  assert.equal(scoreOf(cobol, { offer: 'Développeur Mainframe COBOL / DB2 confirmé (H/F)\n\nmissions' }), CORE_MISSED_CAP);
  assert.ok(scoreOf(cobol) > CORE_MISSED_CAP, 'without the offer, no title, no cap');
  // The title's first technology leads: PostgreSQL met, Oracle missed, no cap.
  const dba = [row('Oracle', 'no'), row('PostgreSQL', 'yes'), ...generic];
  assert.ok(scoreOf(dba, { offer: '\n  Administrateur PostgreSQL / Oracle (H/F)\nOracle et COBOL' }) > CORE_MISSED_CAP);
  // A nice-to-have in the title is not the core; nor is a row the title does not name.
  assert.ok(scoreOf([row('COBOL', 'no', 'nice'), ...generic], { offer: 'Développeur COBOL' }) > CORE_MISSED_CAP);
  assert.ok(scoreOf(cobol, { offer: 'Ingénieur de production\nCOBOL' }) > CORE_MISSED_CAP);
});

test('a junior or first-level title caps a senior profile in the low band', () => {
  const rows = [{ name: 'Windows', importance: 'must', match: 'yes' }, { name: 'Active Directory', importance: 'must', match: 'yes' }];
  for (const title of ['Technicien support helpdesk niveau 1 (H/F)', 'Développeur fullstack junior React', 'Support N1', 'Alternance DevOps', 'Stagiaire SRE', 'Entry-level cloud engineer']) {
    assert.equal(scoreOf(rows, { offer: title, senior: true }), CORE_MISSED_CAP, title);
    assert.equal(scoreOf(rows, { offer: title }), 100, `${title}: a junior profile is not capped`);
  }
  for (const title of ['Ingénieur SRE senior', 'Administrateur N2/N3', 'Chef de projet stage gate']) {
    assert.equal(scoreOf(rows, { offer: title, senior: true }), 100, title);
  }
});
