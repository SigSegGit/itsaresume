// 2.28b: a stored run's own model answers, fed again to the current code,
// say which verdicts the code changes, without any model call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v4 } from './fixtures/v4.js';
import { replayRun } from '../src/replay.js';

const OFFER = 'Senior SRE wanted. Must have: PostgreSQL, SQL.';
const ANSWER = {
  language: 'en',
  fit: { score: 50, verdict: 'partial', rationale: '' },
  headline: 'Senior SRE',
  summary: ['SRE running PostgreSQL in critical production.'],
  requirements: [
    { name: 'PostgreSQL', importance: 'must', match: 'yes', skills: ['postgresql'], note: '' },
    { name: 'SQL', importance: 'must', match: 'adjacent', skills: ['postgresql'], note: '' },
  ],
  experiences: [{ id: 'acme', bullets: ['acme-pg'] }],
  skill_groups: [{ id: 'db', skills: ['postgresql'] }],
};

test('replay: a stored run fed again to the current code lists each verdict it changes, with no model call', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'itsacv-replay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'offer.txt'), OFFER);
  writeFileSync(join(dir, 'raw.json'), JSON.stringify({ calls: [
    { step: 'listing', backend: 'claude-code', text: JSON.stringify({ requirements: [{ name: 'PostgreSQL', importance: 'must' }, { name: 'SQL', importance: 'must' }] }) },
    { step: 'analysis', backend: 'claude-code', text: JSON.stringify(ANSWER) },
  ] }));
  writeFileSync(join(dir, 'analysis.json'), JSON.stringify({ requirements: [
    { name: 'PostgreSQL', match: 'yes' }, { name: 'SQL', match: 'adjacent' },
  ], fit: { score: 83 } }));
  const result = await replayRun({ dir, profile: v4() });
  assert.deepEqual(result.changed, [{ name: 'SQL', before: 'adjacent', after: 'yes' }]);
  assert.equal(result.before.score, 83);
  assert.equal(result.after.score, 100);
});
