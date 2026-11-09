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
    entry('gemini', { fit: { score: 80, verdict: 'go', qualification: { level: 'strong' } }, repairs: Array(10).fill('x') }),
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
