import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVerdicts, compareRuns, publicComparison, compareMarkdown } from '../src/compare.js';

const entry = (model, over = {}) => ({
  model, status: 'done', error: null, elapsed_ms: 1000, tokens: { x: { input: 10, output: 5 } }, attempts: 1, pages: 1, dir: `/out/${model}`,
  repairs: [], fit: { score: 60, verdict: 'go', qualification: { level: 'strong' } },
  analysis: { requirements: [{ name: 'Kubernetes', match: 'yes' }, { name: 'Terraform', match: 'yes' }] }, ...over,
});

test('compareRuns: one line per model, disagreements first, leads found by code', () => {
  const report = compareRuns([
    entry('claude', { analysis: { requirements: [{ name: 'Kubernetes', match: 'yes' }, { name: 'Terraform', match: 'adjacent' }] }, attempts: 2 }),
    entry('gemini', { fit: { score: 80, verdict: 'go', qualification: { level: 'strong' } }, repairs: [...Array(3).fill("requirement Go: no profile skill names it, the model's reading only: adjacent, to verify (was yes)"), 'requirement Linux: never claimed in the profile, now no (was yes)'] }),
    entry('local', { status: 'failed', error: 'router http://10.0.0.5 down', fit: null, analysis: null, repairs: null, tokens: null }),
  ]);
  assert.deepEqual(report.models.map((m) => [m.model, m.status, m.score, m.tokens]), [['claude', 'done', 60, 15], ['gemini', 'done', 80, 15], ['local', 'failed', null, null]]);
  assert.equal(report.rows[0].name, 'terraform', 'a disagreement comes first');
  assert.equal(report.rows[0].agree, false);
  assert.deepEqual(report.leads.map((lead) => lead.kind).sort(), ['attempts', 'disagree', 'failed', 'repairs', 'spread']);
  assert.ok(!report.leads.some((lead) => lead.text.includes('10.0.0.5')), 'a lead never carries an error text');
});

test('compareRuns: a spread of 15 points or fewer is no lead', () => {
  const report = compareRuns([entry('claude'), entry('gemini', { fit: { score: 75, verdict: 'go', qualification: null } })]);
  assert.deepEqual(report.leads, []);
});

test('the public comparison keeps no error text, no reason, no path', () => {
  const report = publicComparison(compareRuns([
    entry('claude', { repairs: ['requirement Terraform: no profile skill names it'] }),
    entry('local', { status: 'failed', error: 'router http://10.0.0.5 down', fit: null, analysis: null, repairs: null }),
  ]));
  const text = JSON.stringify(report);
  assert.ok(!text.includes('10.0.0.5'));
  assert.ok(!text.includes('/out/'));
  assert.ok(!text.includes('no profile skill'));
  assert.equal(report.models[1].error, 'échec');
});

test('the comparison in markdown: a table per model, a cell cannot break its row', () => {
  const md = compareMarkdown('Fintech', compareRuns([
    entry('claude', { analysis: { requirements: [{ name: 'A | B\nC', match: 'yes' }] } }),
    entry('gemini', { analysis: { requirements: [{ name: 'A | B\nC', match: 'no' }] } }),
  ]));
  assert.match(md, /^# Comparaison : Fintech/);
  assert.match(md, /\| claude \| done \| 60 /);
  assert.match(md, /a \\\| b c/);
});

test('compare: one row per requirement across backends, disagreements and demotion reasons kept', () => {
  const runs = {
    claude: { requirements: [{ name: 'Supervision', match: 'yes' }, { name: 'Astreinte', match: 'adjacent' }], repairs: ["requirement Astreinte: no profile skill names it, the model's reading only: adjacent, to verify"] },
    local: { requirements: [{ name: 'supervision', match: 'adjacent' }, { name: 'Astreinte', match: 'adjacent' }], repairs: [] },
    gemini: { error: 'overloaded' },
  };
  const { rows, failed } = compareVerdicts(runs);
  assert.deepEqual(failed, { gemini: 'overloaded' });
  const supervision = rows.find((row) => row.name === 'supervision');
  assert.deepEqual(supervision.verdicts, { claude: 'yes', local: 'adjacent' });
  assert.equal(supervision.agree, false);
  const astreinte = rows.find((row) => row.name === 'astreinte');
  assert.equal(astreinte.agree, true);
  assert.deepEqual(astreinte.why, { claude: ["no profile skill names it, the model's reading only: adjacent, to verify"] });
});

// 2.33: on "Test 1" every model got "many repairs" (34, 29, 44), mostly the
// code's ordinary work. Only a repair that changes the model's verdict counts.
test('compareRuns: only the repairs that change a verdict make the lead, which names the most frequent kinds', () => {
  const ordinary = [
    'requirement PostgreSQL: listed 9 times, counted once',
    'requirement Pédagogie: a personal quality, not scored (to show in interview)',
    'requirement AWS: named like the profile skill aws, now yes with that skill alone (dropped: gcp)',
    "requirement Ansible: the profile's Terraform meets it too",
    'requirement Nationalité: an administrative condition, to confirm (not scored)',
    "requirement Python: nice by the offer's cue, the model said must",
    "requirement Bash: no profile skill names it, the model's reading only: adjacent, to verify",
  ];
  const changed = [
    "requirement Astreinte: no profile skill names it, the model's reading only: adjacent, to verify (was yes)",
    "requirement Veille: no profile skill names it, the model's reading only: adjacent, to verify (was yes)",
    'requirement Kafka: never claimed in the profile, now no (was adjacent)',
    'requirement Docker: named like the profile skill docker, now yes with that skill alone (was no)',
  ];
  const report = compareRuns([
    entry('claude', { repairs: [...Array(30).fill(ordinary).flat()] }),
    entry('gemini', { repairs: [...ordinary, ...changed] }),
  ]);
  assert.deepEqual(report.models.map((m) => [m.model, m.repairs, m.verdicts_changed]), [['claude', 210, 0], ['gemini', 11, 4]]);
  const leads = report.leads.filter((lead) => lead.kind === 'repairs');
  assert.equal(leads.length, 1, 'ordinary repairs, however many, are no lead');
  assert.match(leads[0].text, /^gemini : le code a changé 4 de ses verdicts, surtout : aucune compétence du profil ne la nomme \(2\), jamais revendiquée \(1\), nommée comme une compétence du profil \(1\)\.$/);
});

// 2.38 (seen on 2.37b): the listing is shared, each model names its rows;
// one requirement named two ways was two "disagreements".
test('compareRuns: rows line up by the listed requirements they cover, not by each model\'s names', () => {
  const listed = [
    { name: 'Moindre privilège', importance: 'must' },
    { name: 'IAM', importance: 'must' },
    { name: 'Remédiation des vulnérabilités', importance: 'nice' },
    { name: 'Terraform', importance: 'must' },
  ];
  const rows = (...requirements) => ({ listed, analysis: { requirements } });
  const report = compareRuns([
    entry('claude', rows({ name: 'Moindre privilège / IAM', match: 'yes' }, { name: 'Détection et remédiation des vulnérabilités', match: 'adjacent' }, { name: 'Terraform', match: 'yes' }, { name: 'Ansible', match: 'no' })),
    entry('gemini', rows({ name: 'Moindre privilège', match: 'yes' }, { name: 'IAM', match: 'yes' }, { name: 'Remédiation des vulnérabilités', match: 'adjacent' }, { name: 'Terraform', match: 'yes' }, { name: 'Ansible', match: 'no' })),
  ]);
  assert.deepEqual(Object.fromEntries(report.rows.map((row) => [row.name, row.agree])), { ansible: true, iam: true, 'moindre privilège': true, 'remédiation des vulnérabilités': true, terraform: true });
  assert.ok(!report.leads.some((lead) => lead.kind === 'disagree'));
});

test('compareRuns: a listed word inside a longer name is not that requirement ("SQL" is not "SQL Server")', () => {
  const listed = [{ name: 'SQL', importance: 'must' }];
  const report = compareRuns([
    entry('claude', { listed, analysis: { requirements: [{ name: 'SQL Server', match: 'no' }, { name: 'SQL', match: 'yes' }] } }),
    entry('gemini', { listed, analysis: { requirements: [{ name: 'SQL', match: 'yes' }] } }),
  ]);
  assert.deepEqual(Object.fromEntries(report.rows.map((row) => [row.name, row.agree])), { sql: true, 'sql server': false });
});
